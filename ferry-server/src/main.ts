import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ferryHome } from '../../ferry-cli/src/profile.js';
import { buildApp } from './app.js';
import { ensureAgentBranch } from './agent/branch.js';
import { sdkRunner } from './agent/sdk-runner.js';
import { realEngine } from './engine.js';
import { buildPluginZip } from './plugin-zip.js';
import { Store } from './store.js';

const home = ferryHome();
mkdirSync(home, { recursive: true });
const store = new Store(join(home, 'server.db'));
const recovered = store.recoverInterruptedSyncs();
store.recoverInterruptedAgentSessions();

const agentDepsForMain = process.env.ANTHROPIC_API_KEY
  ? {
      runner: sdkRunner({
        model: process.env.FERRY_AGENT_MODEL ?? 'sonnet',
        maxTurns: Number(process.env.FERRY_AGENT_MAX_TURNS ?? 50),
        maxBudgetUsd: Number(process.env.FERRY_AGENT_MAX_BUDGET_USD ?? 5),
        configDir: join(ferryHome(), 'agent'),
      }),
      cloneDir: (slug: string) => join(ferryHome(), 'clones', slug),
      ensureBranch: ensureAgentBranch,
      idleMs: Number(process.env.FERRY_AGENT_IDLE_MS ?? 30 * 60_000),
    }
  : undefined;
if (!agentDepsForMain) {
  console.warn('ANTHROPIC_API_KEY is not set — agent chat is disabled.');
}

const pluginDir = fileURLToPath(new URL('../../ferry-plugin', import.meta.url));
const distDir = fileURLToPath(new URL('../../ferry-dashboard/dist', import.meta.url));
const app = buildApp({
  store,
  engine: realEngine(),
  pluginZip: buildPluginZip(pluginDir),
  staticDir: existsSync(distDir) ? distDir : undefined,
  agent: agentDepsForMain,
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`ferry-server listening on http://127.0.0.1:${port}`);
if (recovered > 0) {
  console.log(`  ${recovered} interrupted sync(s) marked as error after restart`);
}
console.log(existsSync(distDir) ? '  serving dashboard from ferry-dashboard/dist' : '  no dashboard build found — dev mode is `npm --workspace ferry-dashboard run dev`');
