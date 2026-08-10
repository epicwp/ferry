# Ferry Connect plugin — human security skim (scope & checklist)

**Status:** Checkpoint B DONE — signed 2026-08-10 at `e7d862a` (see sign-off table).
Checkpoint A (design-stage) was never separately recorded.
**Why now:** Plan 5 turns the plugin from read-only into one that accepts writes to
customer production sites. The read-only surface was never human-skimmed either; the
write surface must additionally be skimmed *as designed*, before it merges.
**Who:** Robbert (human, not an agent). Agents may prepare pointers; the sign-off is human.
**Effort:** the plugin is ~950 lines of dependency-free PHP (`ferry-plugin/src/` + `ferry.php`).
Checkpoint A ≈ 30–45 min on the design doc; checkpoint B ≈ 60–90 min on the code at a pinned SHA.

## Checkpoints

- **A — write surface on paper** (after the Plan 5 design doc is signed off, before
  implementation hardens): walk the "Write surface" section below against the design doc.
  Catching a design-level hole here is 10× cheaper than after implementation.
- **B — full code skim** (before the first real customer install, and ideally before the
  Plan 5 PR merges): the full checklist below against the code at one pinned commit.
  Record the SHA in the sign-off.

## 1. Auth (`src/Auth.php`, `src/Routes.php::authorize`)

- [ ] HMAC-SHA256 over `method + route + query + body + timestamp` (`Auth::canonical`,
      mirrored in `ferry-cli/src/signing.ts`). Confirm no request input that changes
      behavior is *outside* the signed canonical (note: `rest_route`/`_locale` are unset
      from the signed query — the resolved route itself IS signed; confirm no other
      WP-meaningful query param escapes signing).
- [ ] 60s timestamp window; `hash_equals` for both signature and pairing-code compares.
- [ ] Replay window: HMAC+timestamp means a captured request is replayable for 60s.
      Accepted for read-only; **Plan 5 adds the nonce check (base doc §4.5) — verify it
      exists, is checked before the handler runs, is store-atomic under concurrent
      requests (two requests, same nonce, same instant), and prunes without unbounded growth.**
- [ ] Pairing: `/pair` is `permission_callback __return_true` by design (guarded by the
      code itself). 8 chars × 30-symbol alphabet (~39 bits), 10-min TTL, single-use,
      timing-safe compare. No rate limit (WP has none) — confirm the entropy/TTL math
      still holds for the write-capable plugin, or decide a lockout is needed.
- [ ] Secret at rest: `ferry_secret` in `wp_options` (autoload off). Anyone with DB read
      on the site can sign requests — acceptable (they own the site), but confirm the
      secret grants nothing on *our* server side beyond that one site.

## 2. `/files` path handling (`Routes.php::files`, `::send_range`)

- [ ] Traversal guard: `realpath($root . '/' . $relpath)` + prefix check against
      `$root . DIRECTORY_SEPARATOR` (Routes.php:141-148, duplicated in `send_range`
      183-191). Convince yourself: `..`, absolute paths, null bytes, Windows separators.
- [ ] Symlinks: `realpath` resolves them — a symlink inside docroot pointing outside
      resolves outside `$root` and is refused. Confirm that's the behavior you want
      (it also means legitimate symlinked wp-content setups partially fail — fine).
- [ ] Exclusion check runs on the **resolved** path (`$resolved_rel`), not the requested
      string — so an alias route to an excluded file can't bypass it. Verify.

## 3. wp-config & secrets exfiltration surface

- [ ] `wp-config.php` excluded by exact filename (`Excludes::FILES`) and refused on
      explicit request; the one-level-above-ABSPATH variant is outside `$root` (guarded).
- [ ] ⚠️ **Known gap, decide in Plan 5 design:** backup copies — `wp-config.php.bak`,
      `wp-config-old.php`, `wp-config.php~`, editor swap files — are NOT excluded and
      would travel with DB credentials and salts. Options: pattern-based exclude
      (`wp-config*`), or content-based (any root-level PHP defining `DB_PASSWORD`).
- [ ] `/info` constants denylist (`Config::DENYLIST`): salts + `DB_*` only. Base doc §8
      open question stands: hosts/plugins stuff API secrets into other constants
      (`*_KEY`, `*_SECRET`, `*_TOKEN` — e.g. Stripe live keys in wp-config). This data
      only reaches our own paired server, but it lands in the clone git repo the agent
      reads. Decide: pattern filter, and does it need to be in Plan 5?
- [ ] Uploads hatch: `Excludes::allowed_upload` serves ANY explicitly requested file
      under `wp-content/uploads/` (materialization, §2.8). Deliberate — customer files
      (invoices, ID documents) only move on explicit request. Confirm still acceptable
      once the agent can request them autonomously.

