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

const MANIFEST_URL = 'https://meet.ooak.jp/plugins/share-request/manifest.json';

function tenantWithPlugins(pluginManifests: unknown): Record<string, Record<string, unknown>> {
  return { 'lunar-one': { ...tenants({ 'lunar-one': 'lunar-one:' })['lunar-one'], pluginManifests } };
}

test('pluginManifests defaults to an empty list and keeps valid HTTPS URLs', async () => {
  await withStateDir(async (stateDir) => {
    const absent = parseConfig({ version: 1, tenants: tenants({ 'lunar-one': 'lunar-one:' }) }, environment(stateDir));
    assert.deepEqual(absent.tenants.get('lunar-one')?.pluginManifests, []);

    const empty = parseConfig({ version: 1, tenants: tenantWithPlugins([]) }, environment(stateDir));
    assert.deepEqual(empty.tenants.get('lunar-one')?.pluginManifests, []);

    const configured = parseConfig(
      { version: 1, tenants: tenantWithPlugins([MANIFEST_URL, 'https://plugins.example.com/net-report/manifest.json']) },
      environment(stateDir),
    );
    assert.deepEqual(configured.tenants.get('lunar-one')?.pluginManifests, [
      MANIFEST_URL,
      'https://plugins.example.com/net-report/manifest.json',
    ]);
  });
});

test('pluginManifests rejects non-arrays, non-URLs, plain HTTP and URL credentials', async () => {
  await withStateDir(async (stateDir) => {
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenantWithPlugins(MANIFEST_URL) }, environment(stateDir)),
      { message: 'Tenant lunar-one pluginManifests must be an array of URL strings' },
    );
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenantWithPlugins([42]) }, environment(stateDir)),
      { message: 'Tenant lunar-one pluginManifests[0] must be a URL string' },
    );
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenantWithPlugins(['/plugins/share-request/manifest.json']) }, environment(stateDir)),
      { message: 'Tenant lunar-one pluginManifests[0] must be a valid URL' },
    );
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenantWithPlugins([MANIFEST_URL, 'http://meet.ooak.jp/plugins/x/manifest.json']) }, environment(stateDir)),
      { message: 'Tenant lunar-one pluginManifests[1] must use HTTPS' },
    );
    assert.throws(
      () => parseConfig({ version: 1, tenants: tenantWithPlugins(['https://user:secret@meet.ooak.jp/plugins/x/manifest.json']) }, environment(stateDir)),
      { message: 'Tenant lunar-one pluginManifests[0] must not contain URL credentials' },
    );
  });
});

test('pluginManifests allows plain HTTP only with ALLOW_INSECURE_HTTP', async () => {
  await withStateDir(async (stateDir) => {
    const insecure = 'http://localhost:8080/plugins/share-request/manifest.json';
    const config = parseConfig(
      { version: 1, tenants: tenantWithPlugins([insecure]) },
      { ...environment(stateDir), ALLOW_INSECURE_HTTP: 'true' },
    );
    assert.deepEqual(config.tenants.get('lunar-one')?.pluginManifests, [insecure]);
  });
});

test('pluginManifests accepts ten entries and rejects eleven', async () => {
  await withStateDir(async (stateDir) => {
    const ten = Array.from({ length: 10 }, (_, index) => `https://plugins.example.com/plugin-${index}/manifest.json`);
    const config = parseConfig({ version: 1, tenants: tenantWithPlugins(ten) }, environment(stateDir));
    assert.equal(config.tenants.get('lunar-one')?.pluginManifests.length, 10);

    assert.throws(
      () => parseConfig({ version: 1, tenants: tenantWithPlugins([...ten, MANIFEST_URL]) }, environment(stateDir)),
      { message: 'Tenant lunar-one pluginManifests must list at most 10 manifest URLs' },
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
