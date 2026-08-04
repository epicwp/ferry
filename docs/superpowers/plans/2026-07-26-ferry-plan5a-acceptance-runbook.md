# Plan 5a acceptance runbook — write-back engine against the real fixture

Run by a human (Robbert), against the real `ferry-prod` DDEV fixture. This is the last
task of Plan 5a; nothing here is simulated — every command hits the real plugin REST
routes, the real server API, and the real fixture database.

## Suite + typecheck results (feat/write-back @ 233d16a, this task's commit on top)

| Suite | Command | Result |
|---|---|---|
| ferry-plugin | `cd ferry-plugin && vendor/bin/phpunit` | **OK — 182 tests, 503 assertions** |
| ferry-cli | `npm --workspace ferry-cli run test` | **21 files, 132 tests passed** |
| ferry-cli typecheck | `cd ferry-cli && npx tsc -p tsconfig.json --noEmit` | clean, exit 0 |
| ferry-server | `npm --workspace ferry-server run test` | **19 files, 144 tests passed** |
| ferry-server typecheck | `npm --workspace ferry-server run typecheck` | clean, exit 0 |
| ferry-dashboard typecheck | `npm --workspace ferry-dashboard run typecheck` | clean, exit 0 |

`sync.test.ts` prints two `SSE listener error: Error: Listener error` lines to stderr —
that's an intentional throwing-subscriber test (asserts the manager doesn't crash when a
listener throws), not a failure; the file still reports all tests passed.

**Not run** (need the live fixture, which this runbook resets — that's this document's
own job, not something to pre-empt): `ferry-server/e2e/control-plane.ts`,
`ferry-dashboard`'s Playwright e2e.

---

## Preconditions

- Fixture running at `~/ferry-e2e/prod` (DDEV project `ferry-prod`, site
  `https://ferry-prod.ddev.site`). Prior clone at `ferry-prod-ddev-site` from an earlier
  plan's runbook.
- `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` **and**
  `export ANTHROPIC_API_KEY=<key>` (or a git-ignored `.env` at the repo root) —
  both in the shell that starts `ferry-server`. `NODE_EXTRA_CA_CERTS` only takes effect at
  Node process start (Task 4 finding, `.superpowers/sdd/2026-07-26-ferry-plan5a-write-back-engine/task-4-report.md`):
  exporting it later, or starting the dev server in a different shell, leaves every
  `verifyClone` call failing on a TLS trust error that no retry will fix.
- Optional: `FERRY_AGENT_MAX_BUDGET_USD=2` to cap the session.

## Step 0: fixture prelude

1. Delete the stale clone so the fresh-sync step below is a real cold pull, not a resync
   over old state:
   ```
   ddev delete -Oy ferry-prod-ddev-site
   ```
2. **Update the Ferry Connect plugin on the fixture from this branch.** This branch
   changed the signed-request canonical string (adds a nonce, `Auth::canonical` /
   `ferry-cli/src/signing.ts`) and added the write endpoints
   (`/stage`, `/commit`, `/rollback`, `/hashes`, `/tx`) — an old plugin on the fixture
   will 401 every signed call with "Invalid or expired request signature," not because
   pairing broke but because the two sides are computing different bytes to HMAC.
   ```
   cp ferry-plugin/ferry.php ~/ferry-e2e/prod/wp-content/plugins/ferry-connect/ferry.php
   rsync -a --delete ferry-plugin/src/ ~/ferry-e2e/prod/wp-content/plugins/ferry-connect/src/
   php -l ~/ferry-e2e/prod/wp-content/plugins/ferry-connect/ferry.php
   ```
   (No build/composer step — `ferry.php` self-registers a hand-rolled
   `spl_autoload_register`; `vendor/` in this repo is phpunit-only, a dev dependency.)
