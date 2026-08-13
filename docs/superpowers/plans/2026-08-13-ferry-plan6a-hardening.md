# Ferry Plan 6a — Hardening Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the parked security/robustness gaps from Plans 3a–5b: generic 500s, hashed+purged sessions, SSE-aware graceful shutdown, auth rate limits (pairing + login), and the non-UI issue #9/#11 fold-ins.

**Architecture:** All server work lives in `ferry-server` (Fastify 5 + better-sqlite3, single process, no new dependencies): a `setErrorHandler`, a SHA-256 token-hash session layer with boot/hourly purge, a `Lifecycle` object (shutdown flag + SSE connection registry) consumed by a `gracefulShutdown` routine, and a tiny fixed-window in-memory `RateLimiter`. The plugin gets a zero-dep pairing attempt counter and four small robustness fixes. The refusal list gets one TS source of truth plus a PHP parity test.

**Tech Stack:** TypeScript (vitest), native PHP 7.2+ (PHPUnit, no WordPress at test time — stubs in `tests/bootstrap.php`), React 19 (typecheck + Playwright e2e only).

**Spec:** `docs/superpowers/specs/2026-08-13-ferry-plan6a-hardening-design.md` (signed off 2026-08-13). Work on branch `feat/hardening` off `main`.

## Global Constraints

- Plugin stays native PHP 7.2+, zero external dependencies, no command execution (spec §5).
- No new npm dependencies anywhere. Rate limiting is in-memory, single-process; restart resets are accepted.
- The `secure` cookie flag is **NOT** added in 6a (it lands in 6b with the first TLS deployment). Do not "fix" it in passing.
- Exact copy for new client-facing strings: `'Internal server error'`, `'Server is shutting down.'`, `'Too many attempts. Try again later.'` (server 429), `'Too many pairing attempts. Try again later.'` (pair route 429).
- Exact numbers: plugin pairing dies after **5** failed attempts; server pair route **5 attempts / 10 min / site**; login **10 failures / 15 min / account+IP** (cleared on success); signup **10 attempts / 15 min / IP**; session purge at boot + **hourly**; shutdown: **10s** push drain, **15s** hard deadline, second signal exits immediately.
- Existing behavior that must NOT change: curated 4xx/502 messages in `routes/sites.ts` (pair 400/422, test 502+hint); sync/agent-turn work is never awaited at shutdown (boot recovery owns it); `wp-config` guards; the dashboard receives no new SSE event types it must handle (the shutdown frame is a *named* SSE event, invisible to `onmessage`).
- Run commands from the repo root unless stated. Plugin tests: `cd ferry-plugin && vendor/bin/phpunit`. TS tests: `npm --workspace ferry-server run test`, `npm --workspace ferry-cli run test`. Typechecks: `npm --workspace <ws> run typecheck`.
- Commit after every task (small, descriptive commits, as in 5a/5b).

---

### Task 1: Fastify error handler (generic 5xx, logged detail)

**Files:**
- Modify: `ferry-server/src/app.ts` (add `setErrorHandler` right after the content-type parser block, ~line 71)
- Test: `ferry-server/tests/error-handler.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: every uncaught route throw now yields `500 { "error": "Internal server error" }` + a `console.error` line `"<METHOD> <url> → 500:"` with the full error. Errors with `statusCode < 500` (Fastify validation, malformed JSON, deliberate 4xx throws) keep their message as `{ error: message }`.

- [ ] **Step 1: Write the failing tests**

```ts
// ferry-server/tests/error-handler.test.ts
import { describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers/testApp.js';

describe('global error handler', () => {
  it('returns a generic 500 and logs the detail server-side', async () => {
    const { app } = makeApp();
    app.get('/boom', () => {
      throw new Error('secret-internal-detail');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal server error' });
    expect(res.body).not.toContain('secret-internal-detail');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('GET /boom'), expect.any(Error));
    spy.mockRestore();
  });

  it('passes 4xx throws through with their message', async () => {
    const { app } = makeApp();
    app.get('/teapot', () => {
      const err = new Error('I refuse.') as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/teapot' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: 'I refuse.' });
  });
});
```

- [ ] **Step 2: Run to verify both fail** — `npm --workspace ferry-server run test -- tests/error-handler.test.ts`. Expected: FAIL (500 body currently contains `secret-internal-detail`; 4xx body shape is Fastify's `{statusCode, error, message}`, not `{error}`).

- [ ] **Step 3: Implement.** In `app.ts`, after the `addContentTypeParser` block and before the `requireUser` definition:

```ts
  // Spec 6a §3.1: a 500 must never carry err.message to the client. 4xx (validation,
  // malformed JSON, deliberate throws) keep their message — those are curated.
  app.setErrorHandler((err, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: err.message });
    }
    console.error(`${request.method} ${request.url} → 500:`, err);
    return reply.code(500).send({ error: 'Internal server error' });
  });
```

- [ ] **Step 4: Run the whole server suite** — `npm --workspace ferry-server run test`. Expected: PASS, including the pre-existing malformed-JSON test in `tests/auth.test.ts` (its 400 goes through the new 4xx branch; the message still doesn't contain "Unexpected token").

- [ ] **Step 5: Commit** — `git add ferry-server && git commit -m "feat(server): global error handler — generic 500 body, detail to server log"`

---

### Task 2: Hashed session tokens + expired-session purge

**Files:**
- Modify: `ferry-server/src/store.ts` (SCHEMA sessions block ~line 112, constructor migration ~line 236, session methods ~lines 266–283)
- Modify: `ferry-server/src/main.ts` (boot purge + hourly interval, after the recover calls ~line 22)
- Test: `ferry-server/tests/store.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Store.createSession(token, userId, expiresAt)`, `userForSession(token)`, `deleteSession(token)` keep their signatures (raw token in, hashing internal). New: `Store.purgeExpiredSessions(): number` (rows deleted). Task 7 clears the `purgeTimer` interval created here in `main.ts` (name it exactly `purgeTimer`).

- [ ] **Step 1: Write the failing tests** (append to `tests/store.test.ts`; match its existing `new Store(':memory:')` idiom):

```ts
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
// (merge these imports with the file's existing ones)

describe('session hashing and purge', () => {
  it('stores only the sha256 of the token, and authenticates by raw token', () => {
    const store = new Store(':memory:');
    const user = store.createUser('s@example.com', 'x:y')!;
    store.createSession('raw-token-1', user.id, '2099-01-01T00:00:00.000Z');
    const rows = (store as any).db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(createHash('sha256').update('raw-token-1').digest('hex'));
    expect(store.userForSession('raw-token-1')?.id).toBe(user.id);
    store.deleteSession('raw-token-1');
    expect(store.userForSession('raw-token-1')).toBeUndefined();
  });

  it('purges expired sessions and keeps live ones', () => {
    const store = new Store(':memory:');
    const user = store.createUser('p@example.com', 'x:y')!;
    store.createSession('expired', user.id, '2000-01-01T00:00:00.000Z');
    store.createSession('live', user.id, '2099-01-01T00:00:00.000Z');
    expect(store.purgeExpiredSessions()).toBe(1);
    expect(store.userForSession('live')).toBeDefined();
  });

  it('migrates a pre-6a plaintext sessions table by dropping it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ferry-store-')), 's.db');
    const raw = new Database(path);
    raw.exec('CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL)');
    raw.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('plain', 1, '2099-01-01T00:00:00.000Z');
    raw.close();
    const store = new Store(path);
    const cols = (store as any).db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'token_hash')).toBe(true);
    expect(cols.some((c) => c.name === 'token')).toBe(false);
    expect((store as any).db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    store.close();
  });
});
```

Note: if `store.test.ts` already exposes a raw-query helper, use it instead of `(store as any).db`.

- [ ] **Step 2: Run to verify they fail** — `npm --workspace ferry-server run test -- tests/store.test.ts`. Expected: FAIL (`no such column: token_hash`, `purgeExpiredSessions is not a function`).

- [ ] **Step 3: Implement in `store.ts`.**

SCHEMA block:

```ts
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
```

Top of file, next to the other imports:

```ts
import { createHash } from 'node:crypto';
```

Module-level helper (near `isConstraintError`):

```ts
/** Sessions are stored as sha256(token) — a DB leak yields nothing usable, and the
 *  256-bit random token has no structure to brute-force (spec 6a §3.2). */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

Constructor, after `this.db.exec(SCHEMA)` (next to the existing `smoke_result_json` migration):

```ts
    // 6a migration: the pre-6a sessions table stored the raw bearer token as PK.
    // Drop and recreate — every session re-authenticates once, accepted pre-launch.
    const sessionCols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (sessionCols.some((c) => c.name === 'token')) {
      this.db.exec('DROP TABLE sessions');
      this.db.exec(SCHEMA);
    }
```

