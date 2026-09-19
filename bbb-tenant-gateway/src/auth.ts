import { createHash, timingSafeEqual } from 'node:crypto';

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function apiKeyMatches(apiKey: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(apiKey), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authorizationHeader);
  return match?.[1];
}