3. **If signed requests still 401 after the plugin update** ("Invalid or expired request
   signature," not a pairing/multisite error), the fixture's pairing state is stale
   relative to this branch — re-pair from scratch:
   ```
   sqlite3 ~/.ferry/server.db "UPDATE sites SET status='new' WHERE slug='ferry-prod-ddev-site';"
   ```
   then redo the pairing step below (dashboard "Pair" action + a fresh pairing code from
   the fixture). This resets the site row so `POST /api/sites/:id/pair` will accept a new
   code (it 409s on anything but `new`/`refused_multisite`); `ferry link` itself always
   overwrites the local profile with a fresh secret on a successful pair, so no manual
   profile edit is needed.

## Step 1: dev servers, signup, pairing, fresh sync

1. `npm --workspace ferry-server run dev` (in the shell from Step 0.3's exports) and
   `npm --workspace ferry-dashboard run dev`.
2. Sign up at `http://localhost:5173`, add `https://ferry-prod.ddev.site`, pair using
   the code from `cd ~/ferry-e2e/prod && ddev wp eval 'print(json_encode(\Ferry\Auth::issue_pairing_code()));'`.
3. Also log in via curl, for the API-level steps later (same email/password as signup):
   ```
   curl -s -c /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/auth/login \
     -H 'Content-Type: application/json' -d '{"email":"<email>","password":"<password>"}'
   SITE=$(curl -s -b /tmp/ferry-cookies.txt http://localhost:4000/api/sites | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')
   echo "site id: $SITE"
   ```
4. Run the sync from the dashboard (or `curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/sync`)
   to Ready.
   - **PASS**: the clone comes up and `verifyClone` succeeds live — this is the exact
     502-during-DDEV-restart window Task 4 instrumented. Watch
     `GET /api/sites/$SITE/sync/events` (dashboard does this already) for the sync
     reaching `ready` without a manual retry. If it fails with a TLS message, that's
     Step 0's precondition not met in this shell — restart the dev server with the CA
     cert exported first.

## Step 2: agent session — small fix #1, `db_journal`, `create_change` (happy path)

Open the site's Agent chat in the dashboard.

1. Ask: *"The site tagline looks stale — can you update it to something better?"*
   - PASS: the agent states a plan, reads the current value (`ddev wp option get
     blogdescription` inside the clone), updates it (`ddev wp option update
     blogdescription "<new text>"`), verifies, and reports back.
2. Once it confirms the fix, ask it to finalize: *"Looks good — please check `db_journal`
   and create the change card."*
   - The agent calls `db_journal` — the tool_use event's name is the SDK's fully-qualified
     form, `mcp__ferry__db_journal` (server name `ferry`, per `createSdkMcpServer({name:
     'ferry', ...})` in `sdk-runner.ts` — grep the chat stream for `mcp__ferry__` if
     watching tool_use events directly). It returns every typed DB op recorded in the
     clone **since the last sync**, not just this turn's; it must curate to just the
     tagline op. Watch its reasoning here: it should discard anything unrelated (there
     shouldn't be anything yet, since this is the first write since Step 1's sync).
   - It then calls `create_change` (`mcp__ferry__create_change`) with a title/summary, `ops: [{kind:'option_set',
     name:'blogdescription', old:'<V0>', new:'<V1>'}]`, a `preconditions` entry
     `{type:'option', name:'blogdescription', expected:'<V0>'}`, and a `smoke` check
     (e.g. `{label:'homepage', path:'/', expectStatus:200}`).
   - **PASS**: a `change_card` system event appears in the chat stream
     (`GET /api/sites/$SITE/agent/events`); the agent states it cannot push (no push
     tool — that's the human's call).
3. Inspect the created change (no dashboard card yet — that's Plan 5b; this is the 5a
   way, per the task brief):
   ```
   curl -s -b /tmp/ferry-cookies.txt http://localhost:4000/api/sites/$SITE/changes/1
   ```
   - **PASS**: `status: "draft"`, `ops` contains the one curated `option_set`,
     `preconditions` contains the matching `option` precondition.

## Step 3: push change #1 via the API, SSE watched live (happy path)

Terminal A — watch the stream first, so no events are lost between subscribe and the
push actually starting:
```
curl -N -b /tmp/ferry-cookies.txt http://localhost:4000/api/sites/$SITE/push/events
```

Terminal B — start the push:
```
curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/changes/1/push
```
- **PASS**: Terminal A shows a `push_step` event per `staging`/`hashes`/`drift`/`swap`/
  `journal`/`smoke` (each `start` then `ok`), then one `push_done`:
  `{"status":"pushed","txid":"...","smoke":[{"label":"homepage","ok":true,...}]}`.
- Verify the change: `curl -s -b /tmp/ferry-cookies.txt http://localhost:4000/api/sites/$SITE/changes/1`
  → `status: "pushed"`, `prodRef` set.
- Verify production directly, and save the hash for later comparisons:
  ```
  cd ~/ferry-e2e/prod
  V1_HASH=$(ddev wp option get blogdescription | shasum -a 256)
  echo "$V1_HASH"   # keep this around — Steps 7 and 8 compare against it
  ```

## Step 4: agent session — small fix #2 (sets up the conflict demo; recreated in Step 6 for force/rollback)

In the same chat: *"Let's tweak the tagline once more."* The agent edits the clone's DB
again (its local truth is still V1, matching production), curates `db_journal` again
(now two option_set entries exist since the last sync — the V0→V1 one from Step 2 and
this new V1→V2 one; the agent must pick only the latter), and calls `create_change`
again → this becomes change **seq 2**, `ops: [{option_set, old:'<V1>', new:'<V2>'}]`,
precondition `expected:'<V1>'`.

Confirm: `curl -s -b /tmp/ferry-cookies.txt http://localhost:4000/api/sites/$SITE/changes/2`
→ `status: "draft"`.

**Do not push yet** — proceed to the conflict demo first.

## Step 5: conflict demo — manual drift on the FIXTURE, then push

1. On the **fixture** (production, not the clone), drift the same option out from under
   the drafted change:
   ```
   cd ~/ferry-e2e/prod
   ddev wp option update blogdescription "manually edited on prod, mid-flow"
   ```
2. Push change 2 (no force):
   ```
   curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/changes/2/push
   ```
   - **PASS**: the SSE stream (Terminal A) shows `staging`/`hashes` steps only (the
     server's `/commit` call returns `committed:false` before any backup/swap/journal
     step runs, and `push.ts` returns immediately on that — no further per-step events
     are emitted for a conflict), then `push_done`:
     `{"status":"conflict","txid":"...","conflicts":[{"key":"option:blogdescription","expected":"<V1>","found":"manually edited on prod, mid-flow"}]}`.
   - `curl -s -b /tmp/ferry-cookies.txt http://localhost:4000/api/sites/$SITE/changes/2`
     → `status: "conflict"`, `conflict` array present with that same key.
3. **Verify nothing applied** — hash the production value now and confirm it's still the
   drifted string, untouched by the failed push:
   ```
   cd ~/ferry-e2e/prod
   ddev wp option get blogdescription | shasum -a 256
   # expected: still "manually edited on prod, mid-flow"'s hash, NOT V1's and NOT V2's
   ```

**Change 2 stays `conflict` — permanently.** Nothing in the store ever transitions a
`conflict` change back to `draft` (`store.ts` has no such write path), and the push route
itself refuses on status before it even reads the request body
(`routes/changes.ts:51`: `if (change.status !== 'draft') return 409` runs *before* the
`force` flag is read) — so `force` is "skip the drift compare on a draft's first push,"
never "recover a change that already conflicted." The designed recovery for a `conflict`
change is `POST /api/sites/$SITE/changes/2/retry` (`routes/changes.ts:91-104`), which
posts the conflict table into the agent chat as a fresh message and lets the agent decide
what to do next — see the optional demo at the end of this document. Change 2 itself is
otherwise done; the force/rollback demo below uses a **new** change (seq 3), not change 2.

## Step 6: force-push demo — recreate the same fix as a fresh draft, then force it through

The clone was never told about the manual drift on production (the agent has no tool
that reads production state — `site_info` is environment facts, not option values) — so
asking it to redraft the *identical* fix, with no new edit inside the clone, naturally
reproduces the same stale expectation (`old:'<V1>'`) as change 2 had. In the chat:

*"That last push conflicted and got refused — let's just try it again as a fresh change
card. Nothing needs to change in the clone itself; recheck `db_journal` and create a new
change for the same fix."*

- The agent calls `db_journal` again — with no new clone write since change 2 was
  drafted, this returns the exact same op it saw before (`journalCandidates` is a pure
  re-read of the binlog from the fixed sync-position, not a "mark consumed" operation),
  so it curates to the same `option_set old:'<V1>' new:'<V2>'`. It calls `create_change`
  again → **seq 3**, `status: "draft"`, same ops/precondition as change 2.
- Confirm: `curl -s -b /tmp/ferry-cookies.txt http://localhost:4000/api/sites/$SITE/changes/3`
  → `status: "draft"`.

Now push it **with force, on its first attempt** (status is `draft`, so the route guard
passes; `force` is what skips the drift compare this time):
```
curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/changes/3/push \
  -H 'Content-Type: application/json' -d '{"force":true}'
```
- **PASS**: `push_done` reports `{"status":"pushed",...}` — both the file-drift check and
  the DB read-set compare are skipped under `force` (the row lock is still taken, just
  not compared against `expected`). Verify:
  ```
  cd ~/ferry-e2e/prod && ddev wp option get blogdescription
  ```
  → now `<V2>` (change 3's target value) — force overwrote the manual drift
  unconditionally, never even reading what the drifted value was.

## Step 7: manual rollback

Change 3 is now `status: "pushed"`, so it (not change 2) is the one the rollback route
will accept:
```
curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/changes/3/rollback
```
- **PASS**: `{"rolledBack":true}`; `GET .../changes/3` → `status: "rolled_back"`.
- **Fixture restored byte-identical** — rollback inverts change 3's own recorded ops
  (`old:'<V1>'`), so production should be back to exactly V1, the same value as right
  after Step 3's push:
  ```
  cd ~/ferry-e2e/prod
  ddev wp option get blogdescription | shasum -a 256
  ```
  Compare this against `$V1_HASH` captured in Step 3 — **must match exactly**.

## Step 7.5: resync before the next fix

The clone's local DB is still sitting at `<V2>` (nothing in Steps 5–7 touched the
clone itself — only production, via curl and direct `ddev wp` on the fixture) while
production is back at `<V1>`. Drafting a further fix straight from here would give it a
stale `old:'<V2>'`, which would misfire as a spurious conflict against the now-correct
`<V1>` in Step 8. Resync first — this also happens to be a second live exercise of the
Task 4 `verifyClone` fix, and it resets `db_journal`'s baseline (the binlog position is
recorded at sync/pull time), so Step 8 won't need to pick through Steps 4–7's now-stale
entries:
```
curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/sync
```
- **PASS**: reaches `ready` (watch `GET /api/sites/$SITE/sync/events` or the dashboard);
  `cd ~/ferry-e2e/prod && ddev wp option get blogdescription` inside the **clone**
  (`ddev describe` or the dashboard's clone URL to confirm you're targeting the clone,
  not the fixture) now reads `<V1>`, matching production again.

## Step 8: smoke-fail demo — automatic rollback

In the chat: *"One more tagline tweak — and for this one, set the smoke check's
`expectStatus` to 599 so we can test what happens when a smoke check fails after push."*
The agent updates the clone's DB (`<V1>`→`<V3>`), curates `db_journal` (just this one op —
Step 7.5's resync reset the baseline, so there's no stale history to pick through this
time), and calls `create_change` with
`smoke: [{label:'deliberately impossible', path:'/', expectStatus:599}]`. This becomes
change **seq 4**, precondition `expected:'<V1>'` — matching production exactly, no drift.