Session methods:

```ts
  createSession(token: string, userId: number, expiresAt: string): void {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), userId, expiresAt);
  }

  userForSession(token: string): User | undefined {
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, u.password_hash FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash(token), new Date().toISOString()) as { id: number; email: string; password_hash: string } | undefined;
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }

  purgeExpiredSessions(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
  }
```

- [ ] **Step 4: Wire the purge in `main.ts`** — after `store.recoverInterruptedAgentSessions();`:

```ts
store.purgeExpiredSessions();
const purgeTimer = setInterval(() => store.purgeExpiredSessions(), 60 * 60_000);
purgeTimer.unref(); // must not keep the process alive on its own
```

- [ ] **Step 5: Run the full server suite + typecheck** — `npm --workspace ferry-server run test && npm --workspace ferry-server run typecheck`. Expected: PASS (auth route tests prove the cookie round-trip still works against hashed storage).

- [ ] **Step 6: Commit** — `git commit -am "feat(server): hash session tokens (sha256) + purge expired sessions at boot and hourly"`

---

### Task 3: RateLimiter primitive + login/signup limits

**Files:**
- Create: `ferry-server/src/rate-limit.ts`
- Modify: `ferry-server/src/routes/auth.ts`
- Test: `ferry-server/tests/rate-limit.test.ts` (new), `ferry-server/tests/auth.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 4 reuses this class as-is):

```ts
export class RateLimiter {
  constructor(max: number, windowMs: number);
  /** Record one attempt. null = allowed; number = refused, seconds until the window resets. */
  hit(key: string, now?: number): number | null;
  /** null = not limited; number = limited, seconds until reset. Does NOT record an attempt. */
  limitedFor(key: string, now?: number): number | null;
  clear(key: string): void;
}
```

- [ ] **Step 1: Write the failing unit tests**

```ts
// ferry-server/tests/rate-limit.test.ts
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

