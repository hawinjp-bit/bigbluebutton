import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyHs256 } from '../src/jwt.js';

const SECRET = 'test-bbb-shared-secret-0123456789';

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function sign(encodedHeader: string, encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
}

function makeToken(header: unknown, payload: unknown, secret = SECRET): string {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  return `${encodedHeader}.${encodedPayload}.${sign(encodedHeader, encodedPayload, secret)}`;
}

const PAYLOAD = { meeting_id: 'lunar-one:luna-abc', record_id: 'a'.repeat(40) + '-1700000000000' };
const now = () => 1_700_000_000;

test('accepts a valid HS256 token and returns its payload', () => {
  const token = makeToken({ alg: 'HS256', typ: 'JWT' }, PAYLOAD);
  assert.deepEqual(verifyHs256(token, SECRET, now), PAYLOAD);
});

test('rejects a token signed with another secret', () => {
  const token = makeToken({ alg: 'HS256', typ: 'JWT' }, PAYLOAD, 'another-secret-value-9876543210');
  assert.equal(verifyHs256(token, SECRET, now), null);
});

test('rejects a tampered payload', () => {
  const [header, , signature] = makeToken({ alg: 'HS256', typ: 'JWT' }, PAYLOAD).split('.');
  const tampered = `${header}.${base64url(JSON.stringify({ ...PAYLOAD, record_id: 'other' }))}.${signature}`;
  assert.equal(verifyHs256(tampered, SECRET, now), null);
});

test('rejects alg none even with an empty or arbitrary signature', () => {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(PAYLOAD));
  assert.equal(verifyHs256(`${header}.${payload}.`, SECRET, now), null);
  assert.equal(verifyHs256(`${header}.${payload}.${base64url('x')}`, SECRET, now), null);
});

test('rejects every algorithm that is not exactly HS256', () => {
  for (const alg of ['hs256', 'HS384', 'HS512', 'RS256', 'ES256', 'None', '', undefined]) {
    const token = makeToken({ alg, typ: 'JWT' }, PAYLOAD);
    assert.equal(verifyHs256(token, SECRET, now), null, `alg ${String(alg)} must be rejected`);
  }
});

test('rejects a signature of a different length', () => {
  const [header, payload, signature] = makeToken({ alg: 'HS256' }, PAYLOAD).split('.');
  assert.equal(verifyHs256(`${header}.${payload}.${signature}${signature}`, SECRET, now), null);
  assert.equal(verifyHs256(`${header}.${payload}.${signature!.slice(0, 10)}`, SECRET, now), null);
});

test('honours exp when present', () => {
  const expired = makeToken({ alg: 'HS256' }, { ...PAYLOAD, exp: now() });
  assert.equal(verifyHs256(expired, SECRET, now), null);
  const past = makeToken({ alg: 'HS256' }, { ...PAYLOAD, exp: now() - 1 });
  assert.equal(verifyHs256(past, SECRET, now), null);
  const future = makeToken({ alg: 'HS256' }, { ...PAYLOAD, exp: now() + 60 });
  assert.deepEqual(verifyHs256(future, SECRET, now), { ...PAYLOAD, exp: now() + 60 });
  const nonNumeric = makeToken({ alg: 'HS256' }, { ...PAYLOAD, exp: 'later' });
  assert.deepEqual(verifyHs256(nonNumeric, SECRET, now), { ...PAYLOAD, exp: 'later' });
});

test('uses the wall clock by default', () => {
  const expired = makeToken({ alg: 'HS256' }, { ...PAYLOAD, exp: 1 });
  assert.equal(verifyHs256(expired, SECRET), null);
  const valid = makeToken({ alg: 'HS256' }, { ...PAYLOAD, exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.ok(verifyHs256(valid, SECRET));
});

test('requires the payload to be a JSON object', () => {
  const header = base64url(JSON.stringify({ alg: 'HS256' }));
  for (const raw of ['[1,2]', '"text"', '42', 'null', 'not json']) {
    const payload = base64url(raw);
    const token = `${header}.${payload}.${sign(header, payload, SECRET)}`;
    assert.equal(verifyHs256(token, SECRET, now), null, `payload ${raw} must be rejected`);
  }
});

test('never throws on malformed input', () => {
  const header = base64url(JSON.stringify({ alg: 'HS256' }));
  const payload = base64url(JSON.stringify(PAYLOAD));
  const cases = [
    '',
    'abc',
    'a.b',
    'a.b.c.d',
    `${header}.${payload}`,
    `${header}.${payload}.`,
    `..`,
    `${base64url('not json')}.${payload}.${sign(base64url('not json'), payload, SECRET)}`,
    `${header}.${payload}.!!!invalid-chars!!!`,
    `${header}.${payload}.${sign(header, payload, SECRET)}=`,
  ];
  for (const token of cases) {
    assert.equal(verifyHs256(token, SECRET, now), null, `token ${JSON.stringify(token)} must be rejected`);
  }
  assert.equal(verifyHs256(makeToken({ alg: 'HS256' }, PAYLOAD), '', now), null);
  assert.equal(verifyHs256(undefined as unknown as string, SECRET, now), null);
});
