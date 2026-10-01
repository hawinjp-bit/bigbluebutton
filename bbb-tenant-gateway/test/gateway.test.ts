import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashApiKey } from '../src/auth.js';
import { BbbClient } from '../src/bbb-client.js';
import { parseConfig } from '../src/config.js';
import { namespacedId, validateExternalId } from '../src/meeting-ids.js';
import { RecordingMonitor } from '../src/recording-monitor.js';
import { hasTombstone, recordIdFor } from '../src/recordings.js';
import { createApp, createInternalApp, ownedRecording } from '../src/server.js';
import { MeetingStateStore } from '../src/state-store.js';
import type {
  BbbClientLike,
  BbbRecording,
  CreateMeetingOptions,
  CreateMeetingResult,
  GatewayConfig,
  JoinOptions,
  MeetingInfo,
  RecordingItem,
  RecordingPaths,
  RecordingsFilter,
} from '../src/types.js';
import { signWebhook, WebhookQueue, type WebhookTransport } from '../src/webhook.js';

const API_KEY = 'bbbtk_lunar-one_test-key';
const OTHER_API_KEY = 'bbbtk_other-co_test-key';
const BBB_SECRET = 'test-secret';
const WEBHOOK_SECRET = 'webhook-secret-for-tests-0123';
const WEBHOOK_URL = 'https://saas.example.com/hooks/recording';
const CREATE_TIME = '1700000000000';
const START_MS = 1_700_000_000_000;

interface Fixture {
  root: string;
  paths: RecordingPaths;
  stateDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'bbb-gateway-'));
  const paths: RecordingPaths = {
    publishedDir: join(root, 'published'),
    unpublishedDir: join(root, 'unpublished'),
    statusDir: join(root, 'recording', 'status'),
  };
  const stateDir = join(root, 'state');
  await Promise.all([
    mkdir(join(paths.publishedDir, 'video'), { recursive: true }),
    mkdir(join(paths.unpublishedDir, 'video'), { recursive: true }),
    ...['archived', 'sanity', 'processed', 'published'].map((name) =>
      mkdir(join(paths.statusDir, name), { recursive: true })),
    mkdir(stateDir, { recursive: true }),
  ]);
  return { root, paths, stateDir };
}

async function marker(fixture: Fixture, relative: string): Promise<void> {
  const [directory, file] = relative.split('/');
  await writeFile(join(fixture.paths.statusDir, directory!, file!), '');
}

function videoBytes(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = index % 251;
  return buffer;
}

async function publishVideo(
  fixture: Fixture,
  recordId: string,
  options: { size?: number; done?: boolean; unpublished?: boolean; durationMs?: number } = {},
): Promise<void> {
  const base = options.unpublished ? fixture.paths.unpublishedDir : fixture.paths.publishedDir;
  const directory = join(base, 'video', recordId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'video-0.m4v'), videoBytes(options.size ?? 4096));
  await writeFile(join(directory, 'metadata.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<recording>',
    `  <id>${recordId}</id>`,
    '  <state>available</state>',
    '  <published>true</published>',
    `  <start_time>${START_MS}</start_time>`,
    `  <end_time>${START_MS + 125_000}</end_time>`,
    '  <participants>2</participants>',
    '  <playback>',
    '    <format>video</format>',
    `    <duration>${options.durationMs ?? 123_456}</duration>`,
    '    <size>4096</size>',
    '  </playback>',
    '  <meta>',
    '    <meetingName>Room 1</meetingName>',
    '    <tenantid>lunar-one</tenantid>',
    '  </meta>',
    '</recording>',
  ].join('\n'));
  if (options.done !== false) await marker(fixture, `published/${recordId}-video.done`);
}

interface ConfigOptions {
  recordingEnabled?: boolean;
  webhook?: boolean;
  maxConcurrentDownloads?: number;
  retentionDays?: number;
}

