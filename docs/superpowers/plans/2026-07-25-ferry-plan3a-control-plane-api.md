# Ferry Plan 3a — Control Plane API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Fastify control plane that runs the Plan-1/2 engine per site — accounts, sites, device-flow pairing, connection test, and initial sync with live SSE progress and server-verified clone reachability — fully testable without a browser.

**Architecture:** New `ferry-server` workspace package importing the engine (`link()`, `pull()`, `FerryClient`) directly from `ferry-cli` source. One engine change: an optional `onProgress` callback on `pull()`. Accounts/sessions/sites index in one SQLite file; all engine state stays in the existing readable files per site (`~/.ferry/sites/<slug>/`). Sync state lives in memory; every SSE message is the full current state.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Fastify 5, @fastify/cookie, better-sqlite3, fflate (plugin zip), undici, vitest, tsx. Spec: `docs/superpowers/specs/2026-07-25-ferry-plan3-control-plane-design.md`.

## Global Constraints

- All user-facing copy in English (roadmap Plan 3 requirement).
- The site `secret` lives only in `~/.ferry/sites/<slug>/profile.json` — never in SQLite, never in an API response. Clone admin credentials (`PullResult.adminUser/adminPassword`) are never exposed through the API.
- `pull()` without an `onProgress` callback behaves byte-for-byte as today; existing ferry-cli tests must pass unchanged.
- Site status values, exactly: `new | paired | syncing | ready | error | refused_multisite` (spec §2.2).
- Sync phases, exactly, in this order: `info | manifest | resolve | files | git | db | import | done` (spec §3.3).
- SSE protocol: every message is the *full current state* as JSON — no deltas; on connect the server immediately sends the current state (spec §3.3).
- `ferry-cli` has no `exports` map; `ferry-server` imports engine source via relative paths (`../../ferry-cli/src/*.js`) so tsc/tsx/vitest all resolve without build steps. Do not add an exports map in this plan.
- All routes under `/api/sites/*` require a valid session and check site ownership (spec §2.3).
- `FERRY_HOME` env override is respected everywhere (tests and E2E depend on it).
- Match ferry-cli code style: semicolons, single quotes, 2-space indent, `.js` extensions on relative imports.
- Never restore the E2E fixture with `ddev wp core download` — use the official zip (standing E2E rule).

## File Structure

```
package.json                               (new — npm workspaces root)
ferry-cli/src/pull.ts                      (modify — PullPhase/PullProgress/onProgress + emissions)
ferry-cli/src/transfer.ts                  (modify — fetchAll progress option)
ferry-cli/src/db.ts                        (modify — pullDatabase per-table callback)
ferry-cli/tests/progress.test.ts           (new)
ferry-server/package.json                  (new)
ferry-server/tsconfig.json                 (new)
ferry-server/src/store.ts                  (new — SQLite: users, sessions, sites)
ferry-server/src/auth.ts                   (new — scrypt hash/verify, session tokens)
ferry-server/src/app.ts                    (new — buildApp(deps), session preHandler, plugin.zip route)
ferry-server/src/routes/auth.ts            (new — signup/login/logout/me)
ferry-server/src/routes/sites.ts           (new — list/create/get + pair + test)
ferry-server/src/engine.ts                 (new — Engine interface + realEngine() wrapping ferry-cli)
ferry-server/src/sync.ts                   (new — SyncManager state machine)
ferry-server/src/routes/sync.ts            (new — POST sync, GET events SSE)
ferry-server/src/plugin-zip.ts             (new — zip ferry-plugin/ for download)
ferry-server/src/main.ts                   (new — entry: store, recovery, listen)
ferry-server/tests/store.test.ts           (new)
ferry-server/tests/auth.test.ts            (new)
ferry-server/tests/sites.test.ts           (new)
ferry-server/tests/pair-test.test.ts       (new)
ferry-server/tests/sync.test.ts            (new)
ferry-server/tests/plugin-zip.test.ts      (new)
ferry-server/tests/helpers/testApp.ts      (new — in-memory store + stub engine factory)
ferry-server/e2e/control-plane.ts          (new — scripted E2E against the ferry-prod fixture)
docs/superpowers/plans/2026-07-25-ferry-plan3a-e2e-runbook.md   (new)
```

---

### Task 1: Engine progress callback (ferry-cli)

**Files:**
- Modify: `ferry-cli/src/pull.ts`
- Modify: `ferry-cli/src/transfer.ts` (fetchAll, lines 140–153)
- Modify: `ferry-cli/src/db.ts` (pullDatabase, line 17)
- Test: `ferry-cli/tests/progress.test.ts`

**Interfaces:**
- Consumes: existing `pull()`, `fetchAll()`, `pullDatabase()` signatures.
- Produces (used by Task 6's SyncManager and by this task's test):
  - `export type PullPhase = 'info' | 'manifest' | 'resolve' | 'files' | 'git' | 'db' | 'import' | 'done'` (pull.ts)
  - `export interface PullProgress { phase: PullPhase; detail?: string; current?: number; total?: number }` (pull.ts)
  - `export interface PullOpts { full?: boolean; onProgress?: (e: PullProgress) => void }` (pull.ts)
  - `fetchAll(client, entries, destDir, opts)` — `opts` gains `onProgress?: (done: number, total: number) => void`
  - `pullDatabase(client, dumpDir, skip?, onTable?)` — `onTable?: (done: number, total: number, name: string) => void`, called once per table before dumping it

- [ ] **Step 1: Write the failing test**

`ferry-cli/tests/progress.test.ts` — mirrors the setup of `tests/pull.test.ts` (temp `FERRY_HOME`, fixture dir, `FakeEnv`, mock plugin, dead wp.org so every file goes through fetch):

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloneEnv } from '../src/env/ddev.js';
import { saveProfile } from '../src/profile.js';
import { pull, type PullProgress } from '../src/pull.js';
import { hashOf, sizeOf, startMockPlugin, type MockPlugin } from './helpers/mockPlugin.js';

const DEAD_WPORG = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };

class FakeEnv implements CloneEnv {
  async provision(): Promise<void> {}
  async importDb(): Promise<void> {}
  async createAdmin(): Promise<{ user: string; password: string }> {
    return { user: 'ferry-admin', password: 'pw123' };
  }
  url(name: string): string {
    return `https://${name}.ddev.site`;
  }
}

