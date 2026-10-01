import assert from 'node:assert/strict';
import test from 'node:test';
import { BbbApiError, BbbClient } from '../src/bbb-client.js';

const RECORD_ID = '3a1c8eb5f0d2c1b4a5e6f7a8b9c0d1e2f3a4b5c6-1786803013476';
const MEETING_ID = 'lunar-one:luna-7c9e6679-7425-40de-944b-e07fc1f90ae7-1b4e28ba-2fa1-11d2-883f-0016d3cca427';

function recordingXml(recordID: string, meetingID: string, extra = ''): string {
  return `
    <recording>
      <recordID>${recordID}</recordID>
      <meetingID>${meetingID}</meetingID>
      <internalMeetingID>${recordID}</internalMeetingID>
      <name>Luna lesson</name>
      <isBreakout>false</isBreakout>
      <published>true</published>
      <state>published</state>
      <startTime>1786803013476</startTime>
      <endTime>1786803313476</endTime>
      <participants>3</participants>
      <rawSize>123456</rawSize>
      <metadata>
        <tenantid>lunar-one</tenantid>
        <meetingId>${meetingID}</meetingId>
        <meetingName>Luna lesson</meetingName>
        <isBreakout>false</isBreakout>
        <bbb-recording-ready-url>http://127.0.0.1:3198/internal/recording-ready</bbb-recording-ready-url>
      </metadata>
      <size>98765</size>
      <playback>
        <format>
          <type>presentation</type>
          <url>https://meet.ooak.jp/playback/presentation/2.3/${recordID}</url>
          <processingTime>5112</processingTime>
          <length>5</length>
          <size>12345</size>
          <preview>
            <images>
              <image alt="Welcome" height="136" width="176">https://meet.ooak.jp/presentation/${recordID}/thumb-1.png</image>
            </images>
          </preview>
        </format>
        <format>
          <type>video</type>
          <url>https://meet.ooak.jp/playback/video/${recordID}/</url>
          <processingTime>9876</processingTime>
          <length>5</length>
          <size>86420</size>
        </format>
      </playback>
      ${extra}
    </recording>`;
}

function success(inner: string): string {
  return `<?xml version="1.0"?><response><returncode>SUCCESS</returncode>${inner}</response>`;
}

function failed(messageKey: string, message: string): string {
  return `<?xml version="1.0"?><response><returncode>FAILED</returncode><messageKey>${messageKey}</messageKey><message>${message}</message></response>`;
}

interface Exchange {
  url: URL;
  init: RequestInit | undefined;
}

function clientWith(respond: (call: string, query: URLSearchParams) => string | Response): { client: BbbClient; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    exchanges.push({ url, init });
    const call = url.pathname.split('/').pop() ?? '';
    const result = respond(call, url.searchParams);
    return typeof result === 'string'
      ? new Response(result, { status: 200, headers: { 'content-type': 'text/xml' } })
      : result;
  };
  const client = new BbbClient({
    apiBaseUrl: 'https://bbb.example.com/bigbluebutton/api',
    sharedSecret: 'test-shared-secret',
    checksumAlgorithm: 'sha256',
    timeoutMs: 1000,
  }, fetchImplementation);
  return { client, exchanges };
}

test('keeps the documented create signature byte-identical', () => {
  const client = new BbbClient({
    apiBaseUrl: 'https://bbb.example.com/bigbluebutton/api',
    sharedSecret: '639259d4-9dd8-4b25-bf01-95f9567eaf4b',
    checksumAlgorithm: 'sha1',
    timeoutMs: 1000,
  });
  assert.equal(
    client.buildSignedUrl('create', { name: 'Test Meeting', meetingID: 'abc123', attendeePW: '111222', moderatorPW: '333444' }),
    'https://bbb.example.com/bigbluebutton/api/create?name=Test+Meeting&meetingID=abc123&attendeePW=111222&moderatorPW=333444&checksum=1fcbb0c4fc1f039f73aa6d697d2db9ba7f803f17',
  );
});

