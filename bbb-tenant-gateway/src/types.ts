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
  media: TenantMediaConfig;
}

export interface GatewayConfig {
  host: string;
  port: number;
  bbb: {
    apiBaseUrl: string;
    sharedSecret: string;
    checksumAlgorithm: ChecksumAlgorithm;
    timeoutMs: number;
  };
  tenants: Map<string, TenantConfig>;
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
  maxParticipants: number;
  cameraBridge?: CameraBridge;
  screenShareBridge?: ScreenShareBridge;
  audioBridge?: AudioBridge;
  tenantId: string;
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

export interface BbbClientLike {
  createMeeting(options: CreateMeetingOptions): Promise<{ createTime: string }>;
  buildJoinUrl(options: JoinOptions): string;
  listMeetingIds(): Promise<string[]>;
  isMeetingRunning(meetingID: string): Promise<boolean>;
  endMeeting(meetingID: string): Promise<void>;
}