describe('pull progress', () => {
  let home: string;
  let fixture: string;
  let mock: MockPlugin;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    fixture = mkdtempSync(join(tmpdir(), 'ferry-site-'));
    mkdirSync(join(fixture, 'wp-content'), { recursive: true });
    writeFileSync(join(fixture, 'index.php'), '<?php // wp');
    writeFileSync(join(fixture, 'wp-load.php'), '<?php // load');
  });

  afterEach(() => {
    mock?.close();
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('emits phases in order with counters', async () => {
    const paths = ['index.php', 'wp-load.php'];
    mock = await startMockPlugin(fixture, {
      manifest: paths.map((p) => ({ path: p, size: sizeOf(fixture, p), hash: hashOf(fixture, p) })),
      dbTables: [{
        name: 'wp_posts', rows: 1, bytes: 64, pk: 'ID', maxpk: 1,
        batches: [{ sql: 'INSERT INTO wp_posts VALUES (1);\n', lastKey: 1, complete: true }],
      }],
    });
    saveProfile({ url: mock.base, secret: 's', slug: 'fixture', clonePath: join(home, 'clone') });

    const events: PullProgress[] = [];
    await pull('fixture', { env: new FakeEnv(), wporg: DEAD_WPORG }, { onProgress: (e) => events.push(e) });

    const phases = events.map((e) => e.phase);
    // every phase appears, in the documented order
    const order = ['info', 'manifest', 'resolve', 'files', 'git', 'db', 'import', 'done'];
    const firstIndex = order.map((p) => phases.indexOf(p));
    expect(firstIndex.every((i) => i >= 0)).toBe(true);
    expect([...firstIndex].sort((a, b) => a - b)).toEqual(firstIndex);

    const manifestEvent = events.find((e) => e.phase === 'manifest');
    expect(manifestEvent?.total).toBe(2);
    const fileEvents = events.filter((e) => e.phase === 'files' && e.current !== undefined);
    expect(fileEvents.at(-1)?.current).toBe(fileEvents.at(-1)?.total);
    const dbEvent = events.find((e) => e.phase === 'db' && e.detail === 'wp_posts');
    expect(dbEvent).toBeDefined();
    expect(phases.at(-1)).toBe('done');
    // clone actually materialized — progress reporting must not change behavior
    expect(existsSync(join(home, 'clone', 'index.php'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ferry-cli && npx vitest run tests/progress.test.ts`
Expected: FAIL — `'"PullProgress" is not exported'` (or type error on `onProgress`).

- [ ] **Step 3: Implement the seam**

`ferry-cli/src/transfer.ts` — replace `fetchAll` (keep everything else untouched):

```ts
export async function fetchAll(
  client: FerryClient,
  entries: import('./client.js').ManifestEntry[],
  destDir: string,
  opts: { maxBytes?: number; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ skipped: string[] }> {
  const { batches, oversized } = binPack(entries, opts.maxBytes ?? DEFAULT_BATCH_BYTES);
  const limit = pLimit(opts.concurrency ?? 4); // §3.4: more collides with per-account PHP process caps
  const total = entries.length;
  let done = 0;
  const skippedLists = await Promise.all(
    batches.map((b) =>
      limit(async () => {
        const skipped = await fetchBatch(client, b.map((e) => e.path), destDir);
        done += b.length;
        opts.onProgress?.(done, total);
        return skipped;
      }),
    ),
  );
  await Promise.all(
    oversized.map((e) =>
      limit(async () => {
        await fetchOversized(client, e, destDir);
        done += 1;
        opts.onProgress?.(done, total);
      }),
    ),
  );
  return { skipped: skippedLists.flat() };
}
```

`ferry-cli/src/db.ts` — change the `pullDatabase` signature and add one call at the top of the per-table loop:

```ts
export async function pullDatabase(
  client: FerryClient,
  dumpDir: string,
  skip: string[] = [],
  onTable?: (done: number, total: number, name: string) => void,
): Promise<string> {
```

and inside the loop, replace `for (const table of tables) {` with:

```ts
  for (const [i, table] of tables.entries()) {
    onTable?.(i, tables.length, table.name);
```

`ferry-cli/src/pull.ts` — add the types, extend `PullOpts`, and emit. Full set of edits:

```ts
export type PullPhase = 'info' | 'manifest' | 'resolve' | 'files' | 'git' | 'db' | 'import' | 'done';

export interface PullProgress {
  phase: PullPhase;
  detail?: string;
  current?: number;
  total?: number;
}

export interface PullOpts { full?: boolean; onProgress?: (e: PullProgress) => void }
```

In the body (emission points, in flow order — the second `fetchAll` retry call deliberately gets no callback, its totals would double-count):

```ts
  const progress = opts.onProgress ?? (() => {});
```
after `saveProfile(profile);`:
```ts
  progress({ phase: 'info', detail: `WordPress ${info.wp}, PHP ${info.php.version}` });
```
after `const manifest = await fetchManifest(client);`:
```ts
  progress({ phase: 'manifest', total: manifest.length });
```
after `const reportPath = writeReport(slug, report);`:
```ts
  progress({ phase: 'resolve', detail: summarize(report) });
  progress({ phase: 'files', current: 0, total: plan.fetch.length });
```
change the first `fetchAll` call inside `Promise.all` to:
```ts
    fetchAll(client, plan.fetch, docroot, {
      onProgress: (done, total) => progress({ phase: 'files', current: done, total }),
    }),
```
after `const commit = await commitProduction(...)`:
```ts
  progress({ phase: 'git', detail: commit.slice(0, 7) });
```
change the `pullDatabase` call to:
```ts
  const dump = await pullDatabase(client, join(ferryHome(), 'sites', slug, 'db-dump'), liteSkip,
    (done, total, name) => progress({ phase: 'db', current: done, total, detail: name }));
```
before `await envReady;`:
```ts
  progress({ phase: 'import' });
```
immediately before the `return {` statement:
```ts
  progress({ phase: 'done' });
```

- [ ] **Step 4: Run the new test and the full ferry-cli suite**

Run: `cd ferry-cli && npx vitest run`
Expected: `progress.test.ts` PASSES; all pre-existing tests PASS unchanged (this is the "byte-for-byte without callback" guard).

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/pull.ts ferry-cli/src/transfer.ts ferry-cli/src/db.ts ferry-cli/tests/progress.test.ts
git commit -m "feat(cli): optional onProgress callback on pull() for the control plane SSE seam"
```

---

### Task 2: Workspace root + ferry-server scaffold + SQLite store

**Files:**
- Create: `package.json` (repo root)
- Create: `ferry-server/package.json`, `ferry-server/tsconfig.json`
- Create: `ferry-server/src/store.ts`
- Test: `ferry-server/tests/store.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `export type SiteStatus = 'new' | 'paired' | 'syncing' | 'ready' | 'error' | 'refused_multisite'`
  - `export interface User { id: number; email: string; passwordHash: string }`
  - `export interface Site { id: number; userId: number; name: string; url: string; slug: string; status: SiteStatus; lastError: string | null; lastSyncAt: string | null; verifiedAt: string | null; createdAt: string }`
  - `export class Store` with: `constructor(path: string)`, `close()`, `createUser(email, passwordHash): User | undefined` (undefined on duplicate email), `userByEmail(email): User | undefined`, `createSession(token, userId, expiresAt)`, `userForSession(token): User | undefined` (expired → undefined), `deleteSession(token)`, `createSite(userId, name, url, slug): Site | undefined` (undefined on duplicate slug), `sitesFor(userId): Site[]`, `siteFor(userId, id): Site | undefined`, `setStatus(id, status, patch?: { lastError?: string | null; lastSyncAt?: string; verifiedAt?: string })`, `recoverInterruptedSyncs(): number`

- [ ] **Step 1: Create the workspace root and package scaffolding**

`package.json` (repo root):

```json
{
  "name": "ferry",
  "private": true,
  "workspaces": ["ferry-cli", "ferry-server"]
}
```

`ferry-server/package.json`:

```json
{
  "name": "ferry-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "e2e": "tsx e2e/control-plane.ts"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.1",
    "better-sqlite3": "^11.5.0",
    "fastify": "^5.0.0",
    "fflate": "^0.8.3",
    "undici": "^6.21.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

`ferry-server/tsconfig.json` (no `rootDir`/`outDir`: the server runs with tsx and cross-package relative imports into `ferry-cli/src`; `typecheck` is the gate, there is no dist build):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests", "e2e"]
}
```

Then: `rm -f ferry-cli/package-lock.json` (the root lockfile owns resolution now) and run `npm install` at the repo root.

- [ ] **Step 2: Verify the workspace did not break ferry-cli**

Run: `npm --workspace ferry-cli test`
Expected: full ferry-cli suite PASSES (dependencies now hoisted to root `node_modules`).

- [ ] **Step 3: Write the failing store test**

`ferry-server/tests/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

describe('Store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferry-store-'));
    store = new Store(join(dir, 'server.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates users and rejects duplicate emails', () => {
    const user = store.createUser('a@example.com', 'salt:hash');
    expect(user?.email).toBe('a@example.com');
    expect(store.createUser('a@example.com', 'other')).toBeUndefined();
    expect(store.userByEmail('a@example.com')?.id).toBe(user!.id);
  });

  it('round-trips sessions and expires them', () => {
    const user = store.createUser('a@example.com', 'h')!;
    store.createSession('tok1', user.id, new Date(Date.now() + 60_000).toISOString());
    expect(store.userForSession('tok1')?.id).toBe(user.id);
    store.createSession('tok2', user.id, new Date(Date.now() - 1_000).toISOString());
    expect(store.userForSession('tok2')).toBeUndefined();
    store.deleteSession('tok1');
    expect(store.userForSession('tok1')).toBeUndefined();
  });

  it('creates sites with ownership and unique slugs', () => {
    const a = store.createUser('a@example.com', 'h')!;
    const b = store.createUser('b@example.com', 'h')!;
    const site = store.createSite(a.id, 'Shop', 'https://shop.example', 'shop-example')!;
    expect(site.status).toBe('new');
    expect(store.createSite(b.id, 'Dup', 'https://shop.example', 'shop-example')).toBeUndefined();
    expect(store.sitesFor(a.id)).toHaveLength(1);
    expect(store.siteFor(b.id, site.id)).toBeUndefined(); // not the owner
    expect(store.siteFor(a.id, site.id)?.slug).toBe('shop-example');
  });

  it('patches status fields', () => {
    const a = store.createUser('a@example.com', 'h')!;
    const site = store.createSite(a.id, 'Shop', 'https://shop.example', 'shop-example')!;
    store.setStatus(site.id, 'error', { lastError: 'boom' });
    expect(store.siteFor(a.id, site.id)).toMatchObject({ status: 'error', lastError: 'boom' });
    store.setStatus(site.id, 'ready', { lastError: null, lastSyncAt: '2026-07-25T00:00:00.000Z', verifiedAt: '2026-07-25T00:00:01.000Z' });
    expect(store.siteFor(a.id, site.id)).toMatchObject({ status: 'ready', lastError: null, verifiedAt: '2026-07-25T00:00:01.000Z' });
  });

  it('recovers interrupted syncs at boot', () => {
    const a = store.createUser('a@example.com', 'h')!;
    const site = store.createSite(a.id, 'Shop', 'https://shop.example', 'shop-example')!;
    store.setStatus(site.id, 'syncing');
    expect(store.recoverInterruptedSyncs()).toBe(1);
    expect(store.siteFor(a.id, site.id)).toMatchObject({
      status: 'error',
      lastError: 'Sync interrupted by a server restart — run it again.',
    });
    expect(store.recoverInterruptedSyncs()).toBe(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm --workspace ferry-server test`
Expected: FAIL — cannot find `../src/store.js`.

- [ ] **Step 5: Implement the store**

`ferry-server/src/store.ts`:

```ts
import Database from 'better-sqlite3';

export interface User { id: number; email: string; passwordHash: string }

export type SiteStatus = 'new' | 'paired' | 'syncing' | 'ready' | 'error' | 'refused_multisite';

export interface Site {
  id: number;
  userId: number;
  name: string;
  url: string;
  slug: string;
  status: SiteStatus;
  lastError: string | null;
  lastSyncAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  last_sync_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL
);
`;

interface SiteRow {
  id: number; user_id: number; name: string; url: string; slug: string; status: string;
  last_error: string | null; last_sync_at: string | null; verified_at: string | null; created_at: string;
}

function toSite(row: SiteRow): Site {
  return {
    id: row.id, userId: row.user_id, name: row.name, url: row.url, slug: row.slug,
    status: row.status as SiteStatus, lastError: row.last_error,
    lastSyncAt: row.last_sync_at, verifiedAt: row.verified_at, createdAt: row.created_at,
  };
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createUser(email: string, passwordHash: string): User | undefined {
    try {
      const info = this.db
        .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(email, passwordHash, new Date().toISOString());
      return { id: Number(info.lastInsertRowid), email, passwordHash };
    } catch {
      return undefined; // UNIQUE violation: email already registered
    }
  }

  userByEmail(email: string): User | undefined {
    const row = this.db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as
      | { id: number; email: string; password_hash: string }
      | undefined;
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : undefined;
  }

  createSession(token: string, userId: number, expiresAt: string): void {
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  }

  userForSession(token: string): User | undefined {
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, u.password_hash FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, new Date().toISOString()) as { id: number; email: string; password_hash: string } | undefined;
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  createSite(userId: number, name: string, url: string, slug: string): Site | undefined {
    try {
      const info = this.db
        .prepare('INSERT INTO sites (user_id, name, url, slug, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, name, url, slug, 'new', new Date().toISOString());
      return this.siteFor(userId, Number(info.lastInsertRowid));
    } catch {
      return undefined; // UNIQUE violation: slug already registered on this server
    }
  }

  sitesFor(userId: number): Site[] {
    const rows = this.db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY id').all(userId) as SiteRow[];
    return rows.map(toSite);
  }

  siteFor(userId: number, id: number): Site | undefined {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(id, userId) as SiteRow | undefined;
    return row ? toSite(row) : undefined;
  }

  setStatus(
    id: number,
    status: SiteStatus,
    patch: { lastError?: string | null; lastSyncAt?: string; verifiedAt?: string } = {},
  ): void {
    this.db.prepare('UPDATE sites SET status = ? WHERE id = ?').run(status, id);
    if ('lastError' in patch) {
      this.db.prepare('UPDATE sites SET last_error = ? WHERE id = ?').run(patch.lastError, id);
    }
    if (patch.lastSyncAt !== undefined) {
      this.db.prepare('UPDATE sites SET last_sync_at = ? WHERE id = ?').run(patch.lastSyncAt, id);
    }
    if (patch.verifiedAt !== undefined) {
      this.db.prepare('UPDATE sites SET verified_at = ? WHERE id = ?').run(patch.verifiedAt, id);
    }
  }

  recoverInterruptedSyncs(): number {
    const info = this.db
      .prepare("UPDATE sites SET status = 'error', last_error = ? WHERE status = 'syncing'")
      .run('Sync interrupted by a server restart — run it again.');
    return info.changes;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm --workspace ferry-server test`
Expected: 5 store tests PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json ferry-cli/package-lock.json ferry-server/package.json ferry-server/tsconfig.json ferry-server/src/store.ts ferry-server/tests/store.test.ts
git commit -m "feat(server): workspace root + ferry-server scaffold with SQLite store"
```

---

### Task 3: Auth — password hashing, sessions, routes

**Files:**
- Create: `ferry-server/src/auth.ts`
- Create: `ferry-server/src/app.ts`
- Create: `ferry-server/src/routes/auth.ts`
- Create: `ferry-server/tests/helpers/testApp.ts`
- Test: `ferry-server/tests/auth.test.ts`

**Interfaces:**
- Consumes: `Store`, `User` from Task 2.
- Produces:
  - `auth.ts`: `hashPassword(password: string): string`, `verifyPassword(password: string, stored: string): boolean`, `newSessionToken(): string`, `sessionExpiry(): string` (ISO, now + 30 days), `SESSION_MAX_AGE_S` (number, 30 days in seconds)
  - `app.ts`: `export const SESSION_COOKIE = 'ferry_session'`; `export interface AppDeps { store: Store; engine?: Engine; pluginZip?: Buffer }` (engine/pluginZip wired in Tasks 5–7); `export function buildApp(deps: AppDeps): FastifyInstance`; a `requireUser` preHandler that populates `request.user` (module augmentation `FastifyRequest.user: User`) or replies 401 `{ error: 'Not signed in.' }`
  - `testApp.ts`: `makeApp(overrides?: Partial<AppDeps>): { app: FastifyInstance; store: Store }` using an in-memory store (`new Store(':memory:')`); plus `signup(app, email?, password?): Promise<string>` returning a `cookie` header value

- [ ] **Step 1: Write the failing test**

`ferry-server/tests/helpers/testApp.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app.js';
import { Store } from '../../src/store.js';

export function makeApp(overrides: Partial<AppDeps> = {}): { app: FastifyInstance; store: Store } {
  const store = overrides.store ?? new Store(':memory:');
  const app = buildApp({ store, ...overrides });
  return { app, store };
}

export async function signup(app: FastifyInstance, email = 'user@example.com', password = 'password1'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.headers['set-cookie'];
  return (Array.isArray(cookie) ? cookie[0]! : cookie!).split(';')[0]!;
}
```

`ferry-server/tests/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { makeApp, signup } from './helpers/testApp.js';

describe('password hashing', () => {
  it('verifies correct passwords and rejects wrong ones', () => {
    const stored = hashPassword('hunter22');
    expect(verifyPassword('hunter22', stored)).toBe(true);
    expect(verifyPassword('hunter23', stored)).toBe(false);
    expect(verifyPassword('hunter22', 'garbage')).toBe(false);
  });
});

describe('auth routes', () => {
  it('signs up, reads /api/me, logs out', async () => {
    const { app } = makeApp();
    const cookie = await signup(app);
    let res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'user@example.com' });
    res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects duplicate signup, bad login, missing session', async () => {
    const { app } = makeApp();
    await signup(app);
    let res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(409);
    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong-password' } });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('validates signup input', async () => {
    const { app } = makeApp();
    let res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'not-an-email', password: 'password1' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'ok@example.com', password: 'short' } });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server test`
Expected: FAIL — `../src/auth.js` / `../../src/app.js` not found.

- [ ] **Step 3: Implement auth + app shell**

`ferry-server/src/auth.ts`:

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionExpiry(): string {
  return new Date(Date.now() + SESSION_MAX_AGE_S * 1000).toISOString();
}
```

`ferry-server/src/app.ts`:

```ts
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Engine } from './engine.js';
import { authRoutes } from './routes/auth.js';
import type { Store, User } from './store.js';

export const SESSION_COOKIE = 'ferry_session';

export interface AppDeps {
  store: Store;
  engine?: Engine;   // wired in Task 5
  pluginZip?: Buffer; // wired in Task 7
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();
  void app.register(cookie);

  // Session gate for everything private. Routes opt in via { preHandler: app.requireUser }.
  const requireUser = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? deps.store.userForSession(token) : undefined;
    if (!user) {
      await reply.code(401).send({ error: 'Not signed in.' });
      return;
    }
    request.user = user;
  };
  app.decorate('requireUser', requireUser);

  authRoutes(app, deps);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

Until Task 5 exists, create a placeholder type module `ferry-server/src/engine.ts` now so `app.ts` compiles:

```ts
// Filled in by the pairing task; the interface exists first so app wiring can reference it.
export interface Engine {
  link(url: string, code: string): Promise<void>;
  pull(slug: string, opts: import('../../ferry-cli/src/pull.js').PullOpts): Promise<import('../../ferry-cli/src/pull.js').PullResult>;
  siteInfo(slug: string): Promise<import('../../ferry-cli/src/profile.js').SiteInfo>;
  verifyClone(url: string): Promise<boolean>;
  cloneUrl(slug: string): string;
}
```

`ferry-server/src/routes/auth.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { hashPassword, newSessionToken, sessionExpiry, verifyPassword, SESSION_MAX_AGE_S } from '../auth.js';
import { SESSION_COOKIE, type AppDeps } from '../app.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_S } as const;

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/auth/signup', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    if (!email || !EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: 'Enter a valid email address.' });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters.' });
    }
    const user = deps.store.createUser(email.toLowerCase(), hashPassword(password));
    if (!user) {
      return reply.code(409).send({ error: 'An account with this email already exists.' });
    }
    const token = newSessionToken();
    deps.store.createSession(token, user.id, sessionExpiry());
    return reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS).send({ email: user.email });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    const user = email ? deps.store.userByEmail(email.toLowerCase()) : undefined;
    if (!user || !password || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'Wrong email or password.' });
    }
    const token = newSessionToken();
    deps.store.createSession(token, user.id, sessionExpiry());
    return reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS).send({ email: user.email });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) deps.store.deleteSession(token);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.get('/api/me', { preHandler: app.requireUser }, async (request) => {
    return { email: request.user.email };
  });
}
```

Note: `Store(':memory:')` works out of the box — better-sqlite3 treats `:memory:` as an in-memory database.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --workspace ferry-server test` and `npm --workspace ferry-server run typecheck`
Expected: auth + store tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/auth.ts ferry-server/src/app.ts ferry-server/src/engine.ts ferry-server/src/routes/auth.ts ferry-server/tests/auth.test.ts ferry-server/tests/helpers/testApp.ts
git commit -m "feat(server): email+password auth with scrypt and cookie sessions"
```

---

### Task 4: Sites routes — list, create, get

**Files:**
- Create: `ferry-server/src/routes/sites.ts`
- Modify: `ferry-server/src/app.ts` (register `siteRoutes(app, deps)` after `authRoutes`)
- Test: `ferry-server/tests/sites.test.ts`

**Interfaces:**
- Consumes: `Store.createSite/sitesFor/siteFor`, `requireUser`, `slugFromUrl` from `../../ferry-cli/src/profile.js`.
- Produces: `siteRoutes(app: FastifyInstance, deps: AppDeps): void`; the site JSON shape returned by every site endpoint: `{ id, name, url, slug, status, lastError, lastSyncAt, verifiedAt, createdAt }` (the `Site` interface verbatim minus `userId`); helper `export function siteJson(site: Site): object` used by Tasks 5–6.

- [ ] **Step 1: Write the failing test**

`ferry-server/tests/sites.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeApp, signup } from './helpers/testApp.js';

describe('site routes', () => {
  it('creates a site with derived slug and lists it', async () => {
    const { app } = makeApp();
    const cookie = await signup(app);
    let res = await app.inject({
      method: 'POST', url: '/api/sites', headers: { cookie },
      payload: { name: 'My Shop', url: 'https://www.klant.nl' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'My Shop', url: 'https://www.klant.nl', slug: 'klant-nl', status: 'new' });
    expect(JSON.stringify(res.json())).not.toContain('secret');
    res = await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } });
    expect(res.json()).toHaveLength(1);
  });

  it('rejects invalid input and duplicate slugs', async () => {
    const { app } = makeApp();
    const cookie = await signup(app);
    let res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: '', url: 'https://a.example' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'X', url: 'not a url' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'X', url: 'ftp://a.example' } });
    expect(res.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'A', url: 'https://dup.example' } });
    res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'B', url: 'https://dup.example' } });
    expect(res.statusCode).toBe(409);
  });

  it('hides other users\' sites', async () => {
    const { app } = makeApp();
    const cookieA = await signup(app, 'a@example.com');
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie: cookieA }, payload: { name: 'A', url: 'https://a.example' } });
    const id = created.json().id as number;
    const cookieB = await signup(app, 'b@example.com');
    let res = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server test`
Expected: FAIL — `../src/routes/sites.js` not registered / 404s.

- [ ] **Step 3: Implement**

`ferry-server/src/routes/sites.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { slugFromUrl } from '../../../ferry-cli/src/profile.js';
import type { AppDeps } from '../app.js';
import type { Site } from '../store.js';

