import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(segment: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(segment)) return null;
  return Buffer.from(segment, 'base64url');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  return isPlainObject(parsed) ? parsed : null;
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Verifies a compact JWS signed with HMAC-SHA256 and returns its payload.
 *
 * Only `alg: "HS256"` (exact, case-sensitive) is accepted; `none`, RSA and
 * ECDSA algorithms are rejected before any signature work happens. The
 * signature is compared with `crypto.timingSafeEqual`. A numeric `exp`
 * claim at or before `now()` (unix seconds) makes the token invalid.
 * Never throws: every malformed input yields `null`.
 */
export function verifyHs256(
  token: string,
  secret: string,
  now: () => number = defaultNow,
): Record<string, unknown> | null {
  try {
    if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    const header = parseJsonObject(encodedHeader);
    if (!header || header.alg !== 'HS256') return null;

    const signature = decodeBase64Url(encodedSignature);
    if (!signature || signature.length === 0) return null;

    const expected = createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`, 'utf8')
      .digest();
    if (expected.length !== signature.length) return null;
    if (!timingSafeEqual(expected, signature)) return null;

    const payload = parseJsonObject(encodedPayload);
    if (!payload) return null;

    const exp = payload.exp;
    if (typeof exp === 'number' && (!Number.isFinite(exp) || exp <= now())) return null;

    return payload;
  } catch {
    return null;
  }
}
