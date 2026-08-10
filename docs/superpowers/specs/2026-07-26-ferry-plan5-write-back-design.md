# Ferry Plan 5 — write-back: design

**Date:** 2026-07-26 · **Status:** approved in brainstorming, pending spec review
**Inputs:** roadmap §Plan 5 · SaaS spec §8 (push), §9 (drift), §13 (approval UX) · base doc
§2.10, §3.6 (upload/2PC), §4.5 (nonce precondition), §6 (acceptance) · design screens 6–12
(`design/` cache, 2026-07-26) · Plan 4 design doc · `docs/2026-07-26-ferry-plugin-security-skim.md`

**Done when (base doc §6):** an agent fixes a bug in a WooCommerce site that receives orders
during the session; the fix is pushed; provably no order, customer, or concurrent change touched.

**Security gate:** this document is the input for **checkpoint A** of the human security skim
(`docs/2026-07-26-ferry-plugin-security-skim.md`) — the write surface below must be skimmed as
designed before implementation hardens, and checkpoint B (code) before the 5a PR merges. No real
customer install before both.

## Decisions (from brainstorming, 2026-07-26)

1. **Split 5a/5b, one design doc.** 5a = engine + plugin (nonce, journal, write endpoints,
   push/drift/smoke/rollback), accepted via an API-level runbook without UI. 5b = dashboard
   (screens 6–12) over the 5a API, accepted via the §6 criterion end-to-end. Mirrors 3a/3b.
2. **Screenshots deferred.** Spec §13 names agent screenshots as the visual approval evidence;
   the (newer) design has no screenshots section on either card. The card ships as designed —
   summary + diff + DB ops + drift + smoke are the approval evidence. Deferral is explicit here
   so §13's claim isn't silently dropped; revisit when a visual-fix use case arrives (needs
   headless browser in the clone, image storage/serving).
3. **Conflict actions v1: Retry + Force.** "Push the code only" (partial change) is deferred —
   it needs journal subsetting and a second drift pass; nothing is rendered for it.
4. **Journal capture: on-demand binlog extraction**, not a continuous tailer. Extraction runs at
   change-creation time from a recorded position. Rejected: a live Node binlog client per site
   (long-lived connections, resume machinery, restart handling — no v1 benefit).
5. **Read set v1 = written keys + agent-declared preconditions.** The §9 transactional check
   ships in full (`SELECT … FOR UPDATE` → verify old values → apply → commit, one transaction).
   Automatic read logging (base doc §2.11) is deferred: every WP page load reads hundreds of
   autoloaded options, so a raw option-filter log drowns the read set; needs a smarter capture
   design. Spec §16 already carries imperfect read sets as the residual risk.
6. **Push executor lives in the engine** (`push()` next to `pull()`), driven by ferry-server,
   streamed over SSE like sync. A small CLI entry point drives the 5a runbook.
7. **The agent creates drafts; it can never push.** `create_change` is the only
   mutation-adjacent tool exposed to the agent; push/rollback/force exist only behind
   `requireUser` routes (and the runbook CLI). One human click stands (spec §13).
8. **No cost UI.** Screens 6–12 show none. The MAX-per-session cost semantics (Plan 4 design
   doc) remain the rule for whenever cost display does appear.
9. **DB op classes v1:** options + postmeta = low risk; other non-core table rows = higher risk,
   pushed only with explicit human confirmation (spec §6-clone); content tables and schema
   changes refused hard (content never crosses; `schema_migrate` deferred).

## Architecture

```
agent (SDK session) ──mcp__ferry__db_journal──► journal candidates (binlog → typed ops)
        │
        └─mcp__ferry__create_change──► Change (draft, SQLite) + journal.ndjson in clone git
                                          │            └─► chat event → inline card (5b)
dashboard button / runbook CLI ──POST push──► PushManager ──► engine.push()
        ▲                                       │                 │ signed HTTP (HMAC+nonce)
        └───────SSE push progress◄──────────────┘                 ▼
                                                    plugin write endpoints (stage/commit/…)
```

## Plugin surface (additions to `ferry/v1`; native PHP, zero-dep, no exec)

### Nonce (hard precondition, first implementation task — base doc §4.5)

- Every signed request adds header `X-Ferry-Nonce`: 32 hex chars (128-bit random).
- **The nonce joins the HMAC canonical**: `method \n route \n query \n body \n timestamp \n nonce`.
  Without this, an attacker could replay a captured request under a fresh nonce — the signature
  wouldn't cover it. `Auth::canonical` and `ferry-cli/src/signing.ts` change together
  (coordinated break: no customers exist; the fixture re-pairs if needed).
- **Replay check is atomic:** each nonce is stored as its own option row
  (`ferry_nonce_<hash>`, autoload off) via `add_option()`, which is an atomic INSERT — a second
  request with the same nonce fails the insert and is rejected. No read-modify-write races.
