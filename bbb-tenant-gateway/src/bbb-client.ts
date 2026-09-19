import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type {
  BbbClientLike,
  BbbParameters,
  ChecksumAlgorithm,
  CreateMeetingOptions,
  JoinOptions,
} from './types.js';

interface BbbClientConfig {
  apiBaseUrl: string;
  sharedSecret: string;
  checksumAlgorithm: ChecksumAlgorithm;
  timeoutMs: number;
}

interface BbbResponse {
  returncode?: string;
  messageKey?: string;
  message?: string;
  createTime?: string;
  running?: string;
  meetings?: {
    meeting?: { meetingID?: string } | Array<{ meetingID?: string }>;
  };
}

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

  async createMeeting(options: CreateMeetingOptions): Promise<{ createTime: string }> {
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
    });
    if (!response.createTime) throw new BbbApiError('create', 'invalidResponse', 'Missing createTime');
    return { createTime: response.createTime };
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
