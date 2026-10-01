import { loadConfig } from './config.js';

/**
 * Validates the gateway configuration without starting it (used by deploy
 * scripts: `node dist/check-config.js`). Prints a JSON line and exits 0 on
 * success, prints the error message and exits 1 otherwise. Never prints secrets.
 */
try {
  const config = loadConfig();
  console.log(JSON.stringify({ ok: true, tenants: [...config.tenants.keys()] }));
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
