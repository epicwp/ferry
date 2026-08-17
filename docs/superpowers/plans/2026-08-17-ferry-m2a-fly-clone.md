# Ferry M2a — Fly-native Clone Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One demo WordPress site works end-to-end ON FLY — pull → browsable clone at `https://ferry-s-….fly.dev` → agent chat with edits visible on the clone → journal → push → rollback — while local DDEV development stays byte-identical.

**Architecture:** A `FlyEnv` implements the existing `CloneEnv` interface by talking to a small HMAC-authenticated daemon ("sited") inside a per-site Fly Machine over 6PN private networking. The machine runs a single `ferry-site-runtime` image (Apache+PHP from the WordPress base image, matching the production PHP minor via a tag matrix, + MariaDB + wp-cli + sited under supervisord). Clone files, git, and the agent stay on the control plane; `deployFiles` ships the docroot to the machine after pull and after each agent turn. `FERRY_CLONE_ENV=ddev|fly` selects the env (default `ddev`).

**Tech Stack:** Fastify (sited), undici, `tar` npm lib, Fly Machines REST API (`api.machines.dev`) + one GraphQL mutation (IP allocation), Docker (wordpress base + mariadb + supervisord), GitHub Actions matrix build → GHCR.

**Spec:** `docs/superpowers/specs/2026-08-17-ferry-m2-fly-clone-design.md` (covers M2a+M2b; this plan implements the M2a half). Its §12 spike items are resolved by Task 1 of this plan.

## Global Constraints

- **Local behavior unchanged:** `FERRY_CLONE_ENV` unset or `ddev` → everything works exactly as today. The DDEV e2e suites remain THE merge gate. All suites stay green: plugin 216, cli 146+new, server 226+new, dashboard e2e 18, sited (new), four typechecks (cli, server, dashboard, sited).
- **No secrets in git** — the sited secret is generated per site at provision and lives only in `profile.json` (on the ferry-cp volume) and the machine's `files`; the org-scoped Fly token and `ANTHROPIC_API_KEY` are Fly secrets set in Task 15.
- **CloneEnv gains exactly three members** (`showColumns`, `deployFiles`, `destroy`) — both envs and both test FakeEnvs implement all of them; DdevEnv's `deployFiles`/`destroy` are deliberate no-ops (local behavior today).
- **PHP parity:** supported image tags `php8.1 php8.2 php8.3 php8.4`; `provision()` picks from `info.php.version`; a mismatch maps to the nearest tag and MUST surface as a sync progress detail (spec §2), never silently.
- **sited protocol:** HMAC-SHA256 over `METHOD\npath\nsortedQuery\nsha256hex(body)\nUNIXts\nnonce` (body-HASH, unlike the plugin canonical which embeds the body — dumps/tars are streamed from disk). Headers `x-ferry-timestamp`, `x-ferry-nonce`, `x-ferry-signature`. Timestamp window ±300 s; nonces single-use per process.
- **Execution branch:** `feat/fly-m2a` off current `main`. Tasks 2–14 are normal TDD tasks; Tasks 1, 15, 16 are interactive (Robbert: org token, demo site).
- **Do not touch** push/rollback (`ferry-cli/src/push.ts`), the plugin, or the M1 deploy pipeline, except where a task names them.

---

### Task 1: Live Fly spike (INTERACTIVE — needs an org-scoped token from Robbert)

Resolves the spec's §12 verification points against the real platform before any code depends on them. Output = a committed findings doc; any throwaway apps are destroyed.

**Files:**
- Create: `docs/superpowers/specs/2026-08-17-m2a-spike-findings.md`

**Interfaces:**
- Consumes: a temporary org-scoped token — Robbert runs `fly tokens create org -x 48h` (short-lived; the durable one comes in Task 15).
- Produces: verified request shapes and constants that Tasks 6–8 and 12–13 embed: the working IP-allocation call, machine-create config (files/services/guest/mounts), GHCR pull behavior, 6PN timing, memory fit.

- [ ] **Step 1:** With `FLY_API_TOKEN=<org token>`, create a throwaway app + volume + machine via raw `curl` against `https://api.machines.dev/v1` (NOT flyctl — we are validating the API path FlyEnv will use):

```bash
export FLY_API_TOKEN=…   # org-scoped, from Robbert, never committed
H() { curl -fsS -H "Authorization: Bearer $FLY_API_TOKEN" -H "Content-Type: application/json" "$@"; }
H -X POST https://api.machines.dev/v1/apps -d '{"app_name":"ferry-m2a-spike","org_slug":"personal"}'
H -X POST https://api.machines.dev/v1/apps/ferry-m2a-spike/volumes -d '{"name":"data","size_gb":3,"region":"ams"}'
# machine: public wordpress image, volume at /data, services 80/443, a files entry, 1GB guest
H -X POST https://api.machines.dev/v1/apps/ferry-m2a-spike/machines -d '{
  "region":"ams",
  "config":{
    "image":"registry-1.docker.io/library/wordpress:php8.2-apache",
    "guest":{"cpu_kind":"shared","cpus":1,"memory_mb":1024},
    "mounts":[{"volume":"<vol id from previous call>","path":"/data"}],
    "files":[{"guest_path":"/etc/ferry/spike-test","raw_value":"aGVsbG8="}],
    "services":[{"protocol":"tcp","internal_port":80,"ports":[{"port":80,"handlers":["http"]},{"port":443,"handlers":["tls","http"]}]}],
    "restart":{"policy":"always"}
  }}'
```

- [ ] **Step 2:** Find the working IP-allocation call for API-created apps. Try the GraphQL mutation first (`https://api.fly.io/graphql`):

```bash
curl -fsS https://api.fly.io/graphql -H "Authorization: Bearer $FLY_API_TOKEN" -H "Content-Type: application/json" -d '{
  "query":"mutation($input: AllocateIPAddressInput!){allocateIpAddress(input:$input){ipAddress{address type}}}",
  "variables":{"input":{"appId":"ferry-m2a-spike","type":"shared_v4"}}}'
# repeat with "type":"v6"
```
If the mutation name/shape differs, iterate with GraphQL introspection (`{"query":"{__schema{mutationType{fields{name}}}}"`) until shared v4 + dedicated v6 allocate. Record the exact working call verbatim.

- [ ] **Step 3:** Verify: (a) `https://ferry-m2a-spike.fly.dev` serves the WordPress installer over TLS; (b) from the ferry-cp machine (`fly ssh console -a ferry-cp`), `curl http://<machine-id>.vm.ferry-m2a-spike.internal:80` answers over 6PN — time how soon after machine `started` it responds (retry loop granularity); (c) `fly ssh console -a ferry-m2a-spike -C "cat /etc/ferry/spike-test"` prints `hello` (files field works); (d) memory: `fly ssh console -a ferry-m2a-spike -C "free -m"` — record headroom with Apache+PHP alone, note whether 1 GB leaves ≥300 MB for MariaDB or the plan must bump to 2 GB (adjust Task 8's `memory_mb` accordingly).
- [ ] **Step 4:** Verify GHCR pull: create a second throwaway machine with `"image":"ghcr.io/epicwp/<any public image, e.g. push a hello-world to ghcr first>"` — confirm Fly pulls public GHCR images unauthenticated. If GHCR fails, test `registry.fly.io` cross-app pull with the org token as the fallback and record which path Task 13 must use.
- [ ] **Step 5:** Write ALL findings (exact working calls, timings, memory numbers, chosen registry) to the findings doc; destroy everything (`H -X DELETE https://api.machines.dev/v1/apps/ferry-m2a-spike?force=true`, same for the second app); commit.

```bash
git add docs/superpowers/specs/2026-08-17-m2a-spike-findings.md
git commit -m "docs: M2a spike findings — Machines API, IP allocation, GHCR, 6PN timing"
```

---

### Task 2: CloneEnv extension + journal through the seam

Adds `showColumns` / `deployFiles` / `destroy` to the interface, moves `SHOW COLUMNS` parsing into the env, and gives `journalCandidates` its first tests.

**Files:**
- Modify: `ferry-cli/src/env/ddev.ts:42-49` (interface), `:51-99` (DdevEnv)
- Modify: `ferry-cli/src/journal.ts:176-188` (remove parseShowColumns), `:216-221` (use the seam), `:10` (remove `run` if now unused)
- Modify: `ferry-cli/tests/pull.test.ts:15-39` (FakeEnv), `ferry-cli/tests/progress.test.ts:12-27` (FakeEnv)
- Test: `ferry-cli/tests/ddev.test.ts` (append), `ferry-cli/tests/journal.test.ts` (append)

**Interfaces:**
- Consumes: current `CloneEnv` (`ddev.ts:42-49`), `TableColumns` (currently private in journal.ts).
- Produces (later tasks rely on these EXACT signatures):
  - `export interface TableColumns { fields: string[]; pkCols: string[] }` (moves to `ddev.ts`)
  - `CloneEnv.showColumns(clonePath: string, table: string): Promise<TableColumns>`
  - `CloneEnv.deployFiles(clonePath: string): Promise<void>`
  - `CloneEnv.destroy(name: string): Promise<void>`
  - `export function parseShowColumns(stdout: string): TableColumns` (moves to `ddev.ts`)

- [ ] **Step 1: Write the failing tests**

Append to `ferry-cli/tests/ddev.test.ts` (it already imports from `../src/env/ddev.js`):

```ts
import { parseShowColumns } from '../src/env/ddev.js';

describe('parseShowColumns', () => {
  it('reads fields and composite PKs from tab-separated SHOW COLUMNS output', () => {
    const out = 'Field\tType\tNull\tKey\tDefault\tExtra\n' +
      'option_id\tbigint\tNO\tPRI\t\tauto_increment\n' +
      'option_name\tvarchar(191)\tNO\tUNI\t\t\n';
    expect(parseShowColumns(out)).toEqual({ fields: ['option_id', 'option_name'], pkCols: ['option_id'] });
  });
});
```

Append to `ferry-cli/tests/journal.test.ts` — the FIRST test of `journalCandidates` (it has none today). Build a fake env and a profile in a temp `FERRY_HOME`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journalCandidates } from '../src/journal.js';
import { saveProfile } from '../src/profile.js';
import type { CloneEnv, TableColumns } from '../src/env/ddev.js';