export function siteJson(site: Site): object {
  const { userId: _userId, ...rest } = site;
  return rest;
}

function parseSiteUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function siteRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/sites', { preHandler: app.requireUser }, async (request, reply) => {
    const { name, url: rawUrl } = (request.body ?? {}) as { name?: string; url?: string };
    const url = parseSiteUrl(rawUrl);
    if (!name || name.trim() === '') {
      return reply.code(400).send({ error: 'Give the site a name.' });
    }
    if (!url) {
      return reply.code(400).send({ error: 'Enter a valid http(s) site URL.' });
    }
    const site = deps.store.createSite(request.user.id, name.trim(), url, slugFromUrl(url));
    if (!site) {
      return reply.code(409).send({ error: 'This site is already registered on this server.' });
    }
    return reply.code(201).send(siteJson(site));
  });

  app.get('/api/sites', { preHandler: app.requireUser }, async (request) => {
    return deps.store.sitesFor(request.user.id).map(siteJson);
  });

  app.get('/api/sites/:id', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    return siteJson(site);
  });
}
```

In `app.ts`, after `authRoutes(app, deps);` add:

```ts
  siteRoutes(app, deps);
```

with import `import { siteRoutes } from './routes/sites.js';`.

Note the import depth from `src/routes/`: `../../../ferry-cli/src/profile.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --workspace ferry-server test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/routes/sites.ts ferry-server/src/app.ts ferry-server/tests/sites.test.ts
git commit -m "feat(server): site CRUD with ownership and slug derivation"
```

---

### Task 5: Engine adapter + pairing + connection test

**Files:**
- Modify: `ferry-server/src/engine.ts` (replace the placeholder with the real implementation)
- Modify: `ferry-server/src/routes/sites.ts` (add pair + test routes)
- Modify: `ferry-server/tests/helpers/testApp.ts` (default stub engine)
- Test: `ferry-server/tests/pair-test.test.ts`

**Interfaces:**
- Consumes: `link()` (`../../ferry-cli/src/link.js`), `FerryClient`, `loadProfile/ferryHome/slugFromUrl/SiteInfo`, `DdevEnv` (`../../ferry-cli/src/env/ddev.js`), `pull/PullOpts/PullResult`.
- Produces:
  - `engine.ts`: the `Engine` interface (unchanged shape from Task 3) plus `export function realEngine(): Engine`. `link()` writes the profile with `clonePath = join(ferryHome(), 'clones', slugFromUrl(url))`.
  - Routes: `POST /api/sites/:id/pair {code}` → 200 site JSON | 409 already paired | 422 multisite | 400 other pair errors; `POST /api/sites/:id/test` → 200 `{ wp, php, db, server }` | 409 unpaired | 502 with hint on 403.
  - `testApp.ts`: `stubEngine(overrides?: Partial<Engine>): Engine` — every method rejects/throws `'not stubbed'` unless overridden; `cloneUrl` defaults to `` (slug) => `https://${slug}.ddev.site` ``.

