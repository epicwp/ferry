# Ferry Plan 3b — Dashboard Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React dashboard (screens 1–5 + 17) over the Plan 3a control plane API, so the spec §1 flow steps 1–6 run entirely in the browser — plus four parked 3a fixes the dashboard renders on top of.

**Architecture:** New `ferry-dashboard` npm workspace (React + Vite + TS), served statically by `ferry-server` in prod mode (`@fastify/static` + SPA fallback) and by the Vite dev server with an `/api` proxy during dev. Thin pages over `fetch` + `EventSource`; no state library, no CSS framework — one stylesheet carrying the design tokens from the approved design.

**Tech Stack:** React 19, react-router-dom 7, Vite 6, TypeScript strict ESM, `@fastify/static`, Playwright for the E2E gate.

**Spec:** `docs/superpowers/specs/2026-07-25-ferry-plan3-control-plane-design.md` — §4 is the 3b scope; §1 decisions bind it.
**Design reference:** `design/Ferry Dashboard.dc.html` — a disposable DesignSync cache of the Claude Design project "Ferry SaaS Dashboard Design" (see `design/README.md`). **Never commit this file** (Task 3 adds a gitignore guard). If it is missing, re-pull via DesignSync. Screens are marked with `SCREEN N` HTML comments: screen 1 ≈ line 44, screen 2 ≈ 96, screen 3 ≈ 165, screen 4 ≈ 195, screen 5 ≈ 224, screen 17 ≈ 988.

## Global Constraints

- **All UI copy in English.** The design's Dutch copy (none left in screens 1–5/17 — they are already English) is translated where encountered.
- **No clickable clone domain, ever** (spec §1 decision 1): the clone URL renders as copyable text with "Clone verified ✓". The Playwright gate asserts `a[href*="ddev.site"]` does not exist. Clone admin credentials never appear in the UI (they are not in any API response either).
- **Out of scope** (spec §7): email verification, password reset ("Forgot?"), OAuth ("Continue with GitHub"), the signup "Name" field (API is email+password), Activity/Settings/Billing pages (sidebar shows them as inert muted labels for design parity), rate limiting, deployment.
- **Design adaptations already decided:** design screen 2 shows URL form + install card on one screen; because the site must exist before instructions, this splits into `/sites/new` (form) → `/sites/:id/install` (instructions). The design's per-character pairing boxes become one large mono input (paste-friendly, format `XXXX-XXXX` per the plugin's `Auth::issue_pairing_code()`). The design's zip/WP-CLI tab pair becomes a zip download button + always-visible terminal block. Screen 4's checklist follows the **real** engine phase order (`info manifest resolve files git db import`), not the design's illustrative order.
- **Engine/server changes are limited to:** the four parked 3a fixes (Tasks 1–2) and static serving (Task 3). Nothing else in `ferry-cli`/`ferry-server` may change.
- **Suites stay green:** `npm --workspace ferry-cli test` (93 tests + any added), `npm --workspace ferry-server test` (30 + any added), `npm --workspace ferry-server run typecheck`, and the Plan 3a E2E (`npm --workspace ferry-server run e2e`).
- **Conventions:** TypeScript strict, ESM, 2-space indent, same style as `ferry-cli`/`ferry-server`. React function components only.
- **E2E preconditions** (same as 3a — runbook `docs/superpowers/plans/2026-07-25-ferry-plan3a-e2e-runbook.md`): `ferry-prod` fixture running at `~/ferry-e2e/prod`; `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`; before each run `ddev delete -Oy ferry-prod-ddev-site`; never restore the fixture with `ddev wp core download`.
- **Branch:** `feat/dashboard-shell` off `main` (fc14ac3).

## File Structure

```
ferry/
  package.json                      (modify: add ferry-dashboard workspace)
  .gitignore                        (modify: ignore design/* except README)
  ferry-cli/src/db.ts               (modify: 1-based table counter)
  ferry-cli/src/link.ts             (modify: MultisiteError)
  ferry-server/src/app.ts           (modify: staticDir + SPA fallback)
  ferry-server/src/main.ts          (modify: serve ferry-dashboard/dist)
  ferry-server/src/sync.ts          (modify: clear lastError on start)
  ferry-server/src/store.ts         (modify: narrow catches)
  ferry-server/src/routes/sites.ts  (modify: MultisiteError instead of regex)
  ferry-dashboard/
    package.json  tsconfig.json  vite.config.ts  index.html  playwright.config.ts
    src/
      main.tsx        (router)
      api.ts          (typed fetch wrapper + shared API types)
      ui.css          (design tokens + all styles)
      layout.tsx      (RequireAuth, session context, AppLayout sidebar, Logo)
      stepper.tsx     (Plugin → Pair → Sync stepper)
      pages/
        auth.tsx  sites.tsx  new-site.tsx  install.tsx  pair.tsx  sync.tsx
    e2e/
      server.ts           (prod-mode server on :4173, fresh FERRY_HOME)
      dashboard.spec.ts   (all Playwright tests incl. the 3b gate)
```

Routes: `/login` → AuthPage · `/` → SitesPage · `/sites/new` → NewSitePage · `/sites/:id/install` → InstallPage · `/sites/:id/pair` → PairPage · `/sites/:id/sync` → SyncPage. Sites-list row click targets by status: `new` → install, `refused_multisite` → pair, everything else → sync.

---

### Task 1: ferry-cli parked fixes — db counter + typed multisite error

**Files:**
- Modify: `ferry-cli/src/db.ts:28`
- Modify: `ferry-cli/src/link.ts`
- Test: `ferry-cli/tests/progress.test.ts`, `ferry-cli/tests/link.test.ts`

**Interfaces:**
- Consumes: existing `pullDatabase(client, dumpDir, skip, onTable)` and `link(url, code, dir?)`.
- Produces: `onTable(done, total, name)` now emits `done` **1-based** (first event `1 of N`, last `N of N`, `name` = table currently being dumped) — matching the files counter, which ends at N of N. New export `class MultisiteError extends Error {}` from `ferry-cli/src/link.js`; `link()` throws it (same message as today) on `ferry_multisite`. Task 2 consumes both.

- [ ] **Step 1: Extend the progress test to pin the counter contract (fails against current code)**

In `ferry-cli/tests/progress.test.ts`, give the mock a second table and assert the db counter shape. Replace the `dbTables:` array with:

```ts
      dbTables: [{
        name: 'wp_posts', rows: 1, bytes: 64, pk: 'ID', maxpk: 1,
        batches: [{ sql: 'INSERT INTO wp_posts VALUES (1);\n', lastKey: 1, complete: true }],
      }, {
        name: 'wp_options', rows: 1, bytes: 64, pk: 'option_id', maxpk: 1,
        batches: [{ sql: 'INSERT INTO wp_options VALUES (1);\n', lastKey: 1, complete: true }],
      }],
```

and after the existing `dbEvent` assertion add:

```ts
    const dbEvents = events.filter((e) => e.phase === 'db' && e.current !== undefined);
    expect(dbEvents[0]?.current).toBe(1); // 1-based: never "0 of N"
    expect(dbEvents.at(-1)?.current).toBe(2); // reaches N of N, like the files counter
    expect(dbEvents.at(-1)?.total).toBe(2);
    expect(dbEvents.at(-1)?.detail).toBe('wp_options');
```

In `ferry-cli/tests/link.test.ts`, strengthen the multisite test (add `MultisiteError` to the import from `../src/link.js`):

```ts
  it('maps the multisite refusal to a typed error', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 'ferry_multisite', message: 'Multisite is not supported.' }));
    });
    const err = await link(base, 'XXXX-XXXX').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultisiteError);
    expect(String((err as Error).message)).toMatch(/multisite/i);
  });
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `npm --workspace ferry-cli test -- progress link`
Expected: FAIL — `dbEvents[0].current` is `0` not `1`; multisite error is a plain `Error`, not `MultisiteError`.

- [ ] **Step 3: Implement both fixes**

`ferry-cli/src/db.ts` line 28 — the callback fires at the start of each table; make it 1-based so the last emission is `N of N`:

```ts
    onTable?.(i + 1, tables.length, table.name);
