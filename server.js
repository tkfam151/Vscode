import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { config } from './src/config.js';
import { openDb } from './src/db.js';
import { createDriver } from './src/drivers.js';
import { WorkspaceManager } from './src/workspaces.js';
import { createApp } from './src/api.js';

const store = openDb(config.dataDir);
const driver = createDriver(config);

try {
  await driver.init();
} catch (e) {
  console.error(`[classcode] ${e.message}`);
  process.exit(1);
}

const manager = new WorkspaceManager({ config, driver });
const app = createApp({ config, store, manager });

const server =
  config.scheme === 'https'
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, app)
    : http.createServer(app);

server.listen(config.port, config.host, () => {
  const shown = config.publicHost || (config.host === '0.0.0.0' ? '<this-machine-ip>' : config.host);
  console.log(`[classcode] dashboard:   ${config.scheme}://${shown}:${config.port}`);
  console.log(`[classcode] workspaces:  ports ${config.portStart}-${config.portStart + config.portCount - 1} (${config.driver} driver)`);
  console.log(`[classcode] idle timeout: ${Math.round(config.idleMs / 60_000)} min`);
  if (config.scheme === 'http') {
    console.log('[classcode] note: running over plain HTTP. Set TLS_CERT/TLS_KEY for HTTPS (needed for clipboard and webviews in VS Code).');
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[classcode] shutting down, closing workspaces...');
  server.close();
  await manager.shutdown();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