## 4. DB export (`src/Db.php`, `src/DbExcludes.php`)

- [ ] Table names are interpolated into SQL, but only after a strict `in_array` check
      against `SHOW TABLES` (Routes.php:219). Confirm every interpolation site is
      behind that check; `single_pk` uses `%i` (wpdb ≥ 6.2 — confirm minimum WP version).
- [ ] `skip` rules resolve to server-defined WHERE clauses (`DbExcludes::plan`) — the
      wire only carries rule *names*, unknown names are rejected. Confirm no raw SQL
      can arrive from the wire.

## 5. Write surface (Plan 5 — skim AS DESIGNED at checkpoint A, as code at B)

- [ ] **Nonce check exists before ANY write handler** (hard precondition, base doc §4.5).
- [ ] ⚠️ **Staging dir execution risk (flagged 2026-07-26, must be resolved in design):**
      base doc §3.6 stages uploads under `wp-content/uploads/.ferry-staging/<txid>/` —
      inside the web-accessible tree. A staged `.php` file is potentially executable by
      direct URL *before* commit, turning a 60s-replay or any auth slip into RCE.
      Review the designed mitigation (non-executable names in staging, web-server deny
      drop-in, staging outside the web root, randomized unguessable txid — likely several).
      Same question for `.ferry-backup/<txid>/` (old code stays web-reachable).
- [ ] Write path validation: same realpath+prefix guard as reads, plus a write-side
      denylist — at minimum `wp-config.php`, the plugin's own directory (self-update =
      auth bypass), `.ferry-staging`/`.ferry-backup` themselves, mu-plugins ferry files.
- [ ] Typed DB operations only: closed operation set, no raw SQL from the wire, DB
      content writes refused hard (spec: content never pushed back).
- [ ] Two-phase commit: hashes verified server-side in staging *before* swap; `rename()`
      swap same-filesystem (atomic) — what happens on cross-device setups; partial-failure
      behavior; rollback token — who may call rollback, for how long.
- [ ] Drift check transaction (spec §9): `SELECT … FOR UPDATE` scope, lock duration
      bound, and that a mismatch truly applies nothing.
- [ ] Smoke test: must not introduce command execution through the back door — confirm
      it stays HTTP-level checks.
- [ ] Multisite: write endpoints refuse multisite as hard as `/pair` does.
- [ ] Timeouts: write/commit endpoints follow the resumable-batch pattern (timeouts are
      answers) without a half-committed state ever being reachable.