function testConfig(fixture: Fixture, options: ConfigOptions = {}): GatewayConfig {
  const recordingEnabled = options.recordingEnabled ?? false;
  return parseConfig({
    version: 1,
    tenants: {
      'lunar-one': {
        apiKeySha256: hashApiKey(API_KEY),
        meetingIdPrefix: 'lunar-one:',
        userIdPrefix: 'lunar-one:',
        allowedOrigins: ['https://lunar-one.example.com'],
        logoutUrl: 'https://lunar-one.example.com/meetings',
        allowModerator: true,
        allowRecording: recordingEnabled,
        autoStartRecording: recordingEnabled,
        allowStartStopRecording: true,
        maxConcurrentMeetings: 2,
        maxParticipantsPerMeeting: 50,
        maxConcurrentDownloads: options.maxConcurrentDownloads ?? 4,
        recordingRetentionDays: options.retentionDays ?? 30,
        ...(options.webhook ? { recordingReadyWebhook: { url: WEBHOOK_URL, secretEnv: 'LUNAR_ONE_WEBHOOK_SECRET' } } : {}),
      },
      'other-co': {
        apiKeySha256: hashApiKey(OTHER_API_KEY),
        meetingIdPrefix: 'other-co:',
        userIdPrefix: 'other-co:',
        allowRecording: true,
        recordingRetentionDays: options.retentionDays ?? 30,
      },
    },
  }, {
    BBB_API_BASE: 'https://bbb.example.com/bigbluebutton/api',
    BBB_SECRET,
    STATE_DIRECTORY: fixture.stateDir,
    RECORDING_PUBLISHED_DIR: fixture.paths.publishedDir,
    RECORDING_UNPUBLISHED_DIR: fixture.paths.unpublishedDir,
    RECORDING_STATUS_DIR: fixture.paths.statusDir,
    RECORDING_POLL_INTERVAL_MS: '100',
    RETENTION_SWEEP_INTERVAL_MS: '100',
    WEBHOOK_RETRY_SCHEDULE_MS: '1000,5000',
    LUNAR_ONE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
}

class FakeBbbClient implements BbbClientLike {
  activeMeetingIds: string[] = [];
  created?: CreateMeetingOptions;
  joined?: JoinOptions;
  ended?: string;
  duplicate = false;
  /** createTime answered by the next create (change it to simulate a second session of the same room). */
  createTime = CREATE_TIME;
  meetingInfo = new Map<string, MeetingInfo>();
  recordings: BbbRecording[] = [];
  recordingsCalls: RecordingsFilter[] = [];
  deleted: string[] = [];
  deleteResult = true;
  onDelete?: (recordID: string) => Promise<void>;

  async createMeeting(options: CreateMeetingOptions): Promise<CreateMeetingResult> {
    this.created = options;
    if (!this.activeMeetingIds.includes(options.meetingID)) this.activeMeetingIds.push(options.meetingID);
    return { createTime: this.createTime, duplicate: this.duplicate };
  }

  buildJoinUrl(options: JoinOptions): string {
    this.joined = options;
    return 'https://bbb.example.com/bigbluebutton/api/join?checksum=signed';
  }

  async listMeetingIds(): Promise<string[]> {
    return this.activeMeetingIds;
  }

  async isMeetingRunning(meetingID: string): Promise<boolean> {
    return this.activeMeetingIds.includes(meetingID);
  }

  async endMeeting(meetingID: string): Promise<void> {
    this.ended = meetingID;
  }

  async getMeetingInfo(meetingID: string): Promise<MeetingInfo | null> {
    return this.meetingInfo.get(meetingID) ?? null;
  }

  async getRecordings(filter: RecordingsFilter): Promise<BbbRecording[]> {
    this.recordingsCalls.push(filter);
    return this.recordings.filter((recording) =>
      (filter.meetingID === undefined || recording.meetingID === filter.meetingID)
      && (filter.recordID === undefined || recording.recordID === filter.recordID)
      && (filter.metaTenantId === undefined || recording.metadata.tenantid === filter.metaTenantId)
      && (filter.states === undefined || filter.states.includes(recording.state)));
  }

  async deleteRecording(recordID: string): Promise<boolean> {
    if (this.onDelete) await this.onDelete(recordID);
    this.deleted.push(recordID);
    return this.deleteResult;
  }
}

function bbbRecording(partial: Partial<BbbRecording> & { recordID: string; meetingID: string }): BbbRecording {
  return {
    internalMeetingID: partial.recordID,
    name: 'Room',
    state: 'published',
    published: true,
    startTime: String(START_MS),
    endTime: String(START_MS + 125_000),
    participants: 2,
    metadata: { tenantid: 'lunar-one' },
    formats: [],
    ...partial,
  };
}

function meetingInfo(meetingID: string, partial: Partial<MeetingInfo> = {}): MeetingInfo {
  return {
    meetingID,
    internalMeetingID: recordIdFor(meetingID, CREATE_TIME),
    createTime: CREATE_TIME,
    running: false,
    recording: false,
    hasUserJoined: false,
    endTime: '0',
    ...partial,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function clock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

interface Gateway {
  baseUrl: string;
  internalUrl: string;
  fake: FakeBbbClient;
  fixture: Fixture;
  config: GatewayConfig;
  store: MeetingStateStore;
  webhooks: WebhookQueue;
  monitor: RecordingMonitor;
  calls: Call[];
  webhookStatuses: number[];
  time: ReturnType<typeof clock>;
}

async function withGateway(
  callback: (gateway: Gateway) => Promise<void>,
  options: ConfigOptions = {},
): Promise<void> {
  const fixture = await makeFixture();
  const config = testConfig(fixture, options);
  const fake = new FakeBbbClient();
  const time = clock(START_MS + 600_000);
  const calls: Call[] = [];
  const webhookStatuses: number[] = [200];
  const transport: WebhookTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const status = webhookStatuses.length > 1 ? webhookStatuses.shift()! : webhookStatuses[0]!;
    return { status };
  };
  const silent = (): void => undefined;
  const store = new MeetingStateStore(fixture.stateDir, time.now);
  await store.load();
  const webhooks = new WebhookQueue({
    stateDir: fixture.stateDir,
    scheduleMs: config.recording.webhookRetryScheduleMs,
    transport,
    now: time.now,
    logger: silent,
  });
  await webhooks.load();
  const monitor = new RecordingMonitor({ config, bbb: fake, store, webhooks, now: time.now, logger: silent });
  const deps = { bbb: fake, store, webhooks, monitor, now: time.now };

  const server: Server = createServer(createApp(config, deps));
  const internal: Server = createServer(createInternalApp(config, deps));
  server.listen(0, '127.0.0.1');
  internal.listen(0, '127.0.0.1');
  await Promise.all([once(server, 'listening'), once(internal, 'listening')]);
  const address = server.address();
  const internalAddress = internal.address();
  assert(address && typeof address === 'object');
  assert(internalAddress && typeof internalAddress === 'object');
  try {
    await callback({
      baseUrl: `http://127.0.0.1:${address.port}`,
      internalUrl: `http://127.0.0.1:${internalAddress.port}`,
      fake,
      fixture,
      config,
      store,
      webhooks,
      monitor,
      calls,
      webhookStatuses,
      time,
    });
  } finally {
    monitor.stop();
    server.closeAllConnections();
    internal.closeAllConnections();
    server.close();
    internal.close();
    await Promise.all([once(server, 'close'), once(internal, 'close')]);
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function authHeaders(apiKey = API_KEY, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...extra };
}

async function createMeeting(gateway: Gateway, meetingId: string, record: boolean): Promise<Response> {
  return fetch(`${gateway.baseUrl}/v1/tenants/lunar-one/meetings`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ meetingId, name: 'Room', record }),
  });
}

async function getMeeting(gateway: Gateway, meetingId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${gateway.baseUrl}/v1/tenants/lunar-one/meetings/${meetingId}`, {
    headers: authHeaders(),
  });
  assert.equal(response.status, 200);
  return await response.json() as Record<string, unknown>;
}

async function listRecordings(gateway: Gateway, meetingId: string, apiKey = API_KEY, tenant = 'lunar-one'): Promise<RecordingItem[]> {
  const response = await fetch(`${gateway.baseUrl}/v1/tenants/${tenant}/meetings/${meetingId}/recordings`, {
    headers: authHeaders(apiKey),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { items: RecordingItem[] };
  return body.items;
}

function downloadUrl(gateway: Gateway, meetingId: string, recordId: string, tenant = 'lunar-one'): string {
  return `${gateway.baseUrl}/v1/tenants/${tenant}/meetings/${meetingId}/recordings/${recordId}/download`;
}

async function errorCode(response: Response): Promise<string> {
  const body = await response.json() as { error: { code: string } };
  return body.error.code;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function jwt(payload: Record<string, unknown>, secret = BBB_SECRET, alg = 'HS256'): string {
  const header = base64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  if (alg === 'none') return `${header}.${body}.`;
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

async function postCallback(gateway: Gateway, signedParameters: string): Promise<Response> {
  return fetch(`${gateway.internalUrl}/internal/recording-ready`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ signed_parameters: signedParameters }).toString(),
  });
}

const ROOM = 'lunar-one:room-1';
const ROOM_RECORD_ID = recordIdFor(ROOM, CREATE_TIME);

// ---------------------------------------------------------------------------
// Existing behaviour
// ---------------------------------------------------------------------------

test('signs the exact documented BigBlueButton query string', () => {
  const client = new BbbClient({
    apiBaseUrl: 'https://bbb.example.com/bigbluebutton/api',
    sharedSecret: '639259d4-9dd8-4b25-bf01-95f9567eaf4b',
    checksumAlgorithm: 'sha1',
    timeoutMs: 1000,
  });
  const url = client.buildSignedUrl('create', {
    name: 'Test Meeting',
    meetingID: 'abc123',
    attendeePW: '111222',
    moderatorPW: '333444',
  });
  assert.equal(
    url,
    'https://bbb.example.com/bigbluebutton/api/create?name=Test+Meeting&meetingID=abc123&attendeePW=111222&moderatorPW=333444&checksum=1fcbb0c4fc1f039f73aa6d697d2db9ba7f803f17',
  );
});

test('validates and namespaces external identifiers', () => {
  assert.equal(validateExternalId('course-42.1', 'meetingId'), 'course-42.1');
  assert.equal(namespacedId('lunar-one:', 'course-42.1'), 'lunar-one:course-42.1');
  assert.throws(() => validateExternalId('../room', 'meetingId'));
});

test('requires the tenant API key', async () => {
  await withGateway(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 401);
    assert.equal(await errorCode(response), 'unauthorized');
  });
});

test('creates a namespaced meeting and returns createTime', async () => {
  await withGateway(async ({ baseUrl, fake, store }) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: authHeaders(API_KEY, { origin: 'https://lunar-one.example.com' }),
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://lunar-one.example.com');
    assert.deepEqual(await response.json(), {
      meetingId: 'room-1',
      createTime: CREATE_TIME,
      created: true,
      record: false,
    });
    assert.equal(fake.created?.meetingID, ROOM);
    assert.equal(fake.created?.tenantId, 'lunar-one');
    assert.equal(fake.created?.maxParticipants, 50);
    assert.equal(fake.created?.recordingReadyUrl, undefined);
    const stored = store.get('lunar-one', 'room-1');
    assert.equal(stored?.record, false);
    assert.equal(stored?.sessions[0]?.recordId, ROOM_RECORD_ID);
  });
});

test('treats creation of an active tenant meeting as idempotent', async () => {
  await withGateway(async ({ baseUrl, fake }) => {
    fake.activeMeetingIds = [ROOM];
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { created: boolean };
    assert.equal(body.created, false);
  });
});

test('rejects an untrusted browser origin', async () => {
  await withGateway(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: authHeaders(API_KEY, { origin: 'https://attacker.example.com' }),
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), 'origin_not_allowed');
  });
});

test('enforces the tenant recording policy', async () => {
  await withGateway(async (gateway) => {
    const response = await createMeeting(gateway, 'room-1', true);
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), 'recording_not_allowed');
    assert.equal(gateway.store.get('lunar-one', 'room-1'), undefined);
  });
});

test('applies the tenant automatic recording policy', async () => {
  await withGateway(async (gateway) => {
    const response = await createMeeting(gateway, 'recorded-room', true);
    assert.equal(response.status, 201);
    assert.equal(gateway.fake.created?.record, true);
    assert.equal(gateway.fake.created?.autoStartRecording, true);
    assert.equal(gateway.fake.created?.allowStartStopRecording, true);
    assert.equal(gateway.fake.created?.recordingReadyUrl, gateway.config.recording.readyCallbackUrl);
  }, { recordingEnabled: true });
});

test('issues a join URL with namespaced meeting and user IDs', async () => {
  await withGateway(async ({ baseUrl, fake }) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings/room-1/join`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        createTime: CREATE_TIME,
        userId: 'user-1',
        displayName: 'Ada Lovelace',
        role: 'MODERATOR',
        autoJoinAudio: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(fake.joined?.meetingID, ROOM);
    assert.equal(fake.joined?.userID, 'lunar-one:user-1');
    assert.equal(fake.joined?.role, 'MODERATOR');
    assert.equal(fake.joined?.autoJoinAudio, true);
  });
});