```

`ferry-cli/src/link.ts` — add the class above `link()` and throw it (message unchanged):

```ts
export class MultisiteError extends Error {}
```

```ts
    if (data.code === 'ferry_multisite') {
      throw new MultisiteError('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.');
    }
```

- [ ] **Step 4: Run the full ferry-cli suite**

Run: `npm --workspace ferry-cli test`
Expected: PASS (93 + the strengthened assertions). If any other test asserted the 0-based counter, fix that assertion to the new 1-based contract — nothing else.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/db.ts ferry-cli/src/link.ts ferry-cli/tests/progress.test.ts ferry-cli/tests/link.test.ts
git commit -m "fix(cli): 1-based db progress counter; typed MultisiteError from link()"
```

---

### Task 2: ferry-server parked fixes — MultisiteError, lastError reset, narrowed catches

**Files:**
- Modify: `ferry-server/src/routes/sites.ts:62-71`
- Modify: `ferry-server/src/sync.ts:50`
- Modify: `ferry-server/src/store.ts` (both bare catches)
- Test: `ferry-server/tests/pair-test.test.ts`, `ferry-server/tests/sync.test.ts`, `ferry-server/tests/store.test.ts`

**Interfaces:**
- Consumes: `MultisiteError` from `../../../ferry-cli/src/link.js` (Task 1).
- Produces: unchanged HTTP contract (422 + `refused_multisite` on multisite, 400 otherwise). `Store.createUser`/`createSite` still return `undefined` on UNIQUE violations but now **rethrow** anything that is not a `SQLITE_CONSTRAINT*` error. `SyncManager.start()` clears `last_error` the moment a site enters `syncing`, so a retry never shows the stale previous error.

- [ ] **Step 1: Write the failing tests**

`ferry-server/tests/pair-test.test.ts` — make the multisite stub throw the typed error (add `import { MultisiteError } from '../../ferry-cli/src/link.js';`), replacing the plain `Error` in the existing test:

```ts
      engine: stubEngine({ link: async () => { throw new MultisiteError('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.'); } }),
```

Then add a regression test right after it — a *plain* error whose message merely mentions multisite must NOT mark the site refused:

```ts
  it('does not refuse on a plain error that merely mentions multisite', async () => {
    const { app, store } = makeApp({
      engine: stubEngine({ link: async () => { throw new Error('server said: multisite maintenance page returned'); } }),
    });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://s.example' } });
    const id = created.json().id as number;
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'AAAA-BBBB' } });
    expect(res.statusCode).toBe(400);
    const detail = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie } });
    expect(detail.json().status).toBe('new');
  });
```

`ferry-server/tests/sync.test.ts` — add (using this file's existing setup helpers/style; the pull stub must never resolve so the site stays `syncing`):

```ts
  it('clears the stale lastError the moment a retry enters syncing', async () => {
    const { app, store } = makeApp({
      engine: stubEngine({ pull: () => new Promise(() => {}), cloneUrl: (s) => `https://${s}.ddev.site` }),
    });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://retry.example' } });
    const id = created.json().id as number;
    store.setStatus(id, 'error', { lastError: 'previous failure' });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
    const detail = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie } });
    expect(detail.json().status).toBe('syncing');
    expect(detail.json().lastError).toBeNull();
  });
