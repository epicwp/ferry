import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../ferry-server/src/app.js';
import { realEngine } from '../../ferry-server/src/engine.js';
import { buildPluginZip } from '../../ferry-server/src/plugin-zip.js';
import { Store } from '../../ferry-server/src/store.js';

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), 'ferry-dash-e2e-'));
if (!process.env.NODE_EXTRA_CA_CERTS) {
  console.warn('NODE_EXTRA_CA_CERTS is not set — the sync happy path will fail clone verification.');
}

const store = new Store(join(process.env.FERRY_HOME, 'server.db'));
const pluginDir = fileURLToPath(new URL('../../ferry-plugin', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const app = buildApp({ store, engine: realEngine(), pluginZip: buildPluginZip(pluginDir), staticDir: distDir });
await app.listen({ port: 4173, host: '127.0.0.1' });
console.log(`dashboard e2e server on http://127.0.0.1:4173 (FERRY_HOME=${process.env.FERRY_HOME})`);