test('answers 413 with the standard error shape for oversized bodies', async () => {
  await withGateway(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: authHeaders(API_KEY, { 'x-request-id': 'big-body-1' }),
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1', padding: 'x'.repeat(40 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: { code: 'payload_too_large', message: 'Request body is too large', requestId: 'big-body-1' },
    });

    const badCharset = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: authHeaders(API_KEY, { 'content-type': 'application/json; charset=iso-8859-1' }),
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(badCharset.status, 415);
    assert.equal(await errorCode(badCharset), 'unsupported_media_type');

    const badJson = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{"meetingId":',
    });
    assert.equal(badJson.status, 400);
    assert.equal(await errorCode(badJson), 'invalid_json');
  });
});

test('enforces the concurrent meeting limit', async () => {
  await withGateway(async ({ baseUrl, fake }) => {
    fake.activeMeetingIds = ['lunar-one:room-a', 'lunar-one:room-b', 'another:room'];
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ meetingId: 'room-c', name: 'Room C' }),
    });
    assert.equal(response.status, 409);
    assert.equal(await errorCode(response), 'meeting_limit_reached');
  });
});

// ---------------------------------------------------------------------------
// POST /meetings: record flag
// ---------------------------------------------------------------------------

test('create returns the applied record flag for new and duplicate meetings', async () => {
  await withGateway(async (gateway) => {
    const first = await createMeeting(gateway, 'room-1', true);
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { meetingId: 'room-1', createTime: CREATE_TIME, created: true, record: true });
    assert.equal(gateway.store.get('lunar-one', 'room-1')?.record, true);

    // BBB answers duplicateWarning although the pre-check did not list the meeting (race): created=false,
    // and the record flag comes from getMeetingInfo rather than from the request.
    gateway.fake.activeMeetingIds = [];
    gateway.fake.duplicate = true;
    gateway.fake.meetingInfo.set(ROOM, meetingInfo(ROOM, { recording: true }));
    const second = await createMeeting(gateway, 'room-1', false);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { meetingId: 'room-1', createTime: CREATE_TIME, created: false, record: true });

    // Meeting gone from BBB: the stored flag wins over the requested one.
    gateway.fake.meetingInfo.clear();
    const third = await createMeeting(gateway, 'room-1', false);
    assert.equal(third.status, 200);
    const body = await third.json() as { created: boolean; record: boolean };
    assert.equal(body.created, false);
    assert.equal(body.record, true);
    assert.equal(gateway.store.get('lunar-one', 'room-1')?.sessions.length, 1);
  }, { recordingEnabled: true });
});

// ---------------------------------------------------------------------------
// GET /meetings/{id}
// ---------------------------------------------------------------------------