describe('RateLimiter (fixed window)', () => {
  it('allows max hits, refuses beyond with a retry-after, and rolls the window', () => {
    const rl = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(rl.hit('k', t0)).toBeNull();
    expect(rl.hit('k', t0 + 1)).toBeNull();
    expect(rl.hit('k', t0 + 2)).toBeNull();
    const retry = rl.hit('k', t0 + 30_000);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(30);
    expect(rl.hit('k', t0 + 60_001)).toBeNull(); // window rolled — fresh budget
  });

  it('limitedFor reports without recording; clear resets', () => {
    const rl = new RateLimiter(2, 60_000);
    const t0 = 5_000;
    expect(rl.limitedFor('k', t0)).toBeNull();
    rl.hit('k', t0);
    rl.hit('k', t0);
    expect(rl.limitedFor('k', t0 + 1)).toBeGreaterThanOrEqual(1);
    rl.clear('k');
    expect(rl.limitedFor('k', t0 + 2)).toBeNull();
    expect(rl.hit('k', t0 + 3)).toBeNull();
  });

  it('keys are independent', () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.hit('a', 0)).toBeNull();
    expect(rl.hit('b', 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm --workspace ferry-server run test -- tests/rate-limit.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/rate-limit.ts`**

```ts
/**
 * Fixed-window in-memory rate limiter (spec 6a §3.4). Single-process by design —
 * the server is one Node process; a restart resets the windows, accepted.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Record one attempt. null = allowed; number = refused, seconds until the window resets. */
  hit(key: string, now = Date.now()): number | null {
    if (this.hits.size > 10_000) this.sweep(now); // unbounded-key guard (IPs); lazy, amortized
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    entry.count += 1;
    if (entry.count > this.max) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return null;
  }

  /** null = not limited; number = limited, seconds until reset. Does NOT record an attempt. */
  limitedFor(key: string, now = Date.now()): number | null {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt || entry.count < this.max) return null;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run unit tests** — expected PASS.

- [ ] **Step 5: Write the failing route tests** (append to `tests/auth.test.ts`):

```ts
describe('auth rate limits', () => {
  it('locks login after 10 failures per account+IP, even with the right password', async () => {
    const { app } = makeApp();
    await signup(app); // user@example.com / password1
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong' } });
      expect(res.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toEqual({ error: 'Too many attempts. Try again later.' });
  });

  it('clears the failure count on successful login', async () => {
    const { app } = makeApp();
    await signup(app);
    for (let i = 0; i < 9; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong' } });
    }
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(ok.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong' } });
    expect(after.statusCode).toBe(401); // 401, not 429 — the counter restarted
  });

  it('limits signup attempts per IP', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `u${i}@example.com`, password: 'password1' } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'u11@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(429);
  });
});
```

- [ ] **Step 6: Run to verify failure**, then **implement in `routes/auth.ts`**:

```ts
import { RateLimiter } from '../rate-limit.js';

const AUTH_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;  // per account+IP, cleared on success
const SIGNUP_MAX_ATTEMPTS = 10; // per IP
const LIMIT_BODY = { error: 'Too many attempts. Try again later.' };
```

Inside `authRoutes` (per-app instances, so tests stay isolated):

```ts
  const loginLimiter = new RateLimiter(LOGIN_MAX_FAILURES, AUTH_WINDOW_MS);
  const signupLimiter = new RateLimiter(SIGNUP_MAX_ATTEMPTS, AUTH_WINDOW_MS);
```

Signup handler, first lines:

```ts
    const retry = signupLimiter.hit(`signup:${request.ip}`);
    if (retry !== null) return reply.code(429).header('retry-after', String(retry)).send(LIMIT_BODY);
```

Login handler becomes:

```ts
  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    // Limit check BEFORE scrypt — a locked key must not burn CPU per guess (spec 6a §3.4).
    const key = `login:${String(email ?? '').toLowerCase()}:${request.ip}`;
    const limited = loginLimiter.limitedFor(key);
    if (limited !== null) return reply.code(429).header('retry-after', String(limited)).send(LIMIT_BODY);
    const user = email ? deps.store.userByEmail(email.toLowerCase()) : undefined;
    if (!user || !password || !verifyPassword(password, user.passwordHash)) {
      loginLimiter.hit(key);
      return reply.code(401).send({ error: 'Wrong email or password.' });
    }
    loginLimiter.clear(key);
    const token = newSessionToken();
    deps.store.createSession(token, user.id, sessionExpiry());
    return reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS).send({ email: user.email });
  });
```

- [ ] **Step 7: Run the server suite + typecheck.** Expected: PASS.

- [ ] **Step 8: Commit** — `git commit -am "feat(server): fixed-window rate limiter on login (failures, per account+IP) and signup (per IP)"`

---

### Task 4: Pair-route rate limit (outbound-pump cap)

**Files:**
- Modify: `ferry-server/src/routes/sites.ts`
- Test: `ferry-server/tests/sites.test.ts` (add cases; reuse its existing helpers for creating a site with a stubbed engine)

**Interfaces:**
- Consumes: `RateLimiter` from Task 3.
- Produces: `POST /api/sites/:id/pair` → `429 { error: 'Too many pairing attempts. Try again later.' }` + `Retry-After` after 5 attempts per site per 10 min. `engine.link` is NOT called for refused attempts.

- [ ] **Step 1: Write the failing test** (append to `tests/sites.test.ts`, following its existing pair-route test idiom with `stubEngine`):

```ts
  it('rate-limits pairing to 5 attempts per site and stops calling the site', async () => {
    let linkCalls = 0;
    const engine = stubEngine({
      link: () => { linkCalls++; return Promise.reject(new Error('Invalid or expired pairing code.')); },
    });
    const { app } = makeApp({ engine });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://example.com' } });
    const siteId = created.json().id as number;
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: `/api/sites/${siteId}/pair`, headers: { cookie }, payload: { code: 'AAAA-AAAA' } });
      expect(res.statusCode).toBe(400); // engine.link rejected — attempt consumed
    }
    const limited = await app.inject({ method: 'POST', url: `/api/sites/${siteId}/pair`, headers: { cookie }, payload: { code: 'AAAA-AAAA' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'Too many pairing attempts. Try again later.' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(linkCalls).toBe(5);
  });
```

- [ ] **Step 2: Run to verify failure.** Expected: 6th call is 400, not 429.

- [ ] **Step 3: Implement in `routes/sites.ts`.** Import `RateLimiter`; below the `const engine = deps.engine;` guard add:

```ts
  // Spec 6a §3.4: every pair attempt drives a real outbound HTTP request to the
  // operator-supplied site.url — cap the pump per site.
  const pairLimiter = new RateLimiter(5, 10 * 60_000);
```

In the pair handler, after the empty-code 400 check and before `engine.link`:

```ts
    const retry = pairLimiter.hit(`pair:${site.id}`);
    if (retry !== null) {
      return reply.code(429).header('retry-after', String(retry)).send({ error: 'Too many pairing attempts. Try again later.' });
    }
```

- [ ] **Step 4: Run the server suite + typecheck.** Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(server): cap pair attempts at 5/10min per site"`

---

### Task 5: Plugin pairing lockout (5 failed attempts kill the code)

**Files:**
- Modify: `ferry-plugin/src/Auth.php` (`complete_pairing`, new `MAX_ATTEMPTS` const)
- Modify: `ferry-plugin/src/Routes.php` (`pair` handler distinguishes lockout)
- Modify: `ferry-plugin/tests/bootstrap.php` (array-backed option stubs — nothing in the suite defines or calls these today, verified)
- Test: `ferry-plugin/tests/PairingTest.php` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Auth::complete_pairing($code)` now returns `string` (secret) | `null` (bad/expired code) | `false` (this attempt exhausted the budget; code deleted). `Routes::pair` maps `false` → `403 ferry_pairing_locked`. A deleted code behaves exactly like an expired one afterwards (re-issue via re-activation or `wp ferry pair` — existing paths, unchanged).

- [ ] **Step 1: Add WP option stubs to `tests/bootstrap.php`** (append after the `wp_cache_delete` stub):

```php
// Array-backed WP option stubs for classes unit-tested without WordPress (Auth pairing).
// Tests reset $GLOBALS['ferry_options'] in setUp().
$GLOBALS['ferry_options'] = [];
function get_option($name, $default = false) {
    return array_key_exists($name, $GLOBALS['ferry_options']) ? $GLOBALS['ferry_options'][$name] : $default;
}
function update_option($name, $value, $autoload = null) {
    $GLOBALS['ferry_options'][$name] = $value;
    return true;
}
function delete_option($name) {
    unset($GLOBALS['ferry_options'][$name]);
    return true;
}
```

- [ ] **Step 2: Write the failing tests**

```php
<?php
// ferry-plugin/tests/PairingTest.php
use Ferry\Auth;
use PHPUnit\Framework\TestCase;

final class PairingTest extends TestCase
{
    protected function setUp(): void
    {
        $GLOBALS['ferry_options'] = [];
    }

    public function test_correct_code_pairs_and_consumes_the_code(): void
    {
        $pairing = Auth::issue_pairing_code();
        $secret = Auth::complete_pairing(strtolower($pairing['code'])); // case-insensitive input
        $this->assertIsString($secret);
        $this->assertSame(64, strlen($secret));
        $this->assertArrayNotHasKey('ferry_pairing', $GLOBALS['ferry_options']);
        $this->assertSame($secret, $GLOBALS['ferry_options']['ferry_secret']);
    }

    public function test_failed_attempts_count_and_code_survives_below_the_budget(): void
    {
        Auth::issue_pairing_code();
        for ($i = 0; $i < 4; $i++) {
            $this->assertNull(Auth::complete_pairing('0000-0000'));
        }
        $this->assertSame(4, $GLOBALS['ferry_options']['ferry_pairing']['attempts']);
    }

    public function test_fifth_failed_attempt_deletes_the_code_and_reports_lockout(): void
    {
        $pairing = Auth::issue_pairing_code();
        for ($i = 0; $i < 4; $i++) {
            Auth::complete_pairing('0000-0000');
        }
        $this->assertFalse(Auth::complete_pairing('0000-0000'));
        $this->assertArrayNotHasKey('ferry_pairing', $GLOBALS['ferry_options']);
        // afterwards indistinguishable from expiry — even the real code is dead
        $this->assertNull(Auth::complete_pairing($pairing['code']));
    }

    public function test_correct_code_within_the_budget_still_pairs(): void
    {
        $pairing = Auth::issue_pairing_code();
        Auth::complete_pairing('0000-0000');
        $this->assertIsString(Auth::complete_pairing($pairing['code']));
    }

    public function test_a_fresh_code_starts_with_a_fresh_budget(): void
    {
        Auth::issue_pairing_code();
        for ($i = 0; $i < 5; $i++) {
            Auth::complete_pairing('0000-0000');
        }
        $pairing = Auth::issue_pairing_code(); // re-activation / wp ferry pair path
        $this->assertIsString(Auth::complete_pairing($pairing['code']));
    }

    public function test_expired_code_returns_null_without_counting(): void
    {
        Auth::issue_pairing_code();
        $GLOBALS['ferry_options']['ferry_pairing']['expires'] = time() - 1;
        $this->assertNull(Auth::complete_pairing('0000-0000'));
        $this->assertArrayNotHasKey('attempts', $GLOBALS['ferry_options']['ferry_pairing']);
    }
}
```

The wrong-guess placeholder `'0000-0000'` can never equal a real code — `0` is excluded from `CODE_ALPHABET`.

- [ ] **Step 3: Run to verify failure** — `cd ferry-plugin && vendor/bin/phpunit --filter Pairing`. Expected: FAIL (no attempt counting; `complete_pairing` never returns false).

- [ ] **Step 4: Implement.** `Auth.php`: add const + rework the failure branch:

```php
    const MAX_ATTEMPTS = 5;   // failed claims per code; the 5th failure deletes the code
```

```php
    /** Single-use exchange: valid code -> fresh secret, code invalidated. Null on a bad or
     *  expired code; false when THIS attempt spent the budget (code deleted — same as expiry). */
    public static function complete_pairing(string $code)
    {
        $pairing = get_option('ferry_pairing');
        if (!is_array($pairing) || !isset($pairing['code'], $pairing['expires']) || $pairing['expires'] < time()) {
            return null;
        }
        if (!hash_equals($pairing['code'], strtoupper(trim($code)))) {
            $attempts = (int) ($pairing['attempts'] ?? 0) + 1;
            if ($attempts >= self::MAX_ATTEMPTS) {
                // Brute-force budget spent: the code dies like an expired one. update_option
                // is not atomic — a small race around the threshold is acceptable here.
                delete_option('ferry_pairing');
                return false;
            }
            $pairing['attempts'] = $attempts;
            update_option('ferry_pairing', $pairing, false);
            return null;
        }
        $secret = bin2hex(random_bytes(32));
        update_option('ferry_secret', $secret, false);
        delete_option('ferry_pairing');
        return $secret;
    }
```

`Routes.php` `pair()`:

```php
        $secret = Auth::complete_pairing((string) $request->get_param('code'));
        if ($secret === false) {
            return new \WP_Error('ferry_pairing_locked', 'Too many attempts — issue a new pairing code on the site (re-activate the plugin or run `wp ferry pair`).', ['status' => 403]);
        }
        if ($secret === null) {
            return new \WP_Error('ferry_bad_code', 'Invalid or expired pairing code.', ['status' => 403]);
        }
```

- [ ] **Step 5: Run the full plugin suite** — `vendor/bin/phpunit`. Expected: PASS (203 + new).

- [ ] **Step 6: Commit** — `git commit -am "feat(plugin): pairing code dies after 5 failed claim attempts (403 ferry_pairing_locked)"`

---

### Task 6: Lifecycle — shutdown flag, SSE registry, 503 guards

**Files:**
- Create: `ferry-server/src/lifecycle.ts`
- Modify: `ferry-server/src/app.ts` (AppDeps + decorate), `ferry-server/src/routes/sync.ts`, `ferry-server/src/routes/agent.ts`, `ferry-server/src/routes/changes.ts`, `ferry-server/src/routes/sites.ts`
- Test: `ferry-server/tests/lifecycle.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 7 consumes exactly this):

```ts
export class Lifecycle {
  shuttingDown: boolean;                     // starts false
  pushBusy: () => boolean;                   // set by buildApp when a PushManager exists
  registerSse(end: () => void): () => void;  // returns unregister
  closeAllSse(): void;
}
export function refuseDuringShutdown(lifecycle: Lifecycle): preHandler; // 503 'Server is shutting down.'
```

`AppDeps` gains optional `lifecycle?: Lifecycle`; `buildApp` decorates `app.lifecycle` (own instance when not injected). Work-starting routes gain the guard: sync POST, agent messages POST, agent sessions POST, changes push/rollback/retry POST, sites pair POST. All three SSE routes register an `end` closure that writes a terminal frame and closes.

- [ ] **Step 1: Write the failing tests**

```ts
// ferry-server/tests/lifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

describe('Lifecycle', () => {
  it('registers, closes, and unregisters SSE enders', () => {
    const lc = new Lifecycle();
    const closed: string[] = [];
    lc.registerSse(() => closed.push('a'));
    const unregisterB = lc.registerSse(() => closed.push('b'));
    unregisterB();
    lc.closeAllSse();
    expect(closed).toEqual(['a']);
    lc.closeAllSse(); // second call is a no-op
    expect(closed).toEqual(['a']);
  });

  it('a throwing ender does not block the others', () => {
    const lc = new Lifecycle();
    const closed: string[] = [];
    lc.registerSse(() => { throw new Error('boom'); });
    lc.registerSse(() => closed.push('ok'));
    lc.closeAllSse();
    expect(closed).toEqual(['ok']);
  });
});

describe('shutdown 503 guard', () => {
  it('refuses work-starting routes with 503 once shuttingDown flips', async () => {
    const lifecycle = new Lifecycle();
    const { app } = makeApp({ engine: stubEngine(), lifecycle });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://example.com' } });
    const siteId = created.json().id as number;
    lifecycle.shuttingDown = true;
    for (const url of [`/api/sites/${siteId}/sync`, `/api/sites/${siteId}/pair`]) {
      const res = await app.inject({ method: 'POST', url, headers: { cookie }, payload: { code: 'AAAA-AAAA' } });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'Server is shutting down.' });
    }
    // reads stay available during the drain
    const read = await app.inject({ method: 'GET', url: `/api/sites/${siteId}`, headers: { cookie } });
    expect(read.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure.** Expected: FAIL (module not found; 503s are 409/400).

- [ ] **Step 3: Implement `src/lifecycle.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Process-lifecycle seam (spec 6a §3.3). buildApp decorates the instance onto the app;
 * gracefulShutdown() flips the flag, drains SSE through the registry, and waits on pushBusy.
 * Hijacked SSE sockets are invisible to app.close() — this registry is the only handle.
 */
export class Lifecycle {
  shuttingDown = false;
  /** Overwritten by buildApp when a PushManager exists. */
  pushBusy: () => boolean = () => false;
  private sse = new Set<() => void>();

  registerSse(end: () => void): () => void {
    this.sse.add(end);
    return () => this.sse.delete(end);
  }

  closeAllSse(): void {
    for (const end of [...this.sse]) {
      try {
        end();
      } catch (err) {
        console.error('SSE shutdown close failed:', err);
      }
    }
    this.sse.clear();
  }
}

/** Extra preHandler for routes that START work (sync/push/rollback/retry/agent/pair). */
export function refuseDuringShutdown(lifecycle: Lifecycle) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (lifecycle.shuttingDown) {
      await reply.code(503).send({ error: 'Server is shutting down.' });
    }
  };
}
```

- [ ] **Step 4: Wire into `app.ts`.**
  - `AppDeps` gains `lifecycle?: Lifecycle;` (import from `./lifecycle.js`).
  - In `buildApp`, right after `const app = Fastify();`: `const lifecycle = deps.lifecycle ?? new Lifecycle();` and `app.decorate('lifecycle', lifecycle);`
  - After `const push = ...` inside the engine branch: `if (push) lifecycle.pushBusy = () => push.isPushingAny();` (method added in Task 7 — for THIS task use `() => false`; Task 7 replaces it. To keep this task compiling standalone, add the wiring line in Task 7 instead — do NOT reference `isPushingAny` here.)
  - Extend the module augmentation at the bottom: `lifecycle: Lifecycle;` inside `FastifyInstance`.

- [ ] **Step 5: Add the 503 guard to the work-starting routes.** In each file import `refuseDuringShutdown` from `../lifecycle.js` and change the route options to a preHandler array, e.g. in `routes/sync.ts`:

```ts
  app.post('/api/sites/:id/sync', { preHandler: [app.requireUser, refuseDuringShutdown(app.lifecycle)] }, async (request, reply) => {
```

Apply identically to: `routes/agent.ts` (`/agent/messages`, `/agent/sessions`), `routes/changes.ts` (`/push`, `/rollback`, `/retry`), `routes/sites.ts` (`/pair`). GET/read routes are untouched.

- [ ] **Step 6: Register SSE connections in the three SSE routes.** Pattern for `routes/sync.ts` (`.../sync/events`); the heartbeat/unsubscribe lines already exist — add the `end` registration and extend the close handler:

```ts
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    const unregister = app.lifecycle.registerSse(() => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        // Named event: browser EventSource onmessage ignores it — no dashboard change.
        reply.raw.write('event: shutdown\ndata: {}\n\n');
      } catch {
        // socket already gone
      }
      reply.raw.end();
    });
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      unregister();
    });
