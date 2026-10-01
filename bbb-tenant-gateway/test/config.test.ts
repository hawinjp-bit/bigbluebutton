import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashApiKey } from '../src/auth.js';
import { parseConfig } from '../src/config.js';

function environment(stateDir: string): NodeJS.ProcessEnv {
  return {
    BBB_API_BASE: 'https://bbb.example.com/bigbluebutton/api',
    BBB_SECRET: 'test-secret',
    STATE_DIRECTORY: stateDir,
  };
}

function tenants(prefixes: Record<string, string>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [id, meetingIdPrefix] of Object.entries(prefixes)) {
    result[id] = { apiKeySha256: hashApiKey(`bbbtk_${id}_key`), meetingIdPrefix };
  }
  return result;
}

async function withStateDir(callback: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bbb-config-'));
  try {
    await callback(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('rejects a meetingIdPrefix that is a prefix of another tenant\'s', async () => {
  await withStateDir(async (stateDir) => {
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenants({ 'lunar-one': 'lunar-one:', 'lunar-two': 'lunar-one:x' }) }, environment(stateDir)),
      { message: 'Tenant lunar-one meetingIdPrefix "lunar-one:" overlaps tenant lunar-two meetingIdPrefix "lunar-one:x"' },
    );
    // The other direction is caught as well (the longer prefix listed first).
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenants({ 'lunar-two': 'lunar-one:x', 'lunar-one': 'lunar-one:' }) }, environment(stateDir)),
      /overlaps/,
    );
    // Exact duplicates keep their dedicated message.
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenants({ 'tenant-a': 'shared:', 'tenant-b': 'shared:' }) }, environment(stateDir)),
      /Duplicate meetingIdPrefix/,
    );
  });
});

test('accepts prefixes that merely share leading characters', async () => {
  await withStateDir(async (stateDir) => {
    const config = parseConfig(
      { version: 1, tenants: tenants({ 'lunar-one': 'lunar-one:', 'lunar-one-staging': 'lunar-one-staging:' }) },
      environment(stateDir),
    );
    assert.deepEqual([...config.tenants.keys()], ['lunar-one', 'lunar-one-staging']);
    assert.equal(config.tenants.get('lunar-one-staging')?.meetingIdPrefix, 'lunar-one-staging:');
  });
});
