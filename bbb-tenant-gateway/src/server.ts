import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { apiKeyMatches, bearerToken } from './auth.js';
import { BbbApiError } from './bbb-client.js';
import { verifyHs256 } from './jwt.js';
import { namespacedId, validateExternalId } from './meeting-ids.js';
import { TenantRateLimiter } from './rate-limit.js';
import type { RecordingMonitor } from './recording-monitor.js';
import {
  inspectRecording,
  readVideoMetadata,
  RECORD_ID_PATTERN,
  recordIdFor,
  TombstoneWriteError,
  type Inspection,
} from './recordings.js';
import { isRecorded, type MeetingStateStore } from './state-store.js';
import { sendFile } from './stream.js';
import type {
  BbbClientLike,
  BbbRecording,
  BbbRecordingState,
  GatewayConfig,
  MeetingRole,
  MeetingSession,
  RecordingItem,
  RecordingState,
  TenantConfig,
} from './types.js';
import type { WebhookQueue } from './webhook.js';

export interface AppDeps {
  bbb: BbbClientLike;
  store: MeetingStateStore;
  webhooks: WebhookQueue;
  monitor: RecordingMonitor;
  now?: () => Date;
}

interface TenantRequest extends Request {
  tenant?: TenantConfig;
  requestId?: string;
}

const ALL_STATES: BbbRecordingState[] = ['processing', 'processed', 'published', 'unpublished', 'deleted'];
const LISTED_STATES: BbbRecordingState[] = ['processing', 'processed', 'published', 'unpublished'];
const DAY_MS = 86_400_000;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function bodyObject(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new HttpError(400, 'invalid_request', 'A JSON object body is required');
  }
  return request.body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, name: string, min: number, max: number): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new HttpError(400, 'invalid_request', `${name} must be a string between ${min} and ${max} characters`);
  }
  const trimmed = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, 'invalid_request', `${name} must not contain control characters`);
  }
  return trimmed;
}

