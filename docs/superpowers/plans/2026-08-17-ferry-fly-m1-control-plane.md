# Ferry Fly.io M1 — Control Plane Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ferry's control plane + dashboard live on Robbert's Fly.io account with a proven push-to-main deploy pipeline, assistant observability, and tenant gating — no clone/sync/agent on Fly yet.

**Architecture:** One Fly app (single Machine, `ams`, 3 GB volume at `/data` for `FERRY_HOME`) runs the existing `ferry-server` from TypeScript source via `tsx`, serving the built dashboard and the in-memory plugin zip. Four small env-conditioned code changes (listen host, secure cookie, account cap, health endpoint) make the existing app deployable without changing local dev behavior. GitHub Actions deploys on push to `main`.

**Tech Stack:** Fastify 5 + better-sqlite3 + tsx (unchanged), Docker multi-stage on `node:24-slim`, flyctl, GitHub Actions (`superfly/flyctl-actions`).

**Spec:** `docs/superpowers/specs/2026-08-17-fly-deployment-design.md` (approved 2026-08-17). Kickoff context: `docs/superpowers/specs/2026-08-17-fly-deploy-kickoff.md`.

## Global Constraints

- **No secrets in git or in the image.** Repo-root `.env` holds a live `ANTHROPIC_API_KEY`; `.dockerignore` MUST exclude it (Task 6 creates `.dockerignore` before the Dockerfile in the same commit). Fly tokens never get committed; the assistant token lives in git-ignored `.fly/`.
- **No `ANTHROPIC_API_KEY` on Fly in M1** — the server then logs "agent chat is disabled" and runs without an agent. This is deliberate (spec §4/§8). Do not `fly secrets set` anything in this plan.
- **Local dev behavior unchanged:** every new env flag defaults to today's behavior when unset (`FERRY_HOST`→`127.0.0.1`, `FERRY_SECURE_COOKIES`→off, `FERRY_MAX_ACCOUNTS`→unlimited).
- **Server runs from TS source via tsx — never compiled.** `tsx` is a devDependency of `ferry-server`, so the image's `npm ci` must include dev deps (Task 6 does).
- **Suites stay green:** plugin phpunit 216, cli vitest 146, server vitest 209 (+ new tests from this plan), dashboard e2e 18, three typechecks (`npm --workspace ferry-{cli,server,dashboard} run typecheck`).
- **Execution branch:** `feat/fly-m1` off current `main`. Tasks 1–7 are normal TDD tasks; Tasks 8–10 are interactive ops tasks that need Robbert (flyctl auth, tokens) — coordinate, don't skip.
- **Fly app name:** plan uses `ferry-cp` throughout. The `fly.dev` namespace is global; if `fly apps create ferry-cp` fails as taken (Task 8), pick an alternative with Robbert and update `fly.toml` + the commands before proceeding.
- Node 24 everywhere (local is v24.8.0; image is `node:24-slim`; repo has no `engines` floor).

---

### Task 1: Env-config helpers

Pure functions for the three new deployment env vars, unit-tested, not yet wired.

**Files:**
- Create: `ferry-server/src/env-config.ts`
- Test: `ferry-server/tests/env-config.test.ts`

**Interfaces:**
- Consumes: nothing (pure, takes `NodeJS.ProcessEnv`).
- Produces: `listenHost(env): string`, `secureCookies(env): boolean`, `accountCap(env): number | undefined` (throws on malformed `FERRY_MAX_ACCOUNTS`). Task 5 wires all three into `main.ts`; Tasks 2–3 consume the resulting `AppDeps` fields, not these functions.

- [ ] **Step 1: Write the failing test**