- Pruning: on each authorized request, expired nonce rows (older than the 60s window + margin)
  are deleted. No cron.
- Applies to **all** signed endpoints (uniform), verified in `Routes::authorize` before any handler.

### Write endpoints

All write endpoints additionally refuse: multisite (like `/pair`), unpaired sites, and any
target path that is (a) outside the docroot (same realpath+prefix guard as `/files`), (b) in
the read exclusion list (uploads, caches, backups — those never crossed the bridge), or
(c) on the **write denylist**: `wp-config*` (pattern, covers `.bak` copies — see skim doc),
the ferry plugin's own directory (self-update = auth bypass), `.ferry-staging*`/`.ferry-backup*`,
`wp-content/mu-plugins/ferry-*`.

- **`POST /stage`** `{txid, files: [{path, data_b64, hash}]}` — decodes base64 (WAF-safe,
  base doc §3.6), verifies each decoded blob against its hash, writes into the staging area.
  Resumable: multiple calls per txid; response reports staged/verified counts (timeouts are
  answers). `txid` is server-generated, 128-bit hex.
- **Staging/backup layout (RCE mitigation — skim item):**
  `wp-content/uploads/.ferry-staging/<txid>/` holds blobs as `<sha256>.bin` plus a
  `manifest.json` mapping blob → target path. Never target-named files, never a `.php`
  extension on disk. The plugin writes an empty `index.php` and a deny-all `.htaccess` into
  both `.ferry-staging/` and `.ferry-backup/` at creation. Residual risk (nginx ignores
  `.htaccess`) is covered by the `.bin` naming — nginx does not execute `.bin` as PHP.