- [ ] **Step 1: Write the failing test**

Add to `ferry-server/tests/helpers/testApp.ts`:

```ts
import type { Engine } from '../../src/engine.js';

export function stubEngine(overrides: Partial<Engine> = {}): Engine {
  return {
    link: () => Promise.reject(new Error('not stubbed')),
    pull: () => Promise.reject(new Error('not stubbed')),
    siteInfo: () => Promise.reject(new Error('not stubbed')),
    verifyClone: () => Promise.reject(new Error('not stubbed')),
    cloneUrl: (slug: string) => `https://${slug}.ddev.site`,
    ...overrides,
  };
}
```

`ferry-server/tests/pair-test.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

async function makeSite(app: import('fastify').FastifyInstance, cookie: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
  return res.json().id as number;
}

describe('pairing', () => {
  it('pairs a site with a valid code', async () => {
    const linked: string[] = [];
    const { app } = makeApp({ engine: stubEngine({ link: async (url, code) => { linked.push(`${url}|${code}`); } }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('paired');
    expect(linked).toEqual(['https://klant.nl|ABCD2345']);
  });

  it('maps multisite refusal to refused_multisite + 422', async () => {
    const { app } = makeApp({
      engine: stubEngine({ link: async () => { throw new Error('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.'); } }),
    });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(422);
    const detail = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie } });
    expect(detail.json().status).toBe('refused_multisite');
  });

  it('keeps status new on a wrong code and refuses re-pairing', async () => {
    const { app } = makeApp({ engine: stubEngine({ link: async () => { throw new Error('Pairing failed (403).'); } }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    let res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'WRONG234' } });
    expect(res.statusCode).toBe(400);
    let detail = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie } });
    expect(detail.json().status).toBe('new');
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(400); // missing code
  });

  it('refuses pairing an already-paired site', async () => {
    const { app } = makeApp({ engine: stubEngine({ link: async () => {} }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(409);
  });
});

describe('connection test', () => {
  const info = {
    wp: '6.8', php: { version: '8.1.27', extensions: [], ini: {} },
    db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: '', bytes: 1 },
    server: 'nginx', constants: {}, multisite: false, prefix: 'wp_', abspath: '/', siteurl: 'https://klant.nl',
  };

  it('reports versions for a paired site', async () => {
    const { app } = makeApp({ engine: stubEngine({ link: async () => {}, siteInfo: async () => info as never }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wp: '6.8', php: '8.1.27', db: 'mariadb 10.6.16', server: 'nginx' });
  });

  it('refuses testing an unpaired site and hints on 403', async () => {
    const { app } = makeApp({
      engine: stubEngine({ link: async () => {}, siteInfo: async () => { throw new Error('GET /ferry/v1/info failed (403): blocked'); } }),
    });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    let res = await app.inject({ method: 'POST', url: `/api/sites/${id}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('security plugin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server test`
Expected: FAIL — pair/test routes return 404.

- [ ] **Step 3: Implement the real engine and the routes**

`ferry-server/src/engine.ts` (replace the placeholder file):

```ts
import { join } from 'node:path';
import { request } from 'undici';
import { FerryClient } from '../../ferry-cli/src/client.js';
import { DdevEnv } from '../../ferry-cli/src/env/ddev.js';
import { link } from '../../ferry-cli/src/link.js';
import { ferryHome, loadProfile, slugFromUrl, type SiteInfo } from '../../ferry-cli/src/profile.js';
import { pull, type PullOpts, type PullResult } from '../../ferry-cli/src/pull.js';

export interface Engine {
  link(url: string, code: string): Promise<void>;
  pull(slug: string, opts: PullOpts): Promise<PullResult>;
  siteInfo(slug: string): Promise<SiteInfo>;
  verifyClone(url: string): Promise<boolean>;
  cloneUrl(slug: string): string;
}

export function realEngine(): Engine {
  const env = new DdevEnv();
  return {
    async link(url, code) {
      // clone dirs live under the server's FERRY_HOME, not the operator's homedir
      await link(url, code, join(ferryHome(), 'clones', slugFromUrl(url)));
    },
    async pull(slug, opts) {
      return pull(slug, {}, opts);
    },
    async siteInfo(slug) {
      const profile = loadProfile(slug);
      const client = new FerryClient(profile.url, profile.secret);
      await client.syncClock();
      const { data } = await client.getJson('/ferry/v1/info');
      return data as SiteInfo;
    },
    async verifyClone(url) {
      // Spec §3.3: HTTP 200 with a non-empty HTML body, checked from the machine running the clone.
      try {
        const res = await request(url, { maxRedirections: 3 });
        const body = await res.body.text();
        return res.statusCode === 200 && /<html/i.test(body);
      } catch {
        return false;
      }
    },
    cloneUrl(slug) {
      return env.url(slug);
    },
  };
}
```

Append to `siteRoutes` in `ferry-server/src/routes/sites.ts` (deps.engine is required by these routes; `buildApp` callers that use them always pass one — throw at registration if missing):

```ts
  const engine = deps.engine;
  if (!engine) return; // app built without an engine (store-only tests)

  app.post('/api/sites/:id/pair', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status !== 'new' && site.status !== 'refused_multisite') {
      return reply.code(409).send({ error: 'This site is already paired.' });
    }
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code || code.trim() === '') {
      return reply.code(400).send({ error: 'Enter the pairing code shown by the plugin.' });
    }
    try {
      await engine.link(site.url, code.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/multisite/i.test(message)) {
        deps.store.setStatus(site.id, 'refused_multisite', { lastError: message });
        return reply.code(422).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
    deps.store.setStatus(site.id, 'paired', { lastError: null });
    return siteJson(deps.store.siteFor(request.user.id, site.id)!);
  });

  app.post('/api/sites/:id/test', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status === 'new' || site.status === 'refused_multisite') {
      return reply.code(409).send({ error: 'Pair the site first.' });
    }
    try {
      const info = await engine.siteInfo(site.slug);
      return {
        wp: info.wp,
        php: info.php.version,
        db: `${info.db.server} ${info.db.version}`,
        server: info.server,
      };
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (message.includes('(403)')) {
        message += ' — is a security plugin blocking the ferry REST namespace?'; // spec §3.4
      }
      return reply.code(502).send({ error: message });
    }
  });
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm --workspace ferry-server test && npm --workspace ferry-server run typecheck`
Expected: PASS (store/auth/sites tests untouched, pair-test suite green).

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/engine.ts ferry-server/src/routes/sites.ts ferry-server/tests/helpers/testApp.ts ferry-server/tests/pair-test.test.ts
git commit -m "feat(server): engine adapter, device-flow pairing, connection test"
```

---

### Task 6: SyncManager + sync routes + SSE

**Files:**
- Create: `ferry-server/src/sync.ts`
- Create: `ferry-server/src/routes/sync.ts`
- Modify: `ferry-server/src/app.ts` (create one `SyncManager`, register `syncRoutes`)
- Test: `ferry-server/tests/sync.test.ts`

**Interfaces:**
- Consumes: `Engine` (Task 5), `Store`/`Site` (Task 2), `PullProgress` (Task 1), `siteJson` (Task 4).
- Produces:
  - `sync.ts`: `export interface SyncState { status: 'idle' | 'syncing' | 'ready' | 'error'; phase?: string; current?: number; total?: number; detail?: string; error?: string | null; cloneUrl?: string; verifiedAt?: string | null }`; `export class SyncManager` with `constructor(store: Store, engine: Engine)`, `isRunning(siteId: number): boolean`, `start(site: Site): void` (throws `Error('already_syncing')`), `snapshot(site: Site): SyncState`, `subscribe(site: Site, fn: (s: SyncState) => void): () => void` (calls `fn` immediately with the snapshot, returns unsubscribe).
  - `routes/sync.ts`: `syncRoutes(app, deps, sync)`; `POST /api/sites/:id/sync` → 202 `{ started: true }` | 409; `GET /api/sites/:id/sync/events` → SSE.
  - `app.ts`: `AppDeps` unchanged; `buildApp` constructs `new SyncManager(deps.store, deps.engine)` when an engine is present.

- [ ] **Step 1: Write the failing test**

`ferry-server/tests/sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PullProgress, PullResult } from '../../ferry-cli/src/pull.js';
import { SyncManager, type SyncState } from '../src/sync.js';
import { Store } from '../src/store.js';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const RESULT: PullResult = {
  url: 'https://klant-nl.ddev.site', adminUser: 'ferry-admin', adminPassword: 'pw',
  skipped: [], commit: 'abc1234def', neutralizedRepos: 0, liteSkip: [],
  provenance: { reportPath: '/tmp/r.json', summary: 'ok', reused: 0, reconstructed: 0, fetched: 2 },
};

function setup(engineOverrides: Parameters<typeof stubEngine>[0]) {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  store.setStatus(site.id, 'paired');
  const sync = new SyncManager(store, stubEngine(engineOverrides));
  return { store, user, site: store.siteFor(user.id, site.id)!, sync };
}

describe('SyncManager', () => {
  it('runs a sync to ready, forwarding progress and verifying the clone', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => { emit = opts.onProgress; return done.promise; },
      verifyClone: async () => true,
    });
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s));
    sync.start(site);
    expect(sync.isRunning(site.id)).toBe(true);
    expect(store.siteFor(user.id, site.id)!.status).toBe('syncing');
    emit!({ phase: 'files', current: 1, total: 2 });
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
    expect(sync.isRunning(site.id)).toBe(false);
    const final = seen.at(-1)!;
    expect(final).toMatchObject({ status: 'ready', cloneUrl: 'https://klant-nl.ddev.site' });
    expect(seen.some((s) => s.phase === 'files' && s.current === 1)).toBe(true);
    expect(store.siteFor(user.id, site.id)!).toMatchObject({ status: 'ready' });
    expect(store.siteFor(user.id, site.id)!.verifiedAt).not.toBeNull();
  });

  it('records a failed pull as error', async () => {
    const { store, user, site, sync } = setup({ pull: async () => { throw new Error('manifest made no progress - aborting'); } });
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s));
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.at(-1)).toMatchObject({ status: 'error', error: 'manifest made no progress - aborting' });
    expect(store.siteFor(user.id, site.id)!.status).toBe('error');
  });

  it('fails when the clone does not verify', async () => {
    const { store, user, site, sync } = setup({ pull: async () => RESULT, verifyClone: async () => false });
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.siteFor(user.id, site.id)!.status).toBe('error');
    expect(store.siteFor(user.id, site.id)!.lastError).toContain('did not answer');
  });

  it('refuses a second concurrent sync and replays state to late subscribers', async () => {
    const done = deferred<PullResult>();
    const { site, sync } = setup({ pull: async () => done.promise, verifyClone: async () => true });
    sync.start(site);
    expect(() => sync.start(site)).toThrow('already_syncing');
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s)); // subscribe mid-sync
    expect(seen[0]!.status).toBe('syncing');
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.at(-1)!.status).toBe('ready');
  });
});