```ts
// ferry-server/tests/env-config.test.ts
import { describe, expect, it } from 'vitest';
import { accountCap, listenHost, secureCookies } from '../src/env-config.js';

describe('listenHost', () => {
  it('defaults to loopback', () => {
    expect(listenHost({})).toBe('127.0.0.1');
  });
  it('honors FERRY_HOST', () => {
    expect(listenHost({ FERRY_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
  it('treats empty string as unset', () => {
    expect(listenHost({ FERRY_HOST: '' })).toBe('127.0.0.1');
  });
});

describe('secureCookies', () => {
  it("is on only for the exact value '1'", () => {
    expect(secureCookies({})).toBe(false);
    expect(secureCookies({ FERRY_SECURE_COOKIES: '1' })).toBe(true);
    expect(secureCookies({ FERRY_SECURE_COOKIES: '0' })).toBe(false);
    expect(secureCookies({ FERRY_SECURE_COOKIES: 'true' })).toBe(false);
  });
});

describe('accountCap', () => {
  it('unset or empty means unlimited (undefined)', () => {
    expect(accountCap({})).toBeUndefined();
    expect(accountCap({ FERRY_MAX_ACCOUNTS: '' })).toBeUndefined();
  });
  it('parses non-negative integers, including 0 (signup fully closed)', () => {
    expect(accountCap({ FERRY_MAX_ACCOUNTS: '2' })).toBe(2);
    expect(accountCap({ FERRY_MAX_ACCOUNTS: '0' })).toBe(0);
  });
  it('throws on garbage so a typo cannot silently open signup', () => {
    expect(() => accountCap({ FERRY_MAX_ACCOUNTS: 'two' })).toThrow(/FERRY_MAX_ACCOUNTS/);
    expect(() => accountCap({ FERRY_MAX_ACCOUNTS: '-1' })).toThrow(/FERRY_MAX_ACCOUNTS/);
    expect(() => accountCap({ FERRY_MAX_ACCOUNTS: '2.5' })).toThrow(/FERRY_MAX_ACCOUNTS/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server run test -- tests/env-config.test.ts`
Expected: FAIL — cannot resolve `../src/env-config.js`.

- [ ] **Step 3: Write the implementation**

```ts
// ferry-server/src/env-config.ts
// Deployment env parsing (spec 2026-08-17 §4-§5). Pure so each flag is unit-testable;
// every default preserves pre-Fly local-dev behavior.

export function listenHost(env: NodeJS.ProcessEnv): string {
  return env.FERRY_HOST || '127.0.0.1';
}

export function secureCookies(env: NodeJS.ProcessEnv): boolean {
  return env.FERRY_SECURE_COOKIES === '1';
}

export function accountCap(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.FERRY_MAX_ACCOUNTS;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    // Fail the boot, not the check: a typo here must never mean "unlimited signups".
    throw new Error(`FERRY_MAX_ACCOUNTS must be a non-negative integer, got "${raw}"`);
  }
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace ferry-server run test -- tests/env-config.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm --workspace ferry-server run typecheck`
Expected: clean.

```bash
git add ferry-server/src/env-config.ts ferry-server/tests/env-config.test.ts
git commit -m "feat(server): env-config helpers for Fly deployment flags"
```

---

### Task 2: Secure cookie flag

`Set-Cookie` gains `Secure` when the app is built with `secureCookies: true` (Fly sets `FERRY_SECURE_COOKIES=1`; local http dev stays without). Closes the Plan 6a deferral.