```

Apply the same shape to `routes/agent.ts` (`.../agent/events`) and `routes/changes.ts` (`.../push/events`).

- [ ] **Step 7: Run the full server suite + typecheck.** Expected: PASS.

- [ ] **Step 8: Commit** — `git commit -am "feat(server): lifecycle seam — shutdown flag, SSE registry, 503 on work-starting routes"`

---

### Task 7: Graceful shutdown (signals, SSE drain, push grace)

**Files:**
- Create: `ferry-server/src/shutdown.ts`
- Modify: `ferry-server/src/main.ts` (signal handlers), `ferry-server/src/push-manager.ts` (add `isPushingAny`), `ferry-server/src/app.ts` (one wiring line)
- Test: `ferry-server/tests/shutdown.test.ts` (new)

**Interfaces:**
- Consumes: `Lifecycle` (Task 6).
- Produces: `gracefulShutdown(opts: { app: FastifyInstance; store: Store; lifecycle: Lifecycle; pushDrainMs?: number }): Promise<void>`; constants `PUSH_DRAIN_MS = 10_000`, `HARD_DEADLINE_MS = 15_000`; `PushManager.isPushingAny(): boolean`.

- [ ] **Step 1: Write the failing integration test**

```ts
// ferry-server/tests/shutdown.test.ts
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { gracefulShutdown } from '../src/shutdown.js';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

describe('gracefulShutdown', () => {
  it('ends open SSE streams with a shutdown frame, then closes the listener and store', async () => {
    const lifecycle = new Lifecycle();
    const { app, store } = makeApp({ engine: stubEngine(), lifecycle });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://example.com' } });
    const siteId = created.json().id as number;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    let received = '';
    const socketClosed = new Promise<void>((resolve) => {
      const req = get(
        { host: '127.0.0.1', port, path: `/api/sites/${siteId}/sync/events`, headers: { cookie } },
        (res) => {
          res.on('data', (chunk: Buffer) => { received += chunk.toString(); });
          res.on('end', resolve);
          res.on('close', resolve);
        },
      );
      req.on('error', () => resolve());
    });
    // wait until the SSE handshake delivered the snapshot frame
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => { if (received.includes('data:')) { clearInterval(poll); resolve(); } }, 20);
    });

    await gracefulShutdown({ app, store, lifecycle });

    await socketClosed;
    expect(received).toContain('event: shutdown');
    // store is closed — any query now throws
    expect(() => store.purgeExpiredSessions()).toThrow();
  }, 15_000);

  it('waits for an in-flight push up to pushDrainMs', async () => {
    const lifecycle = new Lifecycle();
    const { app, store } = makeApp({ lifecycle });
    let busy = true;
    lifecycle.pushBusy = () => busy;
    setTimeout(() => { busy = false; }, 500);
    const start = Date.now();
    await gracefulShutdown({ app, store, lifecycle, pushDrainMs: 5_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(4_000); // returned when the push finished, not at the deadline
  });
});
```

- [ ] **Step 2: Run to verify failure.** Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/shutdown.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { Lifecycle } from './lifecycle.js';
import type { Store } from './store.js';

export const PUSH_DRAIN_MS = 10_000;   // an in-flight push/rollback gets this long to finish
export const HARD_DEADLINE_MS = 15_000; // main.ts force-exits after this, whatever happens

/**
 * Drain order (spec 6a §3.3): refuse new work (Lifecycle flag — routes already 503),
 * end SSE via the registry (app.close() cannot see hijacked sockets), wait bounded for
 * an in-flight push/rollback (the two-phase-commit window is the one thing worth
 * draining), then close listener and store. Syncs and agent turns are NOT awaited —
 * they are resumable by design and boot recovery already handles them.
 */
export async function gracefulShutdown(opts: {
  app: FastifyInstance;
  store: Store;
  lifecycle: Lifecycle;
  pushDrainMs?: number;
}): Promise<void> {
  const { app, store, lifecycle } = opts;
  const drainMs = opts.pushDrainMs ?? PUSH_DRAIN_MS;
  lifecycle.shuttingDown = true;
  lifecycle.closeAllSse();
  const start = Date.now();
  while (lifecycle.pushBusy() && Date.now() - start < drainMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await app.close();
  store.close();
}
```

- [ ] **Step 4: `push-manager.ts`** — next to `isPushing(siteId)` add:

```ts
  /** Any site mid-push/rollback/recovery — the shutdown drain waits on this. */
  isPushingAny(): boolean {
    return this.pushing.size > 0;
  }
```

