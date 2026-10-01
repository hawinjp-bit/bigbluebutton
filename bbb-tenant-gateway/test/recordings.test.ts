import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classify,
  findVideoFile,
  hasTombstone,
  inspectRecording,
  probeMarkers,
  readVideoMetadata,
  RECORD_ID_PATTERN,
  recordIdFor,
  TombstoneWriteError,
  writeTombstone,
  type MarkerProbe,
} from '../src/recordings.js';
import type { RecordingPaths } from '../src/types.js';

const ID = `${'a'.repeat(40)}-1700000000000`;

interface Fixture {
  root: string;
  paths: RecordingPaths;
  stateDir: string;
}

async function withFixture(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bbb-recordings-'));
  const paths: RecordingPaths = {
    publishedDir: join(root, 'published'),
    unpublishedDir: join(root, 'unpublished'),
    statusDir: join(root, 'status'),
  };
  for (const name of ['archived', 'sanity', 'processed', 'published']) {
    await mkdir(join(paths.statusDir, name), { recursive: true });
  }
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  try {
    await callback({ root, paths, stateDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function marker(fixture: Fixture, relative: string): Promise<void> {
  const [directory, file] = relative.split('/');
  await writeFile(join(fixture.paths.statusDir, directory!, file!), '');
}

async function video(fixture: Fixture, where: 'publishedDir' | 'unpublishedDir', size = 2048, metadata?: string): Promise<string> {
  const directory = join(fixture.paths[where], 'video', ID);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'video-0.m4v');
  await writeFile(path, Buffer.alloc(size, 7));
  if (metadata !== undefined) await writeFile(join(directory, 'metadata.xml'), metadata);
  return path;
}

const METADATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<recording>
  <id>${ID}</id>
  <state>available</state>
  <published>true</published>
  <start_time>1700000000000</start_time>
  <end_time>1700000125000</end_time>
  <participants>3</participants>
  <playback>
    <format>video</format>
    <link>https://meet.example.com/playback/video/${ID}/</link>
    <duration>123456</duration>
    <size>2048</size>
  </playback>
  <meta>
    <meetingName>Room 1</meetingName>
    <isBreakout>false</isBreakout>
    <tenantid>lunar-one</tenantid>
    <bbb-recording-ready-url>http://127.0.0.1:3198/internal/recording-ready</bbb-recording-ready-url>
  </meta>
</recording>`;

test('recordIdFor matches BigBlueButton internalMeetingID construction', () => {
  const expected = `${createHash('sha1').update('rec-test', 'utf8').digest('hex')}-1786803013476`;
  assert.equal(recordIdFor('rec-test', '1786803013476'), expected);
  assert.ok(expected.startsWith('3a1c8eb5'), 'verified against a real recording in the design');
  assert.match(expected, RECORD_ID_PATTERN);
  assert.equal(recordIdFor('lunar-one:ラウンジ', '1700000000000').length, 54);
});

test('RECORD_ID_PATTERN rejects anything that could escape a directory', () => {
  assert.match(ID, RECORD_ID_PATTERN);
  assert.doesNotMatch(`${'A'.repeat(40)}-1700000000000`, RECORD_ID_PATTERN);
  assert.doesNotMatch(`${'a'.repeat(39)}-1700000000000`, RECORD_ID_PATTERN);
  assert.doesNotMatch(`${'a'.repeat(40)}-170000`, RECORD_ID_PATTERN);
  assert.doesNotMatch(`${'a'.repeat(40)}-17000000000000000`, RECORD_ID_PATTERN);
  assert.doesNotMatch('../../etc/passwd', RECORD_ID_PATTERN);
  assert.doesNotMatch(`${ID}/..`, RECORD_ID_PATTERN);
  assert.doesNotMatch(`${ID}\n`, RECORD_ID_PATTERN);
});

test('probeMarkers reads only the gateway-relevant markers', async () => {
  await withFixture(async (fixture) => {
    assert.deepEqual(await probeMarkers(fixture.paths, ID), { norecord: false, failMarker: null, videoDone: false });

    await marker(fixture, `archived/${ID}.done`);
    await marker(fixture, `sanity/${ID}.done`);
    await marker(fixture, `processed/${ID}-presentation.fail`);
    await marker(fixture, `published/${ID}-presentation.done`);
    assert.deepEqual(await probeMarkers(fixture.paths, ID), { norecord: false, failMarker: null, videoDone: false });

    await marker(fixture, `published/${ID}-video.done`);
    assert.equal((await probeMarkers(fixture.paths, ID)).videoDone, true);

    await marker(fixture, `archived/${ID}.norecord`);
    assert.equal((await probeMarkers(fixture.paths, ID)).norecord, true);

    await marker(fixture, `sanity/${ID}.fail`);
    assert.equal((await probeMarkers(fixture.paths, ID)).failMarker, `sanity/${ID}.fail`);
    await marker(fixture, `processed/${ID}-video.fail`);
    assert.equal((await probeMarkers(fixture.paths, ID)).failMarker, `processed/${ID}-video.fail`, 'video-specific wins');

    await assert.rejects(() => probeMarkers(fixture.paths, '../x'), /Invalid recordId/);
  });
});

test('findVideoFile prefers published over unpublished and validates the id', async () => {
  await withFixture(async (fixture) => {
    assert.equal(await findVideoFile(fixture.paths, ID), null);
    const unpublished = await video(fixture, 'unpublishedDir', 100);
    const found = await findVideoFile(fixture.paths, ID);
    assert.equal(found?.path, unpublished);
    assert.equal(found?.size, 100);
    assert.ok(found && found.mtimeMs > 0);

    const published = await video(fixture, 'publishedDir', 200);
    assert.equal((await findVideoFile(fixture.paths, ID))?.path, published);
    await assert.rejects(() => findVideoFile(fixture.paths, `${ID}/..`), /Invalid recordId/);
  });
});

test('readVideoMetadata parses duration, times and lowercased meta keys', async () => {
  await withFixture(async (fixture) => {
    assert.equal(await readVideoMetadata(fixture.paths, ID), null);
    await video(fixture, 'publishedDir', 10, METADATA_XML);
    const metadata = await readVideoMetadata(fixture.paths, ID);
    assert.deepEqual(metadata, {
      durationMs: 123456,
      startTime: '1700000000000',
      endTime: '1700000125000',
      meta: {
        meetingname: 'Room 1',
        isbreakout: 'false',
        tenantid: 'lunar-one',
        'bbb-recording-ready-url': 'http://127.0.0.1:3198/internal/recording-ready',
      },
    });

    await video(fixture, 'publishedDir', 10, '<recording><playback><format>video</format></playback></recording>');
    assert.deepEqual(await readVideoMetadata(fixture.paths, ID), { durationMs: null, startTime: null, endTime: null, meta: {} });

    await video(fixture, 'publishedDir', 10, '<other/>');
    assert.equal(await readVideoMetadata(fixture.paths, ID), null);
  });
});

test('classify follows the documented precedence', () => {
  const none: MarkerProbe = { norecord: false, failMarker: null, videoDone: false };
  const file = { path: 'x', size: 1, mtimeMs: 1 };

  assert.deepEqual(classify({ probe: none, video: null, tombstone: false }), { state: 'processing' });
  assert.deepEqual(classify({ probe: none, video: file, tombstone: false }), { state: 'processing' });
  assert.deepEqual(classify({ probe: { ...none, videoDone: true }, video: null, tombstone: false }), { state: 'processing' });
  assert.deepEqual(classify({ probe: { ...none, videoDone: true }, video: file, tombstone: false }), { state: 'ready' });
  assert.deepEqual(
    classify({ probe: { ...none, videoDone: true, failMarker: `published/${ID}-video.fail` }, video: file, tombstone: false }),
    { state: 'failed', reason: `published/${ID}-video.fail` },
  );
  assert.deepEqual(
    classify({ probe: { ...none, failMarker: `sanity/${ID}.fail` }, video: null, tombstone: false }),
    { state: 'failed', reason: `sanity/${ID}.fail` },
  );
  assert.deepEqual(
    classify({ probe: { ...none, norecord: true, failMarker: `sanity/${ID}.fail` }, video: null, tombstone: false }),
    { state: 'none', reason: 'no_recording_marks' },
  );
  assert.deepEqual(
    classify({ probe: { ...none, videoDone: true }, video: file, tombstone: true }),
    { state: 'deleted', reason: 'deleted' },
  );
  assert.deepEqual(
    classify({ probe: { ...none, videoDone: true }, video: file, tombstone: false, outcome: 'expired' }),
    { state: 'deleted', reason: 'expired' },
  );
  assert.deepEqual(
    classify({ probe: none, video: null, tombstone: false, outcome: 'no_recording' }),
    { state: 'none', reason: 'no_recording_marks' },
  );
  assert.deepEqual(
    classify({ probe: none, video: null, tombstone: false, outcome: 'failed', error: 'archived/x.fail' }),
    { state: 'failed', reason: 'archived/x.fail' },
  );
  assert.deepEqual(classify({ probe: none, video: null, tombstone: false, outcome: 'timeout' }), { state: 'failed', reason: 'timeout' });
  // Markers vanish after 14 days: the stored ready outcome keeps the recording downloadable.
  assert.deepEqual(classify({ probe: none, video: file, tombstone: false, outcome: 'ready' }), { state: 'ready' });
  // ...and so does BigBlueButton listing it as published/unpublished when there is no stored outcome.
  assert.deepEqual(classify({ probe: none, video: file, tombstone: false, listedState: 'published' }), { state: 'ready' });
  assert.deepEqual(classify({ probe: none, video: file, tombstone: false, listedState: 'unpublished' }), { state: 'ready' });
  assert.deepEqual(classify({ probe: none, video: file, tombstone: false }), { state: 'processing' });
  assert.deepEqual(classify({ probe: none, video: file, tombstone: false, listedState: 'processing' }), { state: 'processing' });
  assert.deepEqual(classify({ probe: none, video: null, tombstone: false, listedState: 'published' }), { state: 'processing' }, 'no file');
  assert.deepEqual(
    classify({ probe: { ...none, failMarker: `processed/${ID}-video.fail` }, video: file, tombstone: false, listedState: 'published' }),
    { state: 'failed', reason: `processed/${ID}-video.fail` },
    'a video fail marker still wins over the listing',
  );
  assert.deepEqual(
    classify({ probe: none, video: file, tombstone: false, outcome: 'expired', listedState: 'published' }),
    { state: 'deleted', reason: 'expired' },
    'a stored terminal outcome wins over the listing',
  );
});

test('inspectRecording accepts the listed BigBlueButton state as marker substitute', async () => {
  await withFixture(async (fixture) => {
    await video(fixture, 'publishedDir');
    assert.equal((await inspectRecording(fixture.paths, fixture.stateDir, ID)).state, 'processing');
    assert.equal((await inspectRecording(fixture.paths, fixture.stateDir, ID, undefined, 'published')).state, 'ready');
  });
});

test('tombstones are written atomically under purge/ and validated', async () => {
  await withFixture(async (fixture) => {
    assert.equal(await hasTombstone(fixture.stateDir, ID), false);
    await writeTombstone(fixture.stateDir, { recordId: ID, tenantId: 't', meetingId: 'm', requestedAt: '2026-10-02T00:00:00.000Z' });
    assert.equal(await hasTombstone(fixture.stateDir, ID), true);
    assert.deepEqual(await readdir(join(fixture.stateDir, 'purge')), [`${ID}.json`]);
    assert.deepEqual(JSON.parse(await readFile(join(fixture.stateDir, 'purge', `${ID}.json`), 'utf8')), {
      recordId: ID,
      tenantId: 't',
      meetingId: 'm',
      requestedAt: '2026-10-02T00:00:00.000Z',
    });

    await assert.rejects(
      () => writeTombstone(fixture.stateDir, { recordId: '../escape', tenantId: 't', meetingId: 'm', requestedAt: 'x' }),
      /Invalid recordId/,
    );
    assert.equal(await hasTombstone(fixture.stateDir, '../escape'), false);

    const blocked = join(fixture.root, 'blocked');
    await writeFile(blocked, 'file, not a directory');
    await assert.rejects(
      () => writeTombstone(blocked, { recordId: ID, tenantId: 't', meetingId: 'm', requestedAt: 'x' }),
      (error: unknown) => error instanceof TombstoneWriteError,
    );
  });
});

test('inspectRecording combines markers, file and tombstone', async () => {
  await withFixture(async (fixture) => {
    const idle = await inspectRecording(fixture.paths, fixture.stateDir, ID);
    assert.equal(idle.state, 'processing');
    assert.equal(idle.evidence, false);

    await video(fixture, 'publishedDir');
    await marker(fixture, `published/${ID}-video.done`);
    const ready = await inspectRecording(fixture.paths, fixture.stateDir, ID);
    assert.equal(ready.state, 'ready');
    assert.equal(ready.evidence, true);
    assert.equal(ready.video?.size, 2048);

    await writeTombstone(fixture.stateDir, { recordId: ID, tenantId: 't', meetingId: 'm', requestedAt: 'x' });
    assert.equal((await inspectRecording(fixture.paths, fixture.stateDir, ID)).state, 'deleted');
  });
});