describe('sync routes', () => {
  it('starts a sync over HTTP and refuses unpaired sites', async () => {
    const done = deferred<PullResult>();
    const { app } = makeApp({ engine: stubEngine({ link: async () => {}, pull: async () => done.promise, verifyClone: async () => true }) });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
    const id = created.json().id as number;
    let res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(409); // still status new
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(409); // already running
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('streams full-state SSE messages', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { app } = makeApp({
      engine: stubEngine({ link: async () => {}, pull: async (_s, opts) => { emit = opts.onProgress; return done.promise; }, verifyClone: async () => true }),
    });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
    const id = created.json().id as number;
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sites/${id}/sync/events`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const states: SyncState[] = [];
    async function readUntil(pred: () => boolean): Promise<void> {
      while (!pred()) {
        const { value, done: eof } = await reader.read();
        if (eof) throw new Error('SSE stream ended early');
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop()!; // last piece may be a partial frame — keep it
        for (const frame of frames) {
          if (frame.startsWith('data: ')) states.push(JSON.parse(frame.slice(6)) as SyncState);
        }
      }
    }

    await readUntil(() => states.length >= 1); // snapshot on connect (idle — sync not started yet)
    await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    await readUntil(() => states.some((s) => s.status === 'syncing'));
    emit!({ phase: 'db', current: 3, total: 12, detail: 'wp_posts' });
    await readUntil(() => states.some((s) => s.phase === 'db' && s.current === 3));
    done.resolve(RESULT);
    await readUntil(() => states.some((s) => s.status === 'ready'));
    await reader.cancel();
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server test`
Expected: FAIL — `../src/sync.js` not found.

- [ ] **Step 3: Implement**

`ferry-server/src/sync.ts`:

```ts
import type { PullProgress } from '../../ferry-cli/src/pull.js';
import type { Engine } from './engine.js';
import type { Site, Store } from './store.js';

export interface SyncState {
  status: 'idle' | 'syncing' | 'ready' | 'error';
  phase?: string;
  current?: number;
  total?: number;
  detail?: string;
  error?: string | null;
  cloneUrl?: string;
  verifiedAt?: string | null;
}

type Listener = (state: SyncState) => void;

/**
 * Per-site sync state machine. Active state lives in memory (spec §3.3);
 * the durable outcome goes to the store. Every emitted state is complete —
 * SSE consumers just render the last message they received.
 */
export class SyncManager {
  private active = new Map<number, SyncState>();
  private listeners = new Map<number, Set<Listener>>();

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
  ) {}

  isRunning(siteId: number): boolean {
    return this.active.has(siteId);
  }

  snapshot(site: Site): SyncState {
    const running = this.active.get(site.id);
    if (running) return running;
    if (site.status === 'ready') {
      return { status: 'ready', cloneUrl: this.engine.cloneUrl(site.slug), verifiedAt: site.verifiedAt, error: null };
    }
    if (site.status === 'error') return { status: 'error', error: site.lastError };
    return { status: 'idle', error: null };
  }

  start(site: Site): void {
    if (this.active.has(site.id)) throw new Error('already_syncing');
    const state: SyncState = { status: 'syncing', phase: 'info' };
    this.active.set(site.id, state);
    this.store.setStatus(site.id, 'syncing');
    this.emit(site.id, state);
    void this.run(site);
  }

  subscribe(site: Site, fn: Listener): () => void {
    fn(this.snapshot(site));
    let set = this.listeners.get(site.id);
    if (!set) {
      set = new Set();
      this.listeners.set(site.id, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  private async run(site: Site): Promise<void> {
    try {
      const result = await this.engine.pull(site.slug, {
        onProgress: (e: PullProgress) => {
          const state: SyncState = { status: 'syncing', phase: e.phase, current: e.current, total: e.total, detail: e.detail };
          this.active.set(site.id, state);
          this.emit(site.id, state);
        },
      });
      const verified = await this.engine.verifyClone(result.url);
      if (!verified) {
        throw new Error(`Clone did not answer at ${result.url}.`);
      }
      const now = new Date().toISOString();
      this.store.setStatus(site.id, 'ready', { lastError: null, lastSyncAt: now, verifiedAt: now });
      this.active.delete(site.id);
      this.emit(site.id, { status: 'ready', cloneUrl: result.url, verifiedAt: now, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.setStatus(site.id, 'error', { lastError: message });
      this.active.delete(site.id);
      this.emit(site.id, { status: 'error', error: message });
    }
  }

  private emit(siteId: number, state: SyncState): void {
    for (const fn of this.listeners.get(siteId) ?? []) fn(state);
  }
}
```

`ferry-server/src/routes/sync.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { SyncManager } from '../sync.js';

export function syncRoutes(app: FastifyInstance, deps: AppDeps, sync: SyncManager): void {
  app.post('/api/sites/:id/sync', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status === 'new' || site.status === 'refused_multisite') {
      return reply.code(409).send({ error: 'Pair the site first.' });
    }
    try {
      sync.start(site);
    } catch {
      return reply.code(409).send({ error: 'A sync is already running for this site.' });
    }
    return reply.code(202).send({ started: true });
  });

  app.get('/api/sites/:id/sync/events', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const unsubscribe = sync.subscribe(site, (state) => {
      reply.raw.write(`data: ${JSON.stringify(state)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
```

In `app.ts`: import `SyncManager` and `syncRoutes`; after `siteRoutes(app, deps);` add:

```ts
  if (deps.engine) {
    syncRoutes(app, deps, new SyncManager(deps.store, deps.engine));
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm --workspace ferry-server test && npm --workspace ferry-server run typecheck`
Expected: PASS, including the real-socket SSE test.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/sync.ts ferry-server/src/routes/sync.ts ferry-server/src/app.ts ferry-server/tests/sync.test.ts
git commit -m "feat(server): in-memory sync state machine with full-state SSE and clone verification"
```

---

### Task 7: Plugin zip + server entry

**Files:**
- Create: `ferry-server/src/plugin-zip.ts`
- Create: `ferry-server/src/main.ts`
- Modify: `ferry-server/src/app.ts` (plugin.zip route)
- Test: `ferry-server/tests/plugin-zip.test.ts`

**Interfaces:**
- Consumes: `buildApp`, `Store.recoverInterruptedSyncs`, `realEngine`, `ferryHome`.
- Produces: `buildPluginZip(pluginDir: string): Buffer` — zip with every entry under a top-level `ferry-connect/` folder, excluding `tests/`, `vendor/`, `composer.json`, `composer.lock`, `phpunit.xml`; route `GET /api/plugin.zip` (session-gated, 404 when `deps.pluginZip` absent); runnable entry `npm --workspace ferry-server run dev` on `http://127.0.0.1:4000` (`PORT` env overrides).

- [ ] **Step 1: Write the failing test**

`ferry-server/tests/plugin-zip.test.ts`:

```ts
import { unzipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPluginZip } from '../src/plugin-zip.js';
import { makeApp, signup } from './helpers/testApp.js';

const PLUGIN_DIR = fileURLToPath(new URL('../../ferry-plugin', import.meta.url));

describe('plugin zip', () => {
  it('packs the plugin under ferry-connect/ without dev files', () => {
    const zip = buildPluginZip(PLUGIN_DIR);
    const entries = Object.keys(unzipSync(new Uint8Array(zip)));
    expect(entries).toContain('ferry-connect/ferry.php');
    expect(entries.some((e) => e.startsWith('ferry-connect/src/'))).toBe(true);
    expect(entries.some((e) => e.includes('/vendor/') || e.includes('/tests/'))).toBe(false);
    expect(entries.every((e) => e.startsWith('ferry-connect/'))).toBe(true);
  });

  it('serves the zip to signed-in users only', async () => {
    const { app } = makeApp({ pluginZip: buildPluginZip(PLUGIN_DIR) });
    let res = await app.inject({ method: 'GET', url: '/api/plugin.zip' });
    expect(res.statusCode).toBe(401);
    const cookie = await signup(app);
    res = await app.inject({ method: 'GET', url: '/api/plugin.zip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('ferry-connect.zip');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server test`
Expected: FAIL — `../src/plugin-zip.js` not found.

- [ ] **Step 3: Implement**

`ferry-server/src/plugin-zip.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const EXCLUDE_TOP = new Set(['tests', 'vendor', 'composer.json', 'composer.lock', 'phpunit.xml']);

/** Dev-time stand-in for a released plugin artifact (spec §2.3). */
export function buildPluginZip(pluginDir: string): Buffer {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const rel = relative(pluginDir, abs);
      if (EXCLUDE_TOP.has(rel.split(sep)[0]!)) continue;
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else {
        files[`ferry-connect/${rel.split(sep).join('/')}`] = readFileSync(abs);
      }
    }
  };
  walk(pluginDir);
  return Buffer.from(zipSync(files));
}
```

In `app.ts`, after the sync-routes block:

```ts
  app.get('/api/plugin.zip', { preHandler: app.requireUser }, async (_request, reply) => {
    if (!deps.pluginZip) return reply.code(404).send({ error: 'Plugin artifact not available.' });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', 'attachment; filename="ferry-connect.zip"')
      .send(deps.pluginZip);
  });
```

`ferry-server/src/main.ts`:

```ts
import { mkdirSync } from 'node:fs';
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
const app = buildApp({ store, engine: realEngine(), pluginZip: buildPluginZip(pluginDir) });

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`ferry-server listening on http://127.0.0.1:${port}`);
if (recovered > 0) {
  console.log(`  ${recovered} interrupted sync(s) marked as error after restart`);
}
```

- [ ] **Step 4: Run tests + typecheck + boot smoke**

Run: `npm --workspace ferry-server test && npm --workspace ferry-server run typecheck`
Expected: PASS.
Then boot it once: `PORT=4001 npm --workspace ferry-server run start &` → `curl -s http://127.0.0.1:4001/api/me` → expect `{"error":"Not signed in."}` → kill the server.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/plugin-zip.ts ferry-server/src/main.ts ferry-server/src/app.ts ferry-server/tests/plugin-zip.test.ts
git commit -m "feat(server): plugin zip download and server entry with restart recovery"
```

---

### Task 8: E2E against the ferry-prod fixture + runbook

**Files:**
- Create: `ferry-server/e2e/control-plane.ts`
- Create: `docs/superpowers/plans/2026-07-25-ferry-plan3a-e2e-runbook.md`

**Interfaces:**
- Consumes: `buildApp`, `Store`, `realEngine`, the running `ferry-prod` DDEV fixture (`~/ferry-e2e/prod`, plugin `ferry-connect`, site `https://ferry-prod.ddev.site`), `\Ferry\Auth::issue_pairing_code()` via `ddev wp eval`.
- Produces: `npm --workspace ferry-server run e2e` — exits 0 only when the whole flow (signup → site → pair → test → sync via SSE → verified clone) passes **under 120 seconds**.

- [ ] **Step 1: Write the E2E script**

`ferry-server/e2e/control-plane.ts`:

```ts
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
```

- [ ] **Step 2: Write the runbook**

`docs/superpowers/plans/2026-07-25-ferry-plan3a-e2e-runbook.md`:

```markdown
# Plan 3a E2E runbook — control plane against ferry-prod

## Preconditions
- The paired fixture runs: `cd ~/ferry-e2e/prod && ddev start` (never restore it with
  `ddev wp core download` — use the official zip).
- mkcert CA trusted for Node: `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`
- Docker/DDEV running; workspace installed (`npm install` at the repo root).

## Run
    export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
    npm --workspace ferry-server run e2e

Pass = exit 0, `✔ E2E passed in <s>s` with s < 120, phases printed
`info → manifest → resolve → files → git → db → import → done`, clone server-verified.
The script provisions everything under a fresh temp FERRY_HOME and prints it.

## Teardown
    ddev delete -Oy ferry-prod-ddev-site   # the clone project created by the run
    rm -rf <printed FERRY_HOME>

## Troubleshooting
- `fetch failed ... self-signed certificate` → NODE_EXTRA_CA_CERTS not exported in this shell.
- `pair: 400` → pairing code expired (10 min TTL); the script issues a fresh one per run,
  so this usually means the fixture plugin is deactivated.
- Sync hangs in `import` → DDEV cold start; check `ddev list` and Docker resources.
- Env vars: `FERRY_E2E_PROD` (fixture dir), `FERRY_E2E_URL` (fixture URL), `PORT` unused here
  (the script binds an ephemeral port).
```

- [ ] **Step 3: Run the E2E**

Run (fixture up, CA exported): `npm --workspace ferry-server run e2e`
Expected: exit 0, all phases in order, `✔ E2E passed` well under 120s (Plan-2 pulls of the fixture ran ~60s). If it fails, fix forward — this is the Plan 3a done-gate.

- [ ] **Step 4: Teardown check**

Run: `ddev delete -Oy ferry-prod-ddev-site && rm -rf <printed FERRY_HOME>`
Expected: clone project removed; fixture `ferry-prod` untouched and still running.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/e2e/control-plane.ts docs/superpowers/plans/2026-07-25-ferry-plan3a-e2e-runbook.md
git commit -m "test(server): Plan 3a E2E gate — full pairing+sync flow against ferry-prod under 2 minutes"
```

---

## Self-Review Notes

- **Spec coverage:** §2.1 workspace/packages → Task 2; §2.2 storage split + secrets rule → Tasks 2/4 (siteJson strips nothing secret because the store never holds one); §2.3 API surface → Tasks 3–7 (dashboard static serving is Plan 3b); §3.1 pairing → Task 5; §3.2 connection test + 403 hint → Task 5; §3.3 progress seam/SSE/verification/one-sync-per-site → Tasks 1 and 6; §5 error handling → Tasks 2 (restart recovery), 5 (pair errors), 6 (pull failure); §6 gates → tests per task + Task 8. §4 (dashboard screens) is Plan 3b by design.
- **Deliberately not here:** the CLI printing progress from the new callback (spec marks it non-Plan-3 work); dashboard static serving (3b wires it into `app.ts`).
- Phase names, status values, route paths, and type names are identical across Tasks 1, 5, 6, and 8 — verified against each task's Interfaces block.
```
