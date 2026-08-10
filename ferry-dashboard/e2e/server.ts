import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../ferry-server/src/app.js';
import type { AgentManager } from '../../ferry-server/src/agent/manager.js';
import { ensureAgentBranch } from '../../ferry-server/src/agent/branch.js';
import { scriptedRunner } from '../../ferry-server/src/agent/scripted-runner.js';
import { realEngine } from '../../ferry-server/src/engine.js';
import { buildPluginZip } from '../../ferry-server/src/plugin-zip.js';
import { scriptedPushRunner } from '../../ferry-server/src/push/scripted-push-runner.js';
import type { Conflict, PushRunner, SmokeResult } from '../../ferry-server/src/push/types.js';
import { Store, type ChangeStatus } from '../../ferry-server/src/store.js';

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), 'ferry-dash-e2e-'));
if (!process.env.NODE_EXTRA_CA_CERTS) {
  console.warn('NODE_EXTRA_CA_CERTS is not set — the sync happy path will fail clone verification.');
}

/** Site-slug-dispatched scripts: one server boot serves every scenario. The slug comes from
 *  the site URL the test creates (e.g. https://conflict-shop.example.com). */
function e2ePushRunner(): PushRunner {
  const runnerFor = (slug: string): PushRunner =>
    slug.includes('conflict') ? scriptedPushRunner({ conflictOn: 'drift' })
    : slug.includes('smokefail') ? scriptedPushRunner({ smokeFails: true })
    : scriptedPushRunner();
  return {
    push: (slug, spec, opts) => runnerFor(slug).push(slug, spec, opts),
    rollback: (slug, opts) => runnerFor(slug).rollback(slug, opts),
    txStatus: (slug, txid) => runnerFor(slug).txStatus(slug, txid),
    async hashes(slug, paths) {
      if (slug.includes('driftedpreview')) return Object.fromEntries(paths.map((p) => [p, 'drifted']));
      return Object.fromEntries(paths.map((p) => [p, `scripted-${p}`]));
    },
  };
}

