import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { hashApiKey } from '../src/auth.js';
import { BbbClient } from '../src/bbb-client.js';
import { parseConfig } from '../src/config.js';
import { namespacedId, validateExternalId } from '../src/meeting-ids.js';
import { createApp } from '../src/server.js';
import type { BbbClientLike, CreateMeetingOptions, JoinOptions } from '../src/types.js';

const API_KEY = 'bbbtk_lunar-one_test-key';

function testConfig(recordingEnabled = false) {
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
      },
    },
  }, {
    BBB_API_BASE: 'https://bbb.example.com/bigbluebutton/api',
    BBB_SECRET: 'test-secret',
  });
}

class FakeBbbClient implements BbbClientLike {
  activeMeetingIds: string[] = [];
  created?: CreateMeetingOptions;
  joined?: JoinOptions;
  ended?: string;

  async createMeeting(options: CreateMeetingOptions): Promise<{ createTime: string }> {
    this.created = options;
    if (!this.activeMeetingIds.includes(options.meetingID)) this.activeMeetingIds.push(options.meetingID);
    return { createTime: '1700000000000' };
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
}

async function withGateway(
  callback: (baseUrl: string, fake: FakeBbbClient) => Promise<void>,
  config = testConfig(),
): Promise<void> {
  const fake = new FakeBbbClient();
  const server: Server = createServer(createApp(config, fake));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await callback(`http://127.0.0.1:${address.port}`, fake);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

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
  await withGateway(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 401);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'unauthorized');
  });
});

test('creates a namespaced meeting and returns createTime', async () => {
  await withGateway(async (baseUrl, fake) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        origin: 'https://lunar-one.example.com',
      },
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://lunar-one.example.com');
    assert.deepEqual(await response.json(), {
      meetingId: 'room-1',
      createTime: '1700000000000',
      created: true,
    });
    assert.equal(fake.created?.meetingID, 'lunar-one:room-1');
    assert.equal(fake.created?.tenantId, 'lunar-one');
    assert.equal(fake.created?.maxParticipants, 50);
  });
});

test('treats creation of an active tenant meeting as idempotent', async () => {
  await withGateway(async (baseUrl, fake) => {
    fake.activeMeetingIds = ['lunar-one:room-1'];
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { created: boolean };
    assert.equal(body.created, false);
  });
});

test('rejects an untrusted browser origin', async () => {
  await withGateway(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        origin: 'https://attacker.example.com',
      },
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1' }),
    });
    assert.equal(response.status, 403);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'origin_not_allowed');
  });
});

test('enforces the tenant recording policy', async () => {
  await withGateway(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ meetingId: 'room-1', name: 'Room 1', record: true }),
    });
    assert.equal(response.status, 403);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'recording_not_allowed');
  });
});

test('applies the tenant automatic recording policy', async () => {
  await withGateway(async (baseUrl, fake) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ meetingId: 'recorded-room', name: 'Recorded Room', record: true }),
    });
    assert.equal(response.status, 201);
    assert.equal(fake.created?.record, true);
    assert.equal(fake.created?.autoStartRecording, true);
    assert.equal(fake.created?.allowStartStopRecording, true);
  }, testConfig(true));
});

test('issues a join URL with namespaced meeting and user IDs', async () => {
  await withGateway(async (baseUrl, fake) => {
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings/room-1/join`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        createTime: '1700000000000',
        userId: 'user-1',
        displayName: 'Ada Lovelace',
        role: 'MODERATOR',
        autoJoinAudio: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(fake.joined?.meetingID, 'lunar-one:room-1');
    assert.equal(fake.joined?.userID, 'lunar-one:user-1');
    assert.equal(fake.joined?.role, 'MODERATOR');
    assert.equal(fake.joined?.autoJoinAudio, true);
  });
});

test('enforces the concurrent meeting limit', async () => {
  await withGateway(async (baseUrl, fake) => {
    fake.activeMeetingIds = ['lunar-one:room-a', 'lunar-one:room-b', 'another:room'];
    const response = await fetch(`${baseUrl}/v1/tenants/lunar-one/meetings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ meetingId: 'room-c', name: 'Room C' }),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'meeting_limit_reached');
  });
});
