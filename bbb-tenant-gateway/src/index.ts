import { BbbClient } from './bbb-client.js';
import { loadConfig } from './config.js';
import { createApp } from './server.js';

const config = loadConfig();
const bbbClient = new BbbClient(config.bbb);
const app = createApp(config, bbbClient);

const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    level: 'info',
    message: 'BBB tenant gateway started',
    host: config.host,
    port: config.port,
    tenants: [...config.tenants.keys()],
  }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: 'info', message: 'Shutting down', signal }));
  server.close((error) => {
    if (error) {
      console.error(JSON.stringify({ level: 'error', message: error.message }));
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

