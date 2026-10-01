import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { parseRange, sanitizeFilename, sendFile, type StreamFile } from '../src/stream.js';

const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'); // 36 bytes

test('parseRange handles the documented forms and rejects everything else', () => {
  const size = 100;
  const table: Array<[string | undefined, ReturnType<typeof parseRange>]> = [
    [undefined, null],
    ['', null],
    ['bytes=0-9', { start: 0, end: 9 }],
    ['bytes=10-', { start: 10, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=-500', { start: 0, end: 99 }],
    ['bytes=0-499', { start: 0, end: 99 }],
    ['bytes=99-99', { start: 99, end: 99 }],
    [' bytes=0-1 ', { start: 0, end: 1 }],
    ['bytes=100-', 'unsatisfiable'],
    ['bytes=100-200', 'unsatisfiable'],
    ['bytes=20-10', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=0-1,5-9', null],
    ['bytes=-', null],
    ['bytes=', null],
    ['bytes=a-b', null],
    ['bytes=1-2-3', null],
    ['bytes= 0-1', null],
    ['items=0-1', null],
    ['0-1', null],
    ['bytes=99999999999999999999-', null],
  ];
  for (const [header, expected] of table) {
    assert.deepEqual(parseRange(header, size), expected, `Range: ${String(header)}`);
  }
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
  assert.equal(parseRange('bytes=-1', 0), 'unsatisfiable');
});

test('sanitizeFilename keeps printable ASCII and escapes quotes', () => {
  assert.equal(sanitizeFilename('luna-1-abc.mp4'), 'luna-1-abc.mp4');
  assert.equal(sanitizeFilename('会議-recording.mp4'), '-recording.mp4');
  assert.equal(sanitizeFilename('a"b\\c.mp4'), 'a\\"b\\\\c.mp4');
  assert.equal(sanitizeFilename('new\r\nline.mp4'), 'newline.mp4');
  assert.equal(sanitizeFilename('日本語'), 'download');
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 255);
});

interface Fixture {
  baseUrl: string;
  file: StreamFile;
  resolved: () => number;
  close: () => Promise<void>;
}

async function withFixture(callback: (fixture: Fixture) => Promise<void>, content: Buffer = CONTENT): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bbb-stream-'));
  const path = join(directory, 'video-0.m4v');
  await writeFile(path, content);
  const stats = await stat(path);
  const file: StreamFile = {
    path,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    filename: 'luna-1-rec"1".mp4',
    contentType: 'video/mp4',
  };

  let resolved = 0;
  const app = express();
  const handler: express.RequestHandler = async (request, response) => {
    response.setHeader('x-request-id', 'req-123');
    await sendFile(request, response, file);
    resolved += 1;
  };
  app.route('/download').get(handler).head(handler);
  app.get('/missing', async (request, response) => {
    await sendFile(request, response, { ...file, path: join(directory, 'nope.m4v') });
    resolved += 1;
  });

  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const fixture: Fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    file,
    resolved: () => resolved,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };

  try {
    await callback(fixture);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function settled(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('GET without Range streams the whole file with download headers', async () => {
  await withFixture(async ({ baseUrl, file, resolved }) => {
    const response = await fetch(`${baseUrl}/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-length'), String(CONTENT.length));
    assert.equal(response.headers.get('etag'), `"${file.size}-${file.mtimeMs}"`);
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="luna-1-rec\\"1\\".mp4"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), CONTENT.toString());
    await settled(() => resolved() === 1);
  });
});

test('GET with a satisfiable Range answers 206 with Content-Range', async () => {
  await withFixture(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/download`, { headers: { Range: 'bytes=10-19' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 10-19/${CONTENT.length}`);
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(await response.text(), 'abcdefghij');

    const suffix = await fetch(`${baseUrl}/download`, { headers: { Range: 'bytes=-6' } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), `bytes 30-35/${CONTENT.length}`);
    assert.equal(await suffix.text(), 'uvwxyz');

    const open = await fetch(`${baseUrl}/download`, { headers: { Range: 'bytes=30-' } });
    assert.equal(open.status, 206);
    assert.equal(await open.text(), 'uvwxyz');
  });
});

test('malformed or multi Range headers are ignored (200 full body)', async () => {
  await withFixture(async ({ baseUrl }) => {
    for (const range of ['bytes=0-1,5-9', 'garbage', 'bytes=-']) {
      const response = await fetch(`${baseUrl}/download`, { headers: { Range: range } });
      assert.equal(response.status, 200, `Range: ${range}`);
      assert.equal(await response.text(), CONTENT.toString());
    }
  });
});

test('unsatisfiable Range answers 416 with a JSON error and Content-Range */size', async () => {
  await withFixture(async ({ baseUrl, resolved }) => {
    const response = await fetch(`${baseUrl}/download`, { headers: { Range: 'bytes=500-' } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${CONTENT.length}`);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('content-disposition'), null);
    const body = await response.json() as { error: { code: string; message: string; requestId: string } };
    assert.equal(body.error.code, 'range_not_satisfiable');
    assert.equal(body.error.requestId, 'req-123');
    assert.ok(body.error.message.length > 0);
    await settled(() => resolved() === 1);
  });
});

test('HEAD returns the headers only', async () => {
  await withFixture(async ({ baseUrl, file, resolved }) => {
    const response = await fetch(`${baseUrl}/download`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(CONTENT.length));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('etag'), `"${file.size}-${file.mtimeMs}"`);
    assert.equal(await response.text(), '');

    const ranged = await fetch(`${baseUrl}/download`, { method: 'HEAD', headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-length'), '4');
    assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${CONTENT.length}`);
    assert.equal(await ranged.text(), '');

    const bad = await fetch(`${baseUrl}/download`, { method: 'HEAD', headers: { Range: 'bytes=99-' } });
    assert.equal(bad.status, 416);
    assert.equal(await bad.text(), '');
    await settled(() => resolved() === 3);
  });
});

test('an empty file is served with Content-Length 0', async () => {
  await withFixture(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(await response.text(), '');
    const ranged = await fetch(`${baseUrl}/download`, { headers: { Range: 'bytes=0-' } });
    assert.equal(ranged.status, 416);
  }, Buffer.alloc(0));
});

test('a read error before any byte was sent becomes a 500 JSON error', async () => {
  await withFixture(async ({ baseUrl, resolved }) => {
    const response = await fetch(`${baseUrl}/missing`);
    assert.equal(response.status, 500);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'internal_error');
    await settled(() => resolved() === 1);
  });
});

test('sendFile resolves when the client disconnects mid-stream', async () => {
  const large = Buffer.alloc(4 * 1024 * 1024, 0x61);
  await withFixture(async ({ baseUrl, resolved }) => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/download`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await settled(() => resolved() === 1);
  }, large);
});
