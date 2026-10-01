import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';

export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null;

export interface StreamFile {
  path: string;
  size: number;
  mtimeMs: number;
  filename: string;
  contentType: string;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
const MAX_FILENAME_LENGTH = 255;

/**
 * Parses a single `Range` header against a resource of `size` bytes.
 *
 * Supported forms: `bytes=start-end`, `bytes=start-`, `bytes=-suffix`.
 * Multiple ranges or anything unparsable returns `null` (the caller
 * answers with the full representation). A range that cannot be satisfied
 * (start past the end, start after end, empty suffix) returns 'unsatisfiable'.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return null;
  if (!Number.isSafeInteger(size) || size < 0) return null;

  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (startRaw === '' && endRaw === '') return null;

  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return 'unsatisfiable';

  if (endRaw === '') return { start, end: size - 1 };
  const end = Number(endRaw);
  if (!Number.isSafeInteger(end)) return null;
  if (start > end) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** Keeps printable ASCII only and escapes the two characters that break a quoted-string. */
export function sanitizeFilename(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\"]/g, (char) => `\\${char}`)
    .slice(0, MAX_FILENAME_LENGTH);
  return ascii.trim() === '' ? 'download' : ascii;
}

function requestIdOf(response: Response): string | undefined {
  const value = response.getHeader('x-request-id');
  return typeof value === 'string' ? value : undefined;
}

function sendJsonError(response: Response, status: number, code: string, message: string): void {
  response.removeHeader('Content-Length');
  response.removeHeader('Content-Disposition');
  response.status(status);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.json({ error: { code, message, requestId: requestIdOf(response) } });
}

/**
 * Streams a file to an Express response with download headers, single-range
 * (206) support, HEAD support and a 416 JSON error for unsatisfiable ranges.
 * Resolves once the response finished or the client went away; never rejects
 * because of the client.
 */
export async function sendFile(request: Request, response: Response, file: StreamFile): Promise<void> {
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', file.contentType);
  response.setHeader('ETag', `"${file.size}-${file.mtimeMs}"`);
  response.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(file.filename)}"`);
  response.setHeader('Cache-Control', 'no-store');

  const range = parseRange(request.headers.range, file.size);
  if (range === 'unsatisfiable') {
    response.setHeader('Content-Range', `bytes */${file.size}`);
    sendJsonError(
      response,
      416,
      'range_not_satisfiable',
      `The requested range cannot be satisfied for a resource of ${file.size} bytes`,
    );
    return;
  }

  let start = 0;
  let end = file.size - 1;
  if (range) {
    start = range.start;
    end = range.end;
    response.status(206);
    response.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  } else {
    response.status(200);
  }

  const length = file.size === 0 ? 0 : end - start + 1;
  response.setHeader('Content-Length', String(length));

  if (request.method === 'HEAD' || length === 0) {
    response.end();
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const stream = createReadStream(file.path, { start, end });

    response.once('finish', settle);
    response.once('close', () => {
      stream.destroy();
      settle();
    });

    stream.once('error', (error: NodeJS.ErrnoException) => {
      if (!response.headersSent) {
        response.removeHeader('Content-Range');
        sendJsonError(response, 500, 'internal_error', 'Unable to read the recording file');
      } else {
        response.destroy(error);
      }
      settle();
    });

    stream.pipe(response);
  });
}