```

`ferry-server/tests/store.test.ts` — add:

```ts
  it('rethrows non-constraint errors instead of swallowing them', () => {
    const store = new Store(':memory:');
    store.close();
    expect(() => store.createUser('x@example.com', 'hash')).toThrow();
    expect(() => store.createSite(1, 'X', 'https://x.example', 'x-example')).toThrow();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm --workspace ferry-server test`
Expected: FAIL — plain-error test gets 422/`refused_multisite` (regex matched), retry test sees `lastError: 'previous failure'`, store test gets `undefined` back instead of a throw. (The typed-stub edit alone still passes — that's fine; the regression test is the teeth.)

- [ ] **Step 3: Implement the three fixes**

`ferry-server/src/routes/sites.ts` — add `import { MultisiteError } from '../../../ferry-cli/src/link.js';` and replace the catch body of the pair route:

```ts
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof MultisiteError) {
        deps.store.setStatus(site.id, 'refused_multisite', { lastError: message });
        return reply.code(422).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
```

`ferry-server/src/sync.ts` — in `start()`:

```ts
    this.store.setStatus(site.id, 'syncing', { lastError: null });
```

`ferry-server/src/store.ts` — add a module-level helper and use it in both catches:

```ts
function isConstraintError(err: unknown): boolean {
  return err instanceof Error && String((err as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT');
}
```

```ts
    } catch (err) {
      if (isConstraintError(err)) return undefined; // UNIQUE violation: email already registered
      throw err;
    }
```

(and the same shape in `createSite`, keeping its `// UNIQUE violation: slug already registered on this server` comment).

- [ ] **Step 4: Run the full server suite + typecheck**

Run: `npm --workspace ferry-server test && npm --workspace ferry-server run typecheck`
Expected: PASS (30 + new).

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src ferry-server/tests
git commit -m "fix(server): typed multisite detection, clear stale lastError on retry, narrow store catches"
```

---

### Task 3: ferry-dashboard workspace scaffold + static serving from ferry-server

**Files:**
- Modify: `package.json` (root), `.gitignore` (root)
- Create: `ferry-dashboard/package.json`, `ferry-dashboard/tsconfig.json`, `ferry-dashboard/vite.config.ts`, `ferry-dashboard/index.html`, `ferry-dashboard/src/main.tsx`, `ferry-dashboard/src/ui.css`
- Modify: `ferry-server/src/app.ts`, `ferry-server/src/main.ts`, `ferry-server/package.json` (add `@fastify/static`)
- Test: `ferry-server/tests/static.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AppDeps` gains optional `staticDir?: string`; when set, `buildApp` serves that directory and falls back to its `index.html` for GET non-`/api/*` routes (SPA fallback); `/api/*` 404s stay JSON. `ferry-dashboard` builds to `ferry-dashboard/dist` via `npm --workspace ferry-dashboard run build`. `src/ui.css` defines the design-token custom properties and base classes (`btn`, `btn--primary`, `btn--outline`, `card`, `field`, `input`, `chip`, `form-error`, `page-center`, `mono`) that all page tasks use.

- [ ] **Step 1: Root wiring + gitignore guard**

`package.json` (root):

```json
{
  "name": "ferry",
  "private": true,
  "workspaces": ["ferry-cli", "ferry-server", "ferry-dashboard"]
}
```

`.gitignore` — append (the DesignSync cache must never be committed; the README stays):

```
design/*
!design/README.md
```

Verify: `git status --short` no longer lists `design/Ferry Dashboard.dc.html`.

- [ ] **Step 2: Dashboard package files**

`ferry-dashboard/package.json`:

```json
{
  "name": "ferry-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json && vite build",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.6.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "typescript": "^5.5.0",
    "vite": "^6.3.0"
  }
}
```

`ferry-dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noUnusedLocals": true
  },
  "include": ["src"]
}
```

`ferry-dashboard/vite.config.ts` (dev proxy per spec §2.1; port override for E2E):

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': `http://127.0.0.1:${process.env.FERRY_API_PORT ?? '4000'}` },
  },
});
```

`ferry-dashboard/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
    <title>Ferry</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`ferry-dashboard/src/main.tsx` (placeholder until Task 4 installs the router):

```tsx
import { createRoot } from 'react-dom/client';
import './ui.css';

createRoot(document.getElementById('root')!).render(<div className="page-center">Ferry dashboard</div>);
```

`ferry-dashboard/src/ui.css` — tokens copied verbatim from the design export (line 25) plus the base primitives. Start from exactly this and extend in later tasks:

```css
:root {
  --bg: oklch(0.968 0.005 255);
  --surface: #ffffff;
  --surface-2: oklch(0.986 0.004 255);
  --panel: oklch(0.976 0.005 255);
  --border: oklch(0.912 0.006 255);
  --border-strong: oklch(0.85 0.008 255);
  --text: oklch(0.26 0.02 262);
  --muted: oklch(0.53 0.02 262);
  --faint: oklch(0.66 0.015 262);
  --accent: oklch(0.52 0.16 262);
  --accent-ink: oklch(0.4 0.16 262);
  --accent-weak: oklch(0.955 0.028 262);
  --green: oklch(0.57 0.13 155);
  --green-weak: oklch(0.955 0.045 155);
  --amber: oklch(0.66 0.13 68);
  --amber-weak: oklch(0.955 0.055 72);
  --red: oklch(0.56 0.19 25);
  --red-weak: oklch(0.955 0.04 25);
  --mono: 'IBM Plex Mono', ui-monospace, monospace;
  --radius: 14px;
  --shadow: 0 1px 2px rgba(22, 24, 44, 0.05), 0 18px 40px -22px rgba(22, 24, 44, 0.22);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  color: var(--text);
  background: var(--bg);
  font-size: 14px;
  line-height: 1.5;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: oklch(0.44 0.16 262); }
::selection { background: var(--accent-weak); }
@keyframes spin { to { transform: rotate(360deg); } }

.mono { font-family: var(--mono); }
.page-center {
  min-height: 100vh;
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  border: 0; border-radius: 9px; padding: 10px 18px;
  font: inherit; font-weight: 500; cursor: pointer; background: none; color: var(--text);
}
.btn--primary { background: var(--accent); color: #fff; box-shadow: 0 8px 20px -10px var(--accent); }
.btn--primary:disabled { opacity: 0.6; cursor: default; }
.btn--outline { border: 1px solid var(--border-strong); color: var(--muted); background: var(--surface); }
.field { display: block; margin-bottom: 12px; }
.field > span { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
.input {
  width: 100%; height: 42px; border: 1px solid var(--border-strong); border-radius: 9px;
  background: var(--surface); padding: 0 12px; font: inherit; font-size: 13px; color: var(--text);
}
.input:focus { outline: none; border-color: var(--accent); }
.form-error {
  background: var(--red-weak); border: 1px solid var(--red); color: var(--red);
  border-radius: 9px; padding: 10px 14px; font-size: 13px; margin-top: 12px;
}
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 500; white-space: nowrap;
}
.chip::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.chip--new, .chip--asleep { color: var(--faint); }
.chip--paired { color: var(--accent-ink); }
.chip--syncing { color: var(--accent-ink); }
.chip--ready { color: var(--green); }
.chip--error, .chip--refused { color: var(--red); }
```

- [ ] **Step 3: Install and build**

Run: `npm install && npm --workspace ferry-dashboard run build`
Expected: `ferry-dashboard/dist/index.html` exists, no TS errors.

- [ ] **Step 4: Failing test for static serving**

Run: `npm --workspace ferry-server install --save @fastify/static` (v8.x for Fastify 5).

Create `ferry-server/tests/static.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers/testApp.js';

function appWithDist() {
  const dist = mkdtempSync(join(tmpdir(), 'ferry-dist-'));
  writeFileSync(join(dist, 'index.html'), '<html><body>ferry-dashboard</body></html>');
  return makeApp({ staticDir: dist });
}

describe('static dashboard serving', () => {
  it('serves index.html at the root', async () => {
    const { app } = appWithDist();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ferry-dashboard');
  });

  it('falls back to index.html for SPA routes', async () => {
    const { app } = appWithDist();
    const res = await app.inject({ method: 'GET', url: '/sites/12/sync' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ferry-dashboard');
  });

  it('keeps unknown API routes as JSON 404s', async () => {
    const { app } = appWithDist();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
```

Run: `npm --workspace ferry-server test -- static`
Expected: FAIL — `staticDir` is not a known dep / routes 404.

- [ ] **Step 5: Implement static serving**

`ferry-server/src/app.ts` — extend `AppDeps` and register at the end of `buildApp` (after the plugin.zip route, before `return app`):

```ts
export interface AppDeps {
  store: Store;
  engine?: Engine;   // wired in Task 5
  pluginZip?: Buffer; // wired in Task 7
  staticDir?: string; // built dashboard (prod mode); dev uses the Vite proxy instead
}
```

```ts
  if (deps.staticDir) {
    void app.register(fastifyStatic, { root: deps.staticDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html'); // SPA fallback: the router owns non-API paths
      }
      return reply.code(404).send({ error: 'Not found.' });
    });
  }
```

with `import fastifyStatic from '@fastify/static';` at the top.

`ferry-server/src/main.ts` — serve the built dashboard when present:

```ts
import { existsSync, mkdirSync } from 'node:fs';
```

```ts
const distDir = fileURLToPath(new URL('../../ferry-dashboard/dist', import.meta.url));
const app = buildApp({
  store,
  engine: realEngine(),
  pluginZip: buildPluginZip(pluginDir),
  staticDir: existsSync(distDir) ? distDir : undefined,
});
```

and after the listen log:

```ts
console.log(existsSync(distDir) ? '  serving dashboard from ferry-dashboard/dist' : '  no dashboard build found — dev mode is `npm --workspace ferry-dashboard run dev`');
```

- [ ] **Step 6: Verify**

Run: `npm --workspace ferry-server test && npm --workspace ferry-server run typecheck`
Expected: PASS (all, including the 3 new static tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore ferry-dashboard ferry-server
git commit -m "feat(dashboard): workspace scaffold; ferry-server serves the built SPA with fallback"
```

---

### Task 4: API client, auth screen (17), app shell + Playwright infrastructure

**Files:**
- Create: `ferry-dashboard/src/api.ts`, `ferry-dashboard/src/layout.tsx`, `ferry-dashboard/src/pages/auth.tsx`, `ferry-dashboard/src/pages/sites.tsx` (shell placeholder), `ferry-dashboard/playwright.config.ts`, `ferry-dashboard/e2e/server.ts`, `ferry-dashboard/e2e/dashboard.spec.ts`
- Modify: `ferry-dashboard/src/main.tsx`, `ferry-dashboard/src/ui.css`, `ferry-dashboard/package.json`

**Interfaces:**
- Consumes: `ui.css` primitives (Task 3); server API (`/api/auth/*`, `/api/me`).
- Produces (used by every later page task):
  - `api.get<T>(path)` / `api.post<T>(path, body?)` — throw `ApiError { message, status }` with the server's `{error}` text.
  - Types `Site`, `SiteStatus`, `SyncState`, `TestResult` exactly mirroring `ferry-server` JSON.
  - `RequireAuth` route wrapper (redirects to `/login` on 401) + `useEmail()` context hook.
  - `AppLayout({ title, headerRight?, children })` — sidebar shell used by list-style pages; `Logo({ size })`.
  - Playwright: `npm --workspace ferry-dashboard run e2e` builds and tests against the real server (prod mode, port 4173, fresh `FERRY_HOME` per run); `signUp(page)` helper in the spec.

- [ ] **Step 1: API client**

`ferry-dashboard/src/api.ts`:

```ts
export type SiteStatus = 'new' | 'paired' | 'syncing' | 'ready' | 'error' | 'refused_multisite';

export interface Site {
  id: number;
  name: string;
  url: string;
  slug: string;
  status: SiteStatus;
  lastError: string | null;
  lastSyncAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** Mirror of ferry-server's SyncState — every SSE message is this full shape. */
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

export interface TestResult { wp: string; php: string; db: string; server: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json: { error?: string } | null = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status);
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
};
```

- [ ] **Step 2: Layout, session guard, logo**

`ferry-dashboard/src/layout.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { api } from './api';

const SessionContext = createContext('');
export const useEmail = () => useContext(SessionContext);

/** Route wrapper: everything behind it requires a session; 401 → /login. */
export function RequireAuth() {
  const [email, setEmail] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    api.get<{ email: string }>('/api/me')
      .then((me) => setEmail(me.email))
      .catch(() => navigate('/login', { replace: true }));
  }, [navigate]);
  if (email === null) return null;
  return (
    <SessionContext.Provider value={email}>
      <Outlet />
    </SessionContext.Provider>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }}>
      <span className="logo__glyph" />
    </span>
  );
}