And in `app.ts`, inside the engine branch after `const push = ...`:

```ts
    if (push) lifecycle.pushBusy = () => push.isPushingAny();
```

- [ ] **Step 5: `main.ts`** — imports: `Lifecycle` from `./lifecycle.js`, `gracefulShutdown, HARD_DEADLINE_MS` from `./shutdown.js`. Create `const lifecycle = new Lifecycle();` above `buildApp` and pass `lifecycle` in the deps object. After `await app.listen(...)`:

```ts
let shutdownStarted = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shutdownStarted) process.exit(130); // second signal: immediate
  shutdownStarted = true;
  console.log(`${signal} — shutting down (press again to force-exit).`);
  const deadline = setTimeout(() => process.exit(1), HARD_DEADLINE_MS);
  deadline.unref();
  clearInterval(purgeTimer);
  void gracefulShutdown({ app, store, lifecycle }).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 6: Run the full server suite + typecheck.** Expected: PASS.

- [ ] **Step 7: Manual smoke** — `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" npm --workspace ferry-server run dev`, then Ctrl-C once: log line appears, process exits promptly with code 0. (tsx watch also sends SIGTERM on file change — restarts must still work.)

- [ ] **Step 8: Commit** — `git commit -am "feat(server): SSE-aware graceful shutdown — signal handlers, push drain, hard deadline"`

---

### Task 8: Refusal-list single source + PHP parity test + cli typecheck script

**Files:**
- Create: `ferry-cli/src/refusals.ts`
- Modify: `ferry-cli/src/journal.ts` (~lines 103–112, 170), `ferry-server/src/changes.ts` (~lines 27–41)
- Modify: `ferry-cli/package.json` (add `typecheck` script)
- Test: `ferry-cli/tests/refusals-parity.test.ts` (new), `ferry-cli/tests/journal.test.ts` (add case)

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
// ferry-cli/src/refusals.ts
export const REFUSED_TABLES: string[];    // ['posts','comments','commentmeta','users','usermeta']
export const REFUSED_PREFIXES: string[];  // ['woocommerce_','wc_','actionscheduler_']
export function stripTablePrefix(table: string, prefix: string): string; // lowercases; case-insensitive strip
export function isRefusedBareTable(bare: string): boolean;               // case-insensitive
```

- [ ] **Step 1: Create `ferry-cli/src/refusals.ts`**

```ts
/**
 * Single source of the content-table refusal policy (Global Constraints: DB content
 * never travels through a change card). ferry-cli's journal classifier and
 * ferry-server's change validation import this; ferry-plugin/src/DbOps.php keeps its
 * own copy (zero-dep native PHP, no build step) — tests/refusals-parity.test.ts
 * asserts the copies stay semantically identical.
 */
export const REFUSED_TABLES = ['posts', 'comments', 'commentmeta', 'users', 'usermeta'];
export const REFUSED_PREFIXES = ['woocommerce_', 'wc_', 'actionscheduler_'];

/** Strip the site's table prefix, lowercasing both sides — MySQL table names are
 *  effectively case-insensitive on the usual collations/filesystems (mirrors
 *  DbOps::table_refused). The returned name is lowercase. */
export function stripTablePrefix(table: string, prefix: string): string {
  const lowerTable = table.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  return lowerTable.startsWith(lowerPrefix) ? lowerTable.slice(lowerPrefix.length) : lowerTable;
}

/** `bare` must already be prefix-stripped (lowercased here defensively). */
export function isRefusedBareTable(bare: string): boolean {
  const lower = bare.toLowerCase();
  return REFUSED_TABLES.includes(lower) || REFUSED_PREFIXES.some((p) => lower.startsWith(p));
}
```

- [ ] **Step 2: Write the parity test**

```ts
// ferry-cli/tests/refusals-parity.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REFUSED_PREFIXES, REFUSED_TABLES } from '../src/refusals.js';

const DBOPS_PATH = fileURLToPath(new URL('../../ferry-plugin/src/DbOps.php', import.meta.url));