const store = new Store(join(process.env.FERRY_HOME, 'server.db'));
const pluginDir = fileURLToPath(new URL('../../ferry-plugin', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
let agentManager: AgentManager | undefined;
const app = buildApp({
  store,
  engine: realEngine(),
  pluginZip: buildPluginZip(pluginDir),
  staticDir: distDir,
  // The chat e2e uses the scripted runner (no tokens spent); ensureBranch is real —
  // the happy-path sync produces a real clone with a production branch.
  agent: {
    runner: scriptedRunner(),
    cloneDir: (slug: string) => join(process.env.FERRY_HOME!, 'clones', slug),
    ensureBranch: ensureAgentBranch,
    idleMs: 60_000,
    onManagerReady: (m: AgentManager) => { agentManager = m; },
  },
  push: { runner: e2ePushRunner() },
});

// Design-fixture default (screens 6–12 storyline): two files + one option op. oldHash uses the
// scripted-hashes formula so the drift preview reads "unchanged" unless a test wants otherwise.
const VAT_DIFF = [
  'diff --git a/wp-content/themes/wasgeurtje/functions.php b/wp-content/themes/wasgeurtje/functions.php',
  '--- a/wp-content/themes/wasgeurtje/functions.php',
  '+++ b/wp-content/themes/wasgeurtje/functions.php',
  '@@ -408,13 +408,4 @@',
  " add_action('init', 'wasgeurtje_setup');",
  "-add_filter('woocommerce_calc_tax', 'wg_extra_vat', 20, 3);",
  '-function wg_extra_vat($taxes, $price, $rates) {',
  '-  if ($price > 100) $taxes[1] = $price * 0.21;',
  '-  return $taxes;',
  '-}',
  '+// duplicate VAT hook removed — Woo already adds 21% (Ferry CHANGE-0001)',
  " add_action('wp_enqueue_scripts', 'wg_assets');",
  'diff --git a/wp-content/mu-plugins/woocommerce-tax-overrides.php b/wp-content/mu-plugins/woocommerce-tax-overrides.php',
  '--- a/wp-content/mu-plugins/woocommerce-tax-overrides.php',
  '+++ b/wp-content/mu-plugins/woocommerce-tax-overrides.php',
  '@@ -86,5 +86,6 @@',
  "-$threshold_mode = 'excl';",
  '+// follow the global Woo setting instead of hardcoding',
  "+$threshold_mode = get_option('woocommerce_tax_display_cart');",
].join('\n');

const VAT_FIXTURE = {
  title: 'VAT calculation fixed',
  summary: 'The wrong VAT on orders above €100 was caused by an incorrect setting plus a bug in the theme. I have fixed both.',
  branch: 'agent/work',
  baseSha: 'a3f19c2a3f19c2a3f19c2a3f19c2a3f19c2a3f1',
  headSha: 'f4b81adf4b81adf4b81adf4b81adf4b81adf4b8',
  diffText: VAT_DIFF,
  files: [
    { path: 'wp-content/themes/wasgeurtje/functions.php', oldHash: 'scripted-wp-content/themes/wasgeurtje/functions.php', newHash: 'aaaa' },
    { path: 'wp-content/mu-plugins/woocommerce-tax-overrides.php', oldHash: 'scripted-wp-content/mu-plugins/woocommerce-tax-overrides.php', newHash: 'bbbb' },
  ],
  ops: [{ kind: 'option_set' as const, name: 'woocommerce_tax_display_cart', old: 'incl', new: 'excl' }],
  preconditions: [{ type: 'option' as const, name: 'woocommerce_tax_display_cart', expected: 'incl' }],
  smoke: [
    { label: 'Checkout — VAT on a €120 order is correct', path: '/checkout', expectStatus: 200 },
    { label: 'Order list loads without PHP warnings', path: '/wp-admin/edit.php', expectStatus: 200 },
    { label: 'Product page renders', path: '/product/sample', expectStatus: 200 },
  ],
};

interface SeedBody {
  siteId: number;
  fields?: Partial<typeof VAT_FIXTURE>;
  status?: ChangeStatus;
  conflict?: Conflict[];
  smokeResult?: SmokeResult[];
  backupTxid?: string;
  prodRef?: string;
  emitCard?: boolean;
}

// Test-only seam: exists ONLY in this e2e server, never in app.ts — the product has no way to
// create a change outside the agent's create_change tool.
app.post('/e2e/changes', async (request) => {
  const body = request.body as SeedBody;
  const change = store.createChange(body.siteId, { ...VAT_FIXTURE, ...body.fields });
  if (body.status && body.status !== 'draft') {
    store.setChangeStatus(change.id, body.status, {
      conflict: body.conflict ?? (body.status === 'conflict'
        ? [{ key: 'wp_options · woocommerce_tax_display_cart', expected: 'incl', found: 'excl' }]
        : null),
      backupTxid: body.backupTxid ?? 'a3f19c2b'.repeat(4),
      prodRef: body.prodRef ?? (body.status === 'pushed' ? 'f4b81ad' : null),
      pushedAt: body.status === 'pushed' || body.status === 'rolled_back' ? new Date().toISOString() : undefined,
      rolledBackAt: body.status === 'rolled_back' ? new Date().toISOString() : undefined,
      smokeResult: body.smokeResult ?? (body.status === 'pushed'
        ? [
            { label: 'Checkout — VAT on a €120 order is correct', ok: true, detail: '€24.79' },
            { label: 'Order list loads without PHP warnings', ok: true, detail: '200' },
            { label: 'Product page renders', ok: true, detail: '200 · 340ms' },
          ]
        : null),
    });
  }
  if (body.emitCard) {
    agentManager?.appendSystemEvent(body.siteId, 'change_card', {
      changeId: change.id, seq: change.seq, title: change.title, status: change.status,
    });
  }
  return store.changeById(change.id);
});

await app.listen({ port: 4173, host: '127.0.0.1' });
console.log(`dashboard e2e server on http://127.0.0.1:4173 (FERRY_HOME=${process.env.FERRY_HOME})`);
