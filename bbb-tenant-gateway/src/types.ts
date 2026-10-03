export type ChecksumAlgorithm = 'sha1' | 'sha256' | 'sha384' | 'sha512';
export type CameraBridge = 'bbb-webrtc-sfu' | 'livekit';
export type ScreenShareBridge = 'bbb-webrtc-sfu' | 'livekit';
export type AudioBridge = 'bbb-webrtc-sfu' | 'livekit' | 'freeswitch';
export type MeetingRole = 'MODERATOR' | 'VIEWER';

export interface TenantMediaConfig {
  cameraBridge?: CameraBridge;
  screenShareBridge?: ScreenShareBridge;
  audioBridge?: AudioBridge;
}

export interface RecordingReadyWebhookConfig {
  url: string;
  /** Resolved from the environment variable named by `secretEnv`; never logged. */
  secret: string;
}

export interface TenantConfig {
  id: string;
  apiKeySha256: string;
  meetingIdPrefix: string;
  userIdPrefix: string;
  allowedOrigins: string[];
  logoutUrl?: string;
  meetingEndedCallbackUrl?: string;
  allowModerator: boolean;
  allowRecording: boolean;
  autoStartRecording: boolean;
  allowStartStopRecording: boolean;
  maxConcurrentMeetings: number;
  maxParticipantsPerMeeting: number;
  requestsPerMinute: number;
  /** Days a finished recording stays available before the gateway deletes it. */
  recordingRetentionDays: number;
  /** Concurrent download streams allowed per tenant. */
  maxConcurrentDownloads: number;
  recordingReadyWebhook?: RecordingReadyWebhookConfig;
  media: TenantMediaConfig;
  /** Absolute URLs of BigBlueButton HTML5 plugin manifests loaded into every meeting of the tenant. */
  pluginManifests: string[];
}

export interface RecordingPaths {
  /** BBB publishedDir, default /var/bigbluebutton/published */
  publishedDir: string;
  /** BBB unpublishedDir, default /var/bigbluebutton/unpublished */
  unpublishedDir: string;
  /** BBB recording status markers, default /var/bigbluebutton/recording/status */
  statusDir: string;
}

export interface RecordingConfig {
  paths: RecordingPaths;
  /** Writable directory for meetings.json, webhooks.json and purge/ tombstones. */
  stateDir: string;
  /** Sent as meta_bbb-recording-ready-url when a meeting is recorded. */
  readyCallbackUrl: string;
  /** Prefix of the download URLs handed to tenants, without a trailing slash. */
  publicBaseUrl: string;
  pollIntervalMs: number;
  retentionSweepIntervalMs: number;
  webhookRetryScheduleMs: number[];
}

export interface GatewayConfig {
  host: string;
  port: number;
  /** Loopback-only listener for BigBlueButton's recording-ready callback. */
  internalPort: number;
  bbb: {
    apiBaseUrl: string;
    sharedSecret: string;
    checksumAlgorithm: ChecksumAlgorithm;
    timeoutMs: number;
  };
  tenants: Map<string, TenantConfig>;
  recording: RecordingConfig;
}

export type BbbParameter = string | number | boolean | undefined;
export type BbbParameters = Record<string, BbbParameter>;

export interface CreateMeetingOptions {
  meetingID: string;
  name: string;
  record: boolean;
  autoStartRecording?: boolean;
  allowStartStopRecording?: boolean;
  logoutURL?: string;
  meetingEndedURL?: string;
  /** Sent as meta_bbb-recording-ready-url; BBB posts there after each format publish. */
  recordingReadyUrl?: string;
  maxParticipants: number;
  cameraBridge?: CameraBridge;
  screenShareBridge?: ScreenShareBridge;
  audioBridge?: AudioBridge;
  /** Sent as pluginManifests=[{"url":...}, ...] when non-empty. */
  pluginManifests?: string[];
  tenantId: string;
}

