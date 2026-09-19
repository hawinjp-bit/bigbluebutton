import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AudioBridge,
  CameraBridge,
  ChecksumAlgorithm,
  GatewayConfig,
  ScreenShareBridge,
  TenantConfig,
} from './types.js';

interface RawTenantConfig {
  apiKeySha256?: unknown;
  apiKeySha256Env?: unknown;
  meetingIdPrefix?: unknown;
  userIdPrefix?: unknown;
  allowedOrigins?: unknown;
  logoutUrl?: unknown;
  meetingEndedCallbackUrl?: unknown;
  allowModerator?: unknown;
  allowRecording?: unknown;
  autoStartRecording?: unknown;
  allowStartStopRecording?: unknown;
  maxConcurrentMeetings?: unknown;
  maxParticipantsPerMeeting?: unknown;
  requestsPerMinute?: unknown;
  media?: {
    cameraBridge?: unknown;
    screenShareBridge?: unknown;
    audioBridge?: unknown;
  };
}

interface RawGatewayConfig {
  version?: unknown;
  tenants?: Record<string, RawTenantConfig>;
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CHECKSUM_ALGORITHMS = new Set<ChecksumAlgorithm>(['sha1', 'sha256', 'sha384', 'sha512']);
const CAMERA_BRIDGES = new Set<CameraBridge>(['bbb-webrtc-sfu', 'livekit']);
const SCREEN_SHARE_BRIDGES = new Set<ScreenShareBridge>(['bbb-webrtc-sfu', 'livekit']);
const AUDIO_BRIDGES = new Set<AudioBridge>(['bbb-webrtc-sfu', 'livekit', 'freeswitch']);

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function integerValue(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function configInteger(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function configBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalHttpsUrl(value: unknown, name: string, allowInsecureHttp: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a URL string`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain URL credentials`);
  return url.toString();
}

function parseAllowedOrigins(value: unknown, name: string, allowInsecureHttp: boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);

  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${name}[${index}] must be a string`);
    const url = new URL(entry);
    if (url.origin !== entry) throw new Error(`${name}[${index}] must be an origin without a path`);
    if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
      throw new Error(`${name}[${index}] must use HTTPS`);
    }
    return url.origin;
  });
}

function parseBridge<T extends string>(value: unknown, allowed: Set<T>, name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${name} has an unsupported value`);
  }
  return value as T;
}

function resolveApiKeyHash(
  raw: RawTenantConfig,
  environment: NodeJS.ProcessEnv,
  tenantName: string,
): string {
  const inlineHash = typeof raw.apiKeySha256 === 'string' ? raw.apiKeySha256.trim() : undefined;
  const envName = typeof raw.apiKeySha256Env === 'string' ? raw.apiKeySha256Env.trim() : undefined;

  if ((inlineHash && envName) || (!inlineHash && !envName)) {
    throw new Error(`Tenant ${tenantName} must set exactly one of apiKeySha256 or apiKeySha256Env`);
  }

  const hash = inlineHash ?? requiredEnv(environment, envName!);
  if (!SHA256_PATTERN.test(hash)) throw new Error(`Tenant ${tenantName} API key hash must be SHA-256 hex`);
  return hash.toLowerCase();
}