function optionalBoolean(body: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = body[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_request', `${name} must be a boolean`);
  return value;
}

function tenantFrom(request: TenantRequest): TenantConfig {
  if (!request.tenant) throw new HttpError(500, 'internal_error', 'Tenant context is missing');
  return request.tenant;
}

function externalId(value: unknown, name: string): string {
  try {
    return validateExternalId(value, name);
  } catch (error) {
    throw new HttpError(400, 'invalid_request', (error as Error).message);
  }
}

function internalMeetingId(tenant: TenantConfig, id: string): string {
  try {
    return namespacedId(tenant.meetingIdPrefix, id);
  } catch (error) {
    throw new HttpError(400, 'invalid_request', (error as Error).message);
  }
}

function recordIdParam(value: unknown): string {
  if (typeof value !== 'string' || !RECORD_ID_PATTERN.test(value)) {
    throw new HttpError(404, 'recording_not_found', 'Recording not found');
  }
  return value;
}

function isoFromMs(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function latestSession(sessions: MeetingSession[]): MeetingSession | undefined {
  let latest: MeetingSession | undefined;
  for (const session of sessions) {
    if (!latest || Number(session.createTime) > Number(latest.createTime)) latest = session;
  }
  return latest;
}

/**
 * A BigBlueButton listing belongs to the tenant's meeting only when BOTH the external meeting ID
 * (namespaced with the tenant prefix) and the lowercased `tenantid` metadata match, and the id is well-formed.
 */
export function ownedRecording(recording: BbbRecording, tenant: Pick<TenantConfig, 'id'>, bbbMeetingId: string): boolean {
  return recording.meetingID === bbbMeetingId
    && recording.metadata.tenantid === tenant.id
    && RECORD_ID_PATTERN.test(recording.recordID);
}

/** Errors raised by express.json / body-parser (http-errors shape): numeric 4xx status plus a string type. */
function bodyParserError(error: unknown): { status: number; type: string } | null {
  if (!error || typeof error !== 'object') return null;
  const { status, type } = error as { status?: unknown; type?: unknown };
  if (typeof status !== 'number' || status < 400 || status > 499 || typeof type !== 'string') return null;
  return { status, type };
}

function requestIdMiddleware(request: TenantRequest, response: Response, next: NextFunction): void {
  const suppliedRequestId = request.header('x-request-id');
  request.requestId = suppliedRequestId && /^[A-Za-z0-9._-]{1,100}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : randomUUID();
  response.setHeader('x-request-id', request.requestId);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('cache-control', 'no-store');
  next();
}

function errorHandler(error: unknown, request: TenantRequest, response: Response, _next: NextFunction): void {
  let status = 500;
  let code = 'internal_error';
  let message = 'The request could not be completed';
  const parserError = bodyParserError(error);

  if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (error instanceof BbbApiError) {
    status = 502;
    code = 'bbb_api_error';
    message = `BigBlueButton rejected the ${error.operation} operation (${error.messageKey})`;
  } else if (error instanceof SyntaxError && 'body' in error) {
    status = 400;
    code = 'invalid_json';
    message = 'Request body is not valid JSON';
  } else if (error instanceof TombstoneWriteError) {
    status = 503;
    code = 'recording_delete_unavailable';
    message = 'The deletion could not be recorded; try again later';
  } else if (parserError) {
    // body-parser / http-errors client errors (after the SyntaxError branch, which covers invalid JSON).
    if (parserError.type === 'entity.too.large') {
      status = 413;
      code = 'payload_too_large';
      message = 'Request body is too large';
    } else if (parserError.type === 'charset.unsupported' || parserError.type === 'encoding.unsupported') {
      status = 415;
      code = 'unsupported_media_type';
      message = 'Request body uses an unsupported charset or content encoding';
    } else {
      status = 400;
      code = 'invalid_request';
      message = 'Request body could not be read';
    }
  } else {
    console.error(JSON.stringify({
      level: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : 'Unknown error',
    }));
  }

  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.status(status).json({
    error: {
      code,
      message,
      requestId: request.requestId,
    },
  });
}

function notFoundHandler(_request: Request, _response: Response, next: NextFunction): void {
  next(new HttpError(404, 'not_found', 'Route not found'));
}

export function createApp(config: GatewayConfig, deps: AppDeps): express.Express {
  const { bbb, store, monitor } = deps;
  const app = express();
  const rateLimiter = new TenantRateLimiter();
  const activeDownloads = new Map<string, number>();
  const { paths, stateDir } = config.recording;

  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.use(requestIdMiddleware);
  // Matches nginx client_max_body_size 32k so both layers answer 413 at the same boundary.
  app.use(express.json({ limit: '32kb', strict: true }));

  app.get('/healthz', (_request, response) => {
    response.json({ status: 'ok' });
  });

  const tenantRouter = express.Router({ mergeParams: true });
  tenantRouter.use((request: TenantRequest, response, next) => {
    const tenantId = String(request.params.tenantId || '');
    const tenant = config.tenants.get(tenantId);
    if (!tenant) return next(new HttpError(404, 'tenant_not_found', 'Tenant not found'));
    request.tenant = tenant;

    const origin = request.header('origin');
    if (origin) {
      if (!tenant.allowedOrigins.includes(origin)) {
        return next(new HttpError(403, 'origin_not_allowed', 'Origin is not allowed for this tenant'));
      }
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('access-control-allow-headers', 'Authorization, Content-Type, X-Request-ID');
    }

    if (request.method === 'OPTIONS') return response.sendStatus(204);

    const token = bearerToken(request.header('authorization'));
    if (!token || !apiKeyMatches(token, tenant.apiKeySha256)) {
      response.setHeader('www-authenticate', 'Bearer');
      return next(new HttpError(401, 'unauthorized', 'A valid tenant API key is required'));
    }

    const rateLimit = rateLimiter.consume(tenant.id, tenant.requestsPerMinute);
    if (!rateLimit.allowed) {
      response.setHeader('retry-after', String(rateLimit.retryAfterSeconds));
      return next(new HttpError(429, 'rate_limited', 'Tenant request limit exceeded'));
    }
    return next();
  });

  /**
   * Ownership check shared by download and DELETE: stored session for this tenant+meeting, else BBB.
   * A stored session without an outcome is also looked up in BBB so that a published recording whose
   * status markers BBB's cron already removed (14 days) still classifies as ready.
   */
  async function findOwnedRecording(
    tenant: TenantConfig,
    meetingId: string,
    bbbMeetingId: string,
    recordId: string,
  ): Promise<{ session?: MeetingSession; inspection: Inspection }> {
    const stored = store.findByRecordId(recordId);
    let session: MeetingSession | undefined;
    let listedState: BbbRecordingState | undefined;
    if (stored) {
      if (stored.meeting.tenantId !== tenant.id || stored.meeting.meetingId !== meetingId) {
        throw new HttpError(404, 'recording_not_found', 'Recording not found');
      }
      session = stored.session;
      if (session.outcome === undefined) {
        const listed = await bbb.getRecordings({ recordID: recordId, states: ALL_STATES });
        listedState = listed.find((recording) => recording.recordID === recordId)?.state;
      }
    } else {
      const listed = await bbb.getRecordings({ recordID: recordId, states: ALL_STATES });
      if (listed.length !== 1 || !ownedRecording(listed[0]!, tenant, bbbMeetingId)) {
        throw new HttpError(404, 'recording_not_found', 'Recording not found');
      }
      listedState = listed[0]!.state;
    }
    const inspection = await inspectRecording(paths, stateDir, recordId, session, listedState);
    if (inspection.state === 'deleted') throw new HttpError(404, 'recording_not_found', 'Recording not found');
    return { session, inspection };
  }

  async function buildItem(
    tenant: TenantConfig,
    meetingId: string,
    recordId: string,
    session: MeetingSession | undefined,
    listed: BbbRecording | undefined,
    inspection: Inspection,
  ): Promise<RecordingItem> {
    const ready = inspection.state === 'ready';
    const metadata = ready ? await readVideoMetadata(paths, recordId) : null;
    const startedAt = isoFromMs(listed?.startTime) ?? isoFromMs(metadata?.startTime) ?? isoFromMs(session?.createTime);
    const endedAt = isoFromMs(listed?.endTime) ?? isoFromMs(metadata?.endTime);
    const endedMs = endedAt ? Date.parse(endedAt) : null;
    const state: RecordingItem['state'] = inspection.state === 'ready'
      ? 'ready'
      : inspection.state === 'processing' ? 'processing' : 'failed';
    const video = ready ? inspection.video : null;

    return {
      recordId,
      meetingId,
      state,
      startedAt,
      endedAt,
      durationSec: ready && metadata?.durationMs !== null && metadata?.durationMs !== undefined
        ? Math.round(metadata.durationMs / 1000)
        : null,
      mime: ready ? 'video/mp4' : null,
      sizeBytes: video ? video.size : null,
      filename: ready ? `${meetingId}-${recordId}.mp4` : null,
      downloadUrl: ready
        ? `${config.recording.publicBaseUrl}/v1/tenants/${tenant.id}/meetings/${meetingId}/recordings/${recordId}/download`
        : null,
      playbackUrl: null,
      createdAt: video ? new Date(Math.floor(video.mtimeMs)).toISOString() : null,
      expiresAt: endedMs !== null ? new Date(endedMs + tenant.recordingRetentionDays * DAY_MS).toISOString() : null,
      error: state === 'failed' ? inspection.reason ?? 'failed' : null,
    };
  }

  tenantRouter.post('/meetings', async (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const body = bodyObject(request);
    const meetingId = externalId(body.meetingId, 'meetingId');
    const bbbMeetingId = internalMeetingId(tenant, meetingId);
    const name = requiredString(body, 'name', 2, 128);
    const record = optionalBoolean(body, 'record', false);
    if (record && !tenant.allowRecording) {
      throw new HttpError(403, 'recording_not_allowed', 'Recording is disabled for this tenant');
    }

    const activeMeetingIds = await bbb.listMeetingIds();
    const activeForTenant = activeMeetingIds.filter((id) => id.startsWith(tenant.meetingIdPrefix));
    const alreadyExists = activeMeetingIds.includes(bbbMeetingId);
    if (!alreadyExists && activeForTenant.length >= tenant.maxConcurrentMeetings) {
      throw new HttpError(409, 'meeting_limit_reached', 'Concurrent meeting limit reached');
    }

    const result = await bbb.createMeeting({
      meetingID: bbbMeetingId,
      name,
      record,
      autoStartRecording: record ? tenant.autoStartRecording : undefined,
      allowStartStopRecording: record ? tenant.allowStartStopRecording : undefined,
      logoutURL: tenant.logoutUrl,
      meetingEndedURL: tenant.meetingEndedCallbackUrl,
      recordingReadyUrl: record ? config.recording.readyCallbackUrl : undefined,
      maxParticipants: tenant.maxParticipantsPerMeeting,
      cameraBridge: tenant.media.cameraBridge,
      screenShareBridge: tenant.media.screenShareBridge,
      audioBridge: tenant.media.audioBridge,
      tenantId: tenant.id,
    });

    const created = !(alreadyExists || result.duplicate === true);
    let appliedRecord = record;
    if (!created) {
      let infoRecord: boolean | undefined;
      try {
        infoRecord = (await bbb.getMeetingInfo(bbbMeetingId))?.recording;
      } catch (error) {
        if (!(error instanceof BbbApiError)) throw error;
      }
      appliedRecord = infoRecord ?? store.get(tenant.id, meetingId)?.record ?? record;
    }

    const recordId = recordIdFor(bbbMeetingId, result.createTime);
    await store.upsertSession(tenant.id, meetingId, appliedRecord, { recordId, createTime: result.createTime });

    response.status(created ? 201 : 200).json({
      meetingId,
      createTime: result.createTime,
      created,
      record: appliedRecord,
    });
  });

  tenantRouter.post('/meetings/:meetingId/join', (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const body = bodyObject(request);
    const meetingId = externalId(request.params.meetingId, 'meetingId');
    const userId = externalId(body.userId, 'userId');
    const displayName = requiredString(body, 'displayName', 1, 128);
    const createTime = requiredString(body, 'createTime', 1, 32);
    if (!/^\d+$/.test(createTime)) throw new HttpError(400, 'invalid_request', 'createTime must contain digits only');

    const requestedRole = body.role === undefined ? 'VIEWER' : body.role;
    if (requestedRole !== 'VIEWER' && requestedRole !== 'MODERATOR') {
      throw new HttpError(400, 'invalid_request', 'role must be VIEWER or MODERATOR');
    }
    if (requestedRole === 'MODERATOR' && !tenant.allowModerator) {
      throw new HttpError(403, 'moderator_not_allowed', 'Moderator access is disabled for this tenant');
    }

    const joinUrl = bbb.buildJoinUrl({
      meetingID: internalMeetingId(tenant, meetingId),
      createTime,
      fullName: displayName,
      userID: namespacedId(tenant.userIdPrefix, userId),
      role: requestedRole as MeetingRole,
      logoutURL: tenant.logoutUrl,
      autoJoinAudio: optionalBoolean(body, 'autoJoinAudio', false),
      autoShareWebcam: optionalBoolean(body, 'autoShareWebcam', false),
    });

    response.json({ meetingId, joinUrl });
  });

  tenantRouter.get('/meetings/:meetingId', async (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const meetingId = externalId(request.params.meetingId, 'meetingId');
    const bbbMeetingId = internalMeetingId(tenant, meetingId);
    const info = await bbb.getMeetingInfo(bbbMeetingId);

    if (info) {
      const recordId = RECORD_ID_PATTERN.test(info.internalMeetingID)
        ? info.internalMeetingID
        : recordIdFor(bbbMeetingId, info.createTime);
      if (RECORD_ID_PATTERN.test(recordId)) {
        await store.upsertSession(tenant.id, meetingId, info.recording, { recordId, createTime: info.createTime });
      }
      const state: RecordingState = info.recording && info.hasUserJoined ? 'recording' : 'none';
      response.json({
        meetingId,
        running: info.running,
        record: info.recording,
        recording: { state, recordId: RECORD_ID_PATTERN.test(recordId) ? recordId : null },
      });
      return;
    }

    // Meeting gone: the latest RECORDED session of this meeting (a later record=false session must not
    // hide an earlier recording); without any stored meeting, the latest BBB listing we own.
    const stored = store.get(tenant.id, meetingId);
    const session = stored
      ? latestSession(stored.sessions.filter((candidate) => isRecorded(stored, candidate)))
      : undefined;
    let recordId: string | null = session?.recordId ?? null;
    let listedState: BbbRecordingState | undefined;
    if (!stored) {
      const listed = (await bbb.getRecordings({ meetingID: bbbMeetingId, states: ALL_STATES }))
        .filter((recording) => ownedRecording(recording, tenant, bbbMeetingId));
      let latest: BbbRecording | undefined;
      for (const recording of listed) {
        if (!latest || Number(recording.startTime) > Number(latest.startTime)) latest = recording;
      }
      recordId = latest?.recordID ?? null;
      listedState = latest?.state;
    }

    const record = stored?.record ?? null;
    if (recordId === null) {
      response.json({ meetingId, running: false, record, recording: { state: 'none', recordId: null } });
      return;
    }

    const inspection = await inspectRecording(paths, stateDir, recordId, session, listedState);
    let state: RecordingState;
    switch (inspection.state) {
      case 'ready':
        state = 'ready';
        break;
      case 'failed':
        state = 'failed';
        break;
      case 'processing':
        state = 'processing';
        break;
      default:
        state = 'none';
    }
    const recording: { state: RecordingState; recordId: string; reason?: string } = { state, recordId };
    if (inspection.reason !== undefined) recording.reason = inspection.reason;
    response.json({ meetingId, running: false, record, recording });
  });

  tenantRouter.delete('/meetings/:meetingId', async (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const meetingId = externalId(request.params.meetingId, 'meetingId');
    await bbb.endMeeting(internalMeetingId(tenant, meetingId));
    response.status(202).json({ meetingId, status: 'ending' });
  });

  tenantRouter.get('/meetings/:meetingId/recordings', async (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const meetingId = externalId(request.params.meetingId, 'meetingId');
    const bbbMeetingId = internalMeetingId(tenant, meetingId);

    const listed = (await bbb.getRecordings({ meetingID: bbbMeetingId, states: LISTED_STATES }))
      .filter((recording) => ownedRecording(recording, tenant, bbbMeetingId));
    const sessions = (store.get(tenant.id, meetingId)?.sessions ?? [])
      .filter((session) => RECORD_ID_PATTERN.test(session.recordId));

    const candidates = new Map<string, { session?: MeetingSession; listed?: BbbRecording }>();
    for (const session of sessions) candidates.set(session.recordId, { session });
    for (const recording of listed) {
      const entry = candidates.get(recording.recordID) ?? {};
      entry.listed = recording;
      candidates.set(recording.recordID, entry);
    }

    const items: RecordingItem[] = [];
    for (const [recordId, { session, listed: recording }] of candidates) {
      const inspection = await inspectRecording(paths, stateDir, recordId, session, recording?.state);
      if (inspection.state === 'deleted') continue;
      if (session?.outcome === undefined && !recording && !inspection.evidence) continue;
      items.push(await buildItem(tenant, meetingId, recordId, session, recording, inspection));
    }
    items.sort((a, b) => {
      const left = a.startedAt ? Date.parse(a.startedAt) : Number(a.recordId.slice(41));
      const right = b.startedAt ? Date.parse(b.startedAt) : Number(b.recordId.slice(41));
      return left - right;
    });
    response.json({ items });
  });

  tenantRouter.get('/meetings/:meetingId/recordings/:recordId/download', async (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const meetingId = externalId(request.params.meetingId, 'meetingId');
    const bbbMeetingId = internalMeetingId(tenant, meetingId);
    const recordId = recordIdParam(request.params.recordId);

    const { inspection } = await findOwnedRecording(tenant, meetingId, bbbMeetingId, recordId);
    if (inspection.state !== 'ready' || !inspection.video) {
      const reason = inspection.reason ? `, reason ${inspection.reason}` : '';
      throw new HttpError(
        409,
        'recording_not_ready',
        `Recording is not ready for download (state ${inspection.state}${reason})`,
      );
    }

    const active = activeDownloads.get(tenant.id) ?? 0;
    if (active >= tenant.maxConcurrentDownloads) {
      response.setHeader('retry-after', '5');
      throw new HttpError(429, 'too_many_downloads', 'Too many concurrent downloads for this tenant');
    }
    activeDownloads.set(tenant.id, active + 1);
    try {
      await sendFile(request, response, {
        path: inspection.video.path,
        size: inspection.video.size,
        mtimeMs: inspection.video.mtimeMs,
        filename: `${meetingId}-${recordId}.mp4`,
        contentType: 'video/mp4',
      });
    } finally {
      const remaining = (activeDownloads.get(tenant.id) ?? 1) - 1;
      if (remaining <= 0) activeDownloads.delete(tenant.id);
      else activeDownloads.set(tenant.id, remaining);
      const status = response.statusCode;
      const lengthHeader = response.getHeader('content-length');
      const bytes = request.method === 'HEAD' || (status !== 200 && status !== 206)
        ? 0
        : Number(lengthHeader ?? 0);
      console.log(JSON.stringify({
        level: 'info',
        message: 'recording download',
        requestId: request.requestId,
        tenant: tenant.id,
        recordId,
        status,
        bytes: Number.isFinite(bytes) ? bytes : 0,
      }));
    }
  });

  tenantRouter.delete('/meetings/:meetingId/recordings/:recordId', async (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const meetingId = externalId(request.params.meetingId, 'meetingId');
    const bbbMeetingId = internalMeetingId(tenant, meetingId);
    const recordId = recordIdParam(request.params.recordId);

    const { inspection } = await findOwnedRecording(tenant, meetingId, bbbMeetingId, recordId);
    if (inspection.state === 'processing') {
      throw new HttpError(409, 'recording_not_ready', 'Recording is still processing and cannot be deleted yet');
    }

    await monitor.deleteRecording(tenant, meetingId, recordId, 'deleted');
    response.status(202).json({ recordId, status: 'deleting' });
  });

  app.use('/v1/tenants/:tenantId', tenantRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Loopback-only listener for BigBlueButton's recording-ready callback. */
export function createInternalApp(config: GatewayConfig, deps: AppDeps): express.Express {
  const { store, monitor } = deps;
  const now = deps.now ?? (() => new Date());
  const app = express();

  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.use(requestIdMiddleware);
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.post('/internal/recording-ready', async (request: TenantRequest, response) => {
    const body = request.body as Record<string, unknown> | undefined;
    const token = body && typeof body.signed_parameters === 'string' ? body.signed_parameters : undefined;
    const payload = token === undefined
      ? null
      : verifyHs256(token, config.bbb.sharedSecret, () => Math.floor(now().getTime() / 1000));
    if (!payload) throw new HttpError(401, 'unauthorized', 'signed_parameters is missing or invalid');

    const meetingIdParam = typeof payload.meeting_id === 'string' ? payload.meeting_id : '';
    const recordId = typeof payload.record_id === 'string' ? payload.record_id : '';
    const log = (message: string, extra: Record<string, unknown> = {}): void => {
      console.log(JSON.stringify({ level: 'info', message, requestId: request.requestId, recordId, ...extra }));
    };

    if (!RECORD_ID_PATTERN.test(recordId)) {
      log('recording-ready callback ignored', { reason: 'invalid record_id' });
      response.json({ ok: true });
      return;
    }

    let tenant: TenantConfig | undefined;
    for (const candidate of config.tenants.values()) {
      if (!meetingIdParam.startsWith(candidate.meetingIdPrefix)) continue;
      if (!tenant || candidate.meetingIdPrefix.length > tenant.meetingIdPrefix.length) tenant = candidate;
    }
    if (!tenant) {
      log('recording-ready callback ignored', { reason: 'unknown tenant prefix' });
      response.json({ ok: true });
      return;
    }

    const meetingId = meetingIdParam.slice(tenant.meetingIdPrefix.length);
    try {
      validateExternalId(meetingId, 'meeting_id');
    } catch {
      log('recording-ready callback ignored', { reason: 'invalid meeting_id', tenant: tenant.id });
      response.json({ ok: true });
      return;
    }

    // Sessions created by older gateway versions or lost state are tracked from here; a session we
    // already know keeps its own record flag (never overwritten with true).
    if (!store.findByRecordId(recordId)) {
      const createTime = recordId.slice(recordId.indexOf('-') + 1);
      await store.upsertSession(tenant.id, meetingId, true, { recordId, createTime });
    }
    await monitor.checkNow(recordId);
    log('recording-ready callback accepted', { tenant: tenant.id, meetingId });
    response.json({ ok: true });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