function phpConstArray(source: string, constName: string): string[] {
  const m = source.match(new RegExp(`const ${constName} = \\[([^\\]]*)\\]`, 's'));
  if (!m) throw new Error(`${constName} not found in DbOps.php`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

// Drift between the copies already caused one Critical (wp_-prefix hardcode) — this
// test is the tripwire the shared-source refactor cannot provide across languages.
describe('refusal-list parity: refusals.ts vs ferry-plugin DbOps.php', () => {
  const src = readFileSync(DBOPS_PATH, 'utf8');

  it('REFUSED_TABLES match exactly, in order', () => {
    expect(phpConstArray(src, 'REFUSED_TABLES')).toEqual(REFUSED_TABLES);
  });

  it('REFUSED_PATTERNS are exactly the ^-anchored TS prefixes', () => {
    expect(phpConstArray(src, 'REFUSED_PATTERNS')).toEqual(REFUSED_PREFIXES.map((p) => `/^${p}/`));
  });

  it('PHP matching is lowercased (case-insensitive) like the TS side', () => {
    expect(src).toMatch(/strtolower\(\$table\)/);
  });
});
```

- [ ] **Step 3: Run it** — `npm --workspace ferry-cli run test -- tests/refusals-parity.test.ts`. Expected: PASS immediately (the lists match today — this task changes structure, not policy).

- [ ] **Step 4: Write the failing journal case-insensitivity test** (append to `tests/journal.test.ts`, using its existing `classify` test idiom for a `RawRowEvent`):

```ts
  it('refuses content tables case-insensitively (wp_USERS, WP_posts)', () => {
    const ev = {
      table: 'wp_USERS', kind: 'update' as const, pkCols: ['ID'],
      before: { ID: '1', user_login: 'a' }, after: { ID: '1', user_login: 'b' },
    };
    const result = classify(ev as never, 'wp_');
    expect(result).toHaveProperty('refused');
  });
```

Run — expected: FAIL (current compare is case-sensitive; `wp_USERS` slips through to a generic row op).

- [ ] **Step 5: Refactor `journal.ts`.** Delete the local `REFUSED_TABLES`, `REFUSED_PREFIXES`, `isRefusedTable`, and `stripPrefix` (lines ~103–112). Import instead:

```ts
import { isRefusedBareTable, stripTablePrefix } from './refusals.js';
```

In `classify()` replace `const stripped = stripPrefix(ev.table, prefix);` with `const stripped = stripTablePrefix(ev.table, prefix);` and `if (isRefusedTable(stripped))` with `if (isRefusedBareTable(stripped))`. Note `stripped` is now lowercase, so the `stripped === 'options'` / `'postmeta'` compares become case-insensitive too — deliberate alignment (a `wp_Options` write now classifies as an option op instead of falling through to a generic row op).

- [ ] **Step 6: Refactor `ferry-server/src/changes.ts`.** Delete its local `REFUSED_TABLES`/`REFUSED_PREFIXES`/`isRefusedTable` (keep the explanatory comment, updated to point at the shared source). Import and use:

```ts
import { isRefusedBareTable, stripTablePrefix } from '../../ferry-cli/src/refusals.js';
```

In `validateOps`: `if (isRefusedBareTable(stripTablePrefix(table, prefix))) throw new Error(\`refused_op: ${table}\`);`

- [ ] **Step 7: Add the typecheck script to `ferry-cli/package.json`** (`build` emits; this is the CI-greppable check like the other workspaces):

```json
    "typecheck": "tsc -p tsconfig.json --noEmit",
```

- [ ] **Step 8: Run everything** — `npm --workspace ferry-cli run test && npm --workspace ferry-cli run typecheck && npm --workspace ferry-server run test && npm --workspace ferry-server run typecheck`. Expected: all PASS.

- [ ] **Step 9: Commit** — `git commit -am "refactor: single TS source for the refusal list + PHP parity test + ferry-cli typecheck script"`

---

### Task 9: Plugin rollback — idempotent early-return + apply_error in the response

**Files:**
- Modify: `ferry-plugin/src/Commit.php` (`rollback()`, ~lines 224 and 283–289)
- Test: `ferry-plugin/tests/RollbackTest.php` (add cases), `ferry-plugin/tests/helpers/FakeWpdb.php` (extend if needed)

**Interfaces:**
- Consumes: existing `Tx::read` (passes `rolled_back` through untouched; only non-terminal statuses map to `dirty`).
- Produces: `Commit::rollback` returns `['rolled_back' => true, 'conflicts' => []]` immediately when meta status is already `rolled_back`; on a DB apply failure the response now carries `'apply_error' => ['key' => ..., 'detail' => ...]` exactly as `Commit::run` does. Task 10 plumbs that key through CLI and server.

- [ ] **Step 1: Write the failing tests** (append to `RollbackTest.php`, reusing `commitModifyAndCreate()` / `meta()` / `FakeWpdb`):

```php
    // ---- 6a: a second rollback after full success is a no-op success, not a dirty wedge ----

    public function test_second_rollback_after_success_is_idempotent(): void
    {
        $this->commitModifyAndCreate();
        $inverseOps = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '2', 'new' => '1']];
        $first = Commit::rollback($this->root, new FakeWpdb([['option_value' => '2']]), $this->txid, $inverseOps);
        $this->assertTrue($first['rolled_back'], 'fixture: first rollback must succeed');

        // Second call: the inverse ops' CAS expectations no longer hold (DB now has the OLD
        // values) — without the early-return this wedges meta to rolling_back/dirty.
        $second = Commit::rollback($this->root, new FakeWpdb([['option_value' => '1']]), $this->txid, $inverseOps);
        $this->assertTrue($second['rolled_back']);
        $this->assertSame([], $second['conflicts']);
        $this->assertSame('rolled_back', $this->meta()['status']);
    }

    // ---- 6a: DB apply failure during rollback surfaces apply_error like commit does ----

    public function test_rollback_db_apply_failure_carries_apply_error(): void
    {
        $this->commitModifyAndCreate();
        $inverseOps = [['kind' => 'option_set', 'name' => 'ferry_a', 'old' => '2', 'new' => '1']];
        $wpdb = new FakeWpdb([['option_value' => '2']]); // read-set CAS passes...
        $wpdb->fail_writes = true;                        // ...but the write itself fails

        $result = Commit::rollback($this->root, $wpdb, $this->txid, $inverseOps);

        $this->assertFalse($result['rolled_back']);
        $this->assertSame([], $result['conflicts']);
        $this->assertArrayHasKey('apply_error', $result);
        $this->assertSame('option_set apply failed', $result['apply_error']['detail']);
    }
```

- [ ] **Step 2: Check `tests/helpers/FakeWpdb.php`.** If it has no way to make a write fail, add a public `$fail_writes = false;` property and make its write path (the method `DbOps::apply` drives — `query()` for INSERT/UPDATE/DELETE) return `false` when set, leaving read/`get_row` behavior untouched. Keep the change minimal and match the helper's existing style.

- [ ] **Step 3: Run to verify failure** — `vendor/bin/phpunit --filter Rollback`. Expected: both new tests FAIL (second rollback returns `rolled_back:false` + meta dirty; apply_error absent).

- [ ] **Step 4: Implement in `Commit.php::rollback`.** After the `$meta = Tx::read(...); if (!is_array($meta)) { $meta = []; }` block:

```php
        if (($meta['status'] ?? null) === 'rolled_back') {
            // Idempotency (issue #9): a fully-succeeded rollback must not re-run — the
            // inverse ops' CAS expectations no longer hold and would wedge this record
            // to rolling_back/dirty. Nothing to do is success.
            return ['rolled_back' => true, 'conflicts' => []];
        }
```

And the DB-failure branch becomes:

```php
        $dbResult = DbOps::apply_in_transaction($wpdb, $ops, [], $wpdb->prefix, false);
        if (!$dbResult['committed']) {
            // Files are already correctly restored - that was never wrong, so it stands.
            // Meta stays "rolling_back" (not reset to "committed"): a retry re-checks every
            // file (all satisfied now, nothing pending) and just re-attempts the DB step.
            $response = ['rolled_back' => false, 'conflicts' => $dbResult['conflicts']];
            if (isset($dbResult['apply_error'])) {
                $response['apply_error'] = $dbResult['apply_error'];
            }
            return $response;
        }
```

- [ ] **Step 5: Run the full plugin suite.** Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "fix(plugin): idempotent second rollback + apply_error surfaced in rollback response"`

---

### Task 10: apply_error plumbing — CLI rollback() and PushManager

**Files:**
- Modify: `ferry-cli/src/push.ts` (`rollback()`, ~lines 177–189), `ferry-server/src/push/types.ts` (PushRunner.rollback return type), `ferry-server/src/push-manager.ts` (`rollback()` ~line 164 and `recoverOne` dirty/staged branch ~line 217)
- Test: `ferry-cli/tests/push.test.ts` (add case), `ferry-server/tests/push-manager.test.ts` (add case)

**Interfaces:**
- Consumes: plugin response key `apply_error: {key, detail}` (Task 9).
- Produces: CLI `rollback()` returns `{ ok: boolean; conflicts?: Conflict[]; applyError?: { key: string; detail: string } }`; `PushRunner.rollback` return type matches; a failed rollback with `applyError` lands as a one-row conflict `{ key, expected: 'rollback applied', found: detail }` instead of an empty conflict card.

- [ ] **Step 1: Write the failing CLI test** (append to `tests/push.test.ts`, reusing its existing fake-client idiom for `rollback()`):

```ts
  it('rollback() passes the plugin apply_error through', async () => {
    const client = fakeClient({
      '/ferry/v1/rollback': { rolled_back: false, conflicts: [], apply_error: { key: 'option:x', detail: 'option_set apply failed' } },
    });
    const result = await rollback('site', { txid: 'a'.repeat(32), ops: [], client });
    expect(result.ok).toBe(false);
    expect(result.applyError).toEqual({ key: 'option:x', detail: 'option_set apply failed' });
  });
```

(Adapt `fakeClient` to whatever helper `push.test.ts` already uses for stubbing `FerryClient.postJson` — do not invent a new stub style.)

- [ ] **Step 2: Write the failing PushManager test** (append to `tests/push-manager.test.ts`, reusing its scripted-runner idiom):

```ts
  it('manual rollback with apply_error produces a descriptive one-row conflict', async () => {
    // runner.rollback resolves { ok: false, applyError: { key: 'option:x', detail: 'option_set apply failed' } }
    // → change status 'conflict', conflict === [{ key: 'option:x', expected: 'rollback applied', found: 'option_set apply failed' }]
  });
```

Write it concretely against the file's existing seed/change helpers (a `pushed` change + a scripted runner whose `rollback` resolves as above), asserting the stored conflict row exactly.

- [ ] **Step 3: Run both to verify failure.**

- [ ] **Step 4: Implement.**

`ferry-cli/src/push.ts`:

```ts
export async function rollback(
  slug: string,
  opts: { txid: string; ops: DbOp[]; client?: FerryClient },
): Promise<{ ok: boolean; conflicts?: Conflict[]; applyError?: { key: string; detail: string } }> {
  let client = opts.client;
  if (!client) {
    const profile = loadProfile(slug);
    client = new FerryClient(profile.url, profile.secret);
    await client.syncClock();
  }
  const res = await client.postJson('/ferry/v1/rollback', { txid: opts.txid, ops: opts.ops.map(invertOp) });
  return { ok: res.data.rolled_back, conflicts: res.data.conflicts, applyError: res.data.apply_error };
}
```

`ferry-server/src/push/types.ts`:

```ts
  rollback(slug: string, opts: { txid: string; ops: DbOp[] }): Promise<{ ok: boolean; conflicts?: Conflict[]; applyError?: { key: string; detail: string } }>;
```

`ferry-server/src/push-manager.ts` — shared helper (module scope, near `specFor`-style helpers):

```ts
/** apply_error means the DB write itself failed (not drift) — surface it as a readable
 *  conflict row instead of an empty conflict card (issue #9). */
function rollbackConflict(result: { conflicts?: Conflict[]; applyError?: { key: string; detail: string } }): Conflict[] {
  if (result.applyError) return [{ key: result.applyError.key, expected: 'rollback applied', found: result.applyError.detail }];
  return result.conflicts ?? [];
}
```

Use it in `rollback()`:

```ts
      } else {
        this.store.setChangeStatus(change.id, 'conflict', { conflict: rollbackConflict(result) });
      }
```

and in `recoverOne`'s dirty/staged branch:

```ts
      } else {
        this.store.setChangeStatus(change.id, 'conflict', { conflict: rollbackConflict(rb) });
      }
```

- [ ] **Step 5: Run cli + server suites and typechecks** (the real runner in `engine.ts` passes the CLI result through — the widened type must compile everywhere). Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "fix: plumb rollback apply_error through CLI and PushManager as a readable conflict"`

---

### Task 11: Staging-prune touch() symmetry + Excludes case alignment

**Files:**
- Modify: `ferry-plugin/src/Staging.php` (end of `add()`), `ferry-plugin/src/Excludes.php` (PREFIXES loop)
- Test: `ferry-plugin/tests/StagingTest.php`, `ferry-plugin/tests/ExcludesTest.php` (add cases)

**Interfaces:** none — behavior-only.

- [ ] **Step 1: Write the failing tests.**

`StagingTest.php` (reuse its existing setUp/root idiom):

```php
    public function test_resumed_batch_refreshes_the_staging_dir_mtime(): void
    {
        $txid = str_repeat('a', 32);
        Staging::add($this->root, $txid, []);
        $dir = Staging::dir($this->root, $txid);
        touch($dir, time() - 40 * 86400); // aged past the 30-day retention
        clearstatcache();
        Staging::add($this->root, $txid, []); // resumed batch
        clearstatcache();
        $this->assertGreaterThan(time() - 60, filemtime($dir), 'resumed batch must refresh the prune clock');
    }
```

`ExcludesTest.php`:

```php
    public function test_prefix_exclusions_are_case_insensitive(): void
    {
        $this->assertTrue(Ferry\Excludes::excluded('WP-CONTENT/UPLOADS/photo.jpg'));
        $this->assertTrue(Ferry\Excludes::excluded('Wp-Content/Cache/page.html'));
    }
```

(Match the file's existing use/import style.)

- [ ] **Step 2: Run to verify failure** — `vendor/bin/phpunit --filter 'Staging|Excludes'`.

- [ ] **Step 3: Implement.**

`Staging.php`, after the `file_put_contents($manifest_path, ...)` line:

```php
        // Issue #9: refresh the prune clock on every batch — a multi-batch stage resumed
        // near the 30-day retention edge must not lose its directory mid-transaction.
        touch($dir);
```

`Excludes.php`, the PREFIXES loop only (FILES/BASENAMES stay case-sensitive — the write-side guard covers wp-config separately, and this issue is scoped to PREFIXES):

```php
        foreach (self::PREFIXES as $prefix) {
            if (stripos($relpath, $prefix) === 0) {
                return true;
            }
        }
```

- [ ] **Step 4: Run the full plugin suite.** Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "fix(plugin): staging dir touch() per batch + case-insensitive prefix excludes"`

---

### Task 12: pk / new[pkCol] cross-check (server + plugin)

**Files:**
- Modify: `ferry-server/src/changes.ts` (`validateOps`), `ferry-plugin/src/DbOps.php` (`validate` + new `pk_consistent`)
- Test: `ferry-server/tests/changes.test.ts` (add cases through `ChangeService.create`, its existing idiom), `ferry-plugin/tests/DbOpsTest.php` (add cases)

**Interfaces:**
- Consumes: Task 8's refactored `validateOps` (the new check slots into the same row-op branch).
- Produces: server throws `Error('pk_mismatch: <table>')`; plugin refuses with `reason: 'pk_mismatch'`. `ferry-cli/src/journal.ts` needs NO change: `buildRowOp` reads `pk` from `row[pkCol]`, so they agree by construction (the spec's "cheap assert" is satisfied by construction — add a one-line comment there saying so).

- [ ] **Step 1: Write the failing plugin tests** (append to `DbOpsTest.php`, matching its `validate()` test idiom):

```php
    public function test_row_op_with_mismatched_new_pk_is_refused(): void
    {
        $ops = [['kind' => 'row_insert', 'table' => 'wp_custom', 'pkCol' => 'id', 'pk' => 7, 'new' => ['id' => '8', 'label' => 'x']]];
        $result = Ferry\DbOps::validate($ops, 'wp_');
        $this->assertSame([], $result['ok']);
        $this->assertSame('pk_mismatch', $result['refused'][0]['reason']);
    }

    public function test_row_op_with_matching_string_pk_passes(): void
    {
        $ops = [['kind' => 'row_insert', 'table' => 'wp_custom', 'pkCol' => 'id', 'pk' => 7, 'new' => ['id' => '7', 'label' => 'x']]];
        $result = Ferry\DbOps::validate($ops, 'wp_');
        $this->assertSame([], $result['refused']); // binlog values are strings — '7' agrees with 7
    }

    public function test_row_update_with_mismatched_old_pk_is_refused(): void
    {
        $ops = [['kind' => 'row_update', 'table' => 'wp_custom', 'pkCol' => 'id', 'pk' => 7,
                 'old' => ['id' => '9', 'label' => 'a'], 'new' => ['id' => '7', 'label' => 'b']]];
        $result = Ferry\DbOps::validate($ops, 'wp_');
        $this->assertSame('pk_mismatch', $result['refused'][0]['reason']);
    }
```

- [ ] **Step 2: Write the failing server test** (append to `changes.test.ts`, using the file's existing `ChangeService.create`-throws idiom for `refused_op`): a draft whose ops contain `{ kind: 'row_insert', table: 'wp_custom', pkCol: 'id', pk: 7, new: { id: 8 } }` → `create` rejects with `pk_mismatch: wp_custom`; the matching-`'7'`-string variant succeeds.

- [ ] **Step 3: Run both to verify failure.**

- [ ] **Step 4: Implement.**

`DbOps.php` — in `validate()`, after the `table_refused` check inside the ROW_KINDS branch:

```php
                if (!self::pk_consistent($op)) {
                    $refused[] = ['index' => $index, 'reason' => 'pk_mismatch'];
                    continue;
                }
```

New private method (below `table_refused`):

```php
    /** Row ops: when new/old carries the pk column, its value must agree with `pk` —
     *  otherwise the read-set CAS checks one row while apply() writes another
     *  (row_insert), or an update silently reassigns the primary key (row_update). */
    private static function pk_consistent(array $op): bool
    {
        $pkCol = (string) $op['pkCol'];
        foreach (['new', 'old'] as $side) {
            if (isset($op[$side]) && is_array($op[$side]) && array_key_exists($pkCol, $op[$side])) {
                $value = $op[$side][$pkCol];
                if (!is_numeric($value) || (float) $value !== (float) $op['pk']) {
                    return false;
                }
            }
        }
        return true;
    }
```

`changes.ts` — in `validateOps`'s row-op branch, after the refused-table check:

```ts
      const pkCol = r.pkCol;
      if (typeof pkCol === 'string') {
        for (const side of ['new', 'old'] as const) {
          const row = r[side];
          if (row && typeof row === 'object' && pkCol in (row as Record<string, unknown>)) {
            const value = (row as Record<string, unknown>)[pkCol];
            if (Number(value) !== Number(r.pk)) throw new Error(`pk_mismatch: ${table}`);
          }
        }
      }
```

`journal.ts` — one comment line above `const pk = Number(row[pkCol]);` in `buildRowOp`:

```ts
  // pk is read from row[pkCol] itself — op.pk and new/old[pkCol] agree by construction.
```

- [ ] **Step 5: Run plugin + server + cli suites.** Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "fix: refuse row ops whose new/old pk column disagrees with pk (server + plugin)"`

---

### Task 13: afterReady ordering + rollback-route sync guard + retry guard tests

**Files:**
- Modify: `ferry-server/src/sync.ts` (`run()` success path, ~lines 85–89), `ferry-server/src/routes/changes.ts` (rollback route, ~line 74)
- Test: `ferry-server/tests/sync.test.ts`, `ferry-server/tests/changes-routes.test.ts` (add cases)

**Interfaces:** none new — ordering and guards only.

- [ ] **Step 1: Write the failing sync-ordering test** (append to `sync.test.ts`, using its existing stub-engine idiom):

```ts
  it('isRunning stays true while the afterReady hook runs; ready emits after it', async () => {
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
    const engine = stubEngine({
      pull: async () => ({ url: 'https://s.ddev.site' }),
      verifyClone: async () => ({ ok: true }),
    });
    const store = new Store(':memory:');
    const user = store.createUser('a@b.co', 'x:y')!;
    const site = store.createSite(user.id, 'S', 'https://example.com', 's')!;
    const sync = new SyncManager(store, engine, { afterReady: () => hookGate });
    const states: string[] = [];
    sync.subscribe(site, (s) => states.push(s.status));
    sync.start(site);
    await vi.waitFor(() => expect(store.siteById(site.id)!.status).toBe('ready'));
    expect(sync.isRunning(site.id)).toBe(true);     // hook still pending — turn starts stay blocked
    expect(states).not.toContain('ready');           // ready not emitted yet
    releaseHook();
    await vi.waitFor(() => expect(states).toContain('ready'));
    expect(sync.isRunning(site.id)).toBe(false);
  });

  it('a throwing afterReady hook still lands the sync as ready', async () => {
    const engine = stubEngine({
      pull: async () => ({ url: 'https://s.ddev.site' }),
      verifyClone: async () => ({ ok: true }),
    });
    const store = new Store(':memory:');
    const user = store.createUser('c@b.co', 'x:y')!;
    const site = store.createSite(user.id, 'S2', 'https://example2.com', 's2')!;
    const sync = new SyncManager(store, engine, { afterReady: async () => { throw new Error('hook boom'); } });
    const states: string[] = [];
    sync.subscribe(site, (s) => states.push(s.status));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sync.start(site);
    await vi.waitFor(() => expect(states).toContain('ready'));
    expect(sync.isRunning(site.id)).toBe(false);
    spy.mockRestore();
  });
```

(Adapt store/site seeding to the helpers `sync.test.ts` already uses; the assertions are the contract. Check whether the engine `pull` result shape in existing tests includes more fields — mirror it.)

- [ ] **Step 2: Run to verify failure** (first test: `isRunning` already false / `ready` already emitted while the hook pends).

- [ ] **Step 3: Implement in `sync.ts`.** The success path of `run()` becomes:

```ts
      const now = new Date().toISOString();
      this.store.setStatus(site.id, 'ready', { lastError: null, lastSyncAt: now, verifiedAt: now });
      // Issue #11: run the hook while isRunning() still reads true — its ~50ms git window
      // must not overlap a turn started the instant the ready emit lands. A hook failure
      // logs and the sync still lands as ready.
      if (this.opts.afterReady) {
        try {
          await this.opts.afterReady(site);
        } catch (err) {
          console.error('afterReady hook failed:', err);
        }
      }
      this.active.delete(site.id);
      this.emit(site.id, { status: 'ready', cloneUrl: result.url, verifiedAt: now, error: null });
```

(The old fire-and-forget line at the end disappears.)

- [ ] **Step 4: Write the failing rollback-guard test + retry guard tests** (append to `changes-routes.test.ts`, reusing its seed helpers — it already builds apps with scripted push runners and seeded changes):

- rollback: seed a `pushed` change, make `sync.isRunning(site.id)` true (start a sync with a never-resolving stub engine pull, the file's existing trick for busy-sync tests — check how the push-route sync-guard test does it and mirror that), POST `.../rollback` → 409 `{ error: 'A sync is running for this site.' }`.
- retry, five cases, each a seeded `conflict` change except where stated: (1) sync running → 409 `'A sync is running for this site.'`; (2) push in flight → 409 `'A push is in progress for this site.'`; (3) site status not `ready` → 409 `'Sync the site first.'`; (4) change status `draft` → 409 `'Only a conflicted change can be retried.'`; (5) app built without agents → 409 `'Agent chat is not available.'`. Assert the exact error strings — they are the route's contract.

- [ ] **Step 5: Implement the rollback guard** in `routes/changes.ts`, before the `isPushing` check:

```ts
    // 6a (#11): a rollback is a write-back call — refuse while a sync is rewriting the clone.
    if (sync.isRunning(site.id)) return reply.code(409).send({ error: 'A sync is running for this site.' });
```

- [ ] **Step 6: Run the full server suite + typecheck.** Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -am "fix(server): await afterReady before ready emit; sync guard on rollback; retry guard tests"`

---

### Task 14: Chat composer prefill — clear history state after consuming

**Files:**
- Modify: `ferry-dashboard/src/chat.tsx` (~lines 98–104)
- Test: `ferry-dashboard/e2e/changes.spec.ts` (extend the existing prefill assertion with a reload)

**Interfaces:** none — UI behavior only.

- [ ] **Step 1: Implement in `chat.tsx`.** Extend the react-router import with `useNavigate`, and add after the `draft` state:

```tsx
  const navigate = useNavigate();
  // Issue #11: consume-and-clear — the prefill must not survive in history state,
  // or a reload re-seeds the composer with the stale message.
  useEffect(() => {
    if ((location.state as { prefill?: string } | null)?.prefill) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);
```

(The `useState` lazy initializer keeps reading the prefill on mount — clearing afterwards doesn't blank the composer, it only strips the history record.)

- [ ] **Step 2: Extend the e2e.** Find the existing "Let the agent adjust it" / prefill assertion in `ferry-dashboard/e2e/changes.spec.ts`. After its composer-value assertion add:

```ts
    await page.reload();
    await expect(page.getByRole('textbox')).toHaveValue('');
```

(Adapt the locator to whatever the surrounding test uses for the composer.)

- [ ] **Step 3: Run** — `npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run e2e` (e2e needs the paired fixture running — see runbook preflight; `ddev stop --unlist ferry-prod-ddev-site` if the gate complains about a stale project root). Expected: PASS (18 + extended assertions).

- [ ] **Step 4: Commit** — `git commit -am "fix(dashboard): clear composer prefill from history state after consuming"`

---

### Task 15: Proof runbook + full gate

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-ferry-plan6a-proof-runbook.md`

**Interfaces:** none — documentation + verification.

- [ ] **Step 1: Write the runbook** with these sections (concrete commands + expected output, filled in while executing them against the dev server on :4000 with the paired fixture):

1. **Preflight**: branch `feat/hardening`; `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` exported in the same shell; dev server started; fixture note — update the fixture's `ferry-connect` plugin from this branch first (Task 5 changed `Auth.php`/`Routes.php`), same procedure as the 5a runbook.
2. **Proof 1 — login/signup 429**: 11 wrong-password `curl` POSTs to `/api/auth/login` print `401 ×10` then `429` with a `Retry-After` header.
3. **Proof 2 — plugin pairing lockout**: `ddev wp ferry pair` issues a code (does NOT touch `ferry_secret` — the fixture stays paired); 5 wrong-code POSTs to `https://<fixture>/wp-json/ferry/v1/pair`; the 5th returns `ferry_pairing_locked`; `ddev wp option get ferry_pairing` errors (option gone); a fresh `ddev wp ferry pair` still prints a code. **Never POST the real code — that would rotate the fixture's secret.**
4. **Proof 3 — server pair-route cap**: on a throwaway site record, 6 pair attempts with a bogus code → 5× 400, then 429.
5. **Proof 4 — SIGTERM drain**: `curl -N` on `/api/sites/:id/sync/events` (with a session cookie), `kill -TERM <pid>` → the curl output ends with `event: shutdown`, server log shows the signal line, process exits 0 well under 15s.
6. **Proof 5 — generic 500**: temporarily rename the site's clone directory away, POST `/api/sites/:id/agent/messages` → response body is exactly `{"error":"Internal server error"}` while the server log shows the stack; restore the directory.
7. **Proof 6 — hashed sessions + purge**: `sqlite3 ~/.ferry/server.db "SELECT token_hash, expires_at FROM sessions"` shows only 64-hex values; insert a row with `expires_at` in the past via sqlite3, restart the server, row is gone (boot purge).
8. **Suites at HEAD**: record the four suite counts + typechecks (now incl. `ferry-cli run typecheck`).

- [ ] **Step 2: Execute every proof, paste real transcripts into the runbook.** Any failure: STOP, fix via the normal task flow, re-run.

- [ ] **Step 3: Full gate** — `npm --workspace ferry-cli run test && npm --workspace ferry-server run test && cd ferry-plugin && vendor/bin/phpunit && cd .. && npm --workspace ferry-cli run typecheck && npm --workspace ferry-server run typecheck && npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run e2e`. Expected: all green.

- [ ] **Step 4: Commit** — `git add docs && git commit -m "docs: Plan 6a proof runbook with executed transcripts"`

- [ ] **Step 5 (post-merge, human-gated):** after Robbert's sign-off and merge, tick the shipped items in issues #9/#11 with a comment, including: "#16 cleanup bundle: unrecoverable — no record survived the SDD workspace deletion; the 6a whole-branch review served as the fresh polish pass." Items that remain open after 6a: issue #9's per-card file scoping (shipped in 5b), issue #11's `reduceSteps` unit net (parked, needs a dashboard unit framework).

---

## Plan self-review (done at authoring time)

- **Spec coverage:** §3.1 → Task 1; §3.2 → Task 2; §3.3 → Tasks 6+7; §3.4 → Tasks 3+4+5; §3.5 → Tasks 8 (refusals + typecheck), 9+10 (rollback pair), 11 (staging/excludes), 12 (pk), 13 (retry tests); §3.6 → Tasks 13 (afterReady, rollback guard) + 14 (prefill); §4 gate → Task 15. #16 disposition → Task 15 step 5. Spec's "cheap assert in buildRowOp": satisfied by construction, comment added (Task 12) — deliberate deviation, documented.
- **Type consistency:** `Lifecycle`/`refuseDuringShutdown` (Task 6) match Task 7's imports; `RateLimiter.hit/limitedFor/clear` (Task 3) match Task 4's usage; `applyError` shape `{key, detail}` identical in Tasks 9/10; `purgeTimer` name shared between Tasks 2 and 7; `isPushingAny` defined in Task 7 before its only use (wiring line explicitly deferred to Task 7 to keep Task 6 compiling standalone).
- **Placeholder scan:** Task 10 Step 2 and Task 13 Step 4 describe tests against existing in-file helpers by contract (exact inputs, exact asserted strings) rather than inventing helper code that may not match — deliberate; the implementer must mirror the neighbouring idiom. No TBDs remain.