**Files:**
- Modify: `ferry-server/src/app.ts:44-46` (AppDeps — add field next to `authLimits`)
- Modify: `ferry-server/src/routes/auth.ts:7,13-15,33,50`
- Test: `ferry-server/tests/auth.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `AppDeps` pattern (deps threaded into `authRoutes(app, deps)`), existing `COOKIE_OPTS` const.
- Produces: `AppDeps.secureCookies?: boolean`. Task 5 wires it from `secureCookies(process.env)`. Tests inject it via `makeApp({ secureCookies: true })`.

- [ ] **Step 1: Write the failing test**

Append to `ferry-server/tests/auth.test.ts`:

```ts
describe('secure cookie flag', () => {
  it('adds Secure to the signup session cookie when deps.secureCookies is set', async () => {
    const { app } = makeApp({ secureCookies: true });
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/; secure/i);
  });

  it('adds Secure to the login session cookie when deps.secureCookies is set', async () => {
    const { app } = makeApp({ secureCookies: true });
    await signup(app);
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/; secure/i);
  });

  it('omits Secure by default so local http dev keeps working', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).not.toMatch(/; secure/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server run test -- tests/auth.test.ts`
Expected: the two `secureCookies: true` tests FAIL (no `Secure` attribute; also a TS error until the AppDeps field exists — add the field first if vitest refuses to compile, then the assertion failures are the red state).

- [ ] **Step 3: Implement**

In `ferry-server/src/app.ts`, extend `AppDeps` directly under the `authLimits` field (keep the existing comment style):

```ts
  /** Test seam: e2e runs ~17 signups from one IP against one process; production keeps the default. */
  authLimits?: { signupMax?: number };
  /** Spec 2026-08-17 §5: Set-Cookie gains `secure` behind TLS (Fly). Unset = local http dev. */
  secureCookies?: boolean;
```

In `ferry-server/src/routes/auth.ts`, derive the per-app options once, inside `authRoutes` (line 13), and use them in both `setCookie` calls (lines 33 and 50):

```ts
export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  const loginLimiter = new RateLimiter(LOGIN_MAX_FAILURES, AUTH_WINDOW_MS);
  const signupLimiter = new RateLimiter(deps.authLimits?.signupMax ?? SIGNUP_MAX_ATTEMPTS, AUTH_WINDOW_MS);
  const cookieOpts = deps.secureCookies ? { ...COOKIE_OPTS, secure: true } : COOKIE_OPTS;
```

Then replace `COOKIE_OPTS` with `cookieOpts` in the two `reply.setCookie(SESSION_COOKIE, token, …)` calls (signup and login). Leave the logout `clearCookie` untouched — cookie clearing matches on name+path, not attributes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace ferry-server run test -- tests/auth.test.ts`
Expected: PASS, including all pre-existing auth tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm --workspace ferry-server run typecheck`
Expected: clean.

```bash
git add ferry-server/src/app.ts ferry-server/src/routes/auth.ts ferry-server/tests/auth.test.ts
git commit -m "feat(server): Secure session cookie behind FERRY_SECURE_COOKIES (6a deferral closed)"
```

---

### Task 3: Account cap

Signup returns 403 once the total number of accounts reaches `AppDeps.accountCap`. This is the tenant gate for the Fly test phase (`FERRY_MAX_ACCOUNTS=2`).

**Files:**
- Modify: `ferry-server/src/store.ts` (add `countUsers()` next to `userByEmail`, ~line 279)
- Modify: `ferry-server/src/app.ts` (AppDeps — add `accountCap`)
- Modify: `ferry-server/src/routes/auth.ts:17-26` (signup handler)
- Test: `ferry-server/tests/store.test.ts` (append), `ferry-server/tests/auth.test.ts` (append)

**Interfaces:**
- Consumes: `Store` class (better-sqlite3 `this.db`, `users` table with `email`/`password_hash`), `AppDeps`, signup route from Task 2's state.
- Produces: `Store.countUsers(): number` (Task 4's health endpoint reuses it as its DB touch); `AppDeps.accountCap?: number` (Task 5 wires it from `accountCap(process.env)`).

- [ ] **Step 1: Write the failing tests**

Append to `ferry-server/tests/store.test.ts` (match the file's existing `new Store(':memory:')` construction style):

```ts
describe('countUsers', () => {
  it('counts all users', () => {
    const store = new Store(':memory:');
    expect(store.countUsers()).toBe(0);
    store.createUser('a@example.com', 'hash-a');
    store.createUser('b@example.com', 'hash-b');
    expect(store.countUsers()).toBe(2);
  });
});
```

Append to `ferry-server/tests/auth.test.ts`:

```ts
describe('account cap', () => {
  it('rejects signup with 403 once the cap is reached', async () => {
    const { app } = makeApp({ accountCap: 2 });
    await signup(app, 'a@example.com');
    await signup(app, 'b@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'c@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Signups are closed on this server.' });
  });

  it('a cap of 0 closes signup entirely', async () => {
    const { app } = makeApp({ accountCap: 0 });
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(403);
  });

  it('login keeps working for existing accounts at the cap', async () => {
    const { app } = makeApp({ accountCap: 1 });
    await signup(app); // user@example.com / password1
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(200);
  });

  it('no cap means unlimited (existing behavior)', async () => {
    const { app } = makeApp();
    await signup(app, 'a@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'b@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --workspace ferry-server run test -- tests/store.test.ts tests/auth.test.ts`
Expected: FAIL — `countUsers is not a function`, and the cap tests get 200/`accountCap` type error instead of 403.

- [ ] **Step 3: Implement**

`ferry-server/src/store.ts` — insert directly after `userByEmail` (after line 278):

```ts
  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
```

`ferry-server/src/app.ts` — extend `AppDeps` under the `secureCookies` field from Task 2:

```ts
  /** Spec 2026-08-17 §5: hard cap on total accounts (signup → 403 at the cap). Unset = unlimited. */
  accountCap?: number;
```

`ferry-server/src/routes/auth.ts` — in the signup handler, directly after the rate-limit check (line 20) and before the email validation:

```ts
    if (deps.accountCap !== undefined && deps.store.countUsers() >= deps.accountCap) {
      return reply.code(403).send({ error: 'Signups are closed on this server.' });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --workspace ferry-server run test -- tests/store.test.ts tests/auth.test.ts`
Expected: PASS, including all pre-existing tests (the per-IP signup rate-limit tests do ≤11 attempts and run without a cap, so they are unaffected).

- [ ] **Step 5: Typecheck and commit**

Run: `npm --workspace ferry-server run typecheck`
Expected: clean.

```bash
git add ferry-server/src/store.ts ferry-server/src/app.ts ferry-server/src/routes/auth.ts ferry-server/tests/store.test.ts ferry-server/tests/auth.test.ts
git commit -m "feat(server): FERRY_MAX_ACCOUNTS account cap gates signup (403 at cap)"
```

---

### Task 4: Health endpoint

Unauthenticated `GET /api/health` for deploy verification and the Fly HTTP check. Touches the DB so a wedged SQLite shows up as a failing check, and leaks nothing.

**Files:**
- Modify: `ferry-server/src/app.ts` (register before `authRoutes(app, deps)` at line 102)
- Test: `ferry-server/tests/health.test.ts` (create)

**Interfaces:**
- Consumes: `Store.countUsers()` from Task 3, the generic 500 error handler (app.ts:81-88).
- Produces: `GET /api/health` → `200 {"ok":true}`. Task 7's `fly.toml` check and Task 8/9 verification curl it.

- [ ] **Step 1: Write the failing test**

```ts
// ferry-server/tests/health.test.ts
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers/testApp.js';

describe('GET /api/health', () => {
  it('returns 200 {ok:true} without a session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns a generic 500 when the DB is unavailable', async () => {
    const { app, store } = makeApp();
    store.close();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal server error' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace ferry-server run test -- tests/health.test.ts`
Expected: FAIL — 404 (route does not exist).

- [ ] **Step 3: Implement**

In `ferry-server/src/app.ts`, directly above `authRoutes(app, deps);` (line 102):

```ts
  // Deploy verification (spec 2026-08-17 §5): public, and the countUsers() call makes a
  // wedged DB surface as a failing check instead of a green 200. Response leaks nothing.
  app.get('/api/health', async () => {
    deps.store.countUsers();
    return { ok: true };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace ferry-server run test -- tests/health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm --workspace ferry-server run typecheck`
Expected: clean.

```bash
git add ferry-server/src/app.ts ferry-server/tests/health.test.ts
git commit -m "feat(server): unauthenticated /api/health with DB touch for deploy checks"
```

---

### Task 5: Wire the flags into main.ts + local boot smoke

`main.ts` consumes all three env-config helpers. No unit test (entry point has none today); the gate is a scripted boot smoke.

**Files:**
- Modify: `ferry-server/src/main.ts:5` (imports), `:73-81` (buildApp deps), `:83-85` (listen + log)

**Interfaces:**
- Consumes: `listenHost`/`secureCookies`/`accountCap` (Task 1), `AppDeps.secureCookies` (Task 2), `AppDeps.accountCap` (Task 3).
- Produces: a server whose bind host and gating are env-driven — what the Docker image (Task 6) and fly.toml `[env]` (Task 7) rely on.

- [ ] **Step 1: Implement**

Add the import (alphabetical, after the `changes.js` import at `main.ts:9`):

```ts
import { accountCap, listenHost, secureCookies } from './env-config.js';
```

Extend the `buildApp` call (lines 73-81) with the two new deps:

```ts
const app = buildApp({
  store,
  engine: realEngine(),
  pluginZip: buildPluginZip(pluginDir),
  staticDir: existsSync(distDir) ? distDir : undefined,
  agent: agentDepsForMain,
  push: { runner: realPushRunner() },
  lifecycle,
  secureCookies: secureCookies(process.env),
  accountCap: accountCap(process.env),
});
```

Replace lines 83-85 with:

```ts
const port = Number(process.env.PORT ?? 4000);
const host = listenHost(process.env);
await app.listen({ port, host });
console.log(`ferry-server listening on http://${host}:${port}`);
```

- [ ] **Step 2: Boot smoke — defaults unchanged**

```bash
SMOKE_HOME=$(mktemp -d)
FERRY_HOME="$SMOKE_HOME/ferry" PORT=4991 npm --workspace ferry-server run start &
sleep 3
curl -fsS http://127.0.0.1:4991/api/health   # expect {"ok":true}
kill -TERM %1 && wait %1
```

Expected: log line `ferry-server listening on http://127.0.0.1:4991`, health OK, shutdown log `SIGTERM — shutting down` and a clean exit.

- [ ] **Step 3: Boot smoke — flags active**

```bash
FERRY_HOME="$SMOKE_HOME/ferry" PORT=4991 FERRY_HOST=0.0.0.0 FERRY_SECURE_COOKIES=1 FERRY_MAX_ACCOUNTS=0 npm --workspace ferry-server run start &
sleep 3
curl -fsS -X POST http://127.0.0.1:4991/api/auth/signup -H 'content-type: application/json' -d '{"email":"x@example.com","password":"password1"}' -o /dev/null -w '%{http_code}\n'   # expect 403
kill -TERM %1 && wait %1
rm -rf "$SMOKE_HOME"
```

Expected: log line shows `http://0.0.0.0:4991`, signup returns 403.

- [ ] **Step 4: Full server suite + typecheck**

Run: `npm --workspace ferry-server run test` and `npm --workspace ferry-server run typecheck`
Expected: all tests pass (209 pre-existing + new), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/main.ts
git commit -m "feat(server): env-driven listen host, secure cookies, account cap in main"
```

---

### Task 6: .dockerignore + Dockerfile + local container acceptance

The image: dashboard built in a build stage; runtime deps (server+cli only, dev deps included for `tsx`) in a deps stage with a native toolchain; slim runtime with `git` + `sqlite3`. Local `docker` run proves boot, persistence, gating, secure cookie, and clean drain before Fly is involved.

**Files:**
- Create: `.dockerignore` (repo root)
- Create: `Dockerfile` (repo root)

**Interfaces:**
- Consumes: the env flags from Tasks 1–5; repo layout facts: server imports `ferry-cli/src` by relative path, plugin zip is built at boot from `<repo>/ferry-plugin`, dashboard is served from `<repo>/ferry-dashboard/dist` (`ferry-server/src/main.ts:70-71`).
- Produces: the image `fly deploy` builds (Task 8) — Fly uses this same Dockerfile via remote builders.

- [ ] **Step 1: Create `.dockerignore` FIRST (secret guard)**

```
.git
.env
**/node_modules
**/.DS_Store
ferry-cli/dist
ferry-dashboard/dist
ferry-plugin/vendor
ferry-plugin/tests
docs
.fly
```

(`.env` is the live-key guard; `ferry-dashboard/dist` is rebuilt inside the image; `ferry-plugin/vendor`+`tests` are dev-only and already excluded from the plugin zip at runtime.)

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
# Build the dashboard with the full workspace toolchain.
FROM node:24-slim AS dashboard
WORKDIR /app
COPY package.json package-lock.json ./
COPY ferry-server/package.json ferry-server/
COPY ferry-cli/package.json ferry-cli/
COPY ferry-dashboard/package.json ferry-dashboard/
RUN npm ci
COPY ferry-dashboard ferry-dashboard
RUN npm --workspace ferry-dashboard run build

# Runtime node_modules: server+cli only. Dev deps stay in (tsx runs the server from
# source); toolchain present in case a native module (better-sqlite3) lacks a prebuild.
FROM node:24-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY ferry-server/package.json ferry-server/
COPY ferry-cli/package.json ferry-cli/
COPY ferry-dashboard/package.json ferry-dashboard/
RUN npm ci --workspace ferry-server --workspace ferry-cli --include=dev

FROM node:24-slim
# git: engine/agent-context shell out to it. sqlite3: DB inspection over fly ssh console.
RUN apt-get update && apt-get install -y --no-install-recommends git sqlite3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app /app
COPY ferry-server ferry-server
COPY ferry-cli ferry-cli
COPY ferry-plugin ferry-plugin
COPY --from=dashboard /app/ferry-dashboard/dist ferry-dashboard/dist
ENV NODE_ENV=production
EXPOSE 4000
# Single process (no npm wrapper): Fly's stop signal must reach main.ts's handlers directly.
CMD ["node", "--import", "tsx", "ferry-server/src/main.ts"]
```

- [ ] **Step 3: Build**

Run: `docker build -t ferry-m1 .`
Expected: success. If `npm ci --workspace …` errors on the missing dashboard workspace dir, the `COPY ferry-dashboard/package.json` line above already covers it — check for typos instead.

- [ ] **Step 4: Verify the image contains no secret**

```bash
docker run --rm ferry-m1 sh -c 'ls -la /app/.env 2>&1; grep -r "sk-ant" /app --include=".env" 2>&1; echo CLEAN'
```

Expected: `No such file or directory` for `/app/.env`, no grep hits, `CLEAN`.

- [ ] **Step 5: Container acceptance run**

```bash
docker volume create ferry-m1-data
docker run -d --name ferry-m1 -p 4400:4000 \
  -e FERRY_HOME=/data/ferry -e FERRY_HOST=0.0.0.0 -e FERRY_SECURE_COOKIES=1 -e FERRY_MAX_ACCOUNTS=2 \
  -v ferry-m1-data:/data ferry-m1

sleep 3
curl -fsS http://127.0.0.1:4400/api/health                      # {"ok":true}
curl -fsS http://127.0.0.1:4400/ | grep -o '<title>[^<]*'       # dashboard index.html served
curl -fsS -i -X POST http://127.0.0.1:4400/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"one@example.com","password":"password1"}' | grep -i '^set-cookie'
# expect: ferry_session=…; …; Secure (and HttpOnly)
curl -fsS -X POST http://127.0.0.1:4400/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"two@example.com","password":"password1"}' -o /dev/null -w '%{http_code}\n'   # 200
curl -s -X POST http://127.0.0.1:4400/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"three@example.com","password":"password1"}' -o /dev/null -w '%{http_code}\n' # 403
```

- [ ] **Step 6: Persistence across container replacement + clean drain**

```bash
docker stop ferry-m1          # docker stop sends SIGTERM, 10s default grace
docker logs ferry-m1 | tail -5
# expect: "SIGTERM — shutting down (press again to force-exit)." and no crash lines
docker rm ferry-m1
docker run -d --name ferry-m1 -p 4400:4000 \
  -e FERRY_HOME=/data/ferry -e FERRY_HOST=0.0.0.0 -e FERRY_SECURE_COOKIES=1 -e FERRY_MAX_ACCOUNTS=2 \
  -v ferry-m1-data:/data ferry-m1
sleep 3
curl -fsS -X POST http://127.0.0.1:4400/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"one@example.com","password":"password1"}' -o /dev/null -w '%{http_code}\n'   # 200 — the volume kept server.db
docker rm -f ferry-m1 && docker volume rm ferry-m1-data
```

Also expected in the boot logs (`docker logs ferry-m1 | head -5`): `ANTHROPIC_API_KEY is not set — agent chat is disabled.` and `serving dashboard from ferry-dashboard/dist`.

- [ ] **Step 7: Commit**

```bash
git add .dockerignore Dockerfile
git commit -m "feat(deploy): Docker image — tsx runtime, dashboard build stage, plugin bundled"
```

---

### Task 7: fly.toml + GitHub Actions workflow + .gitignore

Pure config; verified live in Tasks 8–9.

**Files:**
- Create: `fly.toml` (repo root)
- Create: `.github/workflows/deploy.yml`
- Modify: `.gitignore` (add `.fly/`)

**Interfaces:**
- Consumes: the image (Task 6), env flags (Tasks 1–5), `/api/health` (Task 4).
- Produces: the app config `fly deploy` reads (Task 8) and the auto-deploy pipeline (Task 9). The `.fly/` ignore entry is where Task 10 stores the assistant token.

- [ ] **Step 1: Create `fly.toml`**

```toml
# Ferry control plane — M1 (spec docs/superpowers/specs/2026-08-17-fly-deployment-design.md)
app = "ferry-cp"
primary_region = "ams"
kill_timeout = "20s"   # > the 15s shutdown hard deadline (ferry-server/src/shutdown.ts)

[env]
  FERRY_HOME = "/data/ferry"
  FERRY_HOST = "0.0.0.0"
  FERRY_SECURE_COOKIES = "1"
  FERRY_MAX_ACCOUNTS = "2"

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"   # spec §3

[[mounts]]
  source = "ferry_data"
  destination = "/data"

[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = "off"   # stable target for the test loop; volume+SQLite stay warm
  auto_start_machines = true

  [[http_service.checks]]
    interval = "15s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/api/health"
```

- [ ] **Step 2: Create `.github/workflows/deploy.yml`**

```yaml
name: Deploy
on:
  push:
    branches: [main]

concurrency:
  group: fly-deploy
  cancel-in-progress: false   # never kill an in-flight deploy; queue instead

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

- [ ] **Step 3: Add `.fly/` to `.gitignore`**

Append to the repo-root `.gitignore`:

```
.fly/
```

- [ ] **Step 4: Sanity-check and commit**

Run: `git check-ignore .fly/anything && git check-ignore .env`
Expected: both print (ignored).

```bash
git add fly.toml .github/workflows/deploy.yml .gitignore
git commit -m "feat(deploy): fly.toml (ams, volume, health check) + push-to-main deploy workflow"
```

---

### Task 8: Fly launch (INTERACTIVE — needs Robbert)

First deploy, from the branch, with local flyctl. Robbert must be present for auth and account actions. If any `fly` command here fails twice, stop and debug with Robbert — do not improvise infra changes.

**Files:** none (ops). Possible edit: `fly.toml` `app =` if the name is taken.

**Interfaces:**
- Consumes: Dockerfile + fly.toml (Tasks 6–7).
- Produces: a live app `ferry-cp` (URL `https://ferry-cp.fly.dev`) with volume `ferry_data` — Tasks 9–11 verify against it.

- [ ] **Step 1: Auth.** Ask Robbert to run `! fly auth login` (or confirm `fly auth whoami` shows his account).
- [ ] **Step 2: Create app.** `fly apps create ferry-cp` — if taken, agree an alternative with Robbert, update `fly.toml` `app =`, commit (`git commit -am "chore(deploy): app name"`), and substitute the name in every later command.
- [ ] **Step 3: Create volume.** `fly volumes create ferry_data --app ferry-cp --region ams --size 3 --yes` — the single-volume redundancy warning is expected and accepted (spec §3: daily snapshots suffice for the test phase).
- [ ] **Step 4: Deploy from the branch.** `fly deploy --remote-only` (repo root, branch `feat/fly-m1`). Expected: remote builder builds the Dockerfile, one machine starts, health check passes.
- [ ] **Step 5: Verify live.**

```bash
curl -fsS https://ferry-cp.fly.dev/api/health          # {"ok":true}
curl -fsSI https://ferry-cp.fly.dev/ | head -3         # 200, text/html
fly status --app ferry-cp                              # 1 machine, started, checks passing
fly logs --app ferry-cp                                # boot lines incl. "agent chat is disabled"
```

- [ ] **Step 6: Robbert's account (browser).** Robbert opens `https://ferry-cp.fly.dev`, signs up (account 1 of 2), sees the sites list. Then prove the gate and the cookie from the shell:

```bash
curl -fsS -i -X POST https://ferry-cp.fly.dev/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"reserve@robbert.example","password":"<Robbert picks>"}' | grep -i '^set-cookie'
# expect Secure + HttpOnly attributes; this is account 2 of 2 (the reserve)
curl -s -X POST https://ferry-cp.fly.dev/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"mallory@example.com","password":"password1"}' -o /dev/null -w '%{http_code}\n'   # 403
```

- [ ] **Step 7: Persistence + drain across a redeploy.** Run `fly deploy --remote-only` again (unchanged code → machine replaced). Then: Robbert's login still works (criterion 1), and `fly logs` around the replacement shows the shutdown line (`SIGINT — shutting down` — Fly's default stop signal; SIGTERM also handled) with no hard-kill (criterion 7).
- [ ] **Step 8: Download plugin zip behind login** (criterion 6): in Robbert's logged-in browser session, `https://ferry-cp.fly.dev/api/plugin.zip` downloads `ferry-connect.zip`; an anonymous `curl -s -o /dev/null -w '%{http_code}' https://ferry-cp.fly.dev/api/plugin.zip` returns 401.

---

### Task 9: Merge + pipeline proof (INTERACTIVE — needs Robbert for the token)

The GitHub secret goes in BEFORE the merge so the workflow that the merge push triggers can deploy.

**Files:** none (ops + merge).

**Interfaces:**
- Consumes: workflow file (Task 7), live app (Task 8), all code tasks merged in the branch.
- Produces: the standing pipeline — every future push to `main` deploys.

- [ ] **Step 1: Full gate on the branch.**

```bash
npm --workspace ferry-cli run test          # 146
npm --workspace ferry-server run test       # 209 + new (env-config 9, auth +7, store +1, health 2)
npm --workspace ferry-cli run typecheck && npm --workspace ferry-server run typecheck && npm --workspace ferry-dashboard run typecheck
(cd ferry-plugin && vendor/bin/phpunit)     # 216 (composer.json has no scripts block; phpunit is the dev dep)
npm --workspace ferry-dashboard run e2e     # 18 (preflight: ddev stop --unlist ferry-prod-ddev-site if the gate clone collides)
```

Expected: everything green. Fix before merging; nothing rides on red.

- [ ] **Step 2: Deploy token → GitHub secret (Robbert).**

```bash
fly tokens create deploy --app ferry-cp --name gh-actions --expiry 8760h
gh secret set FLY_API_TOKEN --repo epicwp/ferry
# paste the FlyV1 … token at the prompt; it must never be echoed into the transcript or committed
```

- [ ] **Step 3: Merge to main.** Follow the repo's convention (6a used a no-ff merge): `git checkout main && git pull && git merge --no-ff feat/fly-m1 -m "Merge Fly M1: control plane deployment (image, fly.toml, pipeline, gating)"` then `git push origin main`. (If Robbert prefers a PR instead, open one with `gh pr create` and merge it — same result; confirm with him at execution.)
- [ ] **Step 4: Watch the pipeline.** `gh run watch --repo epicwp/ferry` (the push-triggered `Deploy` run). Expected: green in ≲10 min.
- [ ] **Step 5: Verify the auto-deploy landed.** `curl -fsS https://ferry-cp.fly.dev/api/health` → `{"ok":true}`; `fly releases --app ferry-cp` shows the new release (criterion 3). Robbert's login still works.

---

### Task 10: Assistant observability token + proof (INTERACTIVE — needs Robbert)

**Files:** creates git-ignored `.fly/assistant-token` (never committed; `.gitignore` covers `.fly/` since Task 7).

**Interfaces:**
- Consumes: live app (Task 8).
- Produces: the assistant's standing access for the feedback loop (criterion 5).

- [ ] **Step 1: Robbert creates a second, separately-revocable app-scoped token.** Check `fly tokens create --help` for the current subcommands; prefer the most tightly scoped kind that still allows logs + ssh for one app (an app-scoped `fly tokens create deploy --app ferry-cp --name assistant --expiry 8760h` qualifies; do NOT reuse the gh-actions token).
- [ ] **Step 2: Store it.** `mkdir -p .fly && (paste token) > .fly/assistant-token && chmod 600 .fly/assistant-token`. Verify `git status` shows nothing new (ignored).
- [ ] **Step 3: Prove all three access paths with ONLY that token** (unset any ambient fly auth first: run in an env where `FLY_API_TOKEN="$(cat .fly/assistant-token)"` is the sole credential):

```bash
export FLY_API_TOKEN="$(cat .fly/assistant-token)"
fly status --app ferry-cp                                   # machine + checks
fly logs --app ferry-cp --no-tail 2>/dev/null || fly logs --app ferry-cp &  # recent lines, Ctrl-C/kill after capture
fly ssh console --app ferry-cp -C "sqlite3 /data/ferry/server.db 'SELECT COUNT(*) FROM users;'"   # expect 2
```

- [ ] **Step 4: Record the loop contract** — after every future deploy the assistant verifies `/api/health` + logs before reporting "deployed"; rollback = `git revert` + push (Task 9's pipeline redeploys).

---

### Task 11: Acceptance against spec §9 + memory/docs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-fly-deployment-design.md` (status line only: mark M1 deployed with date + app URL)
- Assistant memory: update `ferry-v0-shipped.md` (M1 live, pipeline standing, M2 next)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Walk the spec §9 checklist and record evidence for each criterion (1–8)** — each was proven in Tasks 8–10; re-run any check that wasn't captured. All eight must have a concrete transcript line (curl output, log line, or test count).
- [ ] **Step 2: Update the spec status line + commit.**

```bash
git add docs/superpowers/specs/2026-08-17-fly-deployment-design.md
git commit -m "docs: mark Fly M1 deployed (app URL + date)"
git push origin main   # this push triggers one more deploy — expected, verifies the loop once more
```

- [ ] **Step 3: Report to Robbert** — live URL, what was proven, the two accounts in use, where the assistant token lives, and that M2 (clone substrate on Fly) is the next brainstorm.

---

## Self-review notes (writing time)

- Spec §5 items 1–4 → Tasks 1–5; §4 image/fly.toml → Tasks 6–7; §6 pipeline/observability/loop → Tasks 7, 9, 10; §3 topology → Tasks 7–8; §8 posture → Global Constraints + Task 8 gate proof; §9 criteria → Task 11 (individual proofs in Tasks 8–10). §7 (M2) intentionally has no tasks.
- Lockfile verified at plan time: `claude-agent-sdk-linux*` variants present (12 entries), `tsx@4.23.1` (supports `node --import tsx`), `ferry-cli/assets/` exists and rides the wholesale `COPY ferry-cli`.
- Type consistency: `AppDeps.secureCookies?: boolean` (Task 2) / `AppDeps.accountCap?: number` (Task 3) match Task 5's wiring; `Store.countUsers(): number` (Task 3) matches Task 4's health handler.