test('GET meeting reports the recording state while the meeting exists', async () => {
  await withGateway(async (gateway) => {
    gateway.fake.meetingInfo.set(ROOM, meetingInfo(ROOM, { recording: true, hasUserJoined: false }));
    assert.deepEqual(await getMeeting(gateway, 'room-1'), {
      meetingId: 'room-1',
      running: false,
      record: true,
      recording: { state: 'none', recordId: ROOM_RECORD_ID },
    });
    assert.equal(gateway.store.get('lunar-one', 'room-1')?.sessions[0]?.recordId, ROOM_RECORD_ID);

    gateway.fake.meetingInfo.set(ROOM, meetingInfo(ROOM, { recording: true, hasUserJoined: true, running: true }));
    const body = await getMeeting(gateway, 'room-1');
    assert.equal(body.running, true);
    assert.deepEqual(body.recording, { state: 'recording', recordId: ROOM_RECORD_ID });
  }, { recordingEnabled: true });
});

test('GET meeting classifies a finished meeting from markers, files and tombstones', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    const recordId = ROOM_RECORD_ID;

    assert.deepEqual((await getMeeting(gateway, 'room-1')).recording, { state: 'processing', recordId });

    await marker(gateway.fixture, `processed/${recordId}-presentation.fail`);
    assert.deepEqual((await getMeeting(gateway, 'room-1')).recording, { state: 'processing', recordId });

    await marker(gateway.fixture, `archived/${recordId}.norecord`);
    assert.deepEqual((await getMeeting(gateway, 'room-1')).recording, {
      state: 'none',
      recordId,
      reason: 'no_recording_marks',
    });
    await rm(join(gateway.fixture.paths.statusDir, 'archived', `${recordId}.norecord`));

    await marker(gateway.fixture, `processed/${recordId}-video.fail`);
    assert.deepEqual((await getMeeting(gateway, 'room-1')).recording, {
      state: 'failed',
      recordId,
      reason: `processed/${recordId}-video.fail`,
    });
    await rm(join(gateway.fixture.paths.statusDir, 'processed', `${recordId}-video.fail`));

    await publishVideo(gateway.fixture, recordId);
    const ready = await getMeeting(gateway, 'room-1');
    assert.equal(ready.record, true);
    assert.deepEqual(ready.recording, { state: 'ready', recordId });

    await gateway.monitor.deleteRecording(gateway.config.tenants.get('lunar-one')!, 'room-1', recordId, 'deleted');
    assert.deepEqual((await getMeeting(gateway, 'room-1')).recording, { state: 'none', recordId, reason: 'deleted' });
  }, { recordingEnabled: true });
});

test('GET meeting falls back to BigBlueButton recordings when the store is empty', async () => {
  await withGateway(async (gateway) => {
    // Both spoofed entries are NEWER than the owned one: "latest" must only be chosen among owned entries.
    const spoofedTenant = recordIdFor(ROOM, '1700000009999');
    const otherMeeting = recordIdFor('lunar-one:room-2', '1700000008888');
    gateway.fake.recordings = [
      bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: ROOM }),
      bbbRecording({
        recordID: spoofedTenant,
        meetingID: ROOM,
        startTime: String(START_MS + 9999),
        metadata: { tenantid: 'other-co' },
      }),
      bbbRecording({ recordID: otherMeeting, meetingID: 'lunar-one:room-2', startTime: String(START_MS + 8888) }),
    ];
    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    await publishVideo(gateway.fixture, spoofedTenant);
    await publishVideo(gateway.fixture, otherMeeting);
    assert.deepEqual(await getMeeting(gateway, 'room-1'), {
      meetingId: 'room-1',
      running: false,
      record: null,
      recording: { state: 'ready', recordId: ROOM_RECORD_ID },
    });
  });
});

test('ownedRecording requires the meeting ID, the tenantid metadata and a well-formed id', () => {
  const tenant = { id: 'lunar-one' };
  assert.equal(ownedRecording(bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: ROOM }), tenant, ROOM), true);
  assert.equal(
    ownedRecording(bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: ROOM, metadata: { tenantid: 'other-co' } }), tenant, ROOM),
    false,
    'tenantid of another tenant',
  );
  assert.equal(
    ownedRecording(bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: ROOM, metadata: {} }), tenant, ROOM),
    false,
    'tenantid missing',
  );
  assert.equal(
    ownedRecording(bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: ROOM, metadata: { tenantId: 'lunar-one' } }), tenant, ROOM),
    false,
    'only the lowercased key counts',
  );
  assert.equal(
    ownedRecording(bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: 'lunar-one:room-2' }), tenant, ROOM),
    false,
    'another meeting of the same tenant',
  );
  assert.equal(
    ownedRecording(bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: 'other-co:room-1' }), tenant, ROOM),
    false,
    'same external id under another prefix',
  );
  assert.equal(ownedRecording(bbbRecording({ recordID: '../etc', meetingID: ROOM }), tenant, ROOM), false, 'malformed id');
});

// ---------------------------------------------------------------------------
// GET /recordings
// ---------------------------------------------------------------------------

test('lists recordings with ownership filtering and media fields', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    assert.deepEqual(await listRecordings(gateway, 'room-1'), []);

    const foreign = recordIdFor('other-co:room-1', CREATE_TIME);
    // Listed under lunar-one's meeting ID but stamped with another tenant's metadata: never shown.
    const spoofed = recordIdFor(ROOM, '1700000009999');
    gateway.fake.recordings = [
      bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: ROOM }),
      bbbRecording({ recordID: foreign, meetingID: 'other-co:room-1', metadata: { tenantid: 'other-co' } }),
      bbbRecording({ recordID: spoofed, meetingID: ROOM, startTime: String(START_MS + 9999), metadata: { tenantid: 'other-co' } }),
    ];
    await publishVideo(gateway.fixture, ROOM_RECORD_ID, { durationMs: 123_456 });
    await publishVideo(gateway.fixture, foreign);
    await publishVideo(gateway.fixture, spoofed);
    await marker(gateway.fixture, `processed/${ROOM_RECORD_ID}-presentation.fail`);

    const items = await listRecordings(gateway, 'room-1');
    assert.deepEqual(items.map((entry) => entry.recordId), [ROOM_RECORD_ID], 'the spoofed listing is omitted');
    const item = items[0]!;
    assert.equal(item.recordId, ROOM_RECORD_ID);
    assert.equal(item.meetingId, 'room-1');
    assert.equal(item.state, 'ready');
    assert.equal(item.startedAt, new Date(START_MS).toISOString());
    assert.equal(item.endedAt, new Date(START_MS + 125_000).toISOString());
    assert.equal(item.durationSec, 123);
    assert.equal(item.mime, 'video/mp4');
    assert.equal(item.sizeBytes, 4096);
    assert.equal(item.filename, `room-1-${ROOM_RECORD_ID}.mp4`);
    assert.equal(
      item.downloadUrl,
      `https://meet.ooak.jp/tenant-api/v1/tenants/lunar-one/meetings/room-1/recordings/${ROOM_RECORD_ID}/download`,
    );
    assert.equal(item.playbackUrl, null);
    assert.ok(item.createdAt);
    assert.equal(item.expiresAt, new Date(START_MS + 125_000 + 30 * 86_400_000).toISOString());
    assert.equal(item.error, null);

    // The other tenant only ever sees its own recording of its own room-1, never lunar-one's
    // (nor the spoofed entry, which carries its tenantid but lunar-one's meeting ID).
    const otherItems = await listRecordings(gateway, 'room-1', OTHER_API_KEY, 'other-co');
    assert.deepEqual(otherItems.map((entry) => entry.recordId), [foreign]);
    assert.ok(otherItems[0]?.downloadUrl?.includes('/tenants/other-co/'));
  }, { recordingEnabled: true });
});

