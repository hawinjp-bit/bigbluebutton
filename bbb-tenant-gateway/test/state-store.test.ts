import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MeetingStateStore } from '../src/state-store.js';

const RECORD_A = `${'a'.repeat(40)}-1700000000000`;
const RECORD_B = `${'b'.repeat(40)}-1700000001000`;
const START_MS = 1_700_000_000_000;

function clock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}

async function withStateDir(callback: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bbb-state-'));
  try {
    await callback(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('upserts sessions, keeps existing session data and survives a reload', async () => {
  await withStateDir(async (stateDir) => {
    const time = clock(START_MS);
    const store = new MeetingStateStore(stateDir, time.now);
    await store.load();
    assert.equal(store.get('lunar-one', 'room-1'), undefined);

    const meeting = await store.upsertSession('lunar-one', 'room-1', true, { recordId: RECORD_A, createTime: '1700000000000' });
    assert.deepEqual(meeting, {
      tenantId: 'lunar-one',
      meetingId: 'room-1',
      record: true,
      sessions: [{ recordId: RECORD_A, createTime: '1700000000000', createdAt: '2023-11-14T22:13:20.000Z', record: true }],
      updatedAt: '2023-11-14T22:13:20.000Z',
    });

    await store.setOutcome(RECORD_A, 'failed', 'sanity/x.fail');
    await store.markNotified(RECORD_A, 'failed');
    time.advance(5000);
    await store.upsertSession('lunar-one', 'room-1', false, { recordId: RECORD_A, createTime: '1700000000000' });
    await store.upsertSession('lunar-one', 'room-1', true, { recordId: RECORD_B, createTime: '1700000001000' });

    const files = await readdir(stateDir);
    assert.deepEqual(files, ['meetings.json'], 'no temporary files left behind');
    const persisted = JSON.parse(await readFile(join(stateDir, 'meetings.json'), 'utf8')) as { version: number };
    assert.equal(persisted.version, 1);

    const reloaded = new MeetingStateStore(stateDir, time.now);
    await reloaded.load();
    const record = reloaded.get('lunar-one', 'room-1');
    assert.equal(record?.record, true, 'the meeting flag is the latest upserted value');
    assert.equal(record?.sessions.length, 2);
    // The re-upsert with record=false applied to session A only; session B carries its own true.
    assert.deepEqual(record?.sessions[0], {
      recordId: RECORD_A,
      createTime: '1700000000000',
      createdAt: '2023-11-14T22:13:20.000Z',
      record: false,
      outcome: 'failed',
      outcomeAt: '2023-11-14T22:13:20.000Z',
      error: 'sanity/x.fail',
      notifiedFailed: true,
    });
    assert.equal(record?.sessions[1]?.record, true);
    assert.equal(reloaded.findByRecordId(RECORD_B)?.meeting.meetingId, 'room-1');
    assert.equal(reloaded.findByRecordId('nope'), undefined);
  });
});

test('outcomes are terminal except for deletion and returned records are copies', async () => {
  await withStateDir(async (stateDir) => {
    const store = new MeetingStateStore(stateDir, clock(START_MS).now);
    await store.load();
    await store.upsertSession('t', 'm', true, { recordId: RECORD_A, createTime: '1700000000000' });

    await store.setOutcome(RECORD_A, 'ready');
    await store.setOutcome(RECORD_A, 'failed', 'later');
    assert.equal(store.findByRecordId(RECORD_A)?.session.outcome, 'ready');
    assert.equal(store.findByRecordId(RECORD_A)?.session.error, undefined);

    await store.setOutcome(RECORD_A, 'expired');
    assert.equal(store.findByRecordId(RECORD_A)?.session.outcome, 'expired');
    await store.setOutcome('unknown', 'ready');
    await store.markNotified('unknown', 'ready');

    const copy = store.get('t', 'm')!;
    copy.sessions[0]!.outcome = 'ready';
    copy.record = false;
    assert.equal(store.get('t', 'm')?.sessions[0]?.outcome, 'expired');
    assert.equal(store.get('t', 'm')?.record, true);
  });
});

test('listPending honours record flag, outcome and age; prune forgets old entries', async () => {
  await withStateDir(async (stateDir) => {
    const time = clock(START_MS);
    const store = new MeetingStateStore(stateDir, time.now);
    await store.load();
    await store.upsertSession('t', 'recorded', true, { recordId: RECORD_A, createTime: '1700000000000' });
    await store.upsertSession('t', 'plain', false, { recordId: RECORD_B, createTime: '1700000001000' });
    const pending = store.listPending(3_600_000);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.session.recordId, RECORD_A);

    time.advance(2 * 3_600_000);
    assert.equal(store.listPending(3_600_000).length, 0);
    assert.equal(store.listPending(Number.POSITIVE_INFINITY).length, 1);
    await store.setOutcome(RECORD_A, 'ready');
    assert.equal(store.listPending(Number.POSITIVE_INFINITY).length, 0);

    const RECORD_C = `${'c'.repeat(40)}-1700000002000`;
    const RECORD_D = `${'d'.repeat(40)}-1700000003000`;
    const RECORD_E = `${'e'.repeat(40)}-1700000004000`;
    await store.upsertSession('t', 'fresh', true, { recordId: RECORD_C, createTime: '1700000002000' });
    await store.prune(3_600_000);
    // A is ready and therefore kept regardless of age (it expires or gets deleted later);
    // B is pending and 2 h old → dropped, and its untouched meeting with it.
    assert.deepEqual(store.get('t', 'recorded')?.sessions.map((session) => session.recordId), [RECORD_A]);
    assert.equal(store.get('t', 'plain'), undefined);
    assert.deepEqual(store.listAll().map((meeting) => meeting.meetingId).sort(), ['fresh', 'recorded']);

    // Once A is expired its age counts from outcomeAt, not createdAt: still young right after the outcome.
    time.advance(2 * 3_600_000);
    await store.setOutcome(RECORD_A, 'expired');
    await store.upsertSession('t', 'fresh', true, { recordId: RECORD_D, createTime: '1700000003000' });
    await store.prune(3_600_000);
    assert.deepEqual(store.get('t', 'recorded')?.sessions.map((session) => session.recordId), [RECORD_A]);
    assert.deepEqual(store.get('t', 'fresh')?.sessions.map((session) => session.recordId), [RECORD_D], 'C aged out');

    // 2 h after the expiry A is droppable and the meeting goes with it; D goes too, E keeps 'fresh' alive.
    time.advance(2 * 3_600_000);
    await store.upsertSession('t', 'fresh', true, { recordId: RECORD_E, createTime: '1700000004000' });
    await store.prune(3_600_000);
    assert.equal(store.get('t', 'recorded'), undefined);
    assert.deepEqual(store.get('t', 'fresh')?.sessions.map((session) => session.recordId), [RECORD_E]);

    const reloaded = new MeetingStateStore(stateDir, time.now);
    await reloaded.load();
    assert.equal(reloaded.listAll().length, 1);
    assert.equal(reloaded.listAll()[0]?.meetingId, 'fresh');
  });
});

test('per-session record flags decide what is pending; older state without them falls back to the meeting flag', async () => {
  await withStateDir(async (stateDir) => {
    const time = clock(START_MS);
    const store = new MeetingStateStore(stateDir, time.now);
    await store.load();
    // record=true then record=false for the same meeting: the first session stays recorded.
    await store.upsertSession('t', 'm', true, { recordId: RECORD_A, createTime: '1700000000000' });
    await store.upsertSession('t', 'm', false, { recordId: RECORD_B, createTime: '1700000001000' });
    assert.equal(store.get('t', 'm')?.record, false);
    assert.deepEqual(store.listPending(Number.POSITIVE_INFINITY).map((entry) => entry.session.recordId), [RECORD_A]);

    // record=false then record=true: only the second session is pending.
    await store.upsertSession('t', 'n', false, { recordId: `${'1'.repeat(40)}-1700000000000`, createTime: '1700000000000' });
    await store.upsertSession('t', 'n', true, { recordId: `${'2'.repeat(40)}-1700000001000`, createTime: '1700000001000' });
    assert.deepEqual(
      store.listPending(Number.POSITIVE_INFINITY).map((entry) => entry.session.recordId).sort(),
      [`${'2'.repeat(40)}-1700000001000`, RECORD_A].sort(),
    );

    // A state file written before per-session flags existed: sessions inherit the meeting flag on load.
    await writeFile(join(stateDir, 'meetings.json'), JSON.stringify({
      version: 1,
      meetings: {
        't/legacy': {
          tenantId: 't',
          meetingId: 'legacy',
          record: true,
          sessions: [{ recordId: RECORD_A, createTime: '1700000000000', createdAt: '2023-11-14T22:13:20.000Z' }],
          updatedAt: '2023-11-14T22:13:20.000Z',
        },
      },
    }));
    const legacy = new MeetingStateStore(stateDir, time.now);
    await legacy.load();
    assert.equal(legacy.get('t', 'legacy')?.sessions[0]?.record, undefined);
    assert.equal(legacy.listPending(Number.POSITIVE_INFINITY).length, 1);
  });
});

test('serialises concurrent writes without interleaving', async () => {
  await withStateDir(async (stateDir) => {
    const store = new MeetingStateStore(stateDir, clock(START_MS).now);
    await store.load();
    await Promise.all(Array.from({ length: 25 }, (_, index) =>
      store.upsertSession('t', `m-${index}`, true, {
        recordId: `${index.toString(16).padStart(40, '0')}-1700000000000`,
        createTime: '1700000000000',
      })));
    assert.deepEqual(await readdir(stateDir), ['meetings.json']);
    const persisted = JSON.parse(await readFile(join(stateDir, 'meetings.json'), 'utf8')) as { meetings: Record<string, unknown> };
    assert.equal(Object.keys(persisted.meetings).length, 25);
    assert.equal(store.listAll().length, 25);
  });
});

test('load tolerates a missing file, skips malformed entries and rejects unknown formats', async () => {
  await withStateDir(async (stateDir) => {
    const fresh = new MeetingStateStore(stateDir);
    await fresh.load();
    assert.equal(fresh.listAll().length, 0);

    await writeFile(join(stateDir, 'meetings.json'), JSON.stringify({
      version: 1,
      meetings: {
        't/good': {
          tenantId: 't',
          meetingId: 'good',
          record: true,
          sessions: [
            { recordId: RECORD_A, createTime: '1', createdAt: '2023-11-14T22:13:20.000Z', outcome: 'bogus' },
            { recordId: 42 },
          ],
          updatedAt: '2023-11-14T22:13:20.000Z',
        },
        't/mismatch': { tenantId: 'x', meetingId: 'y', record: true, sessions: [], updatedAt: '' },
        't/garbage': 'nope',
      },
    }));
    const store = new MeetingStateStore(stateDir);
    await store.load();
    assert.equal(store.listAll().length, 1);
    const good = store.get('t', 'good');
    assert.equal(good?.sessions.length, 1);
    assert.equal(good?.sessions[0]?.outcome, undefined);

    await writeFile(join(stateDir, 'meetings.json'), JSON.stringify({ version: 2, meetings: {} }));
    await assert.rejects(() => new MeetingStateStore(stateDir).load(), /unsupported format/);
  });
});