Push it (first attempt, no force needed):
```
curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/changes/4/push
```
- **PASS**: SSE shows `staging`/`hashes`/`drift`/`swap`/`journal` all `ok` (the commit
  itself succeeds — production briefly holds `<V3>`), then `smoke` → `fail` (no real
  response is ever `599`), then `push_done`:
  `{"status":"rolled_back","txid":"...","reason":"smoke_failed","smoke":[{"label":"deliberately impossible","ok":false,...}]}`
  — this is the **automatic** rollback path (`ferry-cli/src/push.ts`'s own `rollback()`
  call inside `push()`), distinct from Step 7's manual one.
- `GET .../changes/4` → `status: "rolled_back"`.
- Verify production reverted on its own, no human rollback call needed:
  ```
  cd ~/ferry-e2e/prod
  ddev wp option get blogdescription | shasum -a 256
  ```
  Compare against `$V1_HASH` again — **must match** (back to V1, same as Steps 3 and 7).

## Optional appendix: the designed conflict-recovery route (`/retry`)

Not required for acceptance, and deliberately run **after** every numbered step above so
it can't shift any seq numbers those steps depend on. Change 2 is still sitting at
`status: "conflict"` from Step 5:
```
curl -s -b /tmp/ferry-cookies.txt -X POST http://localhost:4000/api/sites/$SITE/changes/2/retry
```
- **PASS**: `{"queued":true}`; the chat stream gets a new message rendering the conflict
  as a `key | expected | found` table (`conflictMessage()` in `routes/changes.ts:9-15`)
  ending in "Please investigate the drift and create a new change." The agent may act on
  it and draft another change card — if it does, that's an extra seq number beyond 4;
  no further verification of it is needed for this runbook.

---

## Human gates (not satisfied by this runbook)

- **Security skim checkpoint B** (`docs/2026-07-26-ferry-plugin-security-skim.md`) is
  still marked `Status: NOT DONE — blocking` in that document as of this task. It must be
  completed and signed off (checklist + SHA + date) **before this branch merges** — this
  runbook exercises the write path functionally but is not a substitute for the code
  skim (staging-dir execution risk, write-path denylist, wp-config backup-copy
  exfiltration, etc. — see that doc's checklist).
- **This runbook itself is run by a human**, against the real fixture, not automated —
  that is the point of Task 14. A clean run through Steps 0–8 (all PASS bullets true) is
  the acceptance signal for Plan 5a; it does not by itself satisfy the security gate
  above.