test('a published listing stands in for status markers that BigBlueButton has already purged', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    // The video file is there but the 14-day cron removed every status marker before the gateway saw them.
    await publishVideo(gateway.fixture, ROOM_RECORD_ID, { done: false });
    const url = downloadUrl(gateway, 'room-1', ROOM_RECORD_ID);

    assert.equal((await listRecordings(gateway, 'room-1'))[0]?.state, 'processing');
    assert.equal((await fetch(url, { headers: authHeaders() })).status, 409);

    gateway.fake.recordings = [bbbRecording({ recordID: ROOM_RECORD_ID, meetingID: ROOM, state: 'published' })];
    assert.equal((await listRecordings(gateway, 'room-1'))[0]?.state, 'ready');
    const download = await fetch(url, { headers: authHeaders() });
    assert.equal(download.status, 200);
    assert.equal((await download.arrayBuffer()).byteLength, 4096);
    assert.ok(
      gateway.fake.recordingsCalls.some((call) => call.recordID === ROOM_RECORD_ID),
      'the stored session without an outcome is cross-checked with BBB',
    );

    const deleted = await fetch(`${gateway.baseUrl}/v1/tenants/lunar-one/meetings/room-1/recordings/${ROOM_RECORD_ID}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.equal(deleted.status, 202);
  }, { recordingEnabled: true });
});

test('lists a meeting without recording marks as a failed item', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await marker(gateway.fixture, `archived/${ROOM_RECORD_ID}.norecord`);
    const items = await listRecordings(gateway, 'room-1');
    assert.equal(items.length, 1);
    assert.equal(items[0]?.state, 'failed');
    assert.equal(items[0]?.error, 'no_recording_marks');
    assert.equal(items[0]?.downloadUrl, null);
    assert.equal(items[0]?.sizeBytes, null);

    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'no_recording');
    await rm(join(gateway.fixture.paths.statusDir, 'archived', `${ROOM_RECORD_ID}.norecord`));
    assert.equal((await listRecordings(gateway, 'room-1'))[0]?.error, 'no_recording_marks');
  }, { recordingEnabled: true });
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

test('streams a ready recording with download, range and HEAD semantics', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await publishVideo(gateway.fixture, ROOM_RECORD_ID, { size: 4096 });
    const url = downloadUrl(gateway, 'room-1', ROOM_RECORD_ID);

    const full = await fetch(url, { headers: authHeaders() });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('content-length'), '4096');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(full.headers.get('content-disposition'), `attachment; filename="room-1-${ROOM_RECORD_ID}.mp4"`);
    assert.match(full.headers.get('etag') ?? '', /^"4096-\d+(\.\d+)?"$/);
    const body = Buffer.from(await full.arrayBuffer());
    assert.equal(body.length, 4096);
    assert.ok(body.equals(videoBytes(4096)));

    const partial = await fetch(url, { headers: authHeaders(API_KEY, { range: 'bytes=100-199' }) });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 100-199/4096');
    assert.equal(partial.headers.get('content-length'), '100');
    const slice = Buffer.from(await partial.arrayBuffer());
    assert.ok(slice.equals(videoBytes(4096).subarray(100, 200)));

    const head = await fetch(url, { method: 'HEAD', headers: authHeaders() });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '4096');
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const unsatisfiable = await fetch(url, { headers: authHeaders(API_KEY, { range: 'bytes=5000-' }) });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */4096');
    assert.equal(await errorCode(unsatisfiable), 'range_not_satisfiable');
  }, { recordingEnabled: true });
});

test('refuses downloads that are not ready, not owned or malformed', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    const url = downloadUrl(gateway, 'room-1', ROOM_RECORD_ID);

    const processing = await fetch(url, { headers: authHeaders() });
    assert.equal(processing.status, 409);
    assert.equal(await errorCode(processing), 'recording_not_ready');

    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    const foreign = await fetch(downloadUrl(gateway, 'room-1', ROOM_RECORD_ID, 'other-co'), {
      headers: authHeaders(OTHER_API_KEY),
    });
    assert.equal(foreign.status, 404);
    assert.equal(await errorCode(foreign), 'recording_not_found');

    const wrongMeeting = await fetch(downloadUrl(gateway, 'room-2', ROOM_RECORD_ID), { headers: authHeaders() });
    assert.equal(wrongMeeting.status, 404);

    const malformed = await fetch(downloadUrl(gateway, 'room-1', '..%2F..%2Fetc%2Fpasswd'), { headers: authHeaders() });
    assert.equal(malformed.status, 404);
    assert.equal(await errorCode(malformed), 'recording_not_found');

    const unknown = await fetch(downloadUrl(gateway, 'room-1', `${'b'.repeat(40)}-1700000000000`), {
      headers: authHeaders(),
    });
    assert.equal(unknown.status, 404);
  }, { recordingEnabled: true });
});

test('caps concurrent downloads per tenant', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await publishVideo(gateway.fixture, ROOM_RECORD_ID, { size: 32 * 1024 * 1024 });
    const url = downloadUrl(gateway, 'room-1', ROOM_RECORD_ID);

    const first = await fetch(url, { headers: authHeaders() });
    assert.equal(first.status, 200);
    try {
      const second = await fetch(url, { method: 'HEAD', headers: authHeaders() });
      assert.equal(second.status, 429);
      assert.equal(second.headers.get('retry-after'), '5');
    } finally {
      await first.body?.cancel();
    }

    let released = 0;
    for (let attempt = 0; attempt < 100 && released !== 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      released = (await fetch(url, { method: 'HEAD', headers: authHeaders() })).status;
    }
    assert.equal(released, 200);
  }, { recordingEnabled: true, maxConcurrentDownloads: 1 });
});

// ---------------------------------------------------------------------------
// DELETE /recordings/{id}
// ---------------------------------------------------------------------------

test('deletes a recording tombstone-first and hides it afterwards', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    const url = `${gateway.baseUrl}/v1/tenants/lunar-one/meetings/room-1/recordings/${ROOM_RECORD_ID}`;

    let tombstoneSeenAtDelete = false;
    gateway.fake.onDelete = async () => {
      tombstoneSeenAtDelete = await hasTombstone(gateway.fixture.stateDir, ROOM_RECORD_ID);
    };
    const response = await fetch(url, { method: 'DELETE', headers: authHeaders() });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { recordId: ROOM_RECORD_ID, status: 'deleting' });
    assert.deepEqual(gateway.fake.deleted, [ROOM_RECORD_ID]);
    assert.equal(tombstoneSeenAtDelete, true);
    const tombstone = JSON.parse(await readFile(join(gateway.fixture.stateDir, 'purge', `${ROOM_RECORD_ID}.json`), 'utf8'));
    assert.deepEqual(tombstone, {
      recordId: ROOM_RECORD_ID,
      tenantId: 'lunar-one',
      meetingId: 'room-1',
      requestedAt: gateway.time.now().toISOString(),
    });
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'deleted');

    const again = await fetch(url, { method: 'DELETE', headers: authHeaders() });
    assert.equal(again.status, 404);
    const download = await fetch(downloadUrl(gateway, 'room-1', ROOM_RECORD_ID), { headers: authHeaders() });
    assert.equal(download.status, 404);
    assert.deepEqual(await listRecordings(gateway, 'room-1'), []);
  }, { recordingEnabled: true });
});

test('the poller re-issues BigBlueButton deletes while a deleted id is still public', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    const url = `${gateway.baseUrl}/v1/tenants/lunar-one/meetings/room-1/recordings/${ROOM_RECORD_ID}`;
    const tombstone = join(gateway.fixture.stateDir, 'purge', `${ROOM_RECORD_ID}.json`);

    // BBB answered notFound (e.g. only the presentation format existed, still processing).
    gateway.fake.deleteResult = false;
    assert.equal((await fetch(url, { method: 'DELETE', headers: authHeaders() })).status, 202);
    assert.deepEqual(gateway.fake.deleted, [ROOM_RECORD_ID]);
    // The fake does not move files: emulate BBB's move of the video format out of published/.
    await rm(join(gateway.fixture.paths.publishedDir, 'video', ROOM_RECORD_ID), { recursive: true });

    // Nothing public any more: no retry.
    await gateway.monitor.pollOnce();
    assert.equal(gateway.fake.deleted.length, 1);

    // A late-published presentation format appears after the root purge consumed the tombstone.
    await mkdir(join(gateway.fixture.paths.publishedDir, 'presentation', ROOM_RECORD_ID), { recursive: true });
    await rm(tombstone);
    gateway.fake.deleteResult = true;
    await gateway.monitor.pollOnce();
    assert.deepEqual(gateway.fake.deleted, [ROOM_RECORD_ID, ROOM_RECORD_ID]);
    assert.equal(await hasTombstone(gateway.fixture.stateDir, ROOM_RECORD_ID), true, 'tombstone recreated');
    assert.deepEqual(JSON.parse(await readFile(tombstone, 'utf8')), {
      recordId: ROOM_RECORD_ID,
      tenantId: 'lunar-one',
      meetingId: 'room-1',
      requestedAt: gateway.time.now().toISOString(),
    });

    // Still public (BBB down / rejected): retried every tick, even when the call throws.
    gateway.fake.onDelete = async () => {
      throw new Error('bbb unreachable');
    };
    await gateway.monitor.pollOnce();
    assert.equal(gateway.fake.deleted.length, 2, 'the throwing call did not record a delete');
    gateway.fake.onDelete = undefined;
    await gateway.monitor.pollOnce();
    assert.equal(gateway.fake.deleted.length, 3);

    // Gone from the public tree: quiet again, and the recording stays hidden from the API.
    await rm(join(gateway.fixture.paths.publishedDir, 'presentation', ROOM_RECORD_ID), { recursive: true });
    await gateway.monitor.pollOnce();
    assert.equal(gateway.fake.deleted.length, 3);
    assert.deepEqual(await listRecordings(gateway, 'room-1'), []);
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'deleted');
  }, { recordingEnabled: true });
});

test('the poller tolerates missing or unreadable public trees when retrying deletes', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await marker(gateway.fixture, `archived/${ROOM_RECORD_ID}.fail`);
    assert.equal(
      (await fetch(`${gateway.baseUrl}/v1/tenants/lunar-one/meetings/room-1/recordings/${ROOM_RECORD_ID}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })).status,
      202,
    );
    // No published/ tree at all (ENOENT) and an unpublished/ tree that cannot be listed (a file):
    // nothing to retry, no error, and the poller keeps working.
    await rm(gateway.fixture.paths.publishedDir, { recursive: true, force: true });
    await rm(gateway.fixture.paths.unpublishedDir, { recursive: true, force: true });
    await writeFile(gateway.fixture.paths.unpublishedDir, 'not a directory');
    await gateway.monitor.pollOnce();
    assert.deepEqual(gateway.fake.deleted, [ROOM_RECORD_ID]);
    assert.equal((await stat(gateway.fixture.paths.unpublishedDir)).isFile(), true);
  }, { recordingEnabled: true });
});

