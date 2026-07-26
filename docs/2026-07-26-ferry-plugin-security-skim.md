# Ferry Connect plugin — human security skim (scope & checklist)

**Status:** NOT DONE — blocking. No real customer install until a human has completed
checkpoint B below and signed off at the bottom of this document.
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

## Sign-off

| Checkpoint | Date | Commit SHA | By | Result / notes |
|---|---|---|---|---|
| A (design) | — | — | — | — |
| B (code) | — | — | — | — |