function parseTenant(
  id: string,
  raw: RawTenantConfig,
  environment: NodeJS.ProcessEnv,
  allowInsecureHttp: boolean,
): TenantConfig {
  if (!TENANT_ID_PATTERN.test(id)) throw new Error(`Invalid tenant ID: ${id}`);

  const meetingIdPrefix = typeof raw.meetingIdPrefix === 'string' ? raw.meetingIdPrefix : `${id}:`;
  const userIdPrefix = typeof raw.userIdPrefix === 'string' ? raw.userIdPrefix : `${id}:`;
  if (!/^[A-Za-z0-9._~:-]{1,64}$/.test(meetingIdPrefix)) {
    throw new Error(`Tenant ${id} meetingIdPrefix must use 1-64 safe identifier characters`);
  }
  if (!/^[A-Za-z0-9._~:-]{1,64}$/.test(userIdPrefix)) {
    throw new Error(`Tenant ${id} userIdPrefix must use 1-64 safe identifier characters`);
  }

  return {
    id,
    apiKeySha256: resolveApiKeyHash(raw, environment, id),
    meetingIdPrefix,
    userIdPrefix,
    allowedOrigins: parseAllowedOrigins(raw.allowedOrigins, `Tenant ${id} allowedOrigins`, allowInsecureHttp),
    logoutUrl: optionalHttpsUrl(raw.logoutUrl, `Tenant ${id} logoutUrl`, allowInsecureHttp),
    meetingEndedCallbackUrl: optionalHttpsUrl(
      raw.meetingEndedCallbackUrl,
      `Tenant ${id} meetingEndedCallbackUrl`,
      allowInsecureHttp,
    ),
    allowModerator: configBoolean(raw.allowModerator, false, `Tenant ${id} allowModerator`),
    allowRecording: configBoolean(raw.allowRecording, false, `Tenant ${id} allowRecording`),
    autoStartRecording: configBoolean(
      raw.autoStartRecording,
      false,
      `Tenant ${id} autoStartRecording`,
    ),
    allowStartStopRecording: configBoolean(
      raw.allowStartStopRecording,
      true,
      `Tenant ${id} allowStartStopRecording`,
    ),
    maxConcurrentMeetings: configInteger(
      raw.maxConcurrentMeetings,
      10,
      `Tenant ${id} maxConcurrentMeetings`,
      1,
      10000,
    ),
    maxParticipantsPerMeeting: configInteger(
      raw.maxParticipantsPerMeeting,
      100,
      `Tenant ${id} maxParticipantsPerMeeting`,
      1,
      10000,
    ),
    requestsPerMinute: configInteger(
      raw.requestsPerMinute,
      120,
      `Tenant ${id} requestsPerMinute`,
      1,
      100000,
    ),
    media: {
      cameraBridge: parseBridge(raw.media?.cameraBridge, CAMERA_BRIDGES, `Tenant ${id} cameraBridge`),
      screenShareBridge: parseBridge(
        raw.media?.screenShareBridge,
        SCREEN_SHARE_BRIDGES,
        `Tenant ${id} screenShareBridge`,
      ),
      audioBridge: parseBridge(raw.media?.audioBridge, AUDIO_BRIDGES, `Tenant ${id} audioBridge`),
    },
  };
}

export function parseConfig(raw: RawGatewayConfig, environment: NodeJS.ProcessEnv): GatewayConfig {
  if (raw.version !== 1) throw new Error('Tenant configuration version must be 1');
  if (!raw.tenants || typeof raw.tenants !== 'object') throw new Error('Tenant configuration must contain tenants');

  const allowInsecureHttp = environment.ALLOW_INSECURE_HTTP === 'true';
  const apiBaseUrl = requiredEnv(environment, 'BBB_API_BASE').replace(/\/+$/, '');
  const parsedApiBase = new URL(apiBaseUrl);
  if (parsedApiBase.protocol !== 'https:' && !(allowInsecureHttp && parsedApiBase.protocol === 'http:')) {
    throw new Error('BBB_API_BASE must use HTTPS');
  }
  if (!parsedApiBase.pathname.endsWith('/bigbluebutton/api')) {
    throw new Error('BBB_API_BASE must end with /bigbluebutton/api');
  }
  if (parsedApiBase.search || parsedApiBase.hash || parsedApiBase.username || parsedApiBase.password) {
    throw new Error('BBB_API_BASE must not contain a query, fragment, or URL credentials');
  }

  const checksumAlgorithm = (environment.BBB_CHECKSUM_ALGORITHM ?? 'sha256') as ChecksumAlgorithm;
  if (!CHECKSUM_ALGORITHMS.has(checksumAlgorithm)) {
    throw new Error('BBB_CHECKSUM_ALGORITHM must be sha1, sha256, sha384, or sha512');
  }

  const tenants = new Map<string, TenantConfig>();
  const prefixes = new Set<string>();
  for (const [id, tenant] of Object.entries(raw.tenants)) {
    const parsed = parseTenant(id, tenant, environment, allowInsecureHttp);
    if (prefixes.has(parsed.meetingIdPrefix)) throw new Error(`Duplicate meetingIdPrefix: ${parsed.meetingIdPrefix}`);
    prefixes.add(parsed.meetingIdPrefix);
    tenants.set(id, parsed);
  }
  if (tenants.size === 0) throw new Error('At least one tenant must be configured');

  return {
    host: environment.HOST?.trim() || '127.0.0.1',
    port: integerValue(environment.PORT, 3100, 'PORT', 1, 65535),
    bbb: {
      apiBaseUrl,
      sharedSecret: requiredEnv(environment, 'BBB_SECRET'),
      checksumAlgorithm,
      timeoutMs: integerValue(environment.BBB_TIMEOUT_MS, 10000, 'BBB_TIMEOUT_MS', 1000, 60000),
    },
    tenants,
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const configPath = resolve(environment.TENANT_CONFIG_FILE?.trim() || 'config/tenants.json');
  let raw: RawGatewayConfig;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as RawGatewayConfig;
  } catch (error) {
    throw new Error(`Unable to read tenant configuration ${configPath}: ${(error as Error).message}`);
  }
  return parseConfig(raw, environment);
}