export function AppLayout({ title, headerRight, children }: { title: string; headerRight?: ReactNode; children: ReactNode }) {
  const email = useEmail();
  const navigate = useNavigate();
  const initials = email.slice(0, 2).toUpperCase();
  const logout = async () => {
    await api.post('/api/auth/logout');
    navigate('/login');
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand"><Logo /> <span>Ferry</span></div>
        <nav className="sidebar__nav">
          <span className="sidebar__item sidebar__item--active"><span className="sidebar__dot sidebar__dot--accent" />Sites</span>
          <span className="sidebar__item"><span className="sidebar__dot" />Activity</span>
          <span className="sidebar__item"><span className="sidebar__dot" />Settings</span>
          <span className="sidebar__item"><span className="sidebar__dot" />Billing</span>
        </nav>
        <div className="sidebar__account">
          <span className="sidebar__avatar">{initials}</span>
          <span className="sidebar__who">
            <span className="sidebar__email">{email}</span>
            <button className="sidebar__logout" onClick={logout}>Log out</button>
          </span>
        </div>
      </aside>
      <main className="main">
        <header className="main__header">
          <h1>{title}</h1>
          <div>{headerRight}</div>
        </header>
        <div className="main__body">{children}</div>
      </main>
    </div>
  );
}
```

Append to `ui.css`:

```css
.logo { display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--accent); flex: none; }
.logo__glyph { width: 43%; height: 43%; border: 2px solid #fff; border-radius: 4px; border-bottom-color: transparent; transform: rotate(45deg); }
.shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; background: var(--surface); }
.sidebar { background: var(--surface-2); border-right: 1px solid var(--border); padding: 20px 16px; display: flex; flex-direction: column; }
.sidebar__brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 20px; font-weight: 600; font-size: 16px; letter-spacing: -0.02em; }
.sidebar__nav { display: flex; flex-direction: column; gap: 2px; }
.sidebar__item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; color: var(--muted); }
.sidebar__item--active { background: var(--accent-weak); color: var(--accent-ink); font-weight: 500; }
.sidebar__dot { width: 6px; height: 6px; border-radius: 2px; background: var(--faint); }
.sidebar__dot--accent { background: var(--accent); }
.sidebar__account { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); }
.sidebar__avatar { width: 30px; height: 30px; border-radius: 8px; background: oklch(0.6 0.12 300); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex: none; }
.sidebar__who { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.sidebar__email { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar__logout { border: 0; background: none; padding: 0; font-size: 11.5px; color: var(--faint); text-align: left; cursor: pointer; }
.sidebar__logout:hover { color: var(--accent); }
.main { display: flex; flex-direction: column; min-height: 0; }
.main__header { height: 60px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 28px; }
.main__header h1 { font-weight: 600; font-size: 16px; }
.main__body { flex: 1; overflow: auto; }
.auth-panel { width: 100%; max-width: 320px; }
.auth-panel__brand { display: flex; align-items: center; gap: 10px; margin-bottom: 26px; font-weight: 600; font-size: 17px; letter-spacing: -0.02em; }
.auth-panel h1 { font-size: 19px; letter-spacing: -0.02em; margin-bottom: 6px; }
.auth-panel__sub { font-size: 13px; color: var(--muted); margin-bottom: 22px; }
.auth-panel__switch { text-align: center; font-size: 12.5px; color: var(--muted); margin-top: 20px; }
.auth-panel__switch button { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
```

- [ ] **Step 3: Auth page (screen 17, panels 1–2 — no OAuth, no Forgot, no verify step per spec §7)**

`ferry-dashboard/src/pages/auth.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Logo } from '../layout';

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/auth/${mode}`, { email, password });
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — try again.');
      setBusy(false);
    }
  };

  const login = mode === 'login';
  return (
    <div className="page-center">
      <div className="auth-panel">
        <div className="auth-panel__brand"><Logo size={30} /> Ferry</div>
        <h1>{login ? 'Welcome back' : 'Start with your first site'}</h1>
        <div className="auth-panel__sub">
          {login ? 'Log in to keep working on your sites.' : 'Connecting takes a minute. No credit card needed.'}
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input className="input mono" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 4 }}>
            {login ? 'Log in' : 'Create account'}
          </button>
          {error && <div className="form-error">{error}</div>}
        </form>
        <div className="auth-panel__switch">
          {login ? 'No account yet? ' : 'Already have an account? '}
          <button onClick={() => { setMode(login ? 'signup' : 'login'); setError(''); }}>
            {login ? 'Sign up' : 'Log in'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Router + placeholder sites page**

`ferry-dashboard/src/pages/sites.tsx` (placeholder — Task 5 replaces the body):

```tsx
import { AppLayout } from '../layout';

export function SitesPage() {
  return (
    <AppLayout title="Sites" headerRight={<span className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>0 sites</span>}>
      <div />
    </AppLayout>
  );
}
```

`ferry-dashboard/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RequireAuth } from './layout';
import { AuthPage } from './pages/auth';
import { SitesPage } from './pages/sites';
import './ui.css';

const router = createBrowserRouter([
  { path: '/login', element: <AuthPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <SitesPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
```

- [ ] **Step 5: Playwright infrastructure**

Run: `npm --workspace ferry-dashboard install --save-dev @playwright/test tsx && npx playwright install chromium`

Add to `ferry-dashboard/package.json` scripts:

```json
    "e2e": "vite build && playwright test",
    "e2e:server": "tsx e2e/server.ts"
```

`ferry-dashboard/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000, // the happy path includes a real initial sync (~25s) — generous headroom
  workers: 1, // flows share one server and one DDEV fixture
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'npm run e2e:server',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
```

`ferry-dashboard/e2e/server.ts` — the built dashboard served by the real API server (prod mode), fresh disposable state per run:

```ts
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
```

`ferry-dashboard/e2e/dashboard.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';

/** Each test gets its own account; the server (and its DB) is fresh per Playwright run. */
async function signUp(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('e2e-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
}

test('sign up lands in the dashboard shell', async ({ page }) => {
  await signUp(page);
  await expect(page.getByRole('heading', { name: 'Sites' })).toBeVisible();
});

test('a wrong password shows an inline error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.locator('.form-error')).toContainText('Wrong email or password.');
  await expect(page).toHaveURL('/login');
});
```

- [ ] **Step 6: Run the Playwright tests**

Run: `npm --workspace ferry-dashboard run e2e`
Expected: 2 passed. (No DDEV fixture needed for these.)

- [ ] **Step 7: Typecheck + commit**

Run: `npm --workspace ferry-dashboard run typecheck`

```bash
git add ferry-dashboard package-lock.json
git commit -m "feat(dashboard): api client, auth screen, app shell, Playwright infrastructure"
```

---

### Task 5: Sites list — empty state (screen 1) + filled list with status chips (screen 5)

**Files:**
- Modify: `ferry-dashboard/src/pages/sites.tsx` (replace placeholder), `ferry-dashboard/src/ui.css`, `ferry-dashboard/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `api`, `Site`, `SiteStatus`, `AppLayout`.
- Produces: `timeAgo(iso: string | null): string | null` exported from `pages/sites.tsx` (SyncPage reuses it in Task 8). Row navigation contract: `new` → `/sites/:id/install`, `refused_multisite` → `/sites/:id/pair`, all others → `/sites/:id/sync`.

- [ ] **Step 1: Implement the page**

Replace `ferry-dashboard/src/pages/sites.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Site, type SiteStatus } from '../api';
import { AppLayout } from '../layout';

const CHIP: Record<SiteStatus, { label: string; cls: string }> = {
  new: { label: 'new', cls: 'chip--new' },
  paired: { label: 'paired', cls: 'chip--paired' },
  syncing: { label: 'syncing', cls: 'chip--syncing' },
  ready: { label: 'ready', cls: 'chip--ready' },
  error: { label: 'error', cls: 'chip--error' },
  refused_multisite: { label: 'multisite refused', cls: 'chip--refused' },
};

export function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function targetFor(site: Site): string {
  if (site.status === 'new') return `/sites/${site.id}/install`;
  if (site.status === 'refused_multisite') return `/sites/${site.id}/pair`;
  return `/sites/${site.id}/sync`;
}

function subline(site: Site): string {
  if (site.status === 'error' && site.lastError) return site.lastError;
  if (site.status === 'refused_multisite' && site.lastError) return site.lastError;
  const synced = timeAgo(site.lastSyncAt);
  return synced ? `${site.url} · synced ${synced}` : site.url;
}

export function SitesPage() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    void api.get<Site[]>('/api/sites').then(setSites);
  }, []);
  if (sites === null) return <AppLayout title="Sites">{null}</AppLayout>;

  const headerRight = sites.length === 0
    ? <span className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>0 sites</span>
    : <button className="btn btn--primary" style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => navigate('/sites/new')}>+ New site</button>;

  return (
    <AppLayout title="Sites" headerRight={headerRight}>
      {sites.length === 0 ? (
        <div className="empty">
          <div className="empty__inner">
            <div className="empty__placeholder"><span className="mono">no connected sites</span></div>
            <h2>Connect your first WordPress site</h2>
            <p>Ferry safely clones your production site into an isolated DDEV environment. No SSH, no FTP — one plugin and a pairing code.</p>
            <button className="btn btn--primary" onClick={() => navigate('/sites/new')}>+ New site</button>
          </div>
        </div>
      ) : (
        <div className="site-list">
          {sites.map((site) => {
            const chip = CHIP[site.status];
            const refused = site.status === 'refused_multisite';
            return (
              <div key={site.id} className={refused ? 'site-row site-row--refused' : 'site-row'}>
                <span className={refused ? 'site-row__avatar site-row__avatar--refused' : 'site-row__avatar mono'}>
                  {refused ? '!' : site.name.charAt(0).toUpperCase()}
                </span>
                <span className="site-row__text">
                  <span className="site-row__name">{site.name}</span>
                  <span className={refused ? 'site-row__sub site-row__sub--refused' : 'site-row__sub mono'}>{subline(site)}</span>
                </span>
                <span className={`chip ${chip.cls}`}>{chip.label}</span>
                <button className="btn btn--outline" style={{ padding: '7px 14px', fontSize: 13 }} onClick={() => navigate(targetFor(site))}>
                  Open
                </button>
              </div>
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}
```

Append to `ui.css`:

```css
.empty { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 32px; }
.empty__inner { text-align: center; max-width: 420px; }
.empty__placeholder {
  height: 150px; border-radius: 12px; border: 1px dashed var(--border-strong);
  background: repeating-linear-gradient(45deg, var(--surface-2), var(--surface-2) 10px, var(--panel) 10px, var(--panel) 20px);
  display: flex; align-items: center; justify-content: center; margin-bottom: 24px;
  font-size: 12px; color: var(--faint);
}
.empty__inner h2 { font-size: 18px; letter-spacing: -0.01em; margin-bottom: 8px; }
.empty__inner p { color: var(--muted); font-size: 13.5px; margin-bottom: 22px; text-wrap: pretty; }
.site-list { padding: 24px 28px; display: flex; flex-direction: column; gap: 12px; }
.site-row { border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; display: flex; align-items: center; gap: 16px; background: var(--surface); }
.site-row--refused { border: 1px dashed var(--red); background: var(--red-weak); }
.site-row__avatar { width: 40px; height: 40px; border-radius: 10px; background: var(--accent-weak); color: var(--accent-ink); display: flex; align-items: center; justify-content: center; font-weight: 600; flex: none; }
.site-row__avatar--refused { background: var(--surface); color: var(--red); font-size: 18px; }
.site-row__text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.site-row__name { font-weight: 600; font-size: 15px; }
.site-row__sub { font-size: 12px; color: var(--faint); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-row__sub--refused { color: var(--red); }
.chip--syncing::before { border: 2px solid var(--accent); border-top-color: transparent; background: none; width: 8px; height: 8px; animation: spin 0.8s linear infinite; }
```

- [ ] **Step 2: Extend the Playwright spec**

Add to `ferry-dashboard/e2e/dashboard.spec.ts`:

```ts
test('a fresh account sees the empty sites state', async ({ page }) => {
  await signUp(page);
  await expect(page.getByText('Connect your first WordPress site')).toBeVisible();
  await expect(page.getByText('no connected sites')).toBeVisible();
  await expect(page.getByText('0 sites')).toBeVisible();
});
```

- [ ] **Step 3: Run + verify**

Run: `npm --workspace ferry-dashboard run e2e && npm --workspace ferry-dashboard run typecheck`
Expected: 3 passed. (Filled-list rendering — chips, `synced … ago` — is asserted at the end of the happy path in Task 8; the remaining chip variants are covered by the manual design comparison in Task 9.)

- [ ] **Step 4: Compare against the design**

Open `design/Ferry Dashboard.dc.html` screens 1 and 5 next to `http://127.0.0.1:5173` (dev: `npm --workspace ferry-server run dev` + `npm --workspace ferry-dashboard run dev`). Match: sidebar proportions, empty-state placeholder hatching, row layout, chip colors.

- [ ] **Step 5: Commit**

```bash
git add ferry-dashboard
git commit -m "feat(dashboard): sites list with empty state and status chips (screens 1+5)"
```

---

### Task 6: New site form + install instructions (screen 2)

**Files:**
- Create: `ferry-dashboard/src/stepper.tsx`, `ferry-dashboard/src/pages/new-site.tsx`, `ferry-dashboard/src/pages/install.tsx`
- Modify: `ferry-dashboard/src/main.tsx` (routes), `ferry-dashboard/src/ui.css`, `ferry-dashboard/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `api`, `Site`, `AppLayout`, `ApiError`.
- Produces: `Stepper({ step: 1 | 2 | 3 })` (labels `Plugin`, `Pair`, `Sync`) — PairPage/SyncPage reuse it. Routes `/sites/new` and `/sites/:id/install` registered. The zip downloads from `/api/plugin.zip` via a plain download link (this is the plugin artifact, not a clone domain — allowed).

- [ ] **Step 1: Stepper component**

`ferry-dashboard/src/stepper.tsx`:

```tsx
const LABELS = ['Plugin', 'Pair', 'Sync'] as const;

export function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="stepper mono">
      {LABELS.map((label, i) => (
        <span key={label} className="stepper__group">
          {i > 0 && <span className="stepper__line" />}
          <span className={i + 1 <= step ? 'stepper__item stepper__item--active' : 'stepper__item'}>
            <span className="stepper__num">{i + 1}</span>
            {label}
          </span>
        </span>
      ))}
    </div>
  );
}
```

Append to `ui.css`:

```css
.stepper { display: flex; align-items: center; gap: 8px; margin-bottom: 28px; font-size: 12px; }
.stepper__group { display: contents; }
.stepper__line { flex: 1; height: 1px; background: var(--border); }
.stepper__item { display: flex; align-items: center; gap: 7px; color: var(--faint); }
.stepper__item--active { color: var(--accent-ink); font-weight: 600; }
.stepper__num { width: 20px; height: 20px; border-radius: 50%; background: var(--surface); border: 1px solid var(--border-strong); display: flex; align-items: center; justify-content: center; }
.stepper__item--active .stepper__num { background: var(--accent); border-color: var(--accent); color: #fff; }
.narrow { width: 100%; max-width: 620px; margin: 0 auto; padding: 36px; }
.breadcrumb { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
.breadcrumb a { color: var(--muted); }
.breadcrumb__sep { color: var(--faint); }
.breadcrumb__here { font-weight: 600; }
.card h2 { font-size: 15px; margin-bottom: 4px; }
.card__sub { color: var(--muted); font-size: 13px; margin-bottom: 18px; text-wrap: pretty; }
.terminal {
  background: oklch(0.22 0.02 262); border-radius: 9px; padding: 14px 16px;
  font-family: var(--mono); font-size: 12.5px; color: oklch(0.9 0.02 262); line-height: 1.7;
}
.terminal__prompt { color: oklch(0.62 0.02 262); }
.terminal__ok { color: var(--green); }
.terminal__note { color: oklch(0.8 0.02 262); }
.terminal__code { color: #fff; background: oklch(0.32 0.03 262); padding: 1px 6px; border-radius: 4px; }
.zip-button {
  display: block; border: 1px solid var(--accent); background: var(--accent-weak);
  border-radius: 9px; padding: 12px; text-align: center; margin-bottom: 18px;
}
.zip-button__title { font-weight: 500; font-size: 13px; color: var(--accent-ink); }
.zip-button__sub { font-family: var(--mono); font-size: 11px; color: var(--faint); margin-top: 2px; }
.form-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
```

- [ ] **Step 2: New-site page**

`ferry-dashboard/src/pages/new-site.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Site } from '../api';
import { AppLayout } from '../layout';
import { Stepper } from '../stepper';

export function NewSitePage() {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const site = await api.post<Site>('/api/sites', { name, url });
      navigate(`/sites/${site.id}/install`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — try again.');
      setBusy(false);
    }
  };

  return (
    <AppLayout title="New site">
      <div className="narrow">
        <div className="breadcrumb" style={{ marginBottom: 24 }}>
          <Link to="/">Sites</Link><span className="breadcrumb__sep">/</span><span className="breadcrumb__here">New site</span>
        </div>
        <Stepper step={1} />
        <form onSubmit={submit} className="card">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My webshop" required />
          </label>
          <label className="field">
            <span>Site URL</span>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" required />
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="form-footer">
            <button type="button" className="btn btn--outline" onClick={() => navigate('/')}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>Continue</button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 3: Install page**

`ferry-dashboard/src/pages/install.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Site } from '../api';
import { AppLayout } from '../layout';
import { Stepper } from '../stepper';

export function InstallPage() {
  const { id } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    void api.get<Site>(`/api/sites/${id}`).then(setSite);
  }, [id]);
  if (!site) return <AppLayout title="New site">{null}</AppLayout>;

  return (
    <AppLayout title="New site">
      <div className="narrow">
        <div className="breadcrumb" style={{ marginBottom: 24 }}>
          <Link to="/">Sites</Link><span className="breadcrumb__sep">/</span><span className="breadcrumb__here">{site.name}</span>
        </div>
        <Stepper step={1} />
        <div className="card">
          <h2>Install the Ferry plugin</h2>
          <div className="card__sub">
            Native PHP, no external dependencies — trivially auditable. Install it on <span className="mono">{site.url}</span>; the plugin then shows a pairing code.
          </div>
          <a className="zip-button" href="/api/plugin.zip" download>
            <span className="zip-button__title">Download .zip</span>
            <span className="zip-button__sub">ferry-connect.zip</span>
          </a>
          <div className="terminal">
            <div><span className="terminal__prompt">$</span> wp plugin install ferry-connect.zip --activate</div>
            <div className="terminal__ok">Plugin 'ferry-connect' activated.</div>
            <div><span className="terminal__prompt">$</span> wp ferry pair</div>
            <div className="terminal__note">Pairing code: <span className="terminal__code">XXXX-XXXX</span> · expires in 10:00</div>
          </div>
        </div>
        <div className="form-footer">
          <button className="btn btn--primary" onClick={() => navigate(`/sites/${site.id}/pair`)}>I have a code → pair</button>
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 4: Register routes**

In `ferry-dashboard/src/main.tsx`, add imports and children:

```tsx
import { NewSitePage } from './pages/new-site';
import { InstallPage } from './pages/install';
```

```tsx
      { path: '/sites/new', element: <NewSitePage /> },
      { path: '/sites/:id/install', element: <InstallPage /> },
```

- [ ] **Step 5: Playwright test**

Add to the spec:

```ts
test('creating a site shows install instructions with the plugin download', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'New site' }).click();
  await expect(page).toHaveURL('/sites/new');
  await page.getByLabel('Name').fill('Demo');
  await page.getByLabel('Site URL').fill('https://demo-site.example');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/sites\/\d+\/install$/);
  await expect(page.locator('a[href="/api/plugin.zip"]')).toBeVisible();
  await expect(page.getByText('wp plugin install ferry-connect.zip --activate')).toBeVisible();
  await page.getByRole('button', { name: /I have a code/ }).click();
  await expect(page).toHaveURL(/\/pair$/);
});
```

(The `/pair` route 404s to a blank RequireAuth outlet until Task 7 — the URL assertion still passes because the SPA fallback serves index.html. If the router logs a no-match warning, that is acceptable here; Task 7 completes the route.)

- [ ] **Step 6: Run + verify**

Run: `npm --workspace ferry-dashboard run e2e && npm --workspace ferry-dashboard run typecheck`
Expected: 4 passed.

- [ ] **Step 7: Compare against the design (screen 2) and commit**

```bash
git add ferry-dashboard
git commit -m "feat(dashboard): new-site form and plugin install instructions (screen 2)"
```

---

### Task 7: Pairing screen with inline errors (screen 3)

**Files:**
- Create: `ferry-dashboard/src/pages/pair.tsx`
- Modify: `ferry-dashboard/src/main.tsx` (route), `ferry-dashboard/src/ui.css`, `ferry-dashboard/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `api`, `ApiError`, `Site`, `Stepper`, `Logo`.
- Produces: route `/sites/:id/pair`. On success navigates to `/sites/:id/sync`. Inline errors: wrong/expired code (HTTP 400 — retry stays possible), multisite refusal (HTTP 422 — shown as a hard stop; retry allowed because the API permits re-pairing from `refused_multisite`).

- [ ] **Step 1: Implement the page**

`ferry-dashboard/src/pages/pair.tsx` — centered panel per the design (no sidebar); one large mono input instead of per-character boxes:

```tsx
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

export function PairPage() {
  const { id } = useParams();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const raw = code.trim().toUpperCase();
    const normalized = raw.includes('-') || raw.length !== 8 ? raw : `${raw.slice(0, 4)}-${raw.slice(4)}`;
    setBusy(true);
    setError('');
    setRefused(false);
    try {
      await api.post(`/api/sites/${id}/pair`, { code: normalized });
      navigate(`/sites/${id}/sync`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setRefused(err.status === 422); // multisite: hard refusal styling
      } else {
        setError('Something went wrong — try again.');
      }
      setBusy(false);
    }
  };

  return (
    <div className="page-center">
      <div className="pair-panel">
        <div className="mono pair-panel__step">STEP 2 / 3 · PAIRING</div>
        <h1>Paste the code from the plugin</h1>
        <p>Server and plugin exchange keys. The code is single-use and expires within 10 minutes.</p>
        <form onSubmit={submit}>
          <input
            className="input mono pair-panel__code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            maxLength={9}
            autoFocus
          />
          <button className="btn btn--primary" type="submit" disabled={busy || code.trim().length < 8}>Connect</button>
        </form>
        {error && (
          <div className={refused ? 'form-error pair-panel__refused' : 'form-error'}>
            {refused && <strong>Multisite refused · </strong>}{error}
          </div>
        )}
        <div className="pair-panel__back"><Link to="/">← Back to sites</Link></div>
      </div>
    </div>
  );
}
```

Append to `ui.css`:

```css
.pair-panel { width: 100%; max-width: 560px; text-align: center; }
.pair-panel__step { font-size: 12px; color: var(--faint); margin-bottom: 10px; }
.pair-panel h1 { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 6px; }
.pair-panel p { color: var(--muted); font-size: 13.5px; margin-bottom: 28px; }
.pair-panel__code {
  height: 66px; max-width: 320px; margin: 0 auto 20px; display: block;
  font-size: 28px; font-weight: 600; text-align: center; letter-spacing: 0.35em;
  border: 1.5px solid var(--accent); border-radius: 11px;
}
.pair-panel__code::placeholder { color: var(--faint); letter-spacing: 0.35em; }
.pair-panel__refused { text-align: left; }
.pair-panel__back { margin-top: 24px; font-size: 12.5px; }
```

- [ ] **Step 2: Register the route**

In `main.tsx`: `import { PairPage } from './pages/pair';` and add `{ path: '/sites/:id/pair', element: <PairPage /> },`.

- [ ] **Step 3: Playwright test — inline error without the fixture**

A site whose URL refuses connections makes `link()` fail fast with a clear message; the UI must show it inline and stay on the pairing screen:

```ts
test('a failed pair shows an inline error and stays on the pairing screen', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'New site' }).click();
  await page.getByLabel('Name').fill('Unreachable');
  await page.getByLabel('Site URL').fill('https://127.0.0.1:9');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /I have a code/ }).click();
  await page.getByPlaceholder('XXXX-XXXX').fill('AAAA-BBBB');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.form-error')).toBeVisible();
  await expect(page).toHaveURL(/\/pair$/);
});
```

- [ ] **Step 4: Run + verify**

Run: `npm --workspace ferry-dashboard run e2e && npm --workspace ferry-dashboard run typecheck`
Expected: 5 passed. (The wrong-code-against-real-plugin and multisite paths: wrong code is exercised in the Task 8 happy path against the fixture; the multisite 422 rendering is covered by server tests + the `refused` styling is verified in the Task 9 manual pass.)

- [ ] **Step 5: Compare against the design (screen 3) and commit**

```bash
git add ferry-dashboard
git commit -m "feat(dashboard): pairing screen with inline errors (screen 3)"
```

---

### Task 8: Sync progress via SSE + verified clone (screen 4) — the 3b happy-path gate

**Files:**
- Create: `ferry-dashboard/src/pages/sync.tsx`
- Modify: `ferry-dashboard/src/main.tsx` (route), `ferry-dashboard/src/ui.css`, `ferry-dashboard/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `api`, `Site`, `SyncState`, `TestResult`, `Stepper`, `timeAgo` (Task 5). SSE: `EventSource('/api/sites/:id/sync/events')` — every message is the **full** `SyncState` JSON; render the last message, no accumulation (spec §3.3).
- Produces: route `/sites/:id/sync`. The complete Plan 3b Playwright gate.

- [ ] **Step 1: Implement the page**

`ferry-dashboard/src/pages/sync.tsx`. Behavior: load the site; if `paired`, auto-run the connection test once (flow step 5) and offer "Start first sync"; always subscribe to SSE (the connect-time snapshot restores mid-sync/ready/error state on refresh); `syncing` renders the checklist in the real engine phase order with counters; `ready` renders "Clone verified ✓" + the URL as copyable text (never a link); `error` renders the message + Retry.

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Site, type SyncState, type TestResult } from '../api';
import { Stepper } from '../stepper';
import { timeAgo } from './sites';

const PHASES: { key: string; label: string; sub?: string }[] = [
  { key: 'info', label: 'Reading site info' },
  { key: 'manifest', label: 'Manifest & hashes fetched' },
  { key: 'resolve', label: 'Core & wp.org plugins reconstructed', sub: 'via official checksums — content-addressable cache' },
  { key: 'files', label: 'Transferring unique files' },
  { key: 'git', label: 'git init on production branch' },
  { key: 'db', label: 'Database via keyset pagination' },
  { key: 'import', label: 'Import & DDEV up — production parity' },
];

function phaseIndex(phase: string | undefined): number {
  if (phase === 'done') return PHASES.length;
  const i = PHASES.findIndex((p) => p.key === phase);
  return i === -1 ? 0 : i;
}

export function SyncPage() {
  const { id } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState('');
  const [copied, setCopied] = useState(false);
  const testedRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    void api.get<Site>(`/api/sites/${id}`).then((s) => {
      setSite(s);
      if (s.status === 'paired' && !testedRef.current) {
        testedRef.current = true;
        api.post<TestResult>(`/api/sites/${id}/test`)
          .then(setTest)
          .catch((err) => setTestError(err instanceof ApiError ? err.message : 'Connection test failed.'));
      }
    });
  }, [id]);

  useEffect(() => {
    const es = new EventSource(`/api/sites/${id}/sync/events`);
    es.onmessage = (ev) => setSync(JSON.parse(ev.data) as SyncState);
    return () => es.close();
  }, [id]);

  if (!site || !sync) return <div className="page-center" />;

  const start = async () => {
    await api.post(`/api/sites/${id}/sync`).catch(() => {}); // 409 (already running) resolves via SSE anyway
  };
  const copy = async () => {
    if (sync.cloneUrl) {
      await navigator.clipboard.writeText(sync.cloneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const idx = phaseIndex(sync.phase);
  const fraction = sync.total ? (sync.current ?? 0) / sync.total : 0;
  const pct = Math.min(100, Math.round(((idx + fraction) / PHASES.length) * 100));

  return (
    <div className="page-center">
      <div className="sync-panel">
        <Stepper step={3} />
        <div className="sync-panel__head">
          <span className="sync-panel__avatar mono">{site.name.charAt(0).toUpperCase()}</span>
          <span className="sync-panel__title">
            <span className="sync-panel__name">{site.name}</span>
            <span className="mono sync-panel__sub">production → DDEV clone</span>
          </span>
          {sync.status === 'syncing' && <span className="sync-panel__badge mono">running</span>}
          {sync.status === 'ready' && <span className="sync-panel__badge sync-panel__badge--ok mono">verified</span>}
        </div>

        {sync.status === 'idle' && (
          <div className="card">
            {test && <div className="sync-panel__test">✓ Connected — WordPress {test.wp} · PHP {test.php} · {test.db}</div>}
            {testError && <div className="form-error">{testError}</div>}
            {!test && !testError && site.status === 'paired' && <div className="sync-panel__testing">Testing the connection…</div>}
            <button className="btn btn--primary" style={{ width: '100%', marginTop: 14 }} onClick={start} disabled={!test}>
              Start first sync
            </button>
          </div>
        )}

        {sync.status === 'syncing' && (
          <>
            <div className="progress"><div className="progress__bar" style={{ width: `${pct}%` }} /></div>
            <div className="phase-list">
              {PHASES.map((p, i) => {
                const state = i < idx ? 'done' : i === idx ? 'active' : 'pending';
                const counter =
                  state === 'active' && sync.total !== undefined
                    ? p.key === 'db'
                      ? `${sync.current ?? 0} / ${sync.total} tables${sync.detail ? ` · ${sync.detail}` : ''}`
                      : `${sync.current ?? 0} / ${sync.total}`
                    : null;
                return (
                  <div key={p.key} className={`phase phase--${state}`}>
                    <span className="phase__dot">{state === 'done' ? '✓' : ''}</span>
                    <span className="phase__text">
                      <span className="phase__label">{p.label}</span>
                      {p.sub && <span className="phase__sub">{p.sub}</span>}
                    </span>
                    {counter && <span className="mono phase__counter">{counter}</span>}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {sync.status === 'ready' && (
          <div className="card sync-panel__done">
            <div className="sync-panel__verified">Clone verified ✓</div>
            <div className="sync-panel__verified-sub">
              The control plane fetched the clone over HTTPS and got a live WordPress response
              {sync.verifiedAt ? ` · ${timeAgo(sync.verifiedAt)}` : ''}.
            </div>
            <div className="clone-url">
              <span className="mono clone-url__text">{sync.cloneUrl}</span>
              <button className="btn btn--outline" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="sync-panel__hint">This clone is for your agent — the URL resolves only where the clone runs.</div>
            <button className="btn btn--primary" style={{ width: '100%', marginTop: 18 }} onClick={() => navigate('/')}>
              Back to sites
            </button>
          </div>
        )}

        {sync.status === 'error' && (
          <div className="card">
            <div className="form-error" style={{ marginTop: 0 }}>{sync.error}</div>
            <button className="btn btn--primary" style={{ width: '100%', marginTop: 14 }} onClick={start}>
              Retry sync
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

Append to `ui.css`:

```css
.sync-panel { width: 100%; max-width: 640px; }
.sync-panel__head { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
.sync-panel__avatar { width: 34px; height: 34px; border-radius: 9px; background: var(--surface); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; color: var(--accent-ink); }
.sync-panel__title { display: flex; flex-direction: column; }
.sync-panel__name { font-weight: 600; font-size: 16px; }
.sync-panel__sub { font-size: 12px; color: var(--faint); }
.sync-panel__badge { margin-left: auto; font-size: 12px; color: var(--accent-ink); background: var(--accent-weak); padding: 4px 10px; border-radius: 999px; }
.sync-panel__badge--ok { color: var(--green); background: var(--green-weak); }
.sync-panel__test { color: var(--green); font-weight: 500; }
.sync-panel__testing { color: var(--muted); }
.progress { height: 6px; border-radius: 999px; background: var(--border); overflow: hidden; margin-bottom: 26px; }
.progress__bar { height: 100%; background: linear-gradient(90deg, var(--accent), oklch(0.6 0.15 262)); transition: width 300ms ease; }
.phase-list { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.phase { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.phase:last-child { border-bottom: 0; }
.phase--pending { opacity: 0.55; }
.phase--active { background: var(--accent-weak); }
.phase__dot { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--border-strong); flex: none; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.phase--done .phase__dot { background: var(--green-weak); border-color: var(--green); color: var(--green); }
.phase--active .phase__dot { border: 2px solid var(--accent); border-top-color: transparent; animation: spin 0.8s linear infinite; }
.phase__text { flex: 1; display: flex; flex-direction: column; }
.phase__label { font-weight: 500; }
.phase--active .phase__label { font-weight: 600; color: var(--accent-ink); }
.phase__sub { font-size: 12px; color: var(--faint); }
.phase__counter { font-size: 11.5px; color: var(--accent-ink); }
.sync-panel__verified { color: var(--green); font-weight: 600; font-size: 18px; }
.sync-panel__verified-sub { color: var(--muted); font-size: 13px; margin: 6px 0 16px; }
.clone-url { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface-2); padding: 8px 8px 8px 14px; }
.clone-url__text { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: all; }
.sync-panel__hint { font-size: 12px; color: var(--faint); margin-top: 10px; }
```

- [ ] **Step 2: Register the route**

In `main.tsx`: `import { SyncPage } from './pages/sync';` and add `{ path: '/sites/:id/sync', element: <SyncPage /> },`.

- [ ] **Step 3: The happy-path gate (Playwright, real fixture)**

Add to `ferry-dashboard/e2e/dashboard.spec.ts` (top of file, next to the imports):

```ts
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const FIXTURE_DIR = process.env.FERRY_E2E_PROD ?? join(process.env.HOME ?? '', 'ferry-e2e', 'prod');
const SITE_URL = process.env.FERRY_E2E_URL ?? 'https://ferry-prod.ddev.site';

function pairingCode(): string {
  const raw = execFileSync(
    'ddev',
    ['wp', 'eval', 'print(json_encode(\\Ferry\\Auth::issue_pairing_code()));'],
    { cwd: FIXTURE_DIR, encoding: 'utf8' },
  ).trim();
  return (JSON.parse(raw.slice(raw.indexOf('{'))) as { code: string }).code;
}
```

and the gate itself:

```ts
test('3b gate: sign up → add site → pair → watch progress → ready in the list', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'New site' }).click();
  await page.getByLabel('Name').fill('Ferry Prod');
  await page.getByLabel('Site URL').fill(SITE_URL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /I have a code/ }).click();

  // wrong code first: inline error, stays on the pairing screen (screen 3 scope)
  await page.getByPlaceholder('XXXX-XXXX').fill('AAAA-BBBB');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.form-error')).toBeVisible();
  await expect(page).toHaveURL(/\/pair$/);

  // real code from the fixture plugin
  await page.getByPlaceholder('XXXX-XXXX').fill(pairingCode());
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page).toHaveURL(/\/sync$/);

  // flow step 5: connection test, then start the first sync
  await expect(page.getByText(/Connected — WordPress/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Start first sync' }).click();
  await expect(page.getByText('Transferring unique files')).toBeVisible({ timeout: 30_000 });

  // done: verified clone, URL as copyable text — never a link (§1 decision)
  await expect(page.getByText('Clone verified ✓')).toBeVisible({ timeout: 150_000 });
  expect(await page.locator('a[href*="ddev.site"]').count()).toBe(0);
  expect(page.url()).not.toContain('admin');

  await page.getByRole('button', { name: 'Back to sites' }).click();
  await expect(page.locator('.chip--ready')).toBeVisible();
  await expect(page.getByText(/synced (just now|\d+ min ago)/)).toBeVisible();
});
```

- [ ] **Step 4: Run the gate**

Preconditions (runbook `2026-07-25-ferry-plan3a-e2e-runbook.md`): fixture running (`ddev start` in `~/ferry-e2e/prod`), `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`, then **always**: `ddev delete -Oy ferry-prod-ddev-site` (stale clone project).

Run: `npm --workspace ferry-dashboard run e2e`
Expected: all 6 tests pass; the gate test completes with a real sync (~25–40s). Afterwards the clone project is left running — tear down with `ddev delete -Oy ferry-prod-ddev-site` or keep for the manual design pass.

- [ ] **Step 5: Typecheck + commit**

Run: `npm --workspace ferry-dashboard run typecheck`

```bash
git add ferry-dashboard
git commit -m "feat(dashboard): live sync progress over SSE with verified-clone finish (screen 4) + 3b gate"
```

---

### Task 9: Full gates, manual design comparison, whole-branch review

**Files:**
- No new code. Fix-only changes if a gate fails.

- [ ] **Step 1: All unit suites + typechecks**

Run: `npm --workspace ferry-cli test && npm --workspace ferry-server test && npm --workspace ferry-server run typecheck && npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run build`
Expected: everything green.

- [ ] **Step 2: The 3a API E2E must stay green**

```bash
ddev delete -Oy ferry-prod-ddev-site
npm --workspace ferry-server run e2e
```

Expected: `✔ E2E passed` under 120s. (This proves the Task 1–3 server/engine changes didn't regress the API flow.)

- [ ] **Step 3: The 3b Playwright gate once more, from clean**

```bash
ddev delete -Oy ferry-prod-ddev-site
npm --workspace ferry-dashboard run e2e
```

Expected: all tests pass.

- [ ] **Step 4: Manual design comparison (gate, spec §6)**

Human-in-the-loop: run `npm --workspace ferry-server run dev` + `npm --workspace ferry-dashboard run dev`, open `http://127.0.0.1:5173` next to `design/Ferry Dashboard.dc.html`, and walk screens 17 → 1 → 2 → 3 → 4 → 5. Checklist: token fidelity (colors, radii, IBM Plex), sidebar proportions, empty-state hatching, stepper, terminal block, progress checklist styling, chips, refused row, and the §1 constraints — clone URL is text + "Clone verified ✓", no clone admin credentials anywhere.

