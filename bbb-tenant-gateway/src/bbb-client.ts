import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type {
  BbbClientLike,
  BbbParameters,
  BbbPlaybackFormat,
  BbbRecording,
  BbbRecordingState,
  ChecksumAlgorithm,
  CreateMeetingOptions,
  CreateMeetingResult,
  JoinOptions,
  MeetingInfo,
  RecordingsFilter,
} from './types.js';

interface BbbClientConfig {
  apiBaseUrl: string;
  sharedSecret: string;
  checksumAlgorithm: ChecksumAlgorithm;
  timeoutMs: number;
}

/** fast-xml-parser output with parseTagValue=false: leaves are strings, empty elements are ''. */
type XmlValue = string | XmlNode | XmlValue[];
interface XmlNode {
  [tag: string]: XmlValue | undefined;
}

interface BbbResponse {
  returncode?: string;
  messageKey?: string;
  message?: string;
  createTime?: string;
  running?: string;
  deleted?: string;
  meetingID?: string;
  internalMeetingID?: string;
  recording?: string;
  hasUserJoined?: string;
  endTime?: string;
  meetings?: {
    meeting?: { meetingID?: string } | Array<{ meetingID?: string }>;
  };
  recordings?: XmlValue;
}

const RECORDING_STATES = new Set<BbbRecordingState>([
  'processing',
  'processed',
  'published',
  'unpublished',
  'deleted',
]);

export class BbbApiError extends Error {
  constructor(
    public readonly operation: string,
    public readonly messageKey: string,
    message: string,
  ) {
    super(`BigBlueButton ${operation} failed: ${messageKey}${message ? ` (${message})` : ''}`);
    this.name = 'BbbApiError';
  }
}