- [ ] ⚠️ **Written-acceptance item (final review, Plan 5a): agent subprocess reaches a
      write-capable secret.** The agent subprocess can read `~/.ferry/sites/<slug>/profile.json`
      (the site's HMAC secret, `ferry-cli/src/profile.ts`). Before Plan 5a that secret only
      signed reads; post-5a it also signs `/stage`/`/commit`/`/rollback` - a prompt-injected
      agent (malicious content in the site it's exploring, or an injected tool result) could use
      it to sign production writes directly, bypassing the change-card review step entirely.
      Accepted for v0 until Plan 6's Firecracker isolation sandboxes the subprocess away from
      that file - **must be a conscious, dated sign-off below, not silently waved through.**
- [ ] ⚠️ **Written-acceptance item (final review, Plan 5a): raw-SQL option writes bypass the
      WP object cache.** `DbOps::apply()` writes `option_set`/`option_delete` straight to
      `wp_options` via `$wpdb->query()`, never through `update_option()`/`delete_option()` - so
      on a persistent-object-cache host (Redis/Memcached) the cached value is never invalidated.
      A pushed option change may be invisible to the running site (and to the push's own smoke
      check, which may then validate a stale cached value as if the write had taken effect)
      until the cache is flushed by some other means. Decide: call `wp_cache_delete($name,
      'options')` (and clear the `alloptions` cache key WP's option API also maintains) right
      after `COMMIT`, or accept this gap for v1 - **must be a conscious, dated sign-off below.**

## Checkpoint B preparation — agent-prepared pointers (2026-08-10, `f7b0c3f`)

Prepared per "Agents may prepare pointers" above. Status tags are the agent's reading —
every judgement call is yours. Suites at this SHA: plugin 195 / cli 141 / server 159, all
green. Five bugs were found and fixed during the live acceptance run (`42ee0dc`,
`fe69f83`, `404e68e`, `82b8416`, `f7b0c3f`); the nonce and conflict pointers below
describe the post-fix state. Some line refs in the checklist above predate Plan 5a —
current locations are given here.

### 1. Auth — all verified, one DECIDE
- Canonical now signs `method\nroute\nquery\nbody\ntimestamp\nnonce` — `Auth::canonical`
  (src/Auth.php:56), mirrored byte-for-byte in `ferry-cli/src/signing.ts:19`.
  `rest_route`/`_locale` unset before signing; all other query params are inside it.
- 60s window: `Auth::SIGNATURE_WINDOW` (src/Auth.php:7). `hash_equals` on both compares
  (src/Auth.php:45, :84).
- Nonce: `Nonces::consume` (src/Nonces.php) runs inside `Routes::authorize`
  (src/Routes.php:57) — the `permission_callback` of every signed route, so it runs
  before any handler. Store-atomic via the UNIQUE `option_name` index (concurrent same
  nonce: second INSERT fails closed). Prunes each call (window 120s). Note: consume is
  idempotent *within* one request (request-scoped static, `42ee0dc`) because WP core
  re-invokes permission callbacks; cross-request replay still fails closed
  (tests/NonceTest.php).
- Pairing: 8 chars × 30-symbol alphabet via `random_int` (src/Auth.php:8,:17), 10-min
  TTL, single-use, `hash_equals`. **DECIDE:** still no rate limit — the ~39-bit/10-min
  math is unchanged from read-only days; confirm it still holds now that pairing yields
  a write-capable secret, or require a lockout.
- Secret at rest: `update_option('ferry_secret', $secret, false)` — autoload off
  (src/Auth.php:49). Server-side the secret is per-site in
  `~/.ferry/sites/<slug>/profile.json`, grants nothing beyond that site.

### 2. /files path handling — verified
- Guards moved from Routes.php inline to `Paths::resolve_read` (src/Paths.php:29):
  `realpath` + prefix check; rejects NUL bytes, backslashes, and absolute paths
  (src/Paths.php:44). Symlinks resolving outside `$root` are refused (realpath).
- Exclusion runs on the resolved path; `Routes::files`/`send_range` only serve what
  `resolve_read` returns (src/Routes.php:242, :278).

### 3. wp-config & secrets — one GAP, two DECIDEs
- `wp-config.php` exact-excluded read-side (src/Excludes.php:FILES) and the whole
  `wp-config*` basename family is refused **write-side** (src/Paths.php:92).
- **FIXED at checkpoint B:** backup copies (`wp-config.php.bak`, `wp-config-old.php`,
  `~`/swap files) no longer travel — any basename containing `wp-config` is excluded
  read-side too (`Excludes::excluded`, tests in ExcludesTest.php).
- **FIXED at checkpoint B:** `Config::denied()` now also drops secret-shaped constant
  names (`*_KEY`/`*_SECRET`/`*_TOKEN`/`*_PASSWORD`/`*_PASS`/`*_PWD`) on top of
  `DENYLIST` (src/Config.php, tests in ConfigTest.php).
- Uploads hatch: `Excludes::allowed_upload` (src/Excludes.php:52) still serves any
  explicitly requested uploads path; logs stay blocked. **DECIDE:** confirm acceptable
  now the agent can request uploads autonomously (fetch_uploads tool).

### 4. DB export — verified
- Table interpolation only after `in_array($table, SHOW TABLES, true)`
  (src/Routes.php:311); `single_pk`/key introspection uses `%i` (src/Db.php:63,:68 —
  requires WP ≥ 6.2, fine for the 7.x fixture line).
- Skip rules resolve server-side (`DbExcludes::plan`); unknown names 400
  (src/Routes.php:317). No raw SQL crosses the wire.

### 5. Write surface — verified, with one residual-risk note and the two acceptance items
- Nonce precedes every write handler (same `authorize` permission_callback wiring,
  src/Routes.php:25-31).
- Staging under `wp-content/uploads/.ferry-staging/<txid>/`: txid must match
  `^[0-9a-f]{32}$` (src/Staging.php:35 — unguessable), dir gets `index.php` stub +
  `.htaccess "Require all denied"` (src/Staging.php:25-26); every staged path passes
  `Paths::check_write` first (src/Staging.php via check_write). **Residual risk to
  accept consciously:** `.htaccess` is inert on nginx hosts — there the protections are
  the unguessable txid, upload-dir PHP-exec being commonly disabled, and short staging
  lifetime (Tx::prune). Same applies to `.ferry-backup/<txid>/`.
- Write denylist (src/Paths.php:92-110): `wp-config*` pattern, the plugin's own
  directory under both slugs (`SELF_PLUGIN_DIRS`, src/Paths.php:24-27 — self-update =
  auth bypass, refused case-insensitively after lexical normalization),
  `.ferry-staging`/`.ferry-backup` internals, `wp-content/mu-plugins/ferry-*`, plus
  everything `Excludes::excluded`. `..` segments are rejected outright; existing
  symlink leaves resolving outside `$root` refused (src/Paths.php:44-91).
- Typed ops only: closed kind-set with shape validation (src/DbOps.php:validate),
  `REFUSED_TABLES` posts/comments/users(+meta) and `REFUSED_PATTERNS` woocommerce_/wc_/
  actionscheduler_ (src/DbOps.php:22-23) — content tables refused at create-time
  server-side too (ferry-server/src/changes.ts).
- Two-phase commit: staged blobs re-hashed against manifest + caller's newHash before
  any rename (src/Commit.php:47-53); same-volume renames, completed renames reverted on
  later failure (src/Commit.php:6-11). Rollback is CAS-guarded, 30-day retention
  (src/Tx.php:16), non-terminal statuses never pruned mid-flight (src/Tx.php:17,:53).
- Drift transaction: `START TRANSACTION` → `SELECT … FOR UPDATE` on the full read-set →
  compare → any mismatch ROLLBACKs having applied nothing; apply-statement failure
  rolls back too (`apply_error`), no partial commit (src/DbOps.php:235-279). One drifted
  value now reports one conflict (`82b8416`).
- Smoke stays HTTP-level: `runSmoke` (ferry-cli/src/push.ts) does fetches only, with an
  origin assertion against the site base (push.ts:230) closing the SSRF/backslash
  bypass; paths validated server-side at create_change as well (defense in depth).
- Multisite: every write handler opens with the `is_multisite()` 409 refusal
  (src/Routes.php — stage/commit/rollback/hashes/tx).
- Timeouts: staging is a resumable batch (manifest.json + per-file rejects never abort
  the batch); commit is atomic behind the tx record — a lost `/commit` response is
  classified conflict, never silently re-applied (drift:start-before-POST fix,
  `a5bc71f`).
- **Written-acceptance item 1 (agent-reachable write secret):** unchanged as described
  above (lines 104-111). The agent subprocess can read `profile.json`; post-5a that
  secret signs writes. Mitigations in place today: the change-card flow is the only
  *intended* path, `FERRY_AGENT_MAX_BUDGET_USD` caps sessions, and pushes are
  human-triggered — but a prompt-injected agent could sign `/stage`/`/commit` directly.
  Plan 6 isolation is the designed fix. Sign consciously below.
- **Written-acceptance item 2 — FIXED at checkpoint B:** `DbOps::invalidate_caches()`
  now runs after COMMIT on both the commit and rollback paths: `wp_cache_delete` per
  touched option (+ the `alloptions` bundle) and per touched postmeta post. `row_*` ops
  have no reliable cache key — accepted; the refused-table policy keeps those away from
  WP's hot cached entities (tests in DbOpsTest.php). No conscious acceptance needed
  anymore.

### What remains for the human signature — three v0 acceptances

Everything else in this checklist is verified (pointers above) or fixed at this
checkpoint. The lead-engineer recommendation on all three is **accept for v0**:

- **A. Agent-reachable write secret until Plan 6.** The agent subprocess can read
  `profile.json`; that secret signs writes. Mitigations today: pushing stays one human
  click, `FERRY_AGENT_MAX_BUDGET_USD` caps sessions, and there are no customer installs
  before Plan 6's Firecracker isolation lands.
- **B. Pairing has no rate limit.** ~39 bits entropy, 10-minute TTL, single-use,
  timing-safe compare — brute force within the window is not realistic; codes only
  exist right after the site owner mints one.
- **C. v0 residual risks.** The uploads escape-hatch serves explicitly requested
  customer files to the agent (by design, §2.8); the staging/backup `.htaccess` deny is
  inert on nginx hosts, where the unguessable txid and short lifetime are the guard.

## Sign-off

| Checkpoint | Date | Commit SHA | By | Result / notes |
|---|---|---|---|---|
| A (design) | — | — | — | not separately recorded; write surface was skimmed as code at B |
| B (code) | 2026-08-10 | `e7d862a` | Robbert Vermeulen | PASSED with three conscious v0 acceptances: (A) agent-reachable write secret until Plan 6 isolation; (B) pairing without rate limit; (C) uploads escape-hatch + nginx-inert `.htaccess` on staging (txid unguessability is the guard there). Three gaps fixed at this checkpoint: `wp-config*` read-side exclude, object-cache invalidation after COMMIT, secret-shaped constants filter. Signed via chat, agent-prepared pointers (section above). |
