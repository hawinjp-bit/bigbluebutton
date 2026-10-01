import { createServer, type Server } from 'node:http';
import { BbbClient } from './bbb-client.js';
import { loadConfig } from './config.js';
import { RecordingMonitor } from './recording-monitor.js';
import { createApp, createInternalApp } from './server.js';
import { MeetingStateStore } from './state-store.js';
import { WebhookQueue } from './webhook.js';

function log(line: Record<string, unknown>): void {
  console.log(JSON.stringify(line));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bbb = new BbbClient(config.bbb);

  const store = new MeetingStateStore(config.recording.stateDir);
  await store.load();
  const webhooks = new WebhookQueue({
    stateDir: config.recording.stateDir,
    scheduleMs: config.recording.webhookRetryScheduleMs,
  });
  await webhooks.load();
  const monitor = new RecordingMonitor({ config, bbb, store, webhooks });

  const deps = { bbb, store, webhooks, monitor };
  const publicServer = createServer(createApp(config, deps));
  const internalServer = createServer(createInternalApp(config, deps));

  await listen(publicServer, config.port, config.host);
  await listen(internalServer, config.internalPort, '127.0.0.1');
  monitor.start();

  log({
    level: 'info',
    message: 'BBB tenant gateway started',
    host: config.host,
    port: config.port,
    internalPort: config.internalPort,
    tenants: [...config.tenants.keys()],
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log({ level: 'info', message: 'Shutting down', signal });
    monitor.stop();
    const closeServer = (server: Server, name: string): void => {
      server.close((error) => {
        if (error) {
          console.error(JSON.stringify({ level: 'error', message: error.message, server: name }));
          process.exitCode = 1;
        }
      });
      server.closeIdleConnections();
    };
    closeServer(publicServer, 'public');
    closeServer(internalServer, 'internal');
    // systemd sends SIGKILL after TimeoutStopSec=15; cut in-flight downloads before that so the
    // process exits cleanly (clients resume with Range). unref'd: never keeps an idle process alive.
    const deadline = setTimeout(() => {
      log({ level: 'warn', message: 'Closing in-flight connections' });
      publicServer.closeAllConnections();
      internalServer.closeAllConnections();
    }, 10_000);
    deadline.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: 'error',
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});
