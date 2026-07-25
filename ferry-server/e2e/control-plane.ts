// Plan 3a end-to-end gate: the full spec §1 flow (steps 1–6) against the real
// ferry-prod DDEV fixture, no browser. Preconditions: see the runbook next to this plan.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { realEngine } from '../src/engine.js';
import { Store } from '../src/store.js';

const FIXTURE_DIR = process.env.FERRY_E2E_PROD ?? join(process.env.HOME ?? '', 'ferry-e2e', 'prod');
const SITE_URL = process.env.FERRY_E2E_URL ?? 'https://ferry-prod.ddev.site';
const BUDGET_S = 120; // spec §1 step 6: initial sync < 2 minutes

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

if (!process.env.NODE_EXTRA_CA_CERTS) {
  fail('NODE_EXTRA_CA_CERTS is not set — run: export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"');
}

// Fresh, disposable state for server AND engine; the clone lands under this home too.
process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), 'ferry-e2e-home-'));
console.log(`FERRY_HOME=${process.env.FERRY_HOME}`);

const store = new Store(join(process.env.FERRY_HOME, 'server.db'));
const app = buildApp({ store, engine: realEngine() });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

let cookie = '';
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const started = Date.now();

// 1–2: account + site
let r = await call('POST', '/api/auth/signup', { email: 'e2e@example.com', password: 'e2e-password' });
if (r.status !== 200) fail(`signup: ${r.status} ${JSON.stringify(r.json)}`);
r = await call('POST', '/api/sites', { name: 'Ferry E2E', url: SITE_URL });
if (r.status !== 201) fail(`create site: ${r.status} ${JSON.stringify(r.json)}`);
const siteId = r.json.id as number;

// 3–4: pairing code from the fixture plugin, then pair
const rawPairing = execFileSync(
  'ddev',
  ['wp', 'eval', 'print(json_encode(\\Ferry\\Auth::issue_pairing_code()));'],
  { cwd: FIXTURE_DIR, encoding: 'utf8' },
).trim();
const pairing = JSON.parse(rawPairing.slice(rawPairing.indexOf('{'))) as { code: string };
r = await call('POST', `/api/sites/${siteId}/pair`, { code: pairing.code });
if (r.status !== 200) fail(`pair: ${r.status} ${JSON.stringify(r.json)}`);

// 5: connection test
r = await call('POST', `/api/sites/${siteId}/test`);
if (r.status !== 200) fail(`connection test: ${r.status} ${JSON.stringify(r.json)}`);
console.log(`✔ connection test: WordPress ${r.json.wp}, PHP ${r.json.php}, ${r.json.db}`);

// 6: sync, following SSE (subscribe first — the snapshot must arrive on connect)
const sse = await fetch(`${base}/api/sites/${siteId}/sync/events`, { headers: { cookie } });
if (sse.status !== 200) fail(`SSE connect: ${sse.status}`);
r = await call('POST', `/api/sites/${siteId}/sync`);
if (r.status !== 202) fail(`sync start: ${r.status} ${JSON.stringify(r.json)}`);

const reader = sse.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
const phases: string[] = [];
let final: { status: string; error?: string | null; cloneUrl?: string } | undefined;
while (!final) {
  const { value, done } = await reader.read();
  if (done) fail('SSE stream ended before the sync finished');
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');
  buffer = frames.pop()!;
  for (const frame of frames) {
    if (!frame.startsWith('data: ')) continue;
    const state = JSON.parse(frame.slice(6)) as { status: string; phase?: string; error?: string | null; cloneUrl?: string };
    if (state.phase && phases.at(-1) !== state.phase) {
      phases.push(state.phase);
      console.log(`  phase: ${state.phase}`);
    }
    if (state.status === 'ready' || state.status === 'error') final = state;
  }
}
await reader.cancel();
if (final.status !== 'ready') fail(`sync ended in error: ${final.error}`);

const elapsed = (Date.now() - started) / 1000;
if (elapsed > BUDGET_S) fail(`flow took ${elapsed.toFixed(0)}s — over the ${BUDGET_S}s budget`);

// The secret must never appear in any API response.
r = await call('GET', `/api/sites/${siteId}`);
if (r.status !== 200) fail(`site detail: ${r.status}`);
if (JSON.stringify(r.json).toLowerCase().includes('secret')) fail('site JSON leaks a secret field');
if (r.json.status !== 'ready' || !r.json.verifiedAt) fail(`expected ready+verified, got ${JSON.stringify(r.json)}`);

console.log(`✔ E2E passed in ${elapsed.toFixed(0)}s`);
console.log(`  phases: ${phases.join(' → ')}`);
console.log(`  clone: ${final.cloneUrl} (server-verified)`);
console.log(`  NOTE: clone DDEV project left running for inspection — teardown per the runbook.`);
await app.close();
process.exit(0);
