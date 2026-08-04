import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ferryHome, loadProfile } from '../../ferry-cli/src/profile.js';
import { buildApp } from './app.js';
import { ensureAgentBranch } from './agent/branch.js';
import type { AgentManager } from './agent/manager.js';
import { sdkRunner } from './agent/sdk-runner.js';
import { ChangeService, type CreateChangeInput } from './changes.js';
import { applyEnvFile } from './env-file.js';
import { realEngine, realPushRunner } from './engine.js';
import { buildPluginZip } from './plugin-zip.js';
import { Store } from './store.js';

// Optional git-ignored .env at the repo root (ANTHROPIC_API_KEY etc.); shell env wins.
applyEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));

const home = ferryHome();
mkdirSync(home, { recursive: true });
const store = new Store(join(home, 'server.db'));
const recovered = store.recoverInterruptedSyncs();
store.recoverInterruptedAgentSessions();

const cloneDir = (slug: string) => join(ferryHome(), 'clones', slug);

// create_change needs the live AgentManager for appendSystemEvent's SSE fan-out, but
// AgentManager isn't constructed until buildApp() runs (from the runner built below) —
// filled in via AppDeps.agent.onManagerReady, read here through a closure over this box.
let agentManager: AgentManager | undefined;
const changeService = new ChangeService(store, {
  cloneDir,
  appendSystemEvent: (siteId, type, payload) => agentManager?.appendSystemEvent(siteId, type, payload),
  prefixFor: (slug) => loadProfile(slug).info?.prefix ?? 'wp_',
});

const agentDepsForMain = process.env.ANTHROPIC_API_KEY
  ? {
      runner: sdkRunner(
        {
          model: process.env.FERRY_AGENT_MODEL ?? 'sonnet',
          maxTurns: Number(process.env.FERRY_AGENT_MAX_TURNS ?? 50),
          maxBudgetUsd: Number(process.env.FERRY_AGENT_MAX_BUDGET_USD ?? 5),
          configDir: join(ferryHome(), 'agent'),
        },
        {
          createChange: (slug, input) => {
            const site = store.siteBySlug(slug);
            if (!site) throw new Error(`create_change: unknown site "${slug}".`);
            // The tool call's ops/preconditions arrive as untyped JSON (CreateChangeToolInput);
            // ChangeService.create() re-validates their runtime shape before trusting them.
            return changeService.create(site, input as unknown as CreateChangeInput);
          },
        },
      ),
      cloneDir,
      ensureBranch: ensureAgentBranch,
      idleMs: Number(process.env.FERRY_AGENT_IDLE_MS ?? 30 * 60_000),
      onManagerReady: (m: AgentManager) => { agentManager = m; },
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
  push: { runner: realPushRunner() },
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`ferry-server listening on http://127.0.0.1:${port}`);
if (recovered > 0) {
  console.log(`  ${recovered} interrupted sync(s) marked as error after restart`);
}
console.log(existsSync(distDir) ? '  serving dashboard from ferry-dashboard/dist' : '  no dashboard build found — dev mode is `npm --workspace ferry-dashboard run dev`');