- [ ] **Step 5: Whole-branch review + hand-off**

Per process (spec §6): whole-branch code review (superpowers:requesting-code-review), then superpowers:finishing-a-development-branch — PR `feat/dashboard-shell` → `main`.

---

## Self-Review (performed while writing)

- **Spec coverage:** §4 table — screen 17 → Task 4; screen 1 → Task 5; screen 2 → Task 6; screen 3 → Task 7; screen 4 → Task 8; screen 5 → Task 5. §2.1 (Vite proxy dev / static prod) → Task 3. §5 error handling in the UI: pull-fail retry + SSE reconnect snapshot → Task 8; multisite + wrong-code inline → Task 7; restart recovery is server-side (already shipped in 3a). §6 gates → Tasks 8–9. Parked 3a items (1)–(4) → Tasks 1–2. Done-criterion (flow steps 1–6 in the browser) → Task 8 gate.
- **Type consistency:** `SyncState`/`Site` in `api.ts` mirror `ferry-server/src/sync.ts` + `siteJson()` (camelCase `lastError`/`lastSyncAt`/`verifiedAt` — verified against `store.ts`). `timeAgo` exported from `pages/sites.tsx`, imported in `pages/sync.tsx`. `Stepper` step numbering used consistently (1 install, 2 pair, 3 sync). `MultisiteError` import paths relative to each workspace verified.
- **Known accepted risks:** exact npm minor versions may drift at install time (ranges are conservative); Playwright's `getByLabel` relies on the `<label>` wrappers written in Tasks 4/6; the design's decorative extras (password strength meter, "import via an existing plugin" link, WP-CLI tab) are deliberately omitted and listed under Global Constraints → adaptations.