const RAW = [
  "### UPDATE `db`.`wp_options`",
  '### WHERE',
  '###   @1=7',
  "###   @2='blogname'",
  "###   @3='Old'",
  '### SET',
  '###   @1=7',
  "###   @2='blogname'",
  "###   @3='New'",
].join('\n');

class JournalFakeEnv implements CloneEnv {
  columnsAsked: string[] = [];
  async provision(): Promise<void> {}
  async importDb(): Promise<void> {}
  async createAdmin(): Promise<{ user: string; password: string }> { return { user: 'u', password: 'p' }; }
  url(name: string): string { return `https://${name}.example`; }
  async binlogPosition(): Promise<{ file: string; position: number }> { return { file: 'f', position: 4 }; }
  async extractBinlog(): Promise<string> { return RAW; }
  async showColumns(_clonePath: string, table: string): Promise<TableColumns> {
    this.columnsAsked.push(table);
    return { fields: ['option_id', 'option_name', 'option_value'], pkCols: ['option_id'] };
  }
  async deployFiles(): Promise<void> {}
  async destroy(): Promise<void> {}
}

describe('journalCandidates', () => {
  it('resolves columns through the env seam and classifies the op', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ferry-journal-'));
    process.env.FERRY_HOME = home;
    try {
      saveProfile({
        url: 'https://prod.example', secret: 's', slug: 'jtest',
        clonePath: join(home, 'clones', 'jtest'),
        info: { prefix: 'wp_' } as never,
        binlog: { file: 'f', position: 4 },
      });
      const env = new JournalFakeEnv();
      const result = await journalCandidates('jtest', env);
      expect(env.columnsAsked).toEqual(['wp_options']);
      expect(result.ops).toHaveLength(1);
      expect(result.refusedCount).toBe(0);
    } finally {
      delete process.env.FERRY_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

(Adapt the `saveProfile` shape to the real `SiteProfile` type if the compiler objects — `info` only needs `prefix` for this path. If `classify` treats a `wp_options` UPDATE of `blogname` as refused/noise rather than an op, assert on THAT observed outcome instead — the load-bearing assertions are `columnsAsked` and "no throw"; check `classify`'s rules in `journal.ts` and pin the true expectation.)

- [ ] **Step 2: Run to verify failure**

Run: `npm --workspace ferry-cli run test -- tests/ddev.test.ts tests/journal.test.ts`
Expected: FAIL — `parseShowColumns` not exported; FakeEnv missing `showColumns` (type error).

- [ ] **Step 3: Implement**

In `ferry-cli/src/env/ddev.ts`:

1. Add above the interface:

```ts
export interface TableColumns {
  fields: string[];
  pkCols: string[];
}

/** `SHOW COLUMNS FROM <table>` is `Field\tType\tNull\tKey\tDefault\tExtra` - Key='PRI' marks a
 *  primary-key column (every column of a composite key is marked, not just one). */
export function parseShowColumns(stdout: string): TableColumns {
  const lines = stdout.trim().split('\n').slice(1).filter((l) => l.length > 0);
  const fields: string[] = [];
  const pkCols: string[] = [];
  for (const line of lines) {
    const [field, , , key] = line.split('\t');
    fields.push(field);
    if (key === 'PRI') pkCols.push(field);
  }
  return { fields, pkCols };
}
```

2. Extend the interface (after `extractBinlog`):

```ts
  showColumns(clonePath: string, table: string): Promise<TableColumns>;
  /** Ship the docroot to wherever the clone is served. Local envs serve in place: no-op. */
  deployFiles(clonePath: string): Promise<void>;
  /** Tear down everything provision() created for this clone name. */
  destroy(name: string): Promise<void>;
```

3. Implement on `DdevEnv` (after `extractBinlog`, same `run` helper):

```ts
  async showColumns(clonePath: string, table: string): Promise<TableColumns> {
    const { stdout } = await run('ddev', ['mysql', '-e', `SHOW COLUMNS FROM ${table}`], { cwd: clonePath });
    return parseShowColumns(stdout);
  }

  async deployFiles(): Promise<void> {} // DDEV serves the docroot in place

  async destroy(): Promise<void> {} // matches today's behavior: site delete never removed DDEV projects
```

In `ferry-cli/src/journal.ts`: delete the local `parseShowColumns` and `TableColumns` (import both from `./env/ddev.js` — keep `TableColumns` imported as a type where `parseBinlog` references it); replace lines 216-221 with:

```ts
  // SHOW COLUMNS is async (goes through the env), so resolve every touched table's columns before parsing.
  const columnCache = new Map<string, TableColumns>();
  for (const table of tablesInRaw(raw)) {
    columnCache.set(table, await env.showColumns(docroot, table));
  }
```

Remove journal.ts's `run`/`execFile`/`promisify` imports if `showColumns` was their last use (check with the compiler).

Update BOTH FakeEnvs (`ferry-cli/tests/pull.test.ts:15-39`, `ferry-cli/tests/progress.test.ts:12-27`) with the three new members:

```ts
  async showColumns(): Promise<TableColumns> { return { fields: [], pkCols: [] }; }
  async deployFiles(): Promise<void> { this.calls.push('deployFiles'); }
  async destroy(): Promise<void> {}
```

(progress.test's FakeEnv has no `calls` array — plain no-op there; import `TableColumns` type in both.)

- [ ] **Step 4: Run to verify pass**

Run: `npm --workspace ferry-cli run test` and `npm --workspace ferry-cli run typecheck`
Expected: all cli tests pass (146 + new), typecheck clean. Also run `npm --workspace ferry-server run typecheck` — the server imports these files by relative path and must still compile.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/env/ddev.ts ferry-cli/src/journal.ts ferry-cli/tests/ddev.test.ts ferry-cli/tests/journal.test.ts ferry-cli/tests/pull.test.ts ferry-cli/tests/progress.test.ts
git commit -m "feat(cli): CloneEnv gains showColumns/deployFiles/destroy; journal fully behind the seam"
```

---

### Task 3: Env selection + seam threading (pull, engine, main)

`FERRY_CLONE_ENV` picks the env once in `main.ts`; the engine and pull actually use the injected env (today `engine.pull` drops it); `deployFiles` runs at the right moment; the parity note surfaces in sync progress.

**Files:**
- Create: `ferry-cli/src/env/index.ts`
- Modify: `ferry-server/src/env-config.ts` (add `cloneEnvKind`), `ferry-server/src/engine.ts:29-31,40-50,70-77,82-84`, `ferry-cli/src/pull.ts:101-106`, `ferry-cli/src/profile.ts:20-27` (SiteProfile.flySited), `ferry-server/src/main.ts`
- Test: `ferry-server/tests/env-config.test.ts` (append), `ferry-cli/tests/pull.test.ts` (append), `ferry-server/tests/engine.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's `CloneEnv` members.
- Produces:
  - `env-config.ts`: `export type CloneEnvKind = 'ddev' | 'fly'; export function cloneEnvKind(env: NodeJS.ProcessEnv): CloneEnvKind` (unset/''/'ddev' → `'ddev'`; `'fly'` → `'fly'`; anything else throws).
  - `ferry-cli/src/env/index.ts`: `export function cloneEnv(kind: 'ddev' | 'fly'): CloneEnv` (Task 8 makes the `'fly'` branch real; until then it throws `new Error('FlyEnv arrives in a later task')` — Tasks 3–7 only exercise `'ddev'`).
  - `RealEngineOptions.env?: CloneEnv` — engine threads it into `pull(slug, { env }, opts)` and `cloneUrl`.
  - `SiteProfile.flySited?: { app: string; machineId: string; volumeId: string; secret: string; parityNote?: string }`.

- [ ] **Step 1: Write the failing tests**

`ferry-server/tests/env-config.test.ts` append:

```ts
import { cloneEnvKind } from '../src/env-config.js';

describe('cloneEnvKind', () => {
  it("defaults to ddev for unset/empty/'ddev'", () => {
    expect(cloneEnvKind({})).toBe('ddev');
    expect(cloneEnvKind({ FERRY_CLONE_ENV: '' })).toBe('ddev');
    expect(cloneEnvKind({ FERRY_CLONE_ENV: 'ddev' })).toBe('ddev');
  });
  it("accepts 'fly'", () => {
    expect(cloneEnvKind({ FERRY_CLONE_ENV: 'fly' })).toBe('fly');
  });
  it('throws on anything else', () => {
    expect(() => cloneEnvKind({ FERRY_CLONE_ENV: 'docker' })).toThrow(/FERRY_CLONE_ENV/);
  });
});
```

`ferry-cli/tests/pull.test.ts` — extend an existing FakeEnv-based pull test (or add one following the file's existing setup pattern with `startMockPlugin`) to assert ordering:

```ts
expect(fake.calls).toEqual(['provision', 'deployFiles', 'importDb', 'binlogPosition', 'createAdmin']);
```

(The FakeEnv from Task 2 already records `deployFiles` in `calls`. `provision` is first because pull kicks it off before the transport; the join guarantees it settled before deployFiles.)

`ferry-server/tests/engine.test.ts` append — prove the engine passes the injected env through to `cloneUrl` (the observable seam without running a full pull):

```ts
import { realEngine } from '../src/engine.js';
import type { CloneEnv } from '../../ferry-cli/src/env/ddev.js';

it('cloneUrl comes from the injected env', () => {
  const env = { url: (n: string) => `https://${n}.custom.example` } as unknown as CloneEnv;
  const engine = realEngine({ env });
  expect(engine.cloneUrl('mysite')).toBe('https://mysite.custom.example');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm --workspace ferry-server run test -- tests/env-config.test.ts tests/engine.test.ts && npm --workspace ferry-cli run test -- tests/pull.test.ts`
Expected: FAIL — `cloneEnvKind` missing; `RealEngineOptions.env` unknown; pull ordering lacks `deployFiles`.

- [ ] **Step 3: Implement**

`ferry-server/src/env-config.ts` append:

```ts
export type CloneEnvKind = 'ddev' | 'fly';

export function cloneEnvKind(env: NodeJS.ProcessEnv): CloneEnvKind {
  const raw = env.FERRY_CLONE_ENV;
  if (raw === undefined || raw === '' || raw === 'ddev') return 'ddev';
  if (raw === 'fly') return 'fly';
  throw new Error(`FERRY_CLONE_ENV must be "ddev" or "fly", got "${raw}"`);
}
```

`ferry-cli/src/env/index.ts` (new):

```ts
import { DdevEnv, type CloneEnv } from './ddev.js';

/** Factory over the clone-substrate implementations. The 'fly' branch lands with FlyEnv. */
export function cloneEnv(kind: 'ddev' | 'fly'): CloneEnv {
  if (kind === 'fly') throw new Error('FlyEnv arrives in a later task');
  return new DdevEnv();
}
```

`ferry-cli/src/profile.ts` — extend `SiteProfile`:

```ts
  /** Fly-substrate state written by FlyEnv.provision(); absent for local DDEV clones. */
  flySited?: { app: string; machineId: string; volumeId: string; secret: string; parityNote?: string };
```

`ferry-cli/src/pull.ts` — after `await envReady;` (line 101), before `importDb`:

```ts
  await envReady;                                         // join (§4.6)
  await env.deployFiles(docroot);                         // remote substrates serve a shipped copy; local: no-op
  const postProvision = loadProfile(slug);
  if (postProvision.flySited?.parityNote) progress({ phase: 'import', detail: postProvision.flySited.parityNote });
  await env.importDb(docroot, dump);
```

`ferry-server/src/engine.ts`:

```ts
export interface RealEngineOptions {
  verifyFetch?: VerifyFetch;
  env?: CloneEnv; // clone substrate; defaults to DDEV (local dev)
}
```

In `realEngine`: replace `const env = new DdevEnv();` with `const env = opts.env ?? new DdevEnv();`, and change `pull(slug, {}, opts)` (line 49) to `pull(slug, { env }, pullOpts)` (keep the existing parameter name for the pull options — read the surrounding lines and preserve them). Import `type CloneEnv` from the ddev module. In `verifyClone`'s TLS-error branch (`:70-77`), gate the mkcert/`NODE_EXTRA_CA_CERTS` hint on the URL: only append that hint when `url.includes('.ddev.site')`; otherwise the message is the generic TLS error text.

`ferry-server/src/main.ts` — construct once and thread (final wiring for the fly branch lands in Task 9; this task wires the factory):

```ts
import { cloneEnv } from '../../ferry-cli/src/env/index.js';
import { accountCap, cloneEnvKind, listenHost, secureCookies } from './env-config.js';
// …
const envKind = cloneEnvKind(process.env);
const substrate = cloneEnv(envKind);
// …
const app = buildApp({
  store,
  engine: realEngine({ env: substrate }),
  // … rest unchanged
```

- [ ] **Step 4: Run to verify pass**

Run: `npm --workspace ferry-cli run test && npm --workspace ferry-server run test && npm --workspace ferry-cli run typecheck && npm --workspace ferry-server run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/env/index.ts ferry-cli/src/pull.ts ferry-cli/src/profile.ts ferry-server/src/env-config.ts ferry-server/src/engine.ts ferry-server/src/main.ts ferry-server/tests/env-config.test.ts ferry-server/tests/engine.test.ts ferry-cli/tests/pull.test.ts
git commit -m "feat: FERRY_CLONE_ENV selection; engine/pull thread the injected CloneEnv; deployFiles joins the pull flow"
```

---

### Task 4: ferry-sited workspace — signed transport + /health + /sql

New workspace: the in-machine daemon. This task delivers the request-verification core and the two read endpoints.

**Files:**
- Create: `ferry-sited/package.json`, `ferry-sited/tsconfig.json`, `ferry-sited/src/verify.ts`, `ferry-sited/src/app.ts`, `ferry-sited/src/main.ts`
- Modify: `package.json` (root — add `"ferry-sited"` to `workspaces`)
- Test: `ferry-sited/tests/verify.test.ts`, `ferry-sited/tests/sql.test.ts`

**Interfaces:**
- Consumes: `canonical`-style HMAC signing idea from `ferry-cli/src/signing.ts` (sited defines its own body-HASH canonical — see Global Constraints; do NOT import ferry-cli from sited: sited ships alone into the site image).
- Produces (Tasks 5–7 rely on):
  - `sitedCanonical(method: string, path: string, query: Record<string,string>, bodySha256Hex: string, timestamp: number, nonce: string): string`
  - `verifySited` Fastify preHandler factory: `makeVerify(secret: string): preHandler` — 401 on bad signature, 401 on |now−ts|>300 s, 401 on nonce replay.
  - `buildSited(deps: SitedDeps): FastifyInstance` where
    `interface SitedDeps { secret: string; docroot: string; exec: (cmd: string, args: string[], opts?: { input?: Buffer; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }> }`
  - Routes this task: `GET /health` (unsigned, `{ok:true}`), `POST /sql` (signed; body `{kind:'binlog-status'}` → `{file, position}`; body `{kind:'show-columns', table}` → `{fields, pkCols}`; table validated `/^[A-Za-z0-9_]+$/` else 400).
- sited runs its SQL via `deps.exec('mysql', ['db', '-e', <stmt>])` (the image's MariaDB has database/user `db`, Task 12); `binlog-status` parses the same two-column tab output DdevEnv parses (`ddev.ts:82-84` pattern), `show-columns` reuses the `parseShowColumns` LOGIC — copy the function into `ferry-sited/src/app.ts` with a comment naming its origin (sited cannot import ferry-cli).

- [ ] **Step 1: Scaffold the workspace**

`ferry-sited/package.json`:

```json
{
  "name": "ferry-sited",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "tar": "^7.4.0"
  },
  "devDependencies": {
    "tsx": "^4.23.1",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`ferry-sited/tsconfig.json` — copy `ferry-server/tsconfig.json` and adjust `include` to `["src/**/*.ts", "tests/**/*.ts"]` (keep `noEmit: true`). Add `"ferry-sited"` to the root `package.json` `workspaces` array. Run `npm install` at the root to settle the lockfile (this is the ONE permitted lockfile change; commit it with this task).

- [ ] **Step 2: Write the failing tests**

`ferry-sited/tests/verify.test.ts`:

```ts
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSited, sitedCanonical, type SitedDeps } from '../src/app.js';

const SECRET = 'test-secret';
const okExec: SitedDeps['exec'] = async () => ({ stdout: '', stderr: '', exitCode: 0 });

function signedHeaders(method: string, path: string, body: string, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  const nonce = randomBytes(8).toString('hex');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', SECRET).update(sitedCanonical(method, path, {}, bodyHash, ts, nonce)).digest('hex');
  return { 'x-ferry-timestamp': String(ts), 'x-ferry-nonce': nonce, 'x-ferry-signature': sig, 'content-type': 'application/json' };
}

describe('sited transport', () => {
  it('health is open and empty', async () => {
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec: okExec });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects a missing or wrong signature with 401', async () => {
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec: okExec });
    let res = await app.inject({ method: 'POST', url: '/sql', payload: { kind: 'binlog-status' } });
    expect(res.statusCode).toBe(401);
    const headers = signedHeaders('POST', '/sql', JSON.stringify({ kind: 'binlog-status' }));
    headers['x-ferry-signature'] = 'deadbeef';
    res = await app.inject({ method: 'POST', url: '/sql', headers, payload: { kind: 'binlog-status' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects stale timestamps and replayed nonces', async () => {
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec: okExec });
    const body = JSON.stringify({ kind: 'binlog-status' });
    const stale = signedHeaders('POST', '/sql', body, Math.floor(Date.now() / 1000) - 600);
    expect((await app.inject({ method: 'POST', url: '/sql', headers: stale, payload: body })).statusCode).toBe(401);
    const fresh = signedHeaders('POST', '/sql', body);
    expect((await app.inject({ method: 'POST', url: '/sql', headers: fresh, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/sql', headers: fresh, payload: body })).statusCode).toBe(401); // replay
  });
});
```

`ferry-sited/tests/sql.test.ts`:

```ts
describe('POST /sql', () => {
  it('binlog-status parses the SHOW BINLOG STATUS table', async () => {
    const exec: SitedDeps['exec'] = async (cmd, args) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db', '-e', 'SHOW BINLOG STATUS']);
      return { stdout: 'File\tPosition\tBinlog_Do_DB\nferry-bin.000002\t1234\t\n', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const res = await inject(app, 'POST', '/sql', { kind: 'binlog-status' }); // signed-inject helper as in verify.test
    expect(res.json()).toEqual({ file: 'ferry-bin.000002', position: 1234 });
  });

  it('show-columns validates the table name and parses columns', async () => {
    const exec: SitedDeps['exec'] = async (_c, args) => {
      expect(args[2]).toBe('SHOW COLUMNS FROM wp_options');
      return { stdout: 'Field\tType\tNull\tKey\tDefault\tExtra\noption_id\tbigint\tNO\tPRI\t\tauto\n', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const ok = await inject(app, 'POST', '/sql', { kind: 'show-columns', table: 'wp_options' });
    expect(ok.json()).toEqual({ fields: ['option_id'], pkCols: ['option_id'] });
    const bad = await inject(app, 'POST', '/sql', { kind: 'show-columns', table: 'wp_options; DROP TABLE x' });
    expect(bad.statusCode).toBe(400);
  });
});
```

(Extract the signed-inject helper into `ferry-sited/tests/helpers.ts` and use it in both files — it wraps `signedHeaders` + `app.inject`.)

- [ ] **Step 3: Run to verify failure** — `npm --workspace ferry-sited run test` → cannot resolve `../src/app.js`.

- [ ] **Step 4: Implement**

`ferry-sited/src/verify.ts`:

```ts
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const WINDOW_S = 300;
const MAX_NONCES = 10_000;

export function sitedCanonical(
  method: string,
  path: string,
  query: Record<string, string>,
  bodySha256Hex: string,
  timestamp: number,
  nonce: string,
): string {
  const pairs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`);
  return `${method.toUpperCase()}\n${path}\n${pairs.join('&')}\n${bodySha256Hex}\n${timestamp}\n${nonce}`;
}

/** Signed-request gate. The canonical embeds a body HASH (not the body) so multi-MB
 *  tar/sql payloads can be hashed streaming on the client without double-buffering. */
export function makeVerify(secret: string) {
  const seen = new Set<string>();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ts = Number(request.headers['x-ferry-timestamp']);
    const nonce = String(request.headers['x-ferry-nonce'] ?? '');
    const sig = String(request.headers['x-ferry-signature'] ?? '');
    const deny = () => reply.code(401).send({ error: 'unauthorized' });
    if (!Number.isFinite(ts) || nonce === '' || sig === '') return deny();
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > WINDOW_S) return deny();
    if (seen.has(nonce)) return deny();
    const rawBody = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    const url = new URL(request.url, 'http://sited.local');
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const expected = createHmac('sha256', secret)
      .update(sitedCanonical(request.method, url.pathname, query, bodyHash, ts, nonce))
      .digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny();
    if (seen.size >= MAX_NONCES) seen.clear(); // bounded memory; window check still limits replay
    seen.add(nonce);
  };
}
```

`ferry-sited/src/app.ts` — Fastify instance with a raw-body content-type parser (signature needs exact bytes):

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { makeVerify } from './verify.js';
export { sitedCanonical } from './verify.js';

export interface SitedDeps {
  secret: string;
  docroot: string;
  exec: (cmd: string, args: string[], opts?: { input?: Buffer; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const TABLE_RE = /^[A-Za-z0-9_]+$/;

// Origin: ferry-cli/src/env/ddev.ts parseShowColumns — sited ships alone into the site image, so the logic is copied.
function parseShowColumns(stdout: string): { fields: string[]; pkCols: string[] } {
  const lines = stdout.trim().split('\n').slice(1).filter((l) => l.length > 0);
  const fields: string[] = [];
  const pkCols: string[] = [];
  for (const line of lines) {
    const [field, , , key] = line.split('\t');
    fields.push(field);
    if (key === 'PRI') pkCols.push(field);
  }
  return { fields, pkCols };
}

export function buildSited(deps: SitedDeps): FastifyInstance {
  const app = Fastify({ bodyLimit: 1024 * 1024 * 1024 }); // dumps/tars run to hundreds of MB
  // Every body arrives as raw bytes; routes parse JSON themselves after verification.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  const verify = makeVerify(deps.secret);

  app.get('/health', async () => ({ ok: true }));

  app.post('/sql', { preHandler: verify }, async (request, reply) => {
    const body = JSON.parse((request.body as Buffer).toString('utf8') || '{}') as { kind?: string; table?: string };
    if (body.kind === 'binlog-status') {
      const { stdout, exitCode, stderr } = await deps.exec('mysql', ['db', '-e', 'SHOW BINLOG STATUS']);
      if (exitCode !== 0) return reply.code(500).send({ error: stderr.slice(0, 500) });
      const row = stdout.trim().split('\n')[1]?.split('\t');
      if (!row || row.length < 2) return reply.code(500).send({ error: 'unexpected SHOW BINLOG STATUS output' });
      return { file: row[0], position: Number(row[1]) };
    }
    if (body.kind === 'show-columns') {
      if (!body.table || !TABLE_RE.test(body.table)) return reply.code(400).send({ error: 'invalid table' });
      const { stdout, exitCode, stderr } = await deps.exec('mysql', ['db', '-e', `SHOW COLUMNS FROM ${body.table}`]);
      if (exitCode !== 0) return reply.code(500).send({ error: stderr.slice(0, 500) });
      return parseShowColumns(stdout);
    }
    return reply.code(400).send({ error: 'unknown kind' });
  });

  return app;
}
```

`ferry-sited/src/main.ts`:

```ts
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSited, type SitedDeps } from './app.js';

const exec: SitedDeps['exec'] = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
    });
    if (opts.input !== undefined) { child.stdin?.write(opts.input); child.stdin?.end(); }
  });

const secret = readFileSync(process.env.SITED_SECRET_FILE ?? '/etc/ferry/sited-secret', 'utf8').trim();
const app = buildSited({ secret, docroot: process.env.SITED_DOCROOT ?? '/data/www', exec });
const port = Number(process.env.SITED_PORT ?? 2323);
const host = process.env.SITED_HOST ?? 'fly-local-6pn';
await app.listen({ port, host });
console.log(`sited listening on ${host}:${port}`);
```

- [ ] **Step 5: Run to verify pass** — `npm --workspace ferry-sited run test && npm --workspace ferry-sited run typecheck`. Expected: all green.
- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json ferry-sited/
git commit -m "feat(sited): new workspace — signed transport (body-hash HMAC, nonce window) + /health + /sql"
```

---

### Task 5: sited — /wp, /db/import, /files

The three write endpoints, all behind the Task-4 verifier.

**Files:**
- Modify: `ferry-sited/src/app.ts`
- Test: `ferry-sited/tests/wp.test.ts`, `ferry-sited/tests/import.test.ts`, `ferry-sited/tests/files.test.ts`

**Interfaces:**
- Produces (Task 7's FlyEnv calls these):
  - `POST /wp` body `{argv: string[]}` → `{stdout, stderr, exitCode}`; runs `deps.exec('wp', ['--path=' + deps.docroot, '--allow-root', ...argv], { timeoutMs: 120_000 })`.
  - `POST /db/import` body = raw SQL bytes → pipes to `deps.exec('mysql', ['db'], { input: body })`; 204 on exit 0, 500 with stderr excerpt otherwise.
  - `PUT /files` body = gzipped tar of the docroot (paths relative, no leading `/`, no `..`) → extract to `<docroot>.new`, swap: `rm -rf <docroot>.old; mv <docroot> <docroot>.old; mv <docroot>.new <docroot>; rm -rf <docroot>.old`; 204. Traversal entries → 400 and nothing applied. (Replace-swap gives delete semantics without tracking state; a brief serve blip is acceptable in M2a.)

- [ ] **Step 1: Write the failing tests** — three files, using the Task-4 signed-inject helper. Key cases (write them all out in the test files with real tar fixtures built via the `tar` lib in-test):

```ts
// wp.test.ts
it('runs wp with --path and returns the exec triple', async () => { /* exec asserts argv prefix ['--path=/tmp/www','--allow-root','plugin','list'] */ });
it('caps runtime via timeoutMs 120000', async () => { /* exec records opts.timeoutMs */ });

// import.test.ts
it('pipes the raw body into mysql db and returns 204', async () => { /* exec asserts cmd 'mysql', args ['db'], opts.input equals the sent SQL bytes */ });
it('propagates a failing import as 500 with stderr excerpt', async () => {});

// files.test.ts
it('replaces the docroot atomically from a tar.gz and removes files absent from the tar', async () => {
  // seed docroot with old.txt; tar contains only index.php; after PUT: index.php exists, old.txt gone
});
it('rejects .. and absolute entries with 400 and leaves the docroot untouched', async () => {});
```

- [ ] **Step 2: Run to verify failure** — routes 404.
- [ ] **Step 3: Implement** in `ferry-sited/src/app.ts` (inside `buildSited`, after `/sql`):

```ts
  app.post('/wp', { preHandler: verify }, async (request) => {
    const body = JSON.parse((request.body as Buffer).toString('utf8') || '{}') as { argv?: string[] };
    const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
    return deps.exec('wp', [`--path=${deps.docroot}`, '--allow-root', ...argv], { timeoutMs: 120_000 });
  });

  app.post('/db/import', { preHandler: verify }, async (request, reply) => {
    const sql = request.body as Buffer;
    const { exitCode, stderr } = await deps.exec('mysql', ['db'], { input: sql, timeoutMs: 600_000 });
    if (exitCode !== 0) return reply.code(500).send({ error: stderr.slice(0, 500) });
    return reply.code(204).send();
  });

  app.put('/files', { preHandler: verify }, async (request, reply) => {
    const tarball = request.body as Buffer;
    const next = `${deps.docroot}.new`;
    const old = `${deps.docroot}.old`;
    await fsp.rm(next, { recursive: true, force: true });
    await fsp.mkdir(next, { recursive: true });
    try {
      await extractTar(tarball, next); // tar.x with a filter: reject entries with '..' segments or absolute paths by throwing
    } catch (err) {
      await fsp.rm(next, { recursive: true, force: true });
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'bad archive' });
    }
    await fsp.rm(old, { recursive: true, force: true });
    await fsp.rename(deps.docroot, old).catch(() => {}); // first deploy: docroot may not exist yet
    await fsp.rename(next, deps.docroot);
    await fsp.rm(old, { recursive: true, force: true });
    return reply.code(204).send();
  });
```

with an `extractTar(buffer, dest)` helper at module level using the `tar` package's `t`/`x` streams fed from a `Readable.from(buffer)`, `filter`/`onentry` rejecting any entry whose path is absolute or contains a `..` segment (throw → caught above). Import `fsp` from `node:fs/promises` and `Readable` from `node:stream`.

- [ ] **Step 4: Run to verify pass** — `npm --workspace ferry-sited run test && npm --workspace ferry-sited run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add ferry-sited/src/app.ts ferry-sited/tests/
git commit -m "feat(sited): /wp, /db/import, /files replace-swap with traversal guard"
```

---

### Task 6: fly-api — Machines/GraphQL client

A thin, fully-injectable HTTP client for the platform calls FlyEnv makes. Request shapes come from Task 1's findings doc — read it before implementing and adjust the literals below to what the spike verified.

**Files:**
- Create: `ferry-cli/src/env/fly-api.ts`
- Test: `ferry-cli/tests/fly-api.test.ts`

**Interfaces:**
- Produces (Task 8 consumes):

```ts
export interface FlyApiConfig { token: string; apiBase?: string; graphqlBase?: string } // defaults https://api.machines.dev/v1, https://api.fly.io/graphql
export interface FlyFetch { (url: string, init: { method: string; headers: Record<string,string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }> }
export class FlyApi {
  constructor(cfg: FlyApiConfig, fetchImpl?: FlyFetch); // default wraps undici request
  createApp(name: string, org: string): Promise<void>;
  allocateIps(app: string): Promise<void>;               // shared v4 + v6, exact GraphQL from spike findings
  createVolume(app: string, name: string, region: string, sizeGb: number): Promise<{ id: string }>;
  createMachine(app: string, region: string, config: Record<string, unknown>): Promise<{ id: string }>;
  waitStarted(app: string, machineId: string): Promise<void>;  // GET …/wait?state=started&timeout=60
  destroyApp(app: string): Promise<void>;                // DELETE /apps/{app}?force=true
}
```

- [ ] **Step 1: Write the failing tests** — a fake `FlyFetch` records `{url, method, body}` per call and returns canned responses; one test per method asserting the exact URL, bearer header, and body shape (copy the shapes from the spike findings doc; the volume test asserts the returned `{id}` is surfaced; `waitStarted` test asserts the wait URL; `destroyApp` asserts `?force=true`). Also: any non-2xx status → thrown Error containing the status and URL.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — constructor stores config; each method builds the request per the spike findings; default `fetchImpl` wraps `undici.request` (ferry-cli already depends on undici). Non-2xx → `throw new Error(\`fly api ${method} ${url} → ${status}\`)`.
- [ ] **Step 4: Run to verify pass** — `npm --workspace ferry-cli run test -- tests/fly-api.test.ts` + cli typecheck.
- [ ] **Step 5: Commit** — `feat(cli): FlyApi client for Machines API + IP allocation`.

---### Task 7: FlyEnv — sited client + CloneEnv data methods

FlyEnv's half that talks to sited. Tested against a REAL `buildSited` instance listening on localhost with a test secret — the fake IS the daemon, so protocol drift between client and server is impossible.

**Files:**
- Create: `ferry-cli/src/env/fly.ts`
- Test: `ferry-cli/tests/fly-env.test.ts`

**Interfaces:**
- Consumes: `sitedCanonical` semantics (Task 4 — FlyEnv implements the SAME canonical locally; copy the function into `fly.ts` with an origin comment, keeping sited dependency-free), `SiteProfile.flySited` (Task 3), `TableColumns` (Task 2).
- Produces:

```ts
export interface FlyEnvConfig {
  token: string; org: string; region: string; imageRepo: string;      // e.g. ghcr.io/epicwp/ferry-site-runtime
  sitedPort?: number;                                                  // default 2323
  sitedBaseFor?: (app: string, machineId: string) => string;           // test seam; default http://<machineId>.vm.<app>.internal:<port>
  api?: FlyApi;                                                        // test seam
}
export function flyConfigFromEnv(env: NodeJS.ProcessEnv): FlyEnvConfig; // FERRY_FLY_TOKEN (required), FERRY_FLY_ORG (default 'personal'), FERRY_FLY_REGION (default 'ams'), FERRY_SITE_RUNTIME_IMAGE (required); throws naming the missing var
export class FlyEnv implements CloneEnv {
  constructor(cfg: FlyEnvConfig);
  // CloneEnv members (this task: all except provision/destroy which land in Task 8)
  runWp(clonePath: string, argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>; // extra, not on CloneEnv — the agent's wp tool (Task 9)
  static appName(slug: string): string; // `ferry-s-${slug.slice(0,30)}-${sha256hex('ferry-site:'+slug).slice(0,6)}`, lowercased
}
```
- Slug from clonePath: `basename(clonePath)` (clone dirs are `FERRY_HOME/clones/<slug>`). Profile access via `loadProfile(slug)` for `flySited.{app,machineId,secret}` — every data method throws a clear error if `flySited` is absent ("site has no Fly machine — pull/provision first").

- [ ] **Step 1: Write the failing tests** — spin a real sited: `const sited = buildSited({secret, docroot: tmpWww, exec: fakeExec}); await sited.listen({port: 0, host: '127.0.0.1'})`; point FlyEnv at it via `sitedBaseFor: () => \`http://127.0.0.1:${port}\``; seed a temp `FERRY_HOME` profile with `flySited: {app:'a', machineId:'m', volumeId:'v', secret}`. Cases (write them out):

```ts
it('appName is deterministic, ≤63 chars, and slug-prefixed', …);
it('url() derives from appName synchronously', …);          // https://<appName>.fly.dev
it('showColumns round-trips through sited /sql', …);         // fakeExec returns SHOW COLUMNS output → {fields, pkCols}
it('binlogPosition round-trips through sited /sql', …);
it('importDb streams the dump file body to /db/import', …);  // write dump.sql in tmp; fakeExec asserts received input bytes
it('createAdmin drives wp user create via /wp and returns the credentials it generated', …); // FlyEnv generates the password client-side like DdevEnv (ddev.ts:66-73) and passes it in argv
it('extractBinlog fetches /binlog output', …);               // see note below — GET /binlog is added to sited in this task
it('deployFiles tars the docroot (excluding .git) and PUTs /files', …); // seed clone dir with files + .git/x; sited extracts to tmpWww; assert .git absent, files present
it('runWp forwards argv', …);
it('signed requests fail against a wrong secret (401 surfaces as thrown error)', …);
```

- [ ] **Step 2:** sited needs the one endpoint Task 4/5 did not add — append to `ferry-sited/src/app.ts` (and a test in `ferry-sited/tests/sql.test.ts`): `GET /binlog?file=<f>&position=<n>` (signed) → `deps.exec('mysqlbinlog', ['--no-defaults', '--base64-output=decode-rows', '-v', `--start-position=${position}`, `/data/mysql/${file}`], {timeoutMs: 120_000})` with `file` validated `/^[A-Za-z0-9.\-]+$/` (400 otherwise); returns `{stdout}`. (Path `/data/mysql` matches Task 12's datadir.)
- [ ] **Step 3: Run to verify failure**, then **implement `fly.ts`**: the signed-fetch helper (undici; canonical copy; sha256 body streaming from file for `importDb` — hash pass over the file stream, then send with `fs.createReadStream`; for in-memory tars, hash the buffer), the CloneEnv data methods mapping 1:1 onto sited endpoints, `deployFiles` building the tar with the `tar` lib (`tar.c({gzip: true, cwd: clonePath, filter: p => p !== '.git' && !p.startsWith('.git/')}, ['.'])` collected to a buffer), `createAdmin` generating `randomBytes(9).toString('base64url')` and calling `/wp` with `['user','create','ferry-admin','ferry-admin@ferry.local','--role=administrator',`--user_pass=${password}`]` — non-zero exit that is not "already exists" throws.
- [ ] **Step 4: Run to verify pass** — cli suite + sited suite + both typechecks.
- [ ] **Step 5: Commit** — `feat(cli): FlyEnv data path — signed sited client, deployFiles tar, wp bridge; sited /binlog`.

---

### Task 8: FlyEnv — provision + destroy + factory wiring

**Files:**
- Modify: `ferry-cli/src/env/fly.ts`, `ferry-cli/src/env/index.ts`
- Test: `ferry-cli/tests/fly-env.test.ts` (append)

**Interfaces:**
- Consumes: `FlyApi` (Task 6), spike findings (machine config), `SiteProfile.flySited` (Task 3).
- Produces: working `provision(clonePath, info, name)` / `destroy(name)`; `cloneEnv('fly')` returns `new FlyEnv(flyConfigFromEnv(process.env))`.

- [ ] **Step 1: Write the failing tests** (fake FlyApi records calls; fake sited for the health poll):

```ts
it('provision creates app → ips → volume → machine → waits → polls sited health → saves flySited to the profile', …);
it('provision picks the image tag from info.php.version (8.2.15 → :php8.2)', …);
it('an unsupported PHP minor maps to the nearest tag and records parityNote', …); // e.g. 7.4 → php8.1 + note text contains both versions
it('provision is idempotent when flySited already exists and the machine responds (no duplicate create calls)', …);
it('destroy calls FlyApi.destroyApp with the derived app name and clears flySited', …);
it('the machine config carries the sited secret as a files entry, the volume mount at /data, services 80/443, guest 1024MB shared-1x', …); // adjust memory to spike finding
```

- [ ] **Step 2: Run to verify failure**, then **implement**:

```ts
const PHP_TAGS = ['8.1', '8.2', '8.3', '8.4'];
function phpTag(version: string): { tag: string; note?: string } {
  const minor = version.split('.').slice(0, 2).join('.');
  if (PHP_TAGS.includes(minor)) return { tag: `php${minor}` };
  const nearest = PHP_TAGS.reduce((a, b) => Math.abs(Number(b) - Number(minor)) < Math.abs(Number(a) - Number(minor)) ? b : a);
  return { tag: `php${nearest}`, note: `PHP parity gap: production runs ${version}, clone runs ${nearest} (nearest supported).` };
}
```

`provision`: slug = `name`; if `loadProfile(slug).flySited` exists and sited `/health` answers → return (idempotent re-pull). Else: `api.createApp(appName, org)` → `api.allocateIps(appName)` → `api.createVolume(appName, 'data', region, 3)` → secret = `randomBytes(32).toString('hex')` → `api.createMachine(appName, region, config)` with the Task-1-verified config shape (`image: \`${imageRepo}:${tag}\``, guest per spike memory finding, mounts `[{volume: id, path: '/data'}]`, files `[{guest_path:'/etc/ferry/sited-secret', raw_value: Buffer.from(secret).toString('base64')}]`, services 80/443, restart always) → `api.waitStarted` → poll sited `GET /health` every 2 s up to 120 s → save `profile.flySited = {app, machineId, volumeId, secret, parityNote}`. `destroy(name)`: `api.destroyApp(FlyEnv.appName(name))` (volumes die with the app per spike confirmation — if the spike found otherwise, delete the volume explicitly first) then clear `flySited` and save.

Factory (`ferry-cli/src/env/index.ts`): replace the throw with

```ts
import { FlyEnv, flyConfigFromEnv } from './fly.js';
export function cloneEnv(kind: 'ddev' | 'fly'): CloneEnv {
  return kind === 'fly' ? new FlyEnv(flyConfigFromEnv(process.env)) : new DdevEnv();
}
```

- [ ] **Step 3: Run to verify pass** — full cli suite + typechecks (server too — it imports the factory).
- [ ] **Step 4: Commit** — `feat(cli): FlyEnv provision/destroy — app-per-site via Machines API, PHP tag matrix, parity note`.

---

### Task 9: Agent on Fly — ground rules, wp tool, allowlist, afterTurn deploy

**Files:**
- Modify: `ferry-server/src/agent/ground-rules.ts`, `ferry-server/src/agent/sdk-runner.ts:13-18,28-33,41,52-105,124-136,151`, `ferry-server/src/agent/manager.ts` (afterTurn hook — search `turn_end`), `ferry-server/src/app.ts` (thread `afterTurn` through `AppDeps.agent`), `ferry-server/src/main.ts`
- Test: `ferry-server/tests/agent-routes.test.ts` or a new `ferry-server/tests/ground-rules.test.ts` + `ferry-server/tests/agent-manager.test.ts` (append)

**Interfaces:**
- Consumes: `CloneEnvKind` (Task 3), `FlyEnv.runWp` (Task 7), `substrate` from main (Task 3).
- Produces:
  - `groundRules(slug: string, envKind: 'ddev' | 'fly')` — ddev text unchanged; fly text replaces the `ddev wp` line with: `` "wp-cli runs through the ferry `wp` tool (argv array). There is no local wp or ddev binary." ``, replaces the `.ddev/` never-edit item with `wp-config.php`, `wp-content/mu-plugins/ferry-*`, `ferry-uploads-fallback.php`, and replaces `verify inside the clone (\`ddev wp\`, …)` with `verify via the ferry \`wp\` tool or by requesting the clone URL`.
  - `SdkRunnerConfig.envKind: 'ddev' | 'fly'` — `auditedEnv` drops `DOCKER_HOST` from the allowlist when `'fly'`; `groundRules(opts.slug, config.envKind)` at the query options.
  - `SdkRunnerDeps.runWp?: (slug: string, argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>` — `buildFerryTools` adds a `wp` tool ONLY when `deps.runWp` is set: `tool('wp', 'Run wp-cli in the clone. Pass argv as an array, e.g. ["plugin","list"].', { argv: z.array(z.string()) }, async ({argv}) => text(JSON.stringify(await deps.runWp!(slug, argv))))`.
  - `AgentManager` opts gain `afterTurn?: (slug: string) => Promise<void>` — invoked fire-and-forget (`.catch(err => console.error('afterTurn failed:', err))`) wherever a normalized `turn_end` event is recorded for a session (locate by searching `turn_end` in `manager.ts`; call it with the session's site slug).
  - `main.ts` wiring: `envKind` into `sdkRunner` config; when `envKind === 'fly'`: `runWp: (slug, argv) => (substrate as FlyEnv).runWp(cloneDir(slug), argv)` and `afterTurn: (slug) => substrate.deployFiles(cloneDir(slug))`; `journalCandidates: (slug) => realJournalCandidates(slug, substrate)` (replaces the `new DdevEnv()` at `sdk-runner.ts:128` — move the default construction to main so sdk-runner no longer imports DdevEnv).

- [ ] **Step 1: Write the failing tests** (write these out fully in the test files):

```ts
// ground-rules: fly variant has no 'ddev' occurrences; ddev variant is byte-identical to before (snapshot the current string in the test)
// buildFerryTools: without runWp → 4 tools; with runWp → 5, and the wp tool forwards argv
// auditedEnv/config: envKind 'fly' → spawned env lacks DOCKER_HOST even when process.env has it (test via exported auditedEnv or by exporting the allowlist builder)
// manager: appending a turn_end event fires afterTurn once with the site slug (follow the existing agent-manager.test.ts fake-runner pattern)
```

- [ ] **Step 2: Run to verify failure. Step 3: Implement. Step 4: full server suite + typecheck.**
- [ ] **Step 5: Commit** — `feat(server): fly-mode agent — env-aware ground rules, wp MCP tool, DOCKER_HOST drop, deployFiles after each turn`.

---

### Task 10: Site delete teardown + fly.toml config

**Files:**
- Modify: `ferry-server/src/engine.ts` (Engine interface + realEngine), `ferry-server/src/routes/sites.ts` (the DELETE route — locate it; sites CRUD lives here), `ferry-server/src/main.ts` (nothing new — env already threaded), `fly.toml`
- Test: `ferry-server/tests/sites.test.ts` (append)

**Interfaces:**
- Produces: `Engine.destroyClone(slug: string): Promise<void>` → `env.destroy(slug)`; the sites DELETE route calls `deps.engine.destroyClone(site.slug)` BEFORE removing the row, tolerating failure with a logged warning (the row still deletes — a dangling Fly app must not brick site deletion; the warning names the app so it can be cleaned by hand). Stub engines in tests get a recording `destroyClone`.
- `fly.toml` `[env]` additions (config only, no secrets): `FERRY_CLONE_ENV = "fly"`, `FERRY_FLY_ORG = "personal"`, `FERRY_FLY_REGION = "ams"`, `FERRY_SITE_RUNTIME_IMAGE = "<registry path chosen in Task 1 findings>"`.

- [ ] **Step 1: failing test** — DELETE a ready site with a stub engine: `destroyClone` called with the slug; engine throwing still yields 204 and the site is gone.
- [ ] **Step 2–4: implement, suite green, typecheck.**
- [ ] **Step 5: Commit** — `feat(server): site delete tears down the Fly clone app; fly-mode config in fly.toml`.

---

### Task 11: Dashboard — env-agnostic clone surfaces

**Files:**
- Modify: `ferry-dashboard/src/pages/site.tsx:114`, `ferry-dashboard/src/pages/sync.tsx:14`, `ferry-dashboard/src/pages/sites.tsx:70`
- Test: `ferry-dashboard/e2e/dashboard.spec.ts` (assertion extension only)

**Interfaces:** consumes `SyncState.cloneUrl` (`ferry-dashboard/src/api.ts:23`) — the site page must read the clone host from the API instead of hardcoding.

- [ ] **Step 1:** `site.tsx:114` — replace `<span className="mono">{site.slug}.ddev.site</span>` with the host derived from the sync snapshot the page already fetches (or fetch `GET /api/sites/:id/sync` once if the page lacks it — check how `sync.tsx` obtains `SyncState` and reuse that `api.…` call): `<span className="mono">{sync?.cloneUrl ? new URL(sync.cloneUrl).host : '—'}</span>`.
- [ ] **Step 2:** `sync.tsx:14` — label becomes `{ key: 'import', label: 'Import & serve — production parity' }`. `sites.tsx:70` — copy becomes `…clones your production site into an isolated clone environment. No SSH, no FTP — one plugin and a pairing code.`
- [ ] **Step 3:** e2e — wherever `a[href*="ddev.site"]` is asserted absent (`dashboard.spec.ts:120,133`, `changes.spec.ts:55,92`), extend with the same assertion for `a[href*="fly.dev"]`.
- [ ] **Step 4:** `npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run e2e` (full preflight per runbook: `ddev stop --unlist ferry-prod-ddev-site`, `NODE_EXTRA_CA_CERTS` exported). Expected: 18 pass — the DDEV path still renders its URL via `cloneUrl`, so the gate test's copy-box behavior is unchanged.
- [ ] **Step 5: Commit** — `feat(dashboard): clone surfaces read cloneUrl from the API — no DDEV hardcodes`.

---

### Task 12: ferry-site-runtime image

**Files:**
- Create: `docker/site-runtime/Dockerfile`, `docker/site-runtime/entrypoint.sh`, `docker/site-runtime/supervisord.conf`, `docker/site-runtime/ferry-binlog.cnf`, `docker/site-runtime/apache-docroot.conf`

**Interfaces:** consumes ferry-sited (built INTO the image); produces the image Tasks 8/13/16 reference. The generated wp-config from the overlay expects database `db`, user `db`, password `db`, host `db` (`ferry-cli/src/overlay.ts:44-47`) — the image satisfies it with a MariaDB db/user named `db` and an `/etc/hosts` alias `db → 127.0.0.1`.

- [ ] **Step 1: Write the five files.**

`docker/site-runtime/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
ARG PHP_MINOR=8.2
FROM wordpress:php${PHP_MINOR}-apache
# The wordpress base gives us apache2 + php + the WP extension set; core files come from the clone, not the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      mariadb-server mariadb-client supervisor curl ca-certificates less \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
    && chmod +x /usr/local/bin/wp \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
COPY docker/site-runtime/apache-docroot.conf /etc/apache2/sites-available/000-default.conf
COPY docker/site-runtime/ferry-binlog.cnf /etc/mysql/mariadb.conf.d/90-ferry-binlog.cnf
COPY docker/site-runtime/supervisord.conf /etc/supervisor/conf.d/ferry.conf
# sited: the workspace runs from source via tsx, mirroring ferry-server
WORKDIR /opt/ferry
COPY package.json package-lock.json ./
COPY ferry-sited/package.json ferry-sited/
RUN npm ci --workspace ferry-sited --include=dev
COPY ferry-sited ferry-sited
COPY docker/site-runtime/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
```

`docker/site-runtime/apache-docroot.conf`:

```apache
<VirtualHost *:80>
  DocumentRoot /data/www
  <Directory /data/www>
    AllowOverride All
    Require all granted
  </Directory>
</VirtualHost>
```

`docker/site-runtime/ferry-binlog.cnf` (same intent as `ferry-cli/src/env/ddev.ts:32-40`):

```ini
[mysqld]
datadir = /data/mysql
log-bin = ferry-bin
binlog-format = ROW
binlog-row-image = FULL
server-id = 1
expire-logs-days = 14
bind-address = 127.0.0.1
```

`docker/site-runtime/entrypoint.sh`:

```bash
#!/bin/bash
set -euo pipefail
grep -q ' db$' /etc/hosts || echo '127.0.0.1 db' >> /etc/hosts   # overlay wp-config uses DB_HOST 'db' (overlay.ts:47)
mkdir -p /data/www /data/mysql
chown -R www-data:www-data /data/www
if [ ! -d /data/mysql/mysql ]; then
  chown -R mysql:mysql /data/mysql
  mariadb-install-db --user=mysql --datadir=/data/mysql >/dev/null
  (mariadbd --user=mysql &) && for i in $(seq 1 30); do mysqladmin ping >/dev/null 2>&1 && break; sleep 1; done
  mysql -e "CREATE DATABASE IF NOT EXISTS db; CREATE USER IF NOT EXISTS 'db'@'%' IDENTIFIED BY 'db'; CREATE USER IF NOT EXISTS 'db'@'localhost' IDENTIFIED BY 'db'; GRANT ALL ON db.* TO 'db'@'%'; GRANT ALL ON db.* TO 'db'@'localhost'; FLUSH PRIVILEGES;"
  mysqladmin shutdown
fi
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
```

`docker/site-runtime/supervisord.conf`:

```ini
[supervisord]
nodaemon=true

[program:mariadb]
command=/usr/sbin/mariadbd --user=mysql
priority=1
autorestart=true

[program:apache]
command=apache2-foreground
priority=2
autorestart=true

[program:sited]
command=node --import tsx /opt/ferry/ferry-sited/src/main.ts
directory=/opt/ferry
environment=SITED_DOCROOT="/data/www",SITED_HOST="::"
priority=3
autorestart=true
```

(`SITED_HOST="::"` binds all interfaces — inside the machine only 6PN + loopback exist and the port is never a public service; the `fly-local-6pn` literal is unavailable in local docker smoke, so `::` keeps one config for both.)

- [ ] **Step 2: Local smoke.**

```bash
docker build -f docker/site-runtime/Dockerfile --build-arg PHP_MINOR=8.2 -t ferry-site-runtime:php8.2 .
docker volume create srt-data
mkdir -p /tmp/ferry-secret && printf 'smoketest-secret' > /tmp/ferry-secret/sited-secret
docker run -d --name srt -p 2380:2323 -v srt-data:/data -v /tmp/ferry-secret:/etc/ferry:ro ferry-site-runtime:php8.2
sleep 20
curl -fsS http://127.0.0.1:2380/health                                   # {"ok":true}
docker exec srt mysql db -e 'SELECT 1'                                   # db exists, user db works
docker exec srt wp --info --allow-root | head -2                          # wp-cli present
docker exec srt mysql db -e 'SHOW BINLOG STATUS'                          # binlog on, ferry-bin.…
docker exec srt getent hosts db                                           # 127.0.0.1 db
docker exec srt mysqlbinlog --version                                     # present (mariadb compat symlink) — sited /binlog depends on it
docker rm -f srt && docker volume rm srt-data
```

All six checks pass or the task is not done. If `mysqlbinlog` is absent on the base, add the `mariadb-backup`/compat package or symlink `mariadb-binlog` in the Dockerfile and note it.

- [ ] **Step 3: Commit** — `feat(deploy): ferry-site-runtime image — WP base + MariaDB + wp-cli + sited under supervisord, PHP tag matrix arg`.

---

### Task 13: site-runtime publish workflow

**Files:**
- Create: `.github/workflows/site-runtime.yml`

**Interfaces:** consumes the registry decision from Task 1 findings (default assumption below: public GHCR `ghcr.io/epicwp/ferry-site-runtime`). Produces the tags `FERRY_SITE_RUNTIME_IMAGE` (Task 10) points at.

- [ ] **Step 1: Write the workflow** (pin actions to SHAs like deploy.yml — resolve current SHAs with `gh api repos/<owner>/<repo>/commits/<ref> --jq .sha` at implementation time):

```yaml
name: Site runtime image
on:
  push:
    branches: [main]
    paths: ['docker/site-runtime/**', 'ferry-sited/**', '.github/workflows/site-runtime.yml']
permissions:
  contents: read
  packages: write
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      matrix:
        php: ['8.1', '8.2', '8.3', '8.4']
    steps:
      - uses: actions/checkout@<pinned sha>  # v4
      - uses: docker/login-action@<pinned sha>  # v3
        with: { registry: ghcr.io, username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' }
      - uses: docker/build-push-action@<pinned sha>  # v6
        with:
          context: .
          file: docker/site-runtime/Dockerfile
          build-args: PHP_MINOR=${{ matrix.php }}
          push: true
          tags: ghcr.io/epicwp/ferry-site-runtime:php${{ matrix.php }}
```

- [ ] **Step 2:** Commit (`feat(deploy): matrix publish of ferry-site-runtime to GHCR`). After the merge in Task 15 the first run publishes; then (interactive, once) make the package PUBLIC in the GitHub UI (Packages → ferry-site-runtime → settings) — Fly pulls it unauthenticated per the Task 1 verification.

---

### Task 14: Full gate on the branch

- [ ] **Step 1:** `npm --workspace ferry-cli run test` (146+new), `npm --workspace ferry-server run test` (226+new), `npm --workspace ferry-sited run test`, `(cd ferry-plugin && vendor/bin/phpunit)` (216), all FOUR typechecks, `npm --workspace ferry-dashboard run e2e` (18; runbook preflight applies). Everything green before anything interactive.
- [ ] **Step 2:** Fix anything red (normal TDD loop); commit fixes.

---

### Task 15: Fly config + merge + pipeline (INTERACTIVE — needs Robbert)

- [ ] **Step 1 (Robbert):** mint the durable org-scoped token and set the secrets — piped, never echoed:

```bash
fly tokens create org -x 8760h | fly secrets set FERRY_FLY_TOKEN=- -a ferry-cp --stage
# ANTHROPIC_API_KEY: Robbert pastes it into the secret set command himself (or from the local .env):
fly secrets set ANTHROPIC_API_KEY=<key> -a ferry-cp --stage
```
(`--stage` avoids two restarts; the deploy after merge applies both. If `fly secrets set NAME=-` stdin syntax fails, fall back to `fly secrets set "FERRY_FLY_TOKEN=$(fly tokens create org -x 8760h)"` in one line so the token stays out of the transcript.)

- [ ] **Step 2:** Merge `feat/fly-m2a` → main (no-ff, same convention), push; `gh run watch` BOTH workflows (Deploy + Site runtime image); verify `/api/health`, `fly logs` shows the agent enabled now (`ANTHROPIC_API_KEY` present) and no boot errors from `cloneEnvKind` (fly-mode config valid); make the GHCR package public (Task 13 note); confirm all four `ghcr.io/epicwp/ferry-site-runtime:php8.*` tags exist.

### Task 16: Live acceptance (INTERACTIVE — Robbert + demo site) + close-out

- [ ] **Step 1 (Robbert):** demo WordPress site online on his hosting; installs `ferry-connect.zip` from `https://ferry-cp.fly.dev` (logged in), starts pairing.
- [ ] **Step 2:** Walk spec §11 criteria 1–7 live, recording evidence for each: pair+sync → `ready` with browsable `https://ferry-s-….fly.dev` (check PHP minor: `wp` tool `["eval","echo PHP_VERSION;"]` or the site page Environment card); agent edit visible on the clone URL after the turn; production DB change → journal ops; change card push + verify on production; rollback + verify; site delete → `fly apps list` no longer shows the site app; suites green (criterion 5 = Task 14 record).
- [ ] **Step 3:** Append the executed transcript as `docs/superpowers/plans/2026-08-17-ferry-m2a-acceptance-runbook.md`; update the spec status line (M2a live, date); update assistant memory (M2a shipped, M2b next); commit + push (one more pipeline deploy proves the loop).

---

## Self-review notes (writing time)

- Spec coverage: §3 → Tasks 1/8/12; §4 → 4/5/7; §5 → 2/3/8; §6 → 3/7/9; §7 → 9/15; §8 → 11; §9 → every task's tests + 14/16; §11 → 16; §12 → 1. §10 (M2b) intentionally taskless.
- Sequencing: sited's `/binlog` lands in Task 7 (with its consumer) rather than 5 — deliberate, so the endpoint and client are written against each other.
- Task 9's manager hook and Task 10's DELETE route say "locate by searching" — the files are named and small; exact line anchors would go stale across Tasks 2–8 anyway.
- Deviation from spec §3 noted: app-name hash is unkeyed sha256 (deterministic + public is required; keying adds nothing) — flag to Robbert at review.