export interface CreateMeetingResult {
  createTime: string;
  /** true when BigBlueButton answered duplicateWarning (the meeting already existed). */
  duplicate?: boolean;
}

export interface JoinOptions {
  meetingID: string;
  createTime: string;
  fullName: string;
  userID: string;
  role: MeetingRole;
  logoutURL?: string;
  autoJoinAudio?: boolean;
  autoShareWebcam?: boolean;
}

/** Subset of getMeetingInfo. `running` means "has at least one user" (BBB semantics). */
export interface MeetingInfo {
  meetingID: string;
  internalMeetingID: string;
  createTime: string;
  running: boolean;
  /** The meeting's record flag (not whether recording is active right now). */
  recording: boolean;
  hasUserJoined: boolean;
  endTime: string;
}

export type BbbRecordingState = 'processing' | 'processed' | 'published' | 'unpublished' | 'deleted';

export interface BbbPlaybackFormat {
  type: string;
  url: string;
  /** Minutes, as BigBlueButton reports it. */
  length: number;
  size: number;
}

export interface BbbRecording {
  recordID: string;
  /** The external meeting ID as the gateway sent it (namespaced with the tenant prefix). */
  meetingID: string;
  internalMeetingID: string;
  name: string;
  state: BbbRecordingState;
  published: boolean;
  /** Milliseconds since the epoch, as a string. */
  startTime: string;
  endTime: string;
  participants: number;
  /** Keys are lowercased: BigBlueButton lowercases every meta_ parameter on create. */
  metadata: Record<string, string>;
  formats: BbbPlaybackFormat[];
}

export interface RecordingsFilter {
  meetingID?: string;
  recordID?: string;
  metaTenantId?: string;
  states?: BbbRecordingState[];
}

export interface BbbClientLike {
  createMeeting(options: CreateMeetingOptions): Promise<CreateMeetingResult>;
  buildJoinUrl(options: JoinOptions): string;
  listMeetingIds(): Promise<string[]>;
  isMeetingRunning(meetingID: string): Promise<boolean>;
  endMeeting(meetingID: string): Promise<void>;
  /** null when BigBlueButton answers notFound (the meeting has ended or never existed). */
  getMeetingInfo(meetingID: string): Promise<MeetingInfo | null>;
  getRecordings(filter: RecordingsFilter): Promise<BbbRecording[]>;
  /** false when BigBlueButton answers notFound (nothing published or unpublished under that id). */
  deleteRecording(recordID: string): Promise<boolean>;
}

export type SessionOutcome = 'ready' | 'failed' | 'no_recording' | 'deleted' | 'expired' | 'timeout';

export interface MeetingSession {
  /** BBB internalMeetingID = sha1(meetingID) + '-' + createTime. */
  recordId: string;
  createTime: string;
  /** ISO 8601, when the gateway learned about the session. */
  createdAt: string;
  /** The record flag that applied to this session; falls back to the meeting's flag when absent (older state files). */
  record?: boolean;
  outcome?: SessionOutcome;
  outcomeAt?: string;
  error?: string;
  notifiedReady?: boolean;
  notifiedFailed?: boolean;
}

export interface MeetingRecord {
  tenantId: string;
  /** External meeting ID without the tenant prefix. */
  meetingId: string;
  record: boolean;
  sessions: MeetingSession[];
  updatedAt: string;
}

export type RecordingState = 'none' | 'recording' | 'processing' | 'ready' | 'failed';

export interface RecordingItem {
  recordId: string;
  meetingId: string;
  state: 'processing' | 'ready' | 'failed';
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  mime: 'video/mp4' | null;
  sizeBytes: number | null;
  filename: string | null;
  downloadUrl: string | null;
  playbackUrl: null;
  createdAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

export interface WebhookEvent {
  event: 'recording.ready' | 'recording.failed';
  tenant: string;
  meetingId: string;
  recordId: string;
  occurredAt: string;
  error?: string;
}