function isNode(value: XmlValue | undefined): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: XmlValue | undefined): XmlNode[] {
  if (value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.filter(isNode);
  return isNode(value) ? [value] : [];
}

function text(value: XmlValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function number(value: XmlValue | undefined): number {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordingState(value: XmlValue | undefined, published: boolean): BbbRecordingState {
  const raw = text(value);
  if (RECORDING_STATES.has(raw as BbbRecordingState)) return raw as BbbRecordingState;
  return published ? 'published' : 'unpublished';
}

/** BigBlueButton lowercases meta_ keys on create; normalise again here so every reader agrees. */
function parseMetadata(value: XmlValue | undefined): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (!isNode(value)) return metadata;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') metadata[key.toLowerCase()] = entry;
  }
  return metadata;
}

function parseFormats(value: XmlValue | undefined): BbbPlaybackFormat[] {
  if (!isNode(value)) return [];
  return asList(value.format).map((format) => ({
    type: text(format.type),
    url: text(format.url),
    length: number(format.length),
    size: number(format.size),
  }));
}

function parseRecording(node: XmlNode): BbbRecording {
  const published = text(node.published) === 'true';
  return {
    recordID: text(node.recordID),
    meetingID: text(node.meetingID),
    internalMeetingID: text(node.internalMeetingID),
    name: text(node.name),
    state: recordingState(node.state, published),
    published,
    startTime: text(node.startTime),
    endTime: text(node.endTime),
    participants: number(node.participants),
    metadata: parseMetadata(node.metadata),
    formats: parseFormats(node.playback),
  };
}

export class BbbClient implements BbbClientLike {
  private readonly parser = new XMLParser({ parseTagValue: false, trimValues: true });

  constructor(
    private readonly config: BbbClientConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  buildSignedUrl(callName: string, parameters: BbbParameters): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(parameters)) {
      if (value !== undefined) query.append(name, String(value));
    }

    const serializedQuery = query.toString();
    const checksum = createHash(this.config.checksumAlgorithm)
      .update(`${callName}${serializedQuery}${this.config.sharedSecret}`, 'utf8')
      .digest('hex');
    const signedQuery = serializedQuery
      ? `${serializedQuery}&checksum=${checksum}`
      : `checksum=${checksum}`;
    return `${this.config.apiBaseUrl}/${callName}?${signedQuery}`;
  }

  async createMeeting(options: CreateMeetingOptions): Promise<CreateMeetingResult> {
    const response = await this.call('create', {
      meetingID: options.meetingID,
      name: options.name,
      record: options.record,
      autoStartRecording: options.autoStartRecording,
      allowStartStopRecording: options.allowStartStopRecording,
      logoutURL: options.logoutURL,
      meetingEndedURL: options.meetingEndedURL,
      maxParticipants: options.maxParticipants,
      cameraBridge: options.cameraBridge,
      screenShareBridge: options.screenShareBridge,
      audioBridge: options.audioBridge,
      meta_tenantId: options.tenantId,
      'meta_bbb-recording-ready-url': options.recordingReadyUrl,
    });
    if (!response.createTime) throw new BbbApiError('create', 'invalidResponse', 'Missing createTime');
    return {
      createTime: response.createTime,
      duplicate: response.messageKey === 'duplicateWarning',
    };
  }

  buildJoinUrl(options: JoinOptions): string {
    return this.buildSignedUrl('join', {
      meetingID: options.meetingID,
      createTime: options.createTime,
      fullName: options.fullName,
      userID: options.userID,
      role: options.role,
      logoutURL: options.logoutURL,
      'userdata-bbb_auto_join_audio': options.autoJoinAudio,
      'userdata-bbb_auto_share_webcam': options.autoShareWebcam,
    });
  }

  async listMeetingIds(): Promise<string[]> {
    const response = await this.call('getMeetings', {});
    const rawMeetings = response.meetings?.meeting;
    if (!rawMeetings) return [];
    const meetings = Array.isArray(rawMeetings) ? rawMeetings : [rawMeetings];
    return meetings.flatMap((meeting) => (meeting.meetingID ? [meeting.meetingID] : []));
  }

  async isMeetingRunning(meetingID: string): Promise<boolean> {
    const response = await this.call('isMeetingRunning', { meetingID });
    return response.running === 'true';
  }

  async endMeeting(meetingID: string): Promise<void> {
    await this.call('end', { meetingID });
  }

  async getMeetingInfo(meetingID: string): Promise<MeetingInfo | null> {
    let response: BbbResponse;
    try {
      response = await this.call('getMeetingInfo', { meetingID });
    } catch (error) {
      if (error instanceof BbbApiError && error.messageKey === 'notFound') return null;
      throw error;
    }
    return {
      meetingID: response.meetingID ?? '',
      internalMeetingID: response.internalMeetingID ?? '',
      createTime: response.createTime ?? '',
      running: response.running === 'true',
      recording: response.recording === 'true',
      hasUserJoined: response.hasUserJoined === 'true',
      endTime: response.endTime ?? '',
    };
  }

  async getRecordings(filter: RecordingsFilter): Promise<BbbRecording[]> {
    const response = await this.call('getRecordings', {
      meetingID: filter.meetingID,
      recordID: filter.recordID,
      meta_tenantid: filter.metaTenantId,
      state: filter.states && filter.states.length > 0 ? filter.states.join(',') : undefined,
    });
    const recordings = response.recordings;
    if (!isNode(recordings)) return [];
    return asList(recordings.recording).map(parseRecording);
  }

  async deleteRecording(recordID: string): Promise<boolean> {
    try {
      await this.call('deleteRecordings', { recordID });
    } catch (error) {
      if (error instanceof BbbApiError && error.messageKey === 'notFound') return false;
      throw error;
    }
    // BigBlueButton answers <deleted>true</deleted> on SUCCESS; SUCCESS alone already means it was deleted.
    return true;
  }

  private async call(callName: string, parameters: BbbParameters): Promise<BbbResponse> {
    let response: Response;
    try {
      response = await this.fetchImplementation(this.buildSignedUrl(callName, parameters), {
        method: 'GET',
        headers: { Accept: 'application/xml' },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new BbbApiError(callName, 'transportError', (error as Error).message);
    }

    const body = await response.text();
    let parsed: BbbResponse | undefined;
    try {
      parsed = this.parser.parse(body)?.response as BbbResponse | undefined;
    } catch {
      throw new BbbApiError(callName, 'invalidResponse', `HTTP ${response.status}`);
    }

    if (!response.ok || parsed?.returncode !== 'SUCCESS') {
      throw new BbbApiError(
        callName,
        parsed?.messageKey || `http${response.status}`,
        parsed?.message || '',
      );
    }
    return parsed;
  }
}
