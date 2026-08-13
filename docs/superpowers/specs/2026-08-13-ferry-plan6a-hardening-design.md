# Ferry Plan 6a — hardening bundle (design)

Date: 2026-08-13. Signed-off decisions from the brainstorm session with Robbert are marked **[decision]**.

## 1. Context and scope

Plan 6 (roadmap `docs/superpowers/plans/2026-07-24-ferry-roadmap.md` §Plan 6) is split in two **[decision]**:

- **6a (this spec): hardening bundle** — small, well-understood fixes with their own gate. Merged first.
- **6b: isolation** — Firecracker microVM per site, VM-level egress, stub proxy, re-enabled agent web tools, and moving the agent-reachable write secret out (the secret's new home depends on the VM boundary, so it belongs to 6b). 6b starts with a phase-0 spike (Firecracker needs Linux/KVM; dev machine is macOS).

Explicitly **out of Plan 6 entirely** (deferred to Plan 7+) **[decision]**: DB refresh via block fingerprints / Merkle tree / warm standby, and the business layer (billing, audit log, monitoring, onboarding).

6a scope **[decision]**:

1. Fastify error handler (500s currently leak `err.message`)
2. Session hardening: hashed tokens + expired-session purge
3. SSE-aware graceful shutdown
4. Auth rate limiting: pairing **and** login/signup (one minimal primitive)
5. All non-UI issue #9 items + issue #11 items **except** the `reduceSteps` unit-test net (needs a dashboard unit-test framework, deliberately avoided in 5b — stays parked)
6. Cleanup bundle "(#16)": **unrecoverable** — no record survived the Plan 5a SDD workspace deletion (verified: not a GitHub issue, not in docs/, not in git history, not in transcripts). Disposition: check it off in issue #9 with an "unrecoverable" note; the 6a whole-branch final review serves as the fresh polish pass.

The `secure` cookie flag is **not** in 6a: per standing agreement it lands in whichever plan first deploys behind TLS, which is 6b (the Linux VM host) **[decision]**.

Non-goals: no pino/logger adoption, no `@fastify/rate-limit` dependency, no persistent (SQLite) rate-limit state, no dashboard unit-test framework, no multi-process concerns (server is single-process by design).

## 2. Current state (verified 2026-08-13, main @ a3e1fd5)

- **No `setErrorHandler`** anywhere; Fastify's default serializes `err.message` to the client on every uncaught throw. Live throw paths: `routes/sync.ts:30`, `routes/changes.ts:61,78,107`, `routes/agent.ts:22,29`, `store.ts:196,255,293`. Logging is `console.*` only; a 500 leaves no request-scoped server record.
- **Sessions**: `sessions(token TEXT PRIMARY KEY, user_id, expires_at)` — the raw bearer token is stored plaintext (`store.ts:112-116`). Token itself is strong (`randomBytes(32)` base64url). Expiry (30d) is enforced only at read time; **no purge exists**. Cookie: `httpOnly, sameSite:lax, path:/, maxAge` — no `secure` (6b).
- **SSE**: three routes, all `reply.hijack()` + manual writes + 15s heartbeat: sync `routes/sync.ts:35-53`, agent `routes/agent.ts:44-84`, push `routes/changes.ts:129-164`. **No shutdown handling at all**: no signal handlers, no `app.close()`, no `store.close()` caller. Ctrl-C severs hijacked sockets mid-write; recovery is entirely boot-side (`recoverInterruptedSyncs`, `recoverInterruptedAgentSessions`, `push.recover()`).
- **Pairing**: the code is minted and held by the **plugin** (`Auth.php`: 8 chars from a 30-symbol alphabet ≈ 39.3 bits, TTL 600s, single-use). Plugin `POST /ferry/v1/pair` is unauthenticated with no attempt limit, and a failed attempt leaves the code intact. Server `POST /api/sites/:id/pair` is session-gated but unlimited, and every attempt drives a real outbound HTTP request to the operator-supplied `site.url`. Login (`routes/auth.ts:26-35`) allows unlimited password guesses, each running a full scrypt.

## 3. Design

### 3.1 Fastify error handler

`app.setErrorHandler` in `app.ts`:

- **5xx (or no `statusCode` on the error)**: respond `500 { error: 'Internal server error' }` — never the error message. Log one request-scoped line via `console.error`: method, URL, and the full error (stack included).
- **4xx**: pass through unchanged (Fastify validation errors and any deliberate `statusCode < 500` throws keep their message).
- Deliberately curated raw-message responses stay as-is: `sites.ts:66-71` (pair 400/422 with engine/link message) and `sites.ts:92-96` (test 502 + security-plugin hint) are product UX, not leaks — they are `reply.send` paths, not thrown errors, so the handler doesn't touch them anyway.

Tests: a route that throws returns generic body (no `err.message` substring) and the log line contains the stack; a 4xx validation error keeps its message.

### 3.2 Session hardening

- **Storage**: replace the plaintext token PK with `token_hash TEXT PRIMARY KEY` = hex SHA-256 of the token. `createSession`/`userForSession`/`deleteSession` hash the cookie value at the boundary (`store.ts`); the cookie keeps carrying the raw token. No pepper/HMAC — SHA-256 of a 256-bit random token is preimage-proof; there is nothing to brute-force.
- **Migration**: on boot, if the `sessions` table has a `token` column (PRAGMA table_info), DROP and recreate with the new schema. All existing sessions invalidate once; acceptable pre-launch **[decision]**.
- **Purge**: `store.purgeExpiredSessions()` (`DELETE FROM sessions WHERE expires_at <= now`) at boot and on an hourly `setInterval` (`.unref()`, cleared on shutdown).

Tests: after signup/login the raw token does not appear in the DB (raw SQLite query); hashed lookup authenticates; expired rows are deleted by the purge; logout still deletes by hash.

### 3.3 SSE-aware graceful shutdown

New in `main.ts` + a small seam in `app.ts`:

- **SSE registry**: each of the three SSE routes registers its connection (an `end()` closure that writes a final `event: shutdown` frame, clears its heartbeat interval, and ends the socket) and deregisters on client close. Lives in `AppDeps` so tests can reach it. This is required because `app.close()` cannot see hijacked sockets.
- **Signal handling**: on first SIGINT/SIGTERM:
  1. flip a `shuttingDown` flag — mutating routes that *start* work (sync, push, rollback, retry, agent send/new-session, pair) return `503 { error: 'Server is shutting down.' }`;
  2. close all registered SSE connections (terminal frame → end);
  3. wait up to **10s** for an in-flight push/rollback to finish (the two-phase-commit window is the one thing worth draining); in-flight **syncs and agent turns are not awaited** — they are resumable by design and boot recovery already handles them;
  4. `await app.close()`, `store.close()`, clear the purge interval, exit 0.
  A second signal exits immediately (code 130); a hard deadline of 15s force-exits if anything hangs.
- Dashboard is unchanged: `EventSource` auto-retry already handles the disconnect; the terminal frame just makes it clean instead of severed.

Tests: integration test on an ephemeral `listen` port — open a real SSE stream, invoke the shutdown routine directly (not via kill), assert the client receives the shutdown frame, the socket ends, `app.close()` resolves, and a start-work route returned 503 during the drain.

### 3.4 Auth rate limiting

One tiny fixed-window primitive in `ferry-server` (`RateLimiter`: `Map<key, {count, resetAt}>`, lazy cleanup, constants adjustable), applied to three surfaces **[decision]**:

1. **Plugin `POST /ferry/v1/pair`** (the security-skim acceptance being closed): a failed-attempt counter stored *in* the `ferry_pairing` option. Each failed `hash_equals` increments it; at **5 failures the option is deleted** — the code dies, exactly like TTL expiry, and a fresh code is issued through the existing paths (activation banner / WP-CLI). Lockout response: `403 pairing_locked` ("Too many attempts — issue a new code."). No IP tracking (unreliable behind proxies, needless state); the code itself is the natural rate-limit key. `update_option` is not atomic — a small race around the threshold is acceptable for a brute-force limiter. Zero-dep native PHP, matching the plugin constraint.
2. **Server `POST /api/sites/:id/pair`**: max **5 attempts per site per 10 min** → `429`. Caps the outbound request pump toward operator-supplied URLs.
3. **Login/signup** (`POST /api/auth/login`, `/api/auth/signup`): login counts **failures** per `account+IP` key, **10 per 15 min** → `429`, cleared on success (also caps self-inflicted scrypt CPU burn); signup counts attempts per IP, **10 per 15 min** → `429`.

429 responses carry `{ error: 'Too many attempts. Try again later.' }` + `Retry-After`. In-memory only: the server is single-process and restart-resets are acceptable **[decision]**.

Tests: `RateLimiter` unit tests (window roll-over, clear-on-success); route tests asserting 429 after N and recovery after the window; PHPUnit tests for the plugin counter (increment, lockout deletes option, success path unaffected, expiry semantics unchanged).

### 3.5 Issue #9 fold-ins (non-UI)

| Item | Fix |
|---|---|
| Refusal-list drift (3 copies: `ferry-cli/src/journal.ts:103-108`, `ferry-server/src/changes.ts:28-41`, `ferry-plugin/src/DbOps.php:22-23`) | Single TS source `ferry-cli/src/refusals.ts`; `journal.ts` and `ferry-server/changes.ts` import it (the server already imports engine source from ferry-cli). journal.ts's compare becomes case-insensitive like the other two (it is the odd one out today). PHP stays a separate copy (zero-dep, no build step) but a Node parity test parses `DbOps.php`'s constants and asserts semantic equivalence (tables, prefixes/patterns, case behavior). |
| Idempotent rollback (`Commit.php:217-294` wedges a second rollback to `dirty`) | Early-return `{rolled_back: true}` when meta status is already `rolled_back`, before any status write. |
| `/rollback` `apply_error` parity | `Commit::rollback` propagates `apply_error` like `Commit::run` does; CLI `push.ts` rollback path and `PushManager.rollback` distinguish it from conflicts (mirroring the commit path at `push-manager.ts:134-145`), so an apply failure no longer lands as an empty conflict card. |
| Staging-prune `touch()` symmetry | `Staging::add` touches the tx staging dir after each batch, mirroring the backup-dir touches (`Commit.php:99,259`), so resumed multi-batch stages don't age toward the 30-day prune. |
| `/retry` ready-guard tests | Route tests covering each 409 guard in `changes.ts:102-106` (sync running / pushing / site not ready / change not conflict / no agents). Test-only. |
| Excludes case alignment | `Excludes::PREFIXES` matching becomes case-insensitive (`stripos`), aligning the read side with the write-side guard (`Paths.php:95-107` lowercases everything *except* the delegated Excludes call). Test with an uppercase-variant path. |
| ferry-cli `typecheck` script | `"typecheck": "tsc -p tsconfig.json --noEmit"` — CI-greppable like the other workspaces. |
| `pk` / `new[pkCol]` cross-check | Reject row ops where `new[pkCol]` (or `old[pkCol]`) is present and ≠ `pk`, in both server `validateOps` (`changes.ts:51-62`) and plugin `DbOps` validation — closes the CAS-one-row-write-another hole for `row_insert` and the `SET pkCol = …` reassignment for `row_update` (PK reassignment is refused outright; the binlog journal never produces it). Cheap assert in `journal.ts` `buildRowOp` too. |

### 3.6 Issue #11 fold-ins

| Item | Fix |
|---|---|
| `afterReady` pre-emit hardening | In `SyncManager.run`, await the hook (own try/catch, failure logged, sync still succeeds) **before** `active.delete` + the ready emit, so `sync.isRunning` covers the hook's git window. |
| Rollback route sync guard | `routes/changes.ts:66-80` gains `sync.isRunning(site.id)` → 409, consistent with the push route. |
| Chat composer prefill persists | `chat.tsx` clears history state after consuming the prefill (`navigate(pathname, { replace: true, state: null })` in an effect), so reload no longer re-seeds the composer. |

`reduceSteps` pending-guard unit net: stays parked (no dashboard unit framework) **[decision]**.

## 4. Gate **[decision]**

Green suites + typechecks (plugin / cli incl. new typecheck / server / dashboard e2e) **plus a short proof runbook** (`docs/superpowers/plans/2026-08-13-ferry-plan6a-proof-runbook.md`, written with the implementation) demonstrating live:

1. **Rate limit**: scripted login attempts hit 429 after the threshold; plugin pairing code dies after 5 bad attempts (and a fresh code still pairs); pair-route cap returns 429.
2. **Shutdown**: SIGTERM with an open SSE stream → client sees the shutdown frame, process exits cleanly well under the 15s deadline.
3. **Error handler**: an induced 500 returns the generic body while the server log shows the stack.
4. **Sessions**: raw SQLite query shows only hashes; a seeded expired row is gone after purge.

Process: fresh branch off `main`, subagent-driven development with per-task adversarial reviews (as 5a/5b), 6a merges before the 6b brainstorm starts **[decision]**.

## 5. Standing constraints (unchanged, restated)

Plugin stays native PHP, zero dependencies, no command execution, versioned REST namespace. `wp-config.php` never crosses the bridge; multisite refused. Timeouts are answers. DB content is never pushed; typed ops only. Nothing reaches production without one human click; rollback button stays visible.
