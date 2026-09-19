import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { apiKeyMatches, bearerToken } from './auth.js';
import { BbbApiError } from './bbb-client.js';
import { namespacedId, validateExternalId } from './meeting-ids.js';
import { TenantRateLimiter } from './rate-limit.js';
import type { BbbClientLike, GatewayConfig, MeetingRole, TenantConfig } from './types.js';

interface TenantRequest extends Request {
  tenant?: TenantConfig;
  requestId?: string;
}

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

export function createApp(config: GatewayConfig, bbbClient: BbbClientLike): express.Express {
  const app = express();
  const rateLimiter = new TenantRateLimiter();

  app.disable('x-powered-by');
  app.use((request: TenantRequest, response, next) => {
    const suppliedRequestId = request.header('x-request-id');
    request.requestId = suppliedRequestId && /^[A-Za-z0-9._-]{1,100}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
    response.setHeader('x-request-id', request.requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

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

    const activeMeetingIds = await bbbClient.listMeetingIds();
    const activeForTenant = activeMeetingIds.filter((id) => id.startsWith(tenant.meetingIdPrefix));
    const alreadyExists = activeMeetingIds.includes(bbbMeetingId);
    if (!alreadyExists && activeForTenant.length >= tenant.maxConcurrentMeetings) {
      throw new HttpError(409, 'meeting_limit_reached', 'Concurrent meeting limit reached');
    }

    const created = await bbbClient.createMeeting({
      meetingID: bbbMeetingId,
      name,
      record,
      logoutURL: tenant.logoutUrl,
      meetingEndedURL: tenant.meetingEndedCallbackUrl,
      maxParticipants: tenant.maxParticipantsPerMeeting,
      cameraBridge: tenant.media.cameraBridge,
      screenShareBridge: tenant.media.screenShareBridge,
      audioBridge: tenant.media.audioBridge,
      tenantId: tenant.id,
    });

    response.status(alreadyExists ? 200 : 201).json({
      meetingId,
      createTime: created.createTime,
      created: !alreadyExists,
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

    const joinUrl = bbbClient.buildJoinUrl({
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
    const running = await bbbClient.isMeetingRunning(internalMeetingId(tenant, meetingId));
    response.json({ meetingId, running });
  });

  tenantRouter.delete('/meetings/:meetingId', async (request: TenantRequest, response) => {
    const tenant = tenantFrom(request);
    const meetingId = externalId(request.params.meetingId, 'meetingId');
    await bbbClient.endMeeting(internalMeetingId(tenant, meetingId));
    response.status(202).json({ meetingId, status: 'ending' });
  });

  app.use('/v1/tenants/:tenantId', tenantRouter);

  app.use((_request, _response, next) => {
    next(new HttpError(404, 'not_found', 'Route not found'));
  });

  app.use((error: unknown, request: TenantRequest, response: Response, _next: NextFunction) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'The request could not be completed';

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
    } else {
      console.error(JSON.stringify({
        level: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : 'Unknown error',
      }));
    }

    response.status(status).json({
      error: {
        code,
        message,
        requestId: request.requestId,
      },
    });
  });

  return app;
}
