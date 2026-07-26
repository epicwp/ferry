# Ferry Plan 5a — Write-back Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The full write-back path without UI: nonce-hardened auth, plugin write endpoints (stage / commit / rollback / hashes / tx), binlog→typed-ops journal in the clone, engine `push()` with drift detection + smoke test + automatic rollback, agent change-creation tools, and a server `PushManager` + `/changes` API — accepted via an API-level runbook against the real fixture.

**Architecture:** Spec = `docs/superpowers/specs/2026-07-26-ferry-plan5-write-back-design.md` (BINDING — read it before any task). The plugin stays a dumb typed transport (no exec); the engine (ferry-cli package) owns orchestration; ferry-server wraps it behind `requireUser` routes with SSE streaming and a `PushRunner` test seam mirroring `AgentRunner`.

**Tech Stack:** PHP 7.2+ (plugin, PHPUnit 9, zero runtime deps) · TypeScript/Node (ferry-cli: undici, vitest; ferry-server: fastify, better-sqlite3, vitest) · DDEV MariaDB binlog · git.

## Global Constraints

- Branch: `feat/write-back` (exists). Commit after every task; message prefixes `feat:`/`fix:`/`test:`/`docs:`.
- Plugin: native PHP, **zero external dependencies, no command execution**, namespace stays `/ferry/v1`.
- `wp-config.php` never crosses the bridge — write denylist is `wp-config*` (pattern; covers `.bak` copies).
- DB content never pushed: typed ops only; content tables (`posts`, `comments`, `commentmeta`, `users`, `usermeta`, and any table matching `woocommerce_*`, `wc_*`, `actionscheduler_*`) and all DDL are **refused**.
- Multisite refused on every write endpoint (same error/message shape as `/pair`).
- Timeouts are answers: `/stage` is resumable; `/commit` is single-shot but bounded (refuse > 200 files).
- Nothing pushes without a human action: the agent gets `db_journal` + `create_change` only — no push tool.
- All suites green after every task: `npm --workspace ferry-cli test` (93+), `npm --workspace ferry-server test` (86+), `composer --working-dir=ferry-plugin test` (PHPUnit), plus `npm run typecheck` in both TS workspaces. CI never needs credentials — every test uses fakes.
- The staged-blob rule: nothing web-executable in staging/backup — blobs are `<sha256>.bin`, dirs get `index.php` + deny `.htaccess`.
- Security: checkpoint B of `docs/2026-07-26-ferry-plugin-security-skim.md` runs on this branch before merge (human step; do not mark the final task complete without flagging it).

## Shared wire types (referenced by every task; defined in Task 6/10 code)

```ts
// ferry-cli/src/push-types.ts (created in Task 10)
export type DbOp =
  | { kind: 'option_set'; name: string; old: string | null; new: string }      // old null = absent before
  | { kind: 'option_delete'; name: string; old: string }
  | { kind: 'postmeta_set'; postId: number; key: string; old: string | null; new: string }
  | { kind: 'postmeta_delete'; postId: number; key: string; old: string }
  | { kind: 'row_update'; table: string; pkCol: string; pk: number; old: Record<string, string | null>; new: Record<string, string | null> }
  | { kind: 'row_insert'; table: string; pkCol: string; pk: number; new: Record<string, string | null> }
  | { kind: 'row_delete'; table: string; pkCol: string; pk: number; old: Record<string, string | null> };
export type RiskClass = 'low' | 'higher' | 'refused';
export type Precondition =
  | { type: 'option'; name: string; expected: string | null }
  | { type: 'file_hash'; path: string; expected: string }                       // sha256 hex
  | { type: 'row'; table: string; pkCol: string; pk: number; column: string; expected: string | null };
export interface SmokeCheck { label: string; path: string; expectStatus: number; expectText?: string }
export interface ChangeFile { path: string; newHash: string | null; oldHash: string | null } // newHash null = delete; oldHash null = new file
export interface ChangeSpec { files: ChangeFile[]; ops: DbOp[]; preconditions: Precondition[]; smoke: SmokeCheck[] }
export type PushStep = 'staging' | 'hashes' | 'drift' | 'swap' | 'journal' | 'smoke';
export interface StepEvent { step: PushStep; status: 'start' | 'ok' | 'fail'; detail?: string; durationMs?: number }
export interface Conflict { key: string; expected: string; found: string }
export type PushOutcome =
  | { status: 'pushed'; txid: string; smoke: { label: string; ok: boolean; detail: string }[] }
  | { status: 'conflict'; txid: string; conflicts: Conflict[] }
  | { status: 'rolled_back'; txid: string; reason: string; smoke?: { label: string; ok: boolean; detail: string }[] };
```

The PHP side mirrors `DbOp`/`Precondition` as associative arrays with the same keys. Plugin `/commit` response body:
`{ committed: bool, steps: [{name, ok, durationMs}], conflicts: [{key, expected, found}] }`.

---

### Task 1: Binlog spike → pins doc + parser fixtures

**Files:**
- Create: `docs/superpowers/specs/2026-07-26-binlog-pins.md`
- Create: `ferry-cli/test-fixtures/binlog/update-option.txt`, `insert-postmeta.txt`, `delete-row.txt` (captured `mysqlbinlog` output)

No product code. Run against the existing running clone `ferry-prod-ddev-site` (`~/.ferry/clones/ferry-prod-ddev-site`).

- [ ] **Step 1: Enable binlog on the clone**

Write `.ddev/mysql/ferry-binlog.cnf` in the clone dir:

```ini
[mysqld]
log-bin=ferry-bin
binlog-format=ROW
binlog-row-image=FULL
server-id=1
expire-logs-days=14
```

Run: `ddev restart` in the clone dir. Verify: `ddev mysql -e "SHOW VARIABLES LIKE 'log_bin'"` → `ON`.

