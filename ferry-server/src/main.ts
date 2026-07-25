import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ferryHome } from '../../ferry-cli/src/profile.js';
import { buildApp } from './app.js';
import { realEngine } from './engine.js';
import { buildPluginZip } from './plugin-zip.js';
import { Store } from './store.js';

const home = ferryHome();
mkdirSync(home, { recursive: true });
const store = new Store(join(home, 'server.db'));
const recovered = store.recoverInterruptedSyncs();

const pluginDir = fileURLToPath(new URL('../../ferry-plugin', import.meta.url));
const distDir = fileURLToPath(new URL('../../ferry-dashboard/dist', import.meta.url));
const app = buildApp({
  store,
  engine: realEngine(),
  pluginZip: buildPluginZip(pluginDir),
  staticDir: existsSync(distDir) ? distDir : undefined,
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`ferry-server listening on http://127.0.0.1:${port}`);
if (recovered > 0) {
  console.log(`  ${recovered} interrupted sync(s) marked as error after restart`);
}
console.log(existsSync(distDir) ? '  serving dashboard from ferry-dashboard/dist' : '  no dashboard build found — dev mode is `npm --workspace ferry-dashboard run dev`');
