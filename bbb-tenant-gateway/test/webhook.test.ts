import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebhookEvent } from '../src/types.js';
import { signWebhook, WebhookQueue, type WebhookTransport } from '../src/webhook.js';

const SECRET = 'test-webhook-secret-0123456789';
const URL = 'https://saas.example.com/hooks/recording';
const SCHEDULE = [1000, 5000, 15000];

function readyEvent(recordId = 'a'.repeat(40) + '-1700000000000'): WebhookEvent {
  return {
    event: 'recording.ready',
    tenant: 'lunar-one',
    meetingId: 'luna-1',
    recordId,
    occurredAt: '2026-10-02T00:00:00.000Z',
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeTransport(statuses: Array<number | Error>): { calls: Call[]; transport: WebhookTransport } {
  const calls: Call[] = [];
  const transport: WebhookTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    if (next instanceof Error) throw next;
    return { status: next };
  };
  return { calls, transport };
}

function clock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

test('signWebhook matches the documented HMAC construction', () => {
  const rawBody = '{"event":"recording.ready"}';
  const expected = createHmac('sha256', SECRET).update(`v1:1700000000:${rawBody}`).digest('hex');
  assert.equal(signWebhook(SECRET, 1_700_000_000, rawBody), `v1=${expected}`);
  assert.equal(
    signWebhook(SECRET, 1_700_000_000, rawBody),
    'v1=511a024fc1b7f738a661a9be5ace95094d05961d297ce495142883825ccc8b37',
  );
  assert.notEqual(signWebhook(SECRET, 1_700_000_001, rawBody), signWebhook(SECRET, 1_700_000_000, rawBody));
  assert.notEqual(signWebhook('other-secret-value-00000000', 1_700_000_000, rawBody), signWebhook(SECRET, 1_700_000_000, rawBody));
});

test('delivers a due webhook with the documented headers and a verifiable signature', async () => {
  const { calls, transport } = fakeTransport([200]);
  const time = clock(1_700_000_000_500);
  const lines: Array<Record<string, unknown>> = [];
  const queue = new WebhookQueue({ stateDir: null, scheduleMs: SCHEDULE, transport, now: time.now, logger: (line) => lines.push(line) });

  await queue.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: readyEvent() });
  assert.equal(queue.pending().length, 1);
  await queue.processDue();

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, URL);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers['X-Gateway-Timestamp'], '1700000000');
  assert.equal(call.headers['X-Gateway-Event-Id'], `${readyEvent().recordId}:recording.ready`);
  assert.deepEqual(JSON.parse(call.body), readyEvent());
  assert.equal(call.headers['X-Gateway-Signature'], signWebhook(SECRET, 1_700_000_000, call.body));
  assert.equal(queue.pending().length, 0);

  const delivered = lines.find((line) => line.message === 'webhook delivered');
  assert.ok(delivered);
  assert.equal(delivered.status, 200);
  for (const line of lines) {
    const text = JSON.stringify(line);
    assert.ok(!text.includes(SECRET), 'log line must not contain the secret');
    assert.ok(!text.includes('occurredAt'), 'log line must not contain the body');
  }
});

test('enqueue is idempotent on recordId:event', async () => {
  const { calls, transport } = fakeTransport([200]);
  const queue = new WebhookQueue({ stateDir: null, scheduleMs: SCHEDULE, transport, logger: () => undefined });
  await queue.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: readyEvent() });
  await queue.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: { ...readyEvent(), occurredAt: '2026-10-02T01:00:00.000Z' } });
  await queue.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: { ...readyEvent(), event: 'recording.failed', error: 'timeout' } });
  assert.deepEqual(queue.pending().map((delivery) => delivery.id).sort(), [
    `${readyEvent().recordId}:recording.failed`,
    `${readyEvent().recordId}:recording.ready`,
  ]);
  assert.equal(queue.pending().find((d) => d.id.endsWith(':recording.ready'))!.body.occurredAt, '2026-10-02T00:00:00.000Z');
  await queue.processDue();
  assert.equal(calls.length, 2);
});

test('retries follow the schedule and the delivery is dropped after the last retry', async () => {
  const { calls, transport } = fakeTransport([500]);
  const time = clock(1_700_000_000_000);
  const lines: Array<Record<string, unknown>> = [];
  const queue = new WebhookQueue({ stateDir: null, scheduleMs: SCHEDULE, transport, now: time.now, logger: (line) => lines.push(line) });
  await queue.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: readyEvent() });

  await queue.processDue();
  assert.equal(calls.length, 1);
  let [pending] = queue.pending();
  assert.equal(pending!.attempts, 1);
  assert.equal(pending!.nextAttemptAt, new Date(1_700_000_001_000).toISOString());

  await queue.processDue();
  assert.equal(calls.length, 1, 'not due yet');

  time.advance(999);
  await queue.processDue();
  assert.equal(calls.length, 1, 'still not due');

  time.advance(1);
  await queue.processDue();
  assert.equal(calls.length, 2);
  [pending] = queue.pending();
  assert.equal(pending!.attempts, 2);
  assert.equal(pending!.nextAttemptAt, new Date(1_700_000_001_000 + 5000).toISOString());

  time.advance(5000);
  await queue.processDue();
  assert.equal(calls.length, 3);
  [pending] = queue.pending();
  assert.equal(pending!.attempts, 3);
  assert.equal(pending!.nextAttemptAt, new Date(1_700_000_006_000 + 15000).toISOString());

  time.advance(15000);
  await queue.processDue();
  assert.equal(calls.length, 4);
  assert.equal(queue.pending().length, 0, 'dropped after exceeding the schedule');
  const dropped = lines.find((line) => line.message === 'webhook dropped');
  assert.ok(dropped);
  assert.equal(dropped.level, 'error');
  assert.equal(dropped.id, `${readyEvent().recordId}:recording.ready`);
  assert.equal(dropped.tenantId, 'lunar-one');
  assert.equal(dropped.status, 500);

  time.advance(100000);
  await queue.processDue();
  assert.equal(calls.length, 4);
});