test('createMeeting passes the recording-ready URL and reports duplicates', async () => {
  let messageKey = '';
  const { client, exchanges } = clientWith(() => success(
    `<meetingID>${MEETING_ID}</meetingID><internalMeetingID>${RECORD_ID}</internalMeetingID><createTime>1786803013476</createTime>`
    + (messageKey ? `<messageKey>${messageKey}</messageKey><message>This conference was already in existence.</message>` : ''),
  ));

  const fresh = await client.createMeeting({
    meetingID: MEETING_ID,
    name: 'Luna lesson',
    record: true,
    autoStartRecording: true,
    allowStartStopRecording: false,
    maxParticipants: 100,
    tenantId: 'lunar-one',
    recordingReadyUrl: 'http://127.0.0.1:3198/internal/recording-ready',
  });
  assert.deepEqual(fresh, { createTime: '1786803013476', duplicate: false });
  const query = exchanges[0]!.url.searchParams;
  assert.equal(exchanges[0]!.url.pathname, '/bigbluebutton/api/create');
  assert.equal(query.get('meta_bbb-recording-ready-url'), 'http://127.0.0.1:3198/internal/recording-ready');
  assert.equal(query.get('meta_tenantId'), 'lunar-one');
  assert.equal(query.get('record'), 'true');
  assert.equal(query.get('autoStartRecording'), 'true');
  assert.equal(query.get('allowStartStopRecording'), 'false');
  assert.ok(query.get('checksum'));

  messageKey = 'duplicateWarning';
  const again = await client.createMeeting({ meetingID: MEETING_ID, name: 'Luna lesson', record: false, maxParticipants: 100, tenantId: 'lunar-one' });
  assert.deepEqual(again, { createTime: '1786803013476', duplicate: true });
  assert.equal(exchanges[1]!.url.searchParams.has('meta_bbb-recording-ready-url'), false, 'omitted when not requested');
});

test('getMeetingInfo maps the boolean strings and returns null on notFound', async () => {
  let exists = true;
  const { client, exchanges } = clientWith(() => (exists
    ? success(`
      <meetingName>Luna lesson</meetingName>
      <meetingID>${MEETING_ID}</meetingID>
      <internalMeetingID>${RECORD_ID}</internalMeetingID>
      <createTime>1786803013476</createTime>
      <running>true</running>
      <recording>true</recording>
      <hasUserJoined>true</hasUserJoined>
      <endTime>0</endTime>`)
    : failed('notFound', 'A meeting with that ID does not exist')));

  const info = await client.getMeetingInfo(MEETING_ID);
  assert.deepEqual(info, {
    meetingID: MEETING_ID,
    internalMeetingID: RECORD_ID,
    createTime: '1786803013476',
    running: true,
    recording: true,
    hasUserJoined: true,
    endTime: '0',
  });
  assert.equal(exchanges[0]!.url.pathname, '/bigbluebutton/api/getMeetingInfo');
  assert.equal(exchanges[0]!.url.searchParams.get('meetingID'), MEETING_ID);

  exists = false;
  assert.equal(await client.getMeetingInfo(MEETING_ID), null);
});

test('getMeetingInfo reports false flags for a fresh meeting', async () => {
  const { client } = clientWith(() => success(`
      <meetingID>${MEETING_ID}</meetingID>
      <internalMeetingID>${RECORD_ID}</internalMeetingID>
      <createTime>1786803013476</createTime>
      <running>false</running>
      <recording>false</recording>
      <hasUserJoined>false</hasUserJoined>
      <endTime>0</endTime>`));
  const info = await client.getMeetingInfo(MEETING_ID);
  assert.equal(info?.running, false);
  assert.equal(info?.recording, false);
  assert.equal(info?.hasUserJoined, false);
});

test('getMeetingInfo rethrows other BBB failures', async () => {
  const { client } = clientWith(() => failed('checksumError', 'Checksums do not match'));
  await assert.rejects(client.getMeetingInfo(MEETING_ID), (error: unknown) => error instanceof BbbApiError && error.messageKey === 'checksumError');
});

test('getRecordings parses a single recording with lowercased metadata and both formats', async () => {
  const { client, exchanges } = clientWith(() => success(`<recordings>${recordingXml(RECORD_ID, MEETING_ID)}</recordings>`));
  const recordings = await client.getRecordings({
    meetingID: MEETING_ID,
    metaTenantId: 'lunar-one',
    states: ['processing', 'processed', 'published', 'unpublished'],
  });

  const query = exchanges[0]!.url.searchParams;
  assert.equal(exchanges[0]!.url.pathname, '/bigbluebutton/api/getRecordings');
  assert.equal(query.get('meetingID'), MEETING_ID);
  assert.equal(query.get('meta_tenantid'), 'lunar-one');
  assert.equal(query.get('state'), 'processing,processed,published,unpublished');
  assert.equal(query.has('recordID'), false);

  assert.equal(recordings.length, 1);
  const recording = recordings[0]!;
  assert.equal(recording.recordID, RECORD_ID);
  assert.equal(recording.meetingID, MEETING_ID);
  assert.equal(recording.internalMeetingID, RECORD_ID);
  assert.equal(recording.name, 'Luna lesson');
  assert.equal(recording.state, 'published');
  assert.equal(recording.published, true);
  assert.equal(recording.startTime, '1786803013476');
  assert.equal(recording.endTime, '1786803313476');
  assert.equal(recording.participants, 3);
  assert.deepEqual(recording.metadata, {
    tenantid: 'lunar-one',
    meetingid: MEETING_ID,
    meetingname: 'Luna lesson',
    isbreakout: 'false',
    'bbb-recording-ready-url': 'http://127.0.0.1:3198/internal/recording-ready',
  });
  assert.deepEqual(recording.formats, [
    { type: 'presentation', url: `https://meet.ooak.jp/playback/presentation/2.3/${RECORD_ID}`, length: 5, size: 12345 },
    { type: 'video', url: `https://meet.ooak.jp/playback/video/${RECORD_ID}/`, length: 5, size: 86420 },
  ]);
});

