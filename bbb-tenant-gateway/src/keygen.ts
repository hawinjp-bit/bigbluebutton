import { randomBytes } from 'node:crypto';
import { hashApiKey } from './auth.js';

const tenantId = process.argv[2];
if (!tenantId || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(tenantId)) {
  console.error('Usage: npm run keygen -- <tenant-id>');
  process.exitCode = 1;
} else {
  const apiKey = `bbbtk_${tenantId}_${randomBytes(32).toString('base64url')}`;
  console.log(JSON.stringify({
    tenantId,
    apiKey,
    apiKeySha256: hashApiKey(apiKey),
  }, null, 2));
  console.error('Store apiKey in the tenant secret store. Configure only apiKeySha256 on the gateway.');
}