test('a 3xx redirect and transport errors count as failures; processDue never throws', async () => {
  const { calls, transport } = fakeTransport([302, new Error('fetch failed'), 204]);
  const time = clock(1_700_000_000_000);
  const lines: Array<Record<string, unknown>> = [];
  const queue = new WebhookQueue({ stateDir: null, scheduleMs: SCHEDULE, transport, now: time.now, logger: (line) => lines.push(line) });
  await queue.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: readyEvent() });

  await queue.processDue();
  assert.equal(queue.pending()[0]!.attempts, 1);
  time.advance(1000);
  await queue.processDue();
  assert.equal(queue.pending()[0]!.attempts, 2);
  time.advance(5000);
  await queue.processDue();
  assert.equal(calls.length, 3);
  assert.equal(queue.pending().length, 0);
  const failures = lines.filter((line) => line.message === 'webhook delivery failed');
  assert.equal(failures.length, 2);
  assert.equal(failures[0]!.status, 302);
  assert.equal(failures[1]!.status, null);
  for (const line of lines) assert.ok(!JSON.stringify(line).includes(SECRET));
});

test('the timestamp and signature are recomputed at each attempt', async () => {
  const { calls, transport } = fakeTransport([503, 200]);
  const time = clock(1_700_000_000_000);
  const queue = new WebhookQueue({ stateDir: null, scheduleMs: SCHEDULE, transport, now: time.now, logger: () => undefined });
  await queue.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: readyEvent() });
  await queue.processDue();
  time.advance(60_000);
  await queue.processDue();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.headers['X-Gateway-Timestamp'], '1700000000');
  assert.equal(calls[1]!.headers['X-Gateway-Timestamp'], '1700000060');
  assert.notEqual(calls[0]!.headers['X-Gateway-Signature'], calls[1]!.headers['X-Gateway-Signature']);
  assert.equal(calls[1]!.headers['X-Gateway-Signature'], signWebhook(SECRET, 1_700_000_060, calls[1]!.body));
});

test('pending deliveries survive a reload from webhooks.json', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bbb-webhooks-'));
  try {
    const time = clock(1_700_000_000_000);
    const first = new WebhookQueue({ stateDir, scheduleMs: SCHEDULE, transport: fakeTransport([500]).transport, now: time.now, logger: () => undefined });
    await first.load();
    await first.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: readyEvent() });
    await first.enqueue({ tenantId: 'lunar-one', url: URL, secret: SECRET, body: { ...readyEvent('b'.repeat(40) + '-1700000000001'), event: 'recording.failed', error: 'timeout' } });
    await first.processDue();

    const files = await readdir(stateDir);
    assert.deepEqual(files, ['webhooks.json'], 'temporary files are renamed away');
    const persisted = JSON.parse(await readFile(join(stateDir, 'webhooks.json'), 'utf8')) as { version: number; deliveries: unknown[] };
    assert.equal(persisted.version, 1);
    assert.equal(persisted.deliveries.length, 2);

    const { calls, transport } = fakeTransport([200]);
    const second = new WebhookQueue({ stateDir, scheduleMs: SCHEDULE, transport, now: time.now, logger: () => undefined });
    await second.load();
    const reloaded = second.pending().sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(reloaded.length, 2);
    assert.equal(reloaded[0]!.attempts, 1);
    assert.equal(reloaded[0]!.nextAttemptAt, new Date(1_700_000_001_000).toISOString());
    assert.deepEqual(reloaded[0]!.body, readyEvent());
    assert.equal(reloaded[1]!.body.error, 'timeout');

    await second.processDue();
    assert.equal(calls.length, 0, 'nothing due before the retry delay');
    time.advance(1000);
    await second.processDue();
    assert.equal(calls.length, 2);
    assert.equal(second.pending().length, 0);
    const after = JSON.parse(await readFile(join(stateDir, 'webhooks.json'), 'utf8')) as { deliveries: unknown[] };
    assert.equal(after.deliveries.length, 0);

    const third = new WebhookQueue({ stateDir, scheduleMs: SCHEDULE, transport, now: time.now, logger: () => undefined });
    await third.load();
    assert.equal(third.pending().length, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('load tolerates a missing file and skips malformed entries', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bbb-webhooks-'));
  try {
    const lines: Array<Record<string, unknown>> = [];
    const queue = new WebhookQueue({ stateDir: join(stateDir, 'nested', 'state'), scheduleMs: SCHEDULE, logger: (line) => lines.push(line) });
    await queue.load();
    assert.equal(queue.pending().length, 0);

    await mkdir(join(stateDir, 'nested', 'state'), { recursive: true });
    await writeFile(join(stateDir, 'nested', 'state', 'webhooks.json'), JSON.stringify({
      version: 1,
      deliveries: [
        { id: 'broken' },
        { id: 'x:recording.ready', tenantId: 'lunar-one', url: URL, secret: SECRET, body: readyEvent('x'), attempts: 0, nextAttemptAt: '2026-01-01T00:00:00.000Z' },
      ],
    }));
    await queue.load();
    assert.deepEqual(queue.pending().map((delivery) => delivery.id), ['x:recording.ready']);
    assert.ok(lines.some((line) => line.message === 'webhook state entry skipped' && line.id === 'broken'));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