test('DELETE refuses processing recordings and tolerates BigBlueButton notFound', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    const url = `${gateway.baseUrl}/v1/tenants/lunar-one/meetings/room-1/recordings/${ROOM_RECORD_ID}`;

    const processing = await fetch(url, { method: 'DELETE', headers: authHeaders() });
    assert.equal(processing.status, 409);
    assert.equal(await errorCode(processing), 'recording_not_ready');
    assert.equal(await hasTombstone(gateway.fixture.stateDir, ROOM_RECORD_ID), false);

    await marker(gateway.fixture, `archived/${ROOM_RECORD_ID}.fail`);
    gateway.fake.deleteResult = false;
    const failed = await fetch(url, { method: 'DELETE', headers: authHeaders() });
    assert.equal(failed.status, 202);
    assert.equal(await hasTombstone(gateway.fixture.stateDir, ROOM_RECORD_ID), true);
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'deleted');
  }, { recordingEnabled: true });
});

test('DELETE answers 503 and touches nothing when the tombstone cannot be written', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    // A regular file in place of the purge directory makes mkdir/rename fail on every platform.
    await writeFile(join(gateway.fixture.stateDir, 'purge'), 'not a directory');

    const url = `${gateway.baseUrl}/v1/tenants/lunar-one/meetings/room-1/recordings/${ROOM_RECORD_ID}`;
    const response = await fetch(url, { method: 'DELETE', headers: authHeaders() });
    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), 'recording_delete_unavailable');
    assert.deepEqual(gateway.fake.deleted, []);
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, undefined);
  }, { recordingEnabled: true });
});