- [ ] **Step 2: Pin position + extraction commands**

Record which of these works on this MariaDB (10.x): `SHOW MASTER STATUS` vs `SHOW BINLOG STATUS`. Then make three writes via `ddev wp option update ferry_spike_opt hello`, a postmeta add, a row delete on a throwaway table, and extract:

```
ddev exec "mysqlbinlog --no-defaults --base64-output=decode-rows -v \
  --start-position=<pos> /var/lib/mysql/ferry-bin.000001"
```

Pin: the binlog file path inside the container, whether `--start-position` + file name from the recorded status tuple suffices, and whether events carry `@1=` ordinals (expected with `-v`) — column *names* are absent; the parser maps ordinals via `SHOW COLUMNS`.

- [ ] **Step 3: Capture fixtures**

Save the raw `mysqlbinlog` output covering one `### UPDATE` on `wp_options`, one `### INSERT` on `wp_postmeta`, one `### DELETE` into the three fixture files (trim unrelated events; keep headers the parser must skip).

- [ ] **Step 4: Write the pins doc**

`docs/superpowers/specs/2026-07-26-binlog-pins.md` records: exact cnf, restart requirement, status statement variant, container binlog path, extraction command, fixture provenance, and any deviation from the design doc's assumptions. If a design assumption breaks (e.g. `mysqlbinlog` missing in the container), STOP and escalate to the human before Task 10.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-26-binlog-pins.md ferry-cli/test-fixtures/binlog/
git commit -m "docs: pin binlog mechanics for the write-back journal (spike)"
```

---

### Task 2: Nonce — plugin side

**Files:**
- Modify: `ferry-plugin/src/Auth.php` (canonical/sign/verify gain a nonce argument)
- Create: `ferry-plugin/src/Nonces.php`
- Modify: `ferry-plugin/src/Routes.php:30-47` (`authorize`)
- Test: `ferry-plugin/tests/NonceTest.php`; update `ferry-plugin/tests/AuthTest.php`

**Interfaces:**
- Produces: `Auth::canonical(string $method, string $route, array $query, string $body, int $timestamp, string $nonce): string` (nonce = 6th `\n`-joined line); `Auth::sign(...same...)`; `Auth::verify(string $secret, string $method, string $route, array $query, string $body, $timestamp, $signature, $nonce, int $now): bool`; `Nonces::consume($wpdb, string $prefix, string $nonce, int $now): bool` (true = fresh, false = replay/invalid).
- Consumes: nothing new.

- [ ] **Step 1: Write failing tests**

In `NonceTest.php` (use/extend `tests/helpers/FakeWpdb.php` — give it an in-memory `options` map keyed by `option_name` whose `insert()` returns `false` on duplicate, mirroring the real UNIQUE index):

```php
public function test_fresh_nonce_consumed_once(): void {
    $wpdb = new FakeWpdb();
    $n = str_repeat('ab', 16); // 32 hex chars
    $this->assertTrue(Nonces::consume($wpdb, 'wp_', $n, 1000));
    $this->assertFalse(Nonces::consume($wpdb, 'wp_', $n, 1010)); // replay
}
public function test_malformed_nonce_rejected(): void {
    $wpdb = new FakeWpdb();
    $this->assertFalse(Nonces::consume($wpdb, 'wp_', 'short', 1000));
    $this->assertFalse(Nonces::consume($wpdb, 'wp_', str_repeat('z', 32), 1000)); // non-hex
}
public function test_expired_nonces_pruned(): void { /* insert row at t=1000, consume at t=1200, assert old row deleted (prune window 120s) */ }
```

In `AuthTest.php`, update every canonical/sign/verify call to pass a nonce and assert the canonical ends with `"\n" . $nonce`. Keep one explicit vector shared with Task 3 (same inputs → same hex signature on both sides):

```php
public function test_cross_parity_vector(): void {
    $sig = Auth::sign('s3cret', 'POST', '/ferry/v1/commit', ['a' => 'b'], '{"x":1}', 1753500000, 'aabbccddeeff00112233445566778899');
    $this->assertSame('<fill from first run; Task 3 asserts the identical constant>', $sig);
}
```

- [ ] **Step 2: Run tests, verify failure** — `composer --working-dir=ferry-plugin test` → NonceTest fails (class missing), AuthTest fails (argument count).

- [ ] **Step 3: Implement**

`Nonces.php`:

```php
<?php
namespace Ferry;

/** §4.5 nonce check: replay protection for the write-capable plugin. Storage is one
 *  options row per nonce; the UNIQUE index on option_name makes consume atomic. */
final class Nonces
{
    const WINDOW = 120; // seconds kept; > 2x the 60s signature window

    public static function consume($wpdb, string $prefix, string $nonce, int $now): bool
    {
        if (!preg_match('/\A[0-9a-f]{32}\z/', $nonce)) {
            return false;
        }
        // prune first so the table cannot grow unboundedly
        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$prefix}options WHERE option_name LIKE %s AND option_value < %d",
            'ferry_nonce_%', $now - self::WINDOW
        ));
        $inserted = $wpdb->insert("{$prefix}options", [
            'option_name'  => 'ferry_nonce_' . $nonce,
            'option_value' => (string) $now,
            'autoload'     => 'no',
        ]);
        return $inserted !== false; // false = duplicate key = replay
    }
}
```

`Auth.php`: append `"\n" . $nonce` in `canonical()`; thread the parameter through `sign()`/`verify()`; in `verify()` reject empty/non-string nonce before signing. `Routes::authorize`: read `$request->get_header('X-Ferry-Nonce')`, pass to `Auth::verify`, and after a valid signature call `Nonces::consume($wpdb, $wpdb->prefix, $nonce, time())` — on false return `new \WP_Error('ferry_replay', 'Request nonce already used or invalid.', ['status' => 401])`.

- [ ] **Step 4: Run tests, verify pass.** Fill the parity-vector constant from the first run output.

- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): nonce check in signed auth (base doc §4.5) — precondition for write endpoints"`