- **`POST /commit`** `{txid, files: [{path, new_hash, old_hash|null}], ops: [...],
  preconditions: [...], force?: bool}` — the §8 sequence server-side:
  1. re-verify staged blob hashes;
  2. **file drift check**: hash every target's current content against `old_hash`
     (`null` = file must not exist) — compare-and-swap per spec §9;
  3. backup: `rename()` current targets into `.ferry-backup/<txid>/` (same filesystem, atomic);
  4. `rename()` staged blobs onto targets;
  5. **DB transaction** (spec §9, verbatim): `BEGIN`; `SELECT … FOR UPDATE` on every read-set
     row (all ops' targets + all precondition keys); verify expected old values; apply typed
     ops; `COMMIT`;
  6. any failure in 2 or 5 → reverse the renames, `ROLLBACK`, respond with the conflict list
     `[{key, expected, found}]` — nothing applied, all or nothing (screen 11's promise).
  `force: true` skips old-value verification in steps 2 and 5 (apply stays transactional).
  A transaction record (start/end status) is written before step 3 and after step 6.
  Commit is single-shot by design (renames + one transaction are cheap); v1 refuses changes
  over 200 files as a guardrail — staging, not commit, is the resumable phase.
- **`POST /rollback`** `{txid}` — verifies current file contents still match what the push
  installed (CAS again — never clobber post-push edits), restores from `.ferry-backup/<txid>/`,
  replays the journal in reverse (verify new values, restore old) in one transaction.
  Backups prune opportunistically after **30 days** (screen 10: rollback available while the
  backup exists).
- **`POST /hashes`** `{paths}` → `{path: hash}` — cheap targeted drift preview for the card's
  "Drift check: production unchanged" line (no full manifest walk).
- **`GET /tx?txid=`** → `{status: staged|committed|conflict|rolled_back|dirty, detail}` — if a
  commit call times out, the server asks instead of guessing. A record that says "started but
  never finished" reads as `dirty`; the server's remediation is `rollback` (restore backup).

### Typed operations (closed set, v1)

| op | payload | risk class |
|---|---|---|
| `option_set` | `{name, old (or absent-marker), new}` | low |
| `option_delete` | `{name, old}` | low |
| `postmeta_set` | `{post_id, meta_key, old (or absent), new}` | low (base doc §2.10 allows) |
| `postmeta_delete` | `{post_id, meta_key, old}` | low |
| `row_update` / `row_insert` / `row_delete` | `{table, pk, old_row, new_row}` | **higher** — needs explicit human confirmation at push time (spec §6-clone) |

Refused hard: ops on content tables (posts, comments, users, WooCommerce order/customer/session
tables — a classification list in the engine), any DDL/schema change, TRUNCATE. DB content is
never pushed back (standing decision). Raw SQL never crosses the wire in either direction.

## Journal capture (engine, clone side)

- **Provision:** DDEV MariaDB config enabling `log_bin`, `binlog_format=ROW`,
  `binlog_row_image=FULL`, a `server-id`, and a bounded expiry. Applied at provision; existing
  clones pick it up on next provision/restart (migration note in the plan).
- **Position bookkeeping:** after every DB import (initial pull and refreshes), the engine
  records the binlog coordinates in the site's state file. The journal window for a change is
  "since the last import".
- **Extraction:** `ddev exec mysqlbinlog --base64-output=decode-rows -v` from the recorded
  position → parse row events `{table, kind, before-image, after-image}` → drop noise tables
  (transients, sessions, Action Scheduler, ferry's own options — the `DbExcludes` categories)
  → map to typed ops (wp_options rows → `option_set`/`option_delete`, postmeta rows →
  `postmeta_*`, the rest → `row_*` with risk class).
- **Curation is mandatory:** the binlog also contains the agent's test checkouts and WP
  background writes. The agent selects which candidate ops belong to the fix (via the tools
  below); nothing enters a change automatically.
- **`journal.ndjson`** (the selected, ordered typed ops with old+new values) is written at the
  clone root and committed on the agent branch next to the code (spec §6-clone; the design's
  git-diff rail shows exactly this file). Push = replay it; rollback = replay it in reverse.
- **Phase 0 spike (first plan task, like Plan 4's SDK pins):** verify the DDEV MariaDB config
  path, exact `mysqlbinlog` flags and output parsing, and position bookkeeping against the real
  fixture before the task list hardens.

## Agent tools (5a — added to the existing in-process MCP server)

- **`mcp__ferry__db_journal`** → the current candidate op list (typed ops + risk class +
  noise already filtered). Read-only.
- **`mcp__ferry__create_change`** `{title, summary, ops (selected), preconditions, smoke_checks}`
  → server-side: requires a clean, committed agent branch; computes the file diff
  (base…agent branch); writes and commits `journal.ndjson`; snapshots diff text + file stats +
  ops + preconditions + smoke plan into a `changes` row (status `draft`, per-site sequential
  `CHANGE-NNNN`); appends a persisted `change_card {change_id}` chat event (the inline card).
  - `preconditions`: `[{type: option|file_hash|row, key, expected}]` — screen 8's "the agent's
    assumptions" section; they join the read set in `/commit`.
  - `smoke_checks`: `[{label, url_path, expect_status, expect_text?}]` — screen 10's named
    checks with metrics.
- Ground rules (system-prompt append) gain: how to finalize a fix (commit → `db_journal` →
  `create_change`), declare assumptions honestly as preconditions, and that pushing is the
  human's — the agent has no push tool.

## Server (5a)

**Data model (SQLite migrations in `store.ts`):**

```
changes:   id, site_id (FK), seq (per-site, renders CHANGE-0007), status
           ('draft'|'pushing'|'pushed'|'conflict'|'rolled_back'|'discarded'),
           title, summary, branch, base_sha, diff_text, files_json, ops_json,
           preconditions_json, smoke_json, backup_txid, prod_ref (short txid form —
           production has no git; this is the "prod @ …" reference on screens 7/10/12),
           created_at,
           pushed_at, rolled_back_at, conflict_json
push_runs: id, change_id (FK), status, steps_json, log_text, started_at, finished_at
```

Plus the fold-in migration: `CREATE INDEX idx_agent_events_session ON agent_events(session_id)`.

**PushManager** (sibling of Sync/AgentManager): `start(changeId, {force})` → guards (per-site
mutual exclusion: sync, agent turn, and push are pairwise exclusive — 409 otherwise) →
runs `engine.push()` with a step callback → streams `push_step`/`push_log`/`push_done` over a
per-site SSE channel (same hijack + heartbeat + flush pattern as sync/agent SSE) and persists
to `push_runs`. The six steps are screen 9's, verbatim: staging → hashes → drift → swap+backup →
journal transaction → smoke. Steps 3–5 execute inside the single `/commit` call; their step
events (with durations) emit in order from its per-step results when it returns — the spinner
sits on the commit call as a whole, which is seconds. Smoke = HTTP checks against production public URLs from the server
(no plugin involvement); any failure → `engine.rollback()` → status `rolled_back` with reason.
Boot recovery: `pushing` at server start resolves via `GET /tx` (commit landed → verify + mark;
dirty → rollback), mirroring sync's restart recovery.

**HTTP API** (all `requireUser` + site ownership):

- `GET  /api/sites/:id/changes` (+ status filter) · `GET /api/sites/:id/changes/:seq`
- `POST /api/sites/:id/changes/:seq/push` `{force?}` → 202; `POST …/rollback`; `POST …/discard`
- `POST /api/sites/:id/changes/:seq/retry` → posts the conflict table into the agent session as
  a message (AgentManager); the conflicted change stays `conflict`; the agent's adjusted fix
  becomes a **new** change (design shows CHANGE-0008 as its own object).
- `GET  /api/sites/:id/push/events?after=` → SSE.

**Runbook CLI:** a thin `ferry push` entry point driving `engine.push()` from a change spec,
for the 5a acceptance runbook — no server required. Kept minimal; the dashboard is the product
path.

**Fold-ins (5a):**
- `verifyClone` gets a bounded retry: up to ~30s total, short backoff, retrying on connection
  errors and 5xx — covers DDEV's ~5s 502 window during container restart at end of pull
  (`engine.ts:34`, observed failing healthy syncs in Plan 4 acceptance).
- `runner_error` detail: customer-facing `status` event gets a generic message ("The agent hit
  an internal error — try again or start a new session."); the raw error is logged server-side
  with site/session ids (`manager.ts:167`).
- `agent_events` index (above).

## Dashboard (5b — screens 6–12, English copy per design)

- **Changes tab** `/sites/:id/changes`: filter pills (all/draft/pushed/rolled back), compact
  rows per screen 7 (draft = amber border + amber pill; pushed = green; rolled back = red "↺").
  Sidebar "Changes" badge = draft count.
- **Change page** `/sites/:id/changes/:seq`: the expanded card, state-switched per screens
  8 (draft: diff blocks, DB journal table with risk chip, preconditions, drift/smoke strip,
  Discard + Push to production), 9 (pushing: six-step list + live log over SSE, elapsed pill),
  10 (pushed: smoke results with metrics, Applied/Backup facts, outlined-red "↺ Roll back",
  retention note), 11 (conflict: read-set table expected/now, Retry [recommended] + Force
  [danger, confirm dialog]; "Push the code only" not rendered), 12 (rolled back: verification
  rows, "Back to chat" + "Let the agent adjust it").
- **Inline card in chat** (screen 6 anatomy) rendered from the persisted `change_card` event;
  "View diff" navigates to the change page. Composer and chat stay usable.
- **Tokens:** `--amber`/`--amber-weak` finally in use (draft signal); add `--amber-ink:
  oklch(0.45 0.1 68)` replacing the design's hardcoded literal. No cost UI.

## Error handling

- Commit call timeout → `GET /tx` resolves; `dirty` → rollback (restore backup) → the change
  returns to `draft` with an explanatory status line. Never an unknown end state.
- Conflict → nothing applied (plugin guarantees), status `conflict` with the per-key table.
- Rollback CAS mismatch (prod edited after push on the same files/keys) → refuse with a
  conflict message; never clobber.
- Push attempted while site is syncing / agent mid-turn → 409, button disabled with reason.
- SSE disconnect/reconnect follows the existing sync/agent patterns (persisted events replay).

## Testing

- **Plugin (PHPUnit):** nonce atomicity + canonical change, staging path guards + denylist,
  commit happy path / file drift conflict / DB verify failure (renames reversed, transaction
  rolled back), force mode, rollback + rollback-CAS, tx status, retention pruning. Temp-dir
  filesystems, `FakeWpdb`.
- **Engine (vitest):** binlog parser against fixture outputs from the spike; push orchestration
  against a fake signed client; verifyClone retry timing.
- **Server:** PushManager lifecycle with a scripted push-runner seam via `AppDeps` (exactly the
  `AgentRunner` pattern — CI never needs credentials); route auth/ownership; SSE replay; boot
  recovery via faked `/tx`.
- **Dashboard (Playwright):** card render from scripted events, push progress states, conflict
  + force confirm, rollback, badge counts — against the scripted server.
- All existing suites stay green (ferry-cli 93, ferry-server 86, dashboard e2e 9).

## Acceptance (manual runbooks, real fixture)

- **5a (API-level, no UI):** fixture `ferry-prod`; make a change (agent or scripted); drive
  push via API/CLI; demonstrate: happy push, mid-push concurrent option change → conflict with
  nothing applied, force push, manual rollback, smoke-fail → automatic rollback.
- **5b (the §6 criterion):** install WooCommerce on the fixture (official zip discipline),
  seed products; run an order generator (checkout loop) for the whole session; plant a bug
  (the design's double-VAT hook is a fine script); agent investigates, fixes on its branch,
  creates the card; human clicks **Push to production**; prove afterwards: every order placed
  during the session intact (count + totals), fix live, and a deliberate manual drift run
  triggers the conflict path honestly. Proof queries listed in the runbook.

## Out of scope / deferred

Screenshots on the card (decision 2) · "Push the code only" (decision 3) · automatic read-set
logging (decision 5) · `schema_migrate` · multi-change stacking/rebasing UX (one draft at a
time is fine in v1) · cost UI · FastCDC, PAKE, provider choice (spec §14) · secure cookie flag
(whichever plan first deploys behind TLS) · public preview URLs.