// ---------------------------------------------------------------------------
// Internal callback
// ---------------------------------------------------------------------------

test('internal callback rejects bad signatures and alg none', async () => {
  await withGateway(async (gateway) => {
    const payload = { meeting_id: ROOM, record_id: ROOM_RECORD_ID };
    const wrongSecret = await postCallback(gateway, jwt(payload, 'another-secret'));
    assert.equal(wrongSecret.status, 401);
    assert.equal(await errorCode(wrongSecret), 'unauthorized');

    const none = await postCallback(gateway, jwt(payload, BBB_SECRET, 'none'));
    assert.equal(none.status, 401);

    const missing = await fetch(`${gateway.internalUrl}/internal/recording-ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'foo=bar',
    });
    assert.equal(missing.status, 401);
    assert.equal(gateway.store.listAll().length, 0);
  }, { recordingEnabled: true, webhook: true });
});

test('internal callback upserts the session and triggers a signed webhook', async () => {
  await withGateway(async (gateway) => {
    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    const response = await postCallback(gateway, jwt({ meeting_id: ROOM, record_id: ROOM_RECORD_ID }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const found = gateway.store.findByRecordId(ROOM_RECORD_ID);
    assert.equal(found?.meeting.tenantId, 'lunar-one');
    assert.equal(found?.meeting.meetingId, 'room-1');
    assert.equal(found?.meeting.record, true);
    assert.equal(found?.session.createTime, CREATE_TIME);
    assert.equal(found?.session.outcome, 'ready');
    assert.equal(found?.session.notifiedReady, true);

    assert.equal(gateway.calls.length, 1);
    const call = gateway.calls[0]!;
    assert.equal(call.url, WEBHOOK_URL);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers['X-Gateway-Event-Id'], `${ROOM_RECORD_ID}:recording.ready`);
    const timestamp = Number(call.headers['X-Gateway-Timestamp']);
    assert.equal(timestamp, Math.floor(gateway.time.now().getTime() / 1000));
    assert.equal(call.headers['X-Gateway-Signature'], signWebhook(WEBHOOK_SECRET, timestamp, call.body));
    assert.deepEqual(JSON.parse(call.body), {
      event: 'recording.ready',
      tenant: 'lunar-one',
      meetingId: 'room-1',
      recordId: ROOM_RECORD_ID,
      occurredAt: gateway.time.now().toISOString(),
    });
    assert.equal(gateway.webhooks.pending().length, 0);
  }, { recordingEnabled: true, webhook: true });
});

test('internal callback ignores unknown tenants and the public app never serves it', async () => {
  await withGateway(async (gateway) => {
    const unknown = await postCallback(gateway, jwt({ meeting_id: 'nobody:room-1', record_id: ROOM_RECORD_ID }));
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { ok: true });
    assert.equal(gateway.store.listAll().length, 0);
    assert.equal(gateway.calls.length, 0);

    const viaPublic = await fetch(`${gateway.baseUrl}/internal/recording-ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ signed_parameters: jwt({ meeting_id: ROOM, record_id: ROOM_RECORD_ID }) }).toString(),
    });
    assert.equal(viaPublic.status, 404);
    assert.equal(await errorCode(viaPublic), 'not_found');

    const wrongCase = await fetch(`${gateway.internalUrl}/INTERNAL/recording-ready`, { method: 'POST' });
    assert.equal(wrongCase.status, 404);
  }, { recordingEnabled: true, webhook: true });
});

// ---------------------------------------------------------------------------
// Monitor: webhooks, timeouts, retention
// ---------------------------------------------------------------------------

test('retries a failed webhook on schedule and sends recording.ready only once', async () => {
  await withGateway(async (gateway) => {
    gateway.webhookStatuses.splice(0, gateway.webhookStatuses.length, 500, 200);
    await createMeeting(gateway, 'room-1', true);
    await publishVideo(gateway.fixture, ROOM_RECORD_ID);

    await gateway.monitor.pollOnce();
    assert.equal(gateway.calls.length, 1);
    assert.equal(gateway.webhooks.pending().length, 1);
    assert.equal(gateway.webhooks.pending()[0]?.attempts, 1);

    await gateway.monitor.pollOnce();
    assert.equal(gateway.calls.length, 1, 'not due yet');

    gateway.time.advance(1000);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.calls.length, 2);
    assert.equal(gateway.webhooks.pending().length, 0);
    assert.equal(JSON.parse(gateway.calls[1]!.body).event, 'recording.ready');

    // Later failure markers never produce a recording.failed after recording.ready.
    await marker(gateway.fixture, `published/${ROOM_RECORD_ID}-video.fail`);
    await gateway.monitor.checkNow(ROOM_RECORD_ID);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.calls.length, 2);
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'ready');
  }, { recordingEnabled: true, webhook: true });
});

test('reports failed recordings and times out silent sessions', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await marker(gateway.fixture, `sanity/${ROOM_RECORD_ID}.fail`);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.calls.length, 1);
    const failed = JSON.parse(gateway.calls[0]!.body) as { event: string; error: string };
    assert.equal(failed.event, 'recording.failed');
    assert.equal(failed.error, `sanity/${ROOM_RECORD_ID}.fail`);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.calls.length, 1, 'recording.failed is sent once');

    const quiet = 'lunar-one:room-2';
    const quietId = recordIdFor(quiet, CREATE_TIME);
    await createMeeting(gateway, 'room-2', true);
    gateway.time.advance(47 * 3_600_000);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(quietId)?.session.outcome, undefined);

    gateway.time.advance(2 * 3_600_000);
    gateway.fake.recordings = [bbbRecording({ recordID: quietId, meetingID: quiet, state: 'processing' })];
    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(quietId)?.session.outcome, undefined, 'BBB still lists it');

    gateway.fake.recordings = [];
    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(quietId)?.session.outcome, 'timeout');
    assert.equal(gateway.calls.length, 2);
    assert.equal((JSON.parse(gateway.calls[1]!.body) as { error: string }).error, 'timeout');
    const items = await listRecordings(gateway, 'room-2');
    assert.equal(items[0]?.state, 'failed');
    assert.equal(items[0]?.error, 'timeout');
  }, { recordingEnabled: true, webhook: true });
});