test('getRecordings parses an array of recordings and only sends provided filters', async () => {
  const other = 'b'.repeat(40) + '-1786803999999';
  const { client, exchanges } = clientWith(() => success(`<recordings>${recordingXml(RECORD_ID, MEETING_ID)}${recordingXml(other, MEETING_ID)
    .replace('<published>true</published>', '<published>false</published>')
    .replace('<state>published</state>', '<state>unpublished</state>')
    .replace(/<playback>[\s\S]*<\/playback>/, '<playback><format><type>video</type><url>https://x/</url><length>1</length><size>2</size></format></playback>')
    .replace(/<metadata>[\s\S]*<\/metadata>/, '<metadata></metadata>')
    .replace('<participants>3</participants>', '<participants></participants>')}</recordings>`));

  const recordings = await client.getRecordings({ recordID: `${RECORD_ID},${other}` });
  const query = exchanges[0]!.url.searchParams;
  assert.equal(query.get('recordID'), `${RECORD_ID},${other}`);
  assert.equal(query.has('meetingID'), false);
  assert.equal(query.has('meta_tenantid'), false);
  assert.equal(query.has('state'), false);

  assert.equal(recordings.length, 2);
  assert.equal(recordings[0]!.recordID, RECORD_ID);
  assert.equal(recordings[1]!.recordID, other);
  assert.equal(recordings[1]!.state, 'unpublished');
  assert.equal(recordings[1]!.published, false);
  assert.equal(recordings[1]!.participants, 0);
  assert.deepEqual(recordings[1]!.metadata, {});
  assert.deepEqual(recordings[1]!.formats, [{ type: 'video', url: 'https://x/', length: 1, size: 2 }]);
});

test('getRecordings returns an empty list for an empty <recordings/> element', async () => {
  const { client } = clientWith(() => success('<recordings></recordings><messageKey>noRecordings</messageKey><message>There are no recordings for the meeting(s).</message>'));
  assert.deepEqual(await client.getRecordings({ meetingID: MEETING_ID }), []);
  const { client: selfClosing } = clientWith(() => success('<recordings/>'));
  assert.deepEqual(await selfClosing.getRecordings({ meetingID: MEETING_ID }), []);
  const { client: absent } = clientWith(() => success(''));
  assert.deepEqual(await absent.getRecordings({ states: [] }), []);
});

test('getRecordings handles a processing entry without playback formats', async () => {
  const { client } = clientWith(() => success(`<recordings><recording>
      <recordID>${RECORD_ID}</recordID>
      <meetingID>${MEETING_ID}</meetingID>
      <internalMeetingID>${RECORD_ID}</internalMeetingID>
      <name>Luna lesson</name>
      <published>false</published>
      <state>processing</state>
      <startTime>1786803013476</startTime>
      <endTime>1786803313476</endTime>
      <participants>1</participants>
      <metadata><tenantid>lunar-one</tenantid></metadata>
      <playback></playback>
    </recording></recordings>`));
  const [recording] = await client.getRecordings({ recordID: RECORD_ID, states: ['processing'] });
  assert.equal(recording?.state, 'processing');
  assert.deepEqual(recording?.formats, []);
  assert.equal(recording?.metadata.tenantid, 'lunar-one');
});

test('deleteRecording returns true on SUCCESS and false on notFound', async () => {
  let found = true;
  const { client, exchanges } = clientWith(() => (found
    ? success('<deleted>true</deleted>')
    : failed('notFound', 'We could not find recordings')));
  assert.equal(await client.deleteRecording(RECORD_ID), true);
  assert.equal(exchanges[0]!.url.pathname, '/bigbluebutton/api/deleteRecordings');
  assert.equal(exchanges[0]!.url.searchParams.get('recordID'), RECORD_ID);
  found = false;
  assert.equal(await client.deleteRecording(RECORD_ID), false);
});

test('deleteRecording rethrows other failures and transport errors', async () => {
  const { client } = clientWith(() => new Response('<html>bad gateway</html>', { status: 502 }));
  await assert.rejects(client.deleteRecording(RECORD_ID), (error: unknown) => error instanceof BbbApiError && error.messageKey === 'http502');
  const failing = new BbbClient({
    apiBaseUrl: 'https://bbb.example.com/bigbluebutton/api',
    sharedSecret: 'test-shared-secret',
    checksumAlgorithm: 'sha256',
    timeoutMs: 1000,
  }, async () => { throw new Error('ECONNREFUSED'); });
  await assert.rejects(failing.deleteRecording(RECORD_ID), (error: unknown) => error instanceof BbbApiError && error.messageKey === 'transportError');
});