---

### Task 3: Nonce — CLI side (coordinated signing change)

**Files:**
- Modify: `ferry-cli/src/signing.ts` (canonical/sign gain `nonce` param)
- Modify: `ferry-cli/src/client.ts:75-128` (`send()` generates a fresh nonce **per attempt** and sends `x-ferry-nonce`)
- Test: `ferry-cli/src/signing.test.ts` (or the existing signing test file — find with `grep -rl canonical ferry-cli/src/*.test.ts`)

**Interfaces:**
- Produces: `canonical(method, route, query, body, timestamp, nonce)`, `sign(secret, method, route, query, body, timestamp, nonce)`; `FerryClient` unchanged externally.
- Consumes: Task 2's canonical format (6th line = nonce).

- [ ] **Step 1: Failing tests** — update signing tests for the new arity; add the **same cross-parity vector as Task 2** (identical inputs, assert the identical hex constant) and a client test asserting: two consecutive `send()` attempts use different nonces (stub `undici.request` to 503 once then 200, capture headers — follow the existing client test's stubbing pattern).

- [ ] **Step 2: Run** `npm --workspace ferry-cli test` → fails.

- [ ] **Step 3: Implement** — `signing.ts` appends `\n${nonce}`; `client.ts` inside the attempt loop:

```ts
const nonce = randomBytes(16).toString('hex'); // fresh per attempt: a retried request must not replay its own nonce
// ...headers:
'x-ferry-nonce': nonce,
'x-ferry-signature': sign(this.secret, method, route, query, body, timestamp, nonce),
```

- [ ] **Step 4: Run tests + typecheck both workspaces** (ferry-server imports signing transitively). Expected: green.

- [ ] **Step 5: Commit** — `git commit -m "feat(cli): nonce joins the HMAC canonical — coordinated with plugin (no customers; fixture updates plugin from this branch)"`

---

### Task 4: verifyClone — instrument first, then bounded retry

**Files:**
- Modify: `ferry-server/src/engine.ts:34-43`, `ferry-server/src/sync.ts:80` (error detail)
- Test: `ferry-server/src/engine.test.ts` (create if absent)

**Context (read before coding):** Plan 4 tried a plain retry loop here; it passed tests but **7+ live syncs still failed identically** while direct `tsx` calls succeeded — root cause never found, fix reverted. Leading hypothesis: the `catch {return false}` swallows a TLS trust error — `NODE_EXTRA_CA_CERTS` only takes effect at Node **process start**, the runbook exports it per-shell, and a dev server started without it fails every mkcert-HTTPS check (matching "always fails in server, works in test shells"). A retry cannot fix that; visibility can.

**Interfaces:**
- Produces: `verifyClone(url): Promise<{ ok: boolean; detail?: string }>` — **signature changes**; `sync.ts` uses `.ok` and surfaces `.detail` in the site error.

- [ ] **Step 1: Failing tests** — inject the HTTP layer: refactor `verifyClone` to accept an optional `fetchFn` (defaults to undici `request`) via `realEngine({ verifyFetch? })`. Tests: (a) 200+HTML → `{ok:true}`; (b) 502, 502, then 200 within budget → `{ok:true}` (fake timers or 3-attempt fake); (c) persistent `Error("unable to get local issuer certificate")` → `{ok:false, detail:` contains `"local issuer"` and the hint `"NODE_EXTRA_CA_CERTS"`}`; (d) persistent 502 past deadline → `{ok:false, detail:` contains `"502"`}.

- [ ] **Step 2: Run** → fail.

- [ ] **Step 3: Implement**

```ts
async verifyClone(url) {
  const deadline = Date.now() + 30_000;
  let last = '';
  for (;;) {
    try {
      const res = await verifyFetch(url, { maxRedirections: 3 });
      const body = await res.body.text();
      if (res.statusCode === 200 && /<html/i.test(body)) return { ok: true };
      last = `HTTP ${res.statusCode}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      if (/certificate|CERT|issuer/i.test(last)) {
        return { ok: false, detail: `TLS trust failure: ${last}. The server process must start with NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" — it cannot be set after boot.` };
      }
    }
    if (Date.now() >= deadline) return { ok: false, detail: `clone did not answer within 30s (last: ${last})` };
    await new Promise((r) => setTimeout(r, 2_000)); // DDEV's restart window is ~5s; 2s polls cover it
  }
}
```

`sync.ts:80`: `const verified = await this.engine.verifyClone(result.url);` → use `verified.ok`; on failure include `verified.detail` in the stored `lastError` (this is the instrumentation Plan 4 lacked).

- [ ] **Step 4: Run ferry-server suite** → green.

- [ ] **Step 5: LIVE validation (the step Plan 4's fix never passed):** with the fixture running, start the dev server **without** `NODE_EXTRA_CA_CERTS`, trigger a sync of the paired site, and confirm the sync error now *names* the TLS cause (or, if it passes, the hypothesis was wrong — record what `detail` says in the task report). Then start it with the export and confirm sync verifies. Update the dev-server line in the plan-4 runbook style docs if the hypothesis confirms: `NODE_EXTRA_CA_CERTS` belongs in the documented dev command, not just the e2e prelude.

- [ ] **Step 6: Commit** — `git commit -m "fix(server): verifyClone reports its failure cause and retries through DDEV's restart window"`

---

### Task 5: Server fold-ins — runner_error redaction + agent_events index

**Files:**
- Modify: `ferry-server/src/agent/manager.ts:167-169`, `ferry-server/src/store.ts` (SCHEMA)
- Test: extend the existing manager test file (`grep -l runner_error ferry-server/src/agent/*.test.ts`) and `ferry-server/src/store.test.ts`

- [ ] **Step 1: Failing tests** — (a) manager: on `runner_error`, the persisted `status` event's `detail` equals the generic copy `'The agent hit an internal error — try again or start a new session.'` and does NOT contain the raw message; a `console.error` spy received the raw message with site/session ids. (b) store: `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_events_session'` returns a row on a fresh store.

- [ ] **Step 2: Run** → fail.

- [ ] **Step 3: Implement** — manager case `'runner_error'`: `console.error(\`agent runner error (site ${siteId}, session ${sessionId}):\`, event.message);` then persist the generic detail. store SCHEMA += `CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);` (IF NOT EXISTS makes existing DBs pick it up on boot — same idempotent pattern as the tables).

- [ ] **Step 4: Run suite** → green. **Step 5: Commit** — `git commit -m "fix(server): redact runner errors from customer SSE (log server-side) + index agent_events by session"`

---

### Task 6: Plugin path guard extraction + write denylist

**Files:**
- Create: `ferry-plugin/src/Paths.php`
- Modify: `ferry-plugin/src/Routes.php:136-151,177-191` (files/send_range use `Paths::resolve_read`)
- Test: `ferry-plugin/tests/PathsTest.php`

**Interfaces:**
- Produces: `Paths::resolve_read(string $root, string $relpath)` → resolved rel path or `null` (traversal/excluded — current `/files` semantics, unchanged); `Paths::check_write(string $root, string $relpath): ?string` → error code string or `null` when writable. Write denylist (checked on the **normalized target** path, case-insensitive basename match for wp-config): basename matches `wp-config*` · path starts with the ferry plugin's own dir (`dirname(plugin_basename(...))`, hardcode `ferry-connect/` and the actual dir name found in the repo) · contains `.ferry-staging` or `.ferry-backup` · starts `wp-content/mu-plugins/ferry-` · is excluded by `Excludes::excluded` (uploads/caches/backups never crossed the bridge).
- Consumes: `Excludes::excluded/allowed_upload` (existing).

- [ ] **Step 1: Failing tests** — `PathsTest.php` with a temp dir: read guard behavior identical to today (traversal `..`, absolute, symlink-out, excluded file each → null; normal path → resolved). Write guard: `wp-config.php`, `wp-config.php.bak`, `WP-CONFIG-old.php`, `wp-content/plugins/ferry-connect/ferry.php`, `wp-content/uploads/.ferry-staging/x/y.bin`, `wp-content/mu-plugins/ferry-overlay.php`, `wp-content/uploads/2026/a.jpg` → error codes; `wp-content/themes/t/functions.php` (not yet existing on disk = create) → null. Note: `check_write` must NOT require the target to exist (new files) — it normalizes lexically (reject `..`, `\`, NUL, leading `/`) and realpath-checks the nearest existing ancestor stays under `$root`.

- [ ] **Step 2: Run** → fail. **Step 3: Implement** `Paths.php` (~60 lines; move the shared realpath+prefix logic out of `Routes::files`/`send_range` and call it from both — behavior-preserving for reads). **Step 4: Run full plugin suite** (regression on files/send_range tests). **Step 5: Commit** — `git commit -m "feat(plugin): shared path guard + write-side denylist (wp-config* pattern, self-dir, ferry artifacts)"`

---

### Task 7: Plugin `/stage`

**Files:**
- Create: `ferry-plugin/src/Staging.php`
- Modify: `ferry-plugin/src/Routes.php` (register `POST /stage`)
- Test: `ferry-plugin/tests/StagingTest.php`

**Interfaces:**
- Produces: `Staging::dir(string $root, string $txid): string` (`$root/wp-content/uploads/.ferry-staging/<txid>`); `Staging::add(string $root, string $txid, array $files): array` where each file = `{path, data_b64, hash}`; returns `{staged: string[], rejected: [{path, code}]}`. `Staging::protect(string $dir): void` writes `index.php` (`<?php // ferry staging — nothing to see`) and `.htaccess` (`Require all denied`). Blobs land at `<dir>/blobs/<sha256>.bin`; `<dir>/manifest.json` accumulates `{files: {<path>: {blob, hash}}}` across calls (resumable). Backup mirror helper `Staging::backup_dir($root, $txid)` → `.ferry-backup/<txid>`.
- Consumes: `Paths::check_write` (Task 6), `Auth`+`Nonces` (Tasks 2) via the normal signed route table.
- Route handler validates: txid `\A[0-9a-f]{32}\z`; per file: `check_write` passes, base64 decodes, `hash('sha256', $decoded) === $hash` — else rejected with a code, never fatal. Multisite refused first (mirror the `/pair` check verbatim).

- [ ] **Step 1: Failing tests** — temp-dir root: stages two files (blobs exist under sha names, manifest maps paths, `index.php` + `.htaccess` present); second call adds a third file (manifest merged — resumability); bad hash → rejected `bad_hash`, nothing written; `wp-config.php.bak` → rejected `denied_path`; bad txid → 400-shaped error return.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** (~90 lines). **Step 4: Run suite** → green. **Step 5: Commit** — `git commit -m "feat(plugin): staged upload endpoint — base64 blobs under non-executable names, resumable"`

---

### Task 8: Plugin typed DB ops + read-set transaction

**Files:**
- Create: `ferry-plugin/src/DbOps.php`
- Test: `ferry-plugin/tests/DbOpsTest.php`

**Interfaces:**
- Produces:
  - `DbOps::validate(array $ops, string $prefix): array` → `['ok' => DbOp[], 'refused' => [{index, reason}]]` — closed-set kind check, content-table refusal (Global Constraints list, prefix-stripped match), shape check per kind.
  - `DbOps::read_set(array $ops, array $preconditions, string $prefix): array` → list of `{sql_select_for_update, key_label, expected}` — one entry per op target (options by name, postmeta by post_id+key, rows by table+pk) plus every `option`/`row` precondition. `file_hash` preconditions are NOT here (they join the file drift step, Task 9).
  - `DbOps::apply_in_transaction($wpdb, array $ops, array $preconditions, string $prefix, bool $force): array` → `{committed: bool, conflicts: [{key, expected, found}]}` implementing spec §9 verbatim: `START TRANSACTION` → for each read-set entry `SELECT ... FOR UPDATE`, compare found vs expected (skip compare when `$force`) → all match ⇒ apply each op (`INSERT`/`UPDATE`/`DELETE` via `$wpdb->prepare`) → `COMMIT`; any mismatch ⇒ `ROLLBACK`, return every conflict (report all, not just the first). Absent-row semantics: expected `null` matches "no row"; a `row_insert` conflicts when the pk already exists.
- Consumes: nothing outside `$wpdb`.

- [ ] **Step 1: Failing tests** — extend `FakeWpdb` with a scriptable `get_row/query` recorder (record SQL in order; canned results keyed by call order). Cases: (a) validate refuses `{kind:'row_update', table:'wp_posts'}` and unknown kinds, accepts `option_set`; (b) happy path: expected values match → recorded SQL sequence is exactly `START TRANSACTION`, `SELECT ... FOR UPDATE` per key, apply statements, `COMMIT`; (c) one mismatch among three keys → `ROLLBACK` recorded, no apply statements, all conflicts listed with found values; (d) `force: true` skips compares but still wraps in a transaction; (e) `option_set` with `old: null` expects no row and INSERTs.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** (~140 lines). **Step 4: Run** → green. **Step 5: Commit** — `git commit -m "feat(plugin): typed DB operations with transactional read-set compare-and-swap (spec §9)"`

---

### Task 9: Plugin `/commit`, `/rollback`, `/hashes`, `/tx` + retention

**Files:**
- Create: `ferry-plugin/src/Commit.php`, `ferry-plugin/src/Tx.php`
- Modify: `ferry-plugin/src/Routes.php` (register the four routes)
- Test: `ferry-plugin/tests/CommitTest.php`, `ferry-plugin/tests/RollbackTest.php`

**Interfaces:**
- Produces:
  - `Tx::write(string $root, string $txid, array $meta): void` / `Tx::read(string $root, string $txid): ?array` — `meta.json` inside the backup dir; statuses `staged → committing → committed | conflict | rolled_back`; a record stuck at `committing` reads as `dirty` from the route. `Tx::prune(string $root, int $now): int` deletes backup dirs older than 30 days (called opportunistically from `/commit` and `/tx`).
  - `Commit::run(string $root, $wpdb, string $txid, array $files, array $ops, array $preconditions, bool $force): array` — the §8 sequence: (1) staged blobs re-hashed against manifest; (2) file drift: each target's current sha256 vs `oldHash` (`null` oldHash = must not exist; `file_hash` preconditions check here too) — mismatches collect as conflicts `{key: path, expected, found}`; (3) `rename()` existing targets into `backup/files/<relpath>` (recording `{path, existed}`); (4) `rename()` blobs onto targets (deletes: backup only); (5) `DbOps::apply_in_transaction`; (6) any failure in 2/5 → reverse completed renames in reverse order, status `conflict`, nothing applied; success → `committed`. Refuses > 200 files. Per-step `durationMs` captured (microtime) into the response steps array.
  - Route `/rollback` `{txid, ops}` (ops = inverse ops with CAS expectations = the pushed new values): verify current target hashes still match what the push installed (from `meta.json`), restore `backup/files/*` via rename (delete files recorded `existed: false`), run inverse ops transactionally, status `rolled_back`. Any CAS failure → conflict response, nothing restored.
  - Route `/hashes` `{paths}` → `{hashes: {path: sha256|null}}` (null = absent; read-guard applied).
  - Route `GET /tx?txid=` → `{status, steps?, committed_at?}` (`dirty` when stuck `committing`).
- Consumes: `Staging` (Task 7), `DbOps` (Task 8), `Paths` (Task 6).

- [ ] **Step 1: Failing tests** — temp-dir + scripted FakeWpdb: (a) happy commit: files swapped, backup holds originals + `{existed}` records, meta `committed`, steps have 5 named entries with durations; (b) drift conflict on file (changed target) → nothing renamed, staging intact, meta `conflict`, conflict lists path with both hashes; (c) DB conflict after renames → **renames reversed** (targets byte-identical to before), meta `conflict`; (d) delete-file change: target moved to backup, nothing renamed in; (e) rollback happy: originals restored, created file removed, meta `rolled_back`; (f) rollback CAS failure (target edited after push) → nothing restored; (g) 201-file commit refused; (h) `Tx::prune` removes a 31-day-old backup, keeps a 29-day-old one.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** (`Commit.php` ~170 lines, `Tx.php` ~60). **Step 4: Full plugin suite** → green. **Step 5: Commit** — `git commit -m "feat(plugin): two-phase commit with atomic rename swap, backup, rollback, and tx status (spec §8)"`

---

### Task 10: Engine journal — binlog extraction → typed candidates

**Files:**
- Create: `ferry-cli/src/push-types.ts` (the Shared wire types block above, verbatim)
- Create: `ferry-cli/src/journal.ts`
- Modify: `ferry-cli/src/env/ddev.ts` (binlog cnf in `provision`; `binlogPosition`/`extractBinlog` methods on `CloneEnv`), `ferry-cli/src/pull.ts:101-104` (record position after `importDb`), `ferry-cli/src/profile.ts` (`SiteProfile.binlog?: { file: string; position: number }`)
- Test: `ferry-cli/src/journal.test.ts` (against Task 1 fixtures)

**Interfaces:**
- Produces:
  - `CloneEnv.binlogPosition(clonePath): Promise<{file: string; position: number}>` (`ddev mysql -e` per pins doc); `CloneEnv.extractBinlog(clonePath, pos): Promise<string>` (raw mysqlbinlog output, command per pins doc).
  - `parseBinlog(raw: string, columns: (table: string) => string[]): RawRowEvent[]` where `RawRowEvent = {table, kind: 'update'|'insert'|'delete', before?: Record<string,string|null>, after?: Record<string,string|null>}` — maps `@N` ordinals through `columns(table)`.
  - `classify(ev: RawRowEvent, prefix: string): { op: DbOp; risk: RiskClass } | { noise: true } | { refused: string }` — noise: options named `_transient_*`, `_site_transient_*`, `cron`, `ferry_*`; refused per Global Constraints tables; `wp_options`→`option_*`, `wp_postmeta`→`postmeta_*`, else `row_*` (risk `higher`).
  - `journalCandidates(slug, env): Promise<{ ops: {op: DbOp; risk: RiskClass}[]; refusedCount: number; noiseCount: number }>` — position from profile, extraction, column maps via `ddev mysql -e "SHOW COLUMNS FROM ..."` (cache per table).
  - `writeJournal(cloneDir, ops: DbOp[]): Promise<void>` — `journal.ndjson`, one JSON op per line.
- Consumes: pins doc constants; `profile.binlog` recorded by `pull.ts` right after `env.importDb(...)` (`profile.binlog = await env.binlogPosition(docroot); saveProfile(profile);`). `provision()` writes the Task 1 cnf before `ddev start` (fresh clones get binlog from birth; existing clones on next provision).

- [ ] **Step 1: Failing tests** — feed the three Task 1 fixtures through `parseBinlog` with a stub `columns` map (`wp_options: ['option_id','option_name','option_value','autoload']`, etc.): asserts exact `DbOp` shapes incl. old+new values; classification: transient update → noise, `wp_posts` update → refused, custom table → `row_update`/`higher`; `writeJournal` emits parseable ndjson.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** (`journal.ts` ~180 lines; the parser is line-oriented: track current `### UPDATE/INSERT/DELETE `table``, collect `@N=value` under WHERE→before / SET→after, unquote per mysqlbinlog conventions from the fixtures). **Step 4: Run ferry-cli suite + typecheck** → green. **Step 5: Commit** — `git commit -m "feat(cli): binlog-to-typed-ops journal — extraction, classification, journal.ndjson (spec §6-clone)"`

---

### Task 11: Engine `push()` + smoke + rollback; `ferry push` command

**Files:**
- Create: `ferry-cli/src/push.ts`
- Modify: `ferry-cli/src/main.ts` (add `push <site> --spec <file>`)
- Test: `ferry-cli/src/push.test.ts`

**Interfaces:**
- Produces:
  - `push(slug: string, spec: ChangeSpec, opts: { headSha: string; onStep?: (e: StepEvent) => void; force?: boolean; client?: FerryClient; blobFor?: (path: string) => Promise<Buffer> }): Promise<PushOutcome>` — default `blobFor` = `git show <headSha>:<path>` in the clone (via `runGit` from `./git.js`); sequence: generate txid (32 hex) → `staging`: batch files ~2 MB per `/stage` call (b64 in the JSON body) → `hashes`: assert every path staged/verified → `drift`+`swap`+`journal`: one `/commit` call; its per-step results re-emit as the three StepEvents with the plugin-reported durations → conflicts ⇒ `{status:'conflict'}` → `smoke`: `runSmoke` → failure ⇒ call `rollback()` then `{status:'rolled_back', reason:'smoke_failed', smoke}`.
  - `rollback(slug, opts: { txid: string; ops: DbOp[]; client?: FerryClient }): Promise<{ok: boolean; conflicts?: Conflict[]}>` — inverts ops locally (`invertOp(op): DbOp` — set↔set with old/new swapped, insert↔delete) and POSTs `/rollback`.
  - `runSmoke(baseUrl: string, checks: SmokeCheck[]): Promise<{label, ok, detail}[]>` — undici GET per check; `ok = status === expectStatus && (!expectText || body.includes(expectText))`; `detail` = `"200 · 340ms"`-style status+timing, plus first 80 chars on mismatch.
  - `FerryClient` gains `postJson(route, body)` (Task 3's send already covers signing; mirror `getJson` for POST).
- Consumes: Task 9 endpoint contracts; Task 10 types; `runGit` (`ferry-cli/src/git.ts:12`).

- [ ] **Step 1: Failing tests** — fake `FerryClient` (object with `postJson`/`getJson` recording calls, canned responses) + fake `blobFor`: (a) happy path emits StepEvents `staging/hashes/drift/swap/journal/smoke` each `start`→`ok`, returns `pushed` with smoke details; (b) `/commit` conflicts → outcome `conflict`, NO smoke call, NO rollback call; (c) smoke fail (undici stubbed 500) → `/rollback` called with inverted ops (assert `option_set{old:'incl',new:'excl'}` became `{old:'excl',new:'incl'}`), outcome `rolled_back`; (d) files batched: 3 files of 1.5 MB → two `/stage` calls; (e) `invertOp` unit-covers all seven kinds.
- [ ] **Step 2: Run** → fail. **Step 3: Implement** (`push.ts` ~200 lines). `main.ts` command: reads the spec JSON, runs push with console step lines, exits 1 on non-pushed outcome — the 5a runbook driver. **Step 4: Suite + typecheck** → green. **Step 5: Commit** — `git commit -m "feat(cli): push engine — stage, two-phase commit, smoke test, automatic rollback (spec §8)"`

---

### Task 12: Server — changes store + ChangeService + agent tools

**Files:**
- Modify: `ferry-server/src/store.ts` (SCHEMA + Change/PushRun types + methods)
- Create: `ferry-server/src/changes.ts` (ChangeService)
- Modify: `ferry-server/src/agent/sdk-runner.ts` (`buildFerryTools` gains `db_journal` + `create_change`; `SdkRunnerDeps` gains `journalCandidates` + `createChange`), `ferry-server/src/agent/manager.ts` (add `appendSystemEvent`), `ferry-server/src/agent/ground-rules.ts` (finalize-a-fix rules), `ferry-server/src/app.ts` (wiring)
- Test: `ferry-server/src/changes.test.ts`, extend store + sdk-runner tool tests

**Interfaces:**
- Produces:
  - SCHEMA additions:

    ```sql
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id),
      seq INTEGER NOT NULL, status TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT NOT NULL, branch TEXT NOT NULL,
      base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, diff_text TEXT NOT NULL,
      files_json TEXT NOT NULL, ops_json TEXT NOT NULL,
      preconditions_json TEXT NOT NULL, smoke_json TEXT NOT NULL,
      backup_txid TEXT, prod_ref TEXT, conflict_json TEXT,
      created_at TEXT NOT NULL, pushed_at TEXT, rolled_back_at TEXT,
      UNIQUE(site_id, seq)
    );
    CREATE TABLE IF NOT EXISTS push_runs (
      id INTEGER PRIMARY KEY, change_id INTEGER NOT NULL REFERENCES changes(id),
      status TEXT NOT NULL, steps_json TEXT NOT NULL, log_text TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    ```

  - Store methods: `createChange(siteId, fields): Change` (seq = `SELECT COALESCE(MAX(seq),0)+1` inside a better-sqlite3 transaction), `changesFor(siteId, status?)`, `changeBySeq(siteId, seq)`, `setChangeStatus(id, status, patch)`, `createPushRun/updatePushRun`, `recoverInterruptedPushes(): {changeId, backupTxid}[]` (status `pushing` rows). `Change.status: 'draft'|'pushing'|'pushed'|'conflict'|'rolled_back'|'discarded'`.
  - `ChangeService` (`changes.ts`): `create(site, input: {title, summary, ops: DbOp[], preconditions: Precondition[], smoke: SmokeCheck[]}): Promise<Change>` — cloneDir via injected `cloneDir(slug)`; guards: `git status --porcelain` empty else throw `'uncommitted_work'`; current branch = `agent/work`; `base = runGit(dir, ['merge-base','production','HEAD'])`; `diff_text = runGit(dir, ['diff', base+'..HEAD', '--', '.', ':(exclude)journal.ndjson'])`; `files_json` from `git diff --numstat` (path, +, −; map to `ChangeFile` with `oldHash`/`newHash` = sha256 of `git show` blob content at base/head, null when absent); then `writeJournal` + `git add journal.ndjson && git commit` (via `runGit`), record `head_sha = rev-parse HEAD`; `store.createChange`; `agents.appendSystemEvent(site.id, 'change_card', {changeId, seq, title, status: 'draft'})`; validate ops against the refused-table list (re-check server-side — never trust tool input).
  - `AgentManager.appendSystemEvent(siteId, type, payload)`: persist+emit onto the current session (no-op when none).
  - Tools (registered in `buildFerryTools`):

    ```ts
    tool('db_journal', 'Typed DB operations recorded in the clone since the last sync — candidates for a change. Curate: include only ops that belong to your fix.', {},
      async () => text(JSON.stringify(await deps.journalCandidates(slug)))),
    tool('create_change', 'Create a draft change card from your committed work on agent/work. The human pushes; you cannot.', {
      title: z.string().min(4), summary: z.string().min(10),
      ops: z.array(z.record(z.unknown())), preconditions: z.array(z.record(z.unknown())),
      smoke: z.array(z.object({ label: z.string(), path: z.string(), expectStatus: z.number(), expectText: z.string().optional() })),
    }, async (args) => text(JSON.stringify(await deps.createChange(slug, args))))
    ```

- Consumes: `journalCandidates`/`writeJournal` (Task 10), `runGit` (ferry-cli git.ts), `store` patterns above.

- [ ] **Step 1: Failing tests** — store: seq increments per site independently; UNIQUE(site_id,seq) holds; recover finds `pushing` rows. ChangeService (temp git repo fixture: init, `production` branch with a file, `agent/work` with an edit + commit): create → diff_text contains the edit, journal.ndjson committed, change row status draft, `appendSystemEvent` spy called with `change_card`; dirty tree → throws `uncommitted_work`; op on `wp_posts` → throws `refused_op`. sdk-runner: `buildFerryTools` returns 4 tools; `create_change` handler passes args through to the dep.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Suite + typecheck** → green. **Step 5: Commit** — `git commit -m "feat(server): change objects — store, ChangeService, and agent tools db_journal/create_change (draft only, no push)"`

---

### Task 13: Server — PushRunner seam, PushManager, `/changes` routes, SSE, recovery

**Files:**
- Create: `ferry-server/src/push/types.ts`, `ferry-server/src/push/scripted-push-runner.ts`, `ferry-server/src/push-manager.ts`, `ferry-server/src/routes/changes.ts`
- Modify: `ferry-server/src/app.ts` (AppDeps gains `push?: { runner: PushRunner }`; register routes; boot recovery), `ferry-server/src/engine.ts` (real `PushRunner` via `push()`/`rollback()` from ferry-cli), `ferry-server/src/routes/sync.ts` + agent message route (mutual exclusion vs pushing)
- Test: `ferry-server/src/push-manager.test.ts`, `ferry-server/src/routes/changes.test.ts`

**Interfaces:**
- Produces:

  ```ts
  // push/types.ts
  export interface PushRunner {
    push(slug: string, spec: ChangeSpec, opts: { headSha: string; force?: boolean; onStep: (e: StepEvent) => void }): Promise<PushOutcome>;
    rollback(slug: string, opts: { txid: string; ops: DbOp[] }): Promise<{ ok: boolean; conflicts?: Conflict[] }>;
    txStatus(slug: string, txid: string): Promise<'committed' | 'dirty' | 'staged' | 'rolled_back' | 'unknown'>;
  }
  ```

  `scriptedPushRunner(script?: {conflictOn?: PushStep; smokeFails?: boolean})` — deterministic step events on timers, mirroring `scripted-runner.ts`'s shape (tests + the e2e server reuse it in 5b).
  - `PushManager` (constructor `(store, runner, opts: { specFor(change): ChangeSpec })`): `isPushing(siteId)`, `subscribe(siteId, fn)` (SSE listeners, same pattern as `AgentManager.subscribe`), `start(site, change, {force})` — throws `'busy'` when pushing, sets status `pushing`, creates push_run, emits `push_step` per StepEvent + `push_done`; outcome → status `pushed` (+`backup_txid`, `prod_ref` = txid slice 7, `pushed_at`) | `conflict` (+`conflict_json`) | `rolled_back`; `rollback(site, change)` — runner.rollback with inverted-op source `change.ops`; success → `rolled_back`; `recover()` — for each interrupted push: `txStatus` `committed` → `pushed` (log: smoke unknown), else runner.rollback → `rolled_back`, failure → `conflict` with detail.
  - Routes (`changes.ts`, all `requireUser` + `siteFor` ownership): `GET /api/sites/:id/changes?status=`, `GET /api/sites/:id/changes/:seq`, `POST /api/sites/:id/changes/:seq/push` `{force?}` → 202 (409 when busy/syncing/agent active — reuse the sync route's guard trio), `POST .../rollback`, `POST .../discard` (draft only), `POST .../retry` → formats `conflict_json` as a plain-text table into `agents.send(site, message)` → 202, `GET /api/sites/:id/push/events?after=` → SSE (verbatim `sync.ts:33-50` hijack/heartbeat pattern over `pushManager.subscribe`).
  - Mutual exclusion completed: sync route + agent message route each add `if (push?.isPushing(site.id)) return 409`.
- Consumes: Tasks 10–12 types/methods; `sync.ts` SSE pattern; the 409 guard style in `routes/sync.ts:8-30`.

- [ ] **Step 1: Failing tests** — PushManager with scripted runner: happy run persists 6 ok steps + status `pushed` + subscribers got `push_step`×N then `push_done`; conflict script → `conflict` + conflict_json; smokeFails script → `rolled_back`; `start` while pushing throws `busy`; `recover` maps `committed`→pushed and `dirty`→rollback-called. Routes (fastify inject, scripted runner): push 202 then second push 409; push while agent active 409; retry sends a message containing the conflicting key; discard on pushed change → 409; SSE replays and streams (follow the existing agent SSE route test).
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** `engine.ts` real runner wires `push()`/`rollback()` from `ferry-cli/src/push.js`; `specFor` builds `ChangeSpec` from the change row's JSON columns. **Step 4: Full server suite + typecheck** → green. **Step 5: Commit** — `git commit -m "feat(server): PushManager + /changes API — SSE push progress, conflict/rollback states, boot recovery"`

---

### Task 14: 5a acceptance runbook + full-suite gate

**Files:**
- Create: `docs/superpowers/plans/2026-07-26-ferry-plan5a-acceptance-runbook.md`

- [ ] **Step 1: Write the runbook** (template: `docs/superpowers/plans/2026-07-26-ferry-plan4-acceptance-runbook.md`). Must include, in order: fixture prelude (`ddev delete -Oy ferry-prod-ddev-site`; `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`; **update the Ferry Connect plugin on the fixture from this branch** — the nonce change requires it; re-pair if signatures fail); fresh sync (validates Task 4 against the real 502 window); agent session making a small fix + `create_change` via chat (validates Tasks 10/12); push via `POST /api/sites/:id/changes/1/push` with SSE watched via `curl -N` (happy path); **conflict demo**: `ddev wp option update <touched option> other-value` on the FIXTURE mid-flow before a second push → conflict response lists the key, fixture file untouched (verify by hash); force push; manual rollback → fixture restored byte-identical (hash compare); smoke-fail demo (a check with `expectStatus: 599`) → automatic rollback observed. Each step lists the exact command and the expected observable.
- [ ] **Step 2: Run every suite and typecheck**, paste summary counts into the runbook header. Expected: all green.
- [ ] **Step 3: Flag the human gates in the final report:** security skim checkpoint B (code, this branch) before merge; the runbook itself is run by the human.
- [ ] **Step 4: Commit** — `git commit -m "docs: Plan 5a acceptance runbook (API-level write-back against the real fixture)"`

---

## Self-review notes (already applied)

- Spec coverage: nonce (§4.5)→T2/3; staging/2PC (§3.6/§8)→T7/9; §9 transaction→T8; journal (§6-clone)→T1/10; push+smoke+rollback→T11/13; agent tools + one-human-click→T12; fold-ins→T4/5; `hashes` drift preview→T9; retention→T9; recovery→T13; runbook→T14. 5b (screens, Retry UX rendering) is deliberately absent — separate plan after 5a ships.
- Type consistency: `DbOp`/`ChangeSpec`/`StepEvent`/`PushOutcome` defined once (push-types.ts) and imported everywhere; PHP mirrors keys exactly; plugin `/commit` response steps re-emit as StepEvents in T11.
- Known judgment calls an implementer must NOT re-open: nonce is line 6 of the canonical; blobs are content-addressed `.bin`; commit refuses >200 files; content-table list is the Global Constraints list.