test('a later record=false session does not stop monitoring an earlier recorded one', async () => {
  await withGateway(async (gateway) => {
    const laterCreateTime = '1700000600000';
    const laterId = recordIdFor(ROOM, laterCreateTime);
    assert.equal((await createMeeting(gateway, 'room-1', true)).status, 201);
    gateway.fake.activeMeetingIds = [];
    gateway.fake.createTime = laterCreateTime;
    assert.equal((await createMeeting(gateway, 'room-1', false)).status, 201);

    const stored = gateway.store.get('lunar-one', 'room-1');
    assert.equal(stored?.record, false, 'the meeting flag is the latest value');
    assert.deepEqual(stored?.sessions.map((session) => [session.recordId, session.record]), [[ROOM_RECORD_ID, true], [laterId, false]]);

    // The gone-meeting view points at the recorded session, not the newest one.
    assert.deepEqual(await getMeeting(gateway, 'room-1'), {
      meetingId: 'room-1',
      running: false,
      record: false,
      recording: { state: 'processing', recordId: ROOM_RECORD_ID },
    });

    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'ready');
    assert.equal(gateway.calls.length, 1);
    assert.equal((JSON.parse(gateway.calls[0]!.body) as { recordId: string }).recordId, ROOM_RECORD_ID);

    // The unrecorded session is never evaluated: no timeout, no webhook.
    gateway.time.advance(49 * 3_600_000);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(laterId)?.session.outcome, undefined);
    assert.equal(gateway.calls.length, 1);
    assert.deepEqual((await listRecordings(gateway, 'room-1')).map((item) => item.recordId), [ROOM_RECORD_ID]);
  }, { recordingEnabled: true, webhook: true });
});

test('an earlier record=false session never times out when a later one is recorded', async () => {
  await withGateway(async (gateway) => {
    const laterCreateTime = '1700000600000';
    const laterId = recordIdFor(ROOM, laterCreateTime);
    assert.equal((await createMeeting(gateway, 'room-1', false)).status, 201);
    gateway.fake.activeMeetingIds = [];
    gateway.fake.createTime = laterCreateTime;
    assert.equal((await createMeeting(gateway, 'room-1', true)).status, 201);
    assert.equal(gateway.store.get('lunar-one', 'room-1')?.record, true);
    assert.deepEqual((await getMeeting(gateway, 'room-1')).recording, { state: 'processing', recordId: laterId });

    gateway.time.advance(49 * 3_600_000);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, undefined, 'record=false: never timed out');
    assert.equal(gateway.store.findByRecordId(laterId)?.session.outcome, 'timeout');
    assert.equal(gateway.calls.length, 1);
    assert.deepEqual(JSON.parse(gateway.calls[0]!.body), {
      event: 'recording.failed',
      tenant: 'lunar-one',
      meetingId: 'room-1',
      recordId: laterId,
      occurredAt: gateway.time.now().toISOString(),
      error: 'timeout',
    });

    // The BBB callback for a session we already know keeps its stored flag (it is not flipped to true).
    await publishVideo(gateway.fixture, ROOM_RECORD_ID);
    const callback = await postCallback(gateway, jwt({ meeting_id: ROOM, record_id: ROOM_RECORD_ID }));
    assert.equal(callback.status, 200);
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.record, false);
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, undefined);
    assert.equal(gateway.calls.length, 1);
  }, { recordingEnabled: true, webhook: true });
});

test('retention sweep expires only old recordings of the right tenant', async () => {
  await withGateway(async (gateway) => {
    const old = recordIdFor('lunar-one:old', CREATE_TIME);
    const young = recordIdFor('lunar-one:young', CREATE_TIME);
    const foreign = recordIdFor('other-co:old', CREATE_TIME);
    const spoofed = recordIdFor('lunar-one:spoofed', CREATE_TIME);
    const nowMs = gateway.time.now().getTime();
    gateway.fake.recordings = [
      bbbRecording({ recordID: old, meetingID: 'lunar-one:old', endTime: String(nowMs - 3 * 86_400_000) }),
      bbbRecording({ recordID: young, meetingID: 'lunar-one:young', endTime: String(nowMs - 3_600_000) }),
      bbbRecording({
        recordID: foreign,
        meetingID: 'other-co:old',
        endTime: String(nowMs - 3 * 86_400_000),
        metadata: { tenantid: 'other-co' },
      }),
      bbbRecording({
        recordID: spoofed,
        meetingID: 'lunar-one:spoofed',
        endTime: String(nowMs - 3 * 86_400_000),
        metadata: { tenantid: 'other-co' },
      }),
    ];
    for (const id of [old, young, foreign, spoofed]) await publishVideo(gateway.fixture, id);

    await gateway.monitor.sweepOnce();
    assert.deepEqual(gateway.fake.deleted.sort(), [foreign, old].sort());
    assert.equal(await hasTombstone(gateway.fixture.stateDir, old), true);
    assert.equal(await hasTombstone(gateway.fixture.stateDir, young), false);
    assert.equal(await hasTombstone(gateway.fixture.stateDir, spoofed), false);
    const expired = gateway.store.findByRecordId(old);
    assert.equal(expired?.meeting.tenantId, 'lunar-one');
    assert.equal(expired?.meeting.meetingId, 'old');
    assert.equal(expired?.session.outcome, 'expired');
    const foreignRecord = gateway.store.findByRecordId(foreign);
    assert.equal(foreignRecord?.meeting.tenantId, 'other-co');

    assert.deepEqual((await getMeeting(gateway, 'old')).recording, { state: 'none', recordId: old, reason: 'expired' });
    assert.equal((await listRecordings(gateway, 'young'))[0]?.state, 'ready');

    await gateway.monitor.sweepOnce();
    assert.equal(gateway.fake.deleted.length, 2, 'already expired recordings are not deleted twice');
  }, { recordingEnabled: true, retentionDays: 1 });
});

test('retention sweep tombstones stale failed sessions', async () => {
  await withGateway(async (gateway) => {
    await createMeeting(gateway, 'room-1', true);
    await marker(gateway.fixture, `archived/${ROOM_RECORD_ID}.fail`);
    await gateway.monitor.pollOnce();
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'failed');

    await gateway.monitor.sweepOnce();
    assert.equal(await hasTombstone(gateway.fixture.stateDir, ROOM_RECORD_ID), false);

    gateway.time.advance(2 * 86_400_000);
    await gateway.monitor.sweepOnce();
    assert.equal(await hasTombstone(gateway.fixture.stateDir, ROOM_RECORD_ID), true);
    assert.equal(gateway.store.findByRecordId(ROOM_RECORD_ID)?.session.outcome, 'expired');
    const files = await readdir(join(gateway.fixture.stateDir, 'purge'));
    assert.deepEqual(files, [`${ROOM_RECORD_ID}.json`]);
  }, { recordingEnabled: true, retentionDays: 1 });
});
