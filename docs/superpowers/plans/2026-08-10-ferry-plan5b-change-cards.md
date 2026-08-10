# Ferry Plan 5b — Change Cards (screens 6–12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard change-card surface — Changes tab, change detail page in five states (draft / pushing / conflict / pushed / rolled back), and the inline card in chat — over the Plan 5a API, plus the three issue-#9 fold-ins that touch this UI.

**Architecture:** Pure dashboard feature over existing 5a server routes, with seven small server fold-ins: scripted-push-runner faithfulness (duplicate `drift` start), visible runner errors, agent/work reset after sync, persisted smoke results, a drift-preview route, a force-on-conflict route guard fix, and turn-scoped push exclusivity. All UI is Playwright-tested against the e2e server (real `buildApp()` + scripted runners + a test-only seed route); no real pushes, no API keys, no DDEV except the existing gate test.

**Tech Stack:** React 19 + react-router 7 + Vite (ferry-dashboard), Fastify + better-sqlite3 (ferry-server), vitest (server), Playwright (dashboard e2e). No new dependencies.

**Branch:** `feat/change-cards` off `main` (482afcd).

## Global Constraints

- One human click to production; the agent never pushes (spec decision 7). The Push/Force/Rollback/Retry buttons are the only mutation paths, all behind `requireUser`.
- Typed ops only; DB content never crosses; no schema changes; multisite refused (standing decisions — untouched here, no plugin changes in this plan).
- Timeouts are answers: every UI state renders honestly from server data; no fake "unchanged"/"passed" claims without a data source.
- Rollback button stays visible (screen 10 + 30-day retention note).
- Never render a clickable clone URL (`a[href*="ddev.site"]` count must stay 0 — asserted in e2e).
- No cost UI on screens 6–12 (spec decision 8).
- UI copy is English, verbatim from the design where listed in tasks below.
- New token `--amber-ink: oklch(0.45 0.1 68)`; use `--amber`/`--amber-weak` for the draft signal (spec §Dashboard).
- ferry-dashboard `tsconfig` has `noUnusedLocals: true` — unused imports fail the build.
- Playwright: `workers: 1`, e2e server on :4173, `npm --workspace ferry-dashboard run e2e` builds first.
- All existing suites stay green: plugin 203, cli 141, server 159 (+new), dashboard e2e 9 (+new).
- Fixture discipline: never `ddev wp core download` on `~/ferry-e2e/prod` (official zip only). The gate e2e test uses the fixture via `FERRY_E2E_PROD`.

## Decisions (deviations & gap fixes — for sign-off)

1. **Screen 9 "live log" renders from `push_step` events.** 5a never implemented `push_log`; the wire has only `push_step`/`push_done`. Log lines = client-timestamped step transitions + `detail` when present. No server change.
2. **Screen 11 renders Retry + Force only.** The design's middle option "Push the code only" is not rendered (spec decision 3, explicit).
3. **Force-on-conflict route guard fix (5a gap).** `POST …/push` currently 409s anything not `draft` — but screen 11's Force button pushes a `conflict`-status change. Guard becomes: `draft` always pushable; `conflict` pushable only with `force: true`. Server change + tests (Task 10).
4. **Risk chip derived client-side.** `ops_json` carries no risk class; derive from op kind (option_*/postmeta_* → "low risk" green; any row_* → "higher risk" amber). Additionally, per spec decision 9 (higher-risk ops need explicit human confirmation), a draft containing row_* ops routes its Push button through the confirm dialog.
5. **Drift preview wired end-to-end.** 5a built plugin `POST /ferry/v1/hashes` explicitly for the card's drift line but exposed no server route. Add optional `PushRunner.hashes()`, a `GET …/changes/:seq/drift` route, and honest UI states (checking / unchanged / drifted / couldn't check). The inline chat card does NOT call it (one plugin roundtrip per chat render is too chatty); its drift row reads "verified at push time inside the write transaction".
6. **Smoke results persisted** (`smoke_result_json`, migration-guarded ALTER TABLE). Today `PushOutcome.smoke` only rides the SSE `push_done` — a pushed change page loaded later couldn't show screen 10's smoke rows honestly. Written on `pushed`/`rolled_back` outcomes; `null` (e.g. boot recovery) renders "smoke status unknown after a server restart — verify manually."
7. **agent/work reset after sync (issue #9c root fix — the "Decide:" item).** After a successful sync, `production` holds current prod (including pushed fixes). If the worktree is clean AND the site has no `draft`/`conflict`/`pushing` change, `agent/work` is reset to `production`. Draft-linked commits are never dropped (a draft's push stages blobs from clone git at `headSha`). Plus the "at minimum" half: the card UI renders `files_json` fully and derives every count from it — no invented "this session" claims.
8. **Step timeline is state-keyed, not append-only (issue #9a UI half).** The real runner emits `drift start` twice (crash-classification marker at `push.ts:124` + re-emission at `:171`); the reducer keys by step id so duplicate starts are no-ops. The scripted runner becomes faithful (13 events) so e2e proves the dedupe (Task 1).
9. **Runner auth errors become visible (issue #9b).** `normalize.ts` maps assistant text matching `/^API Error\b/` (the SDK's synthetic error-message shape — verify against `docs/superpowers/specs/2026-07-26-agent-sdk-pins.md` when implementing) to `runner_error` instead of `agent_text`; the manager already converts that to a generic `status {state:'error'}`. Chat renders `state:'error'` status events red.
10. **List-view pragmatics.** `GET /changes` returns full rows (diffs included) — accepted at v1 volumes, no projection route. List rows drop the design's "drift ✓" meta fragment (a live preview per row would be N plugin roundtrips; the detail page owns drift). "all" filter excludes `discarded`. Conflict rows (absent from screen 7's fixture) get a red "!" icon square + `conflict` pill, consistent with screen 11.
11. **Fixture-specific design copy is generalized** where it names the VAT storyline: screen 9 title → "Pushing to production", screen 10 sub → "The change is live and all smoke checks passed.", screen 10 meta drops "took 5.8s" (no duration column exists), screen 11 explanation line → "Production changed after this fix was drafted, so the fix's assumptions no longer hold." Ops-table key column renders `options · {name}` / `postmeta · post {id} · {key}` / `{table} · {pkCol}={pk}` (the clone-side table prefix isn't known client-side, so the design's `wp_options` literal can't be reproduced honestly).
12. **Elapsed pill is client-measured** from when the page first observes the `pushing` state (a mid-push reload restarts it; `push_runs.started_at` isn't exposed and this isn't worth a route).
13. **Turn-scoped push exclusivity (5a gap — blocks the hero flow).** `isActive` is hot-session-scoped (30 min idle default), so the push route 409s for up to 30 minutes after any chat — chat → card → Push would never work, nor would the §6 one click. The push guard switches to a new `isMidTurn` (session status `running`), matching the spec's "agent **turn**" wording. The sync route's stricter hot-session guard is pre-existing Plan-4 behavior and stays untouched (noted, not changed).

## File Structure

**ferry-server (fold-ins):**
- Modify: `src/push/scripted-push-runner.ts` (drift marker, `hashes`)
- Modify: `src/agent/normalize.ts` (API-error branch), `src/agent/scripted-runner.ts` (magic prompt)
- Modify: `src/agent/branch.ts` (`resetAgentBranchIfIdle`), `src/sync.ts` (`afterReady` hook), `src/app.ts` (wiring)
- Modify: `src/store.ts` (smoke_result_json migration + patch field), `src/push-manager.ts` (persist smoke)
- Modify: `src/engine.ts` (`realPushRunner.hashes`), `src/push/types.ts` (optional `hashes`), `../ferry-cli/src/push-types.ts` (named `SmokeResult`)
- Modify: `src/routes/changes.ts` (drift route, force-on-conflict guard, turn-scoped push guard), `src/agent/manager.ts` (`isMidTurn`)
- Tests: `tests/changes-routes.test.ts`, `tests/push-manager.test.ts`, `tests/normalize.test.ts` (or the file that holds normalize tests), `tests/branch.test.ts` / `tests/sync.test.ts` (follow existing homes), `tests/store.test.ts`

**ferry-dashboard:**
- Modify: `src/api.ts` (types + helpers), `src/ui.css` (`--amber-ink` + changes/modal/diff CSS), `src/main.tsx` (2 routes), `src/pages/site.tsx` (Changes link + badge), `src/chat.tsx` (change_card + error status)
- Create: `src/change-parts.tsx` (changeRef, timeAgo, StatusPill, riskOf, parseDiff/DiffView, OpsTable, ConfirmDialog, InlineChangeCard)
- Create: `src/pages/changes.tsx` (screen 7), `src/pages/change.tsx` (screens 8–12)
- Modify: `e2e/server.ts` (push dep, slug-dispatch runner, manager capture, `/e2e/changes` seed route)
- Create: `e2e/changes.spec.ts`; Modify: `e2e/dashboard.spec.ts` (gate-test 5b section)

**Docs:** Create `docs/runbooks/2026-08-10-plan5b-acceptance.md` (§6 runbook, Task 13).

## Interfaces produced (used across tasks)

- `PushRunner.hashes?(slug: string, paths: string[]): Promise<Record<string, string | null>>` — scripted impl returns `` `scripted-${path}` `` per path.
- `SmokeResult { label: string; ok: boolean; detail?: string }` (ferry-cli/src/push-types.ts, reused inside `PushOutcome`).
- `Change.smokeResult: SmokeResult[] | null` (server store + dashboard mirror).
- `GET /api/sites/:id/changes/:seq/drift` → `{ checked: number; mismatches: string[] }` | 409 (non-draft) | 502 (unreachable).
- e2e seed: `POST /e2e/changes` `{ siteId, fields?, status?, conflict?, smokeResult?, backupTxid?, prodRef?, emitCard? }` → `Change`.
- Dashboard api.ts: `listChanges(siteId, status?)`, `getChange(siteId, seq)`, `pushChange(siteId, seq, force?)`, `rollbackChange`, `discardChange`, `retryChange`, `driftPreview` + mirrored types (`Change`, `ChangeStatus`, `DbOp`, `Precondition`, `SmokeCheck`, `SmokeResult`, `ChangeFile`, `Conflict`, `PushStep`, `StepEvent`, `PushWireEvent`, `DriftPreview`).
- `change-parts.tsx` exports: `changeRef(seq)`, `timeAgo(iso)`, `StatusPill({status})`, `riskOf(ops)`, `DiffView({diffText})`, `OpsTable({ops})`, `ConfirmDialog({title, body, confirmLabel, danger, onConfirm, onCancel})`, `InlineChangeCard({siteId, changeSeq, title})`.

---

### Task 1: Scripted push runner faithfulness — duplicate `drift` start

The real push emits `drift start` twice (crash-classification marker at `ferry-cli/src/push.ts:124`, then the regular re-emission via `emitCommitStep` at `:171-173`): 13 `push_step` events on a happy path, not 12. The fake must match or the 5b UI would only ever be tested against a sequence production never produces.

**Files:**
- Modify: `ferry-server/src/push/scripted-push-runner.ts`
- Test: `ferry-server/tests/changes-routes.test.ts` (assertions at lines 251 and 277)

**Interfaces:** unchanged (`PushRunner`).

- [ ] **Step 1: Update the two count assertions to expect 13 and add a drift-dedupe-relevant assertion**

In `ferry-server/tests/changes-routes.test.ts`, change both `toHaveLength(12)` assertions (lines 251, 277) to:

```ts
    expect(events.filter((e) => e.type === 'push_step')).toHaveLength(13); // 6 steps x (start + ok) + the drift crash-marker start (push.ts:124)
```

and in the first of the two tests, after that line add:

```ts
    const driftStarts = events.filter((e) => e.type === 'push_step')
      .map((e) => e.payload as StepEvent)
      .filter((p) => p.step === 'drift' && p.status === 'start');
    expect(driftStarts).toHaveLength(2); // faithful to the real runner — the UI must dedupe
```

(`StepEvent` is already importable in that file from `../src/push/types.js`; add it to the import if absent.)

- [ ] **Step 2: Run to verify both tests fail**

Run: `npm --workspace ferry-server run test -- changes-routes`
Expected: FAIL — received length 12.

- [ ] **Step 3: Emit the marker in the scripted runner**

In `ferry-server/src/push/scripted-push-runner.ts`, inside the `for (const step of STEPS)` loop, before the existing `opts.onStep({ step, status: 'start' })`:

```ts
        // Faithful to push.ts:124: the real runner emits an extra 'drift' start immediately
        // before the single /commit call (crash classification) — consumers see two starts.
        if (step === 'drift') opts.onStep({ step: 'drift', status: 'start' });
```

- [ ] **Step 4: Run the full server suite**

Run: `npm --workspace ferry-server run test`
Expected: PASS everywhere. If any other test counts `push_step` events (grep `toHaveLength(12)` / `push_step` under `ferry-server/tests/`), align it with the 13-event reality — the fake changed to match production, so count fixes are correct, not test-weakening.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/push/scripted-push-runner.ts ferry-server/tests/changes-routes.test.ts
git commit -m "fix(server): scripted push runner emits the drift crash-marker start like the real runner (issue #9)"
```

### Task 2: Visible runner errors — normalize branch + scripted magic prompt + red chat status

Issue #9b: a 401 from the Anthropic API surfaces as a plain `agent_text` after a long delay. The SDK renders API failures as a synthetic assistant text message starting with `API Error` (verify the exact shape against `docs/superpowers/specs/2026-07-26-agent-sdk-pins.md` — if the pins doc records a different literal, match that instead and note it in the ledger). Route that shape into the existing `runner_error` → `status {state:'error'}` path; render error statuses red in chat.

**Files:**
- Modify: `ferry-server/src/agent/normalize.ts`, `ferry-server/src/agent/scripted-runner.ts`
- Modify: `ferry-dashboard/src/chat.tsx`
- Test: the server test file that covers `normalizeSdkMessage` (grep `normalizeSdkMessage` under `ferry-server/tests/`; add alongside), gate e2e in Task 12 asserts the UI end of it.

**Interfaces:**
- Consumes: `RunnerEvent {type:'runner_error', message}` (`agent/types.ts`), manager handling at `agent/manager.ts:167-171`.
- Produces: scripted runner magic prompt `trigger-runner-error`; chat `status` blocks carry `isError`.

- [ ] **Step 1: Write the failing normalize test**

In the existing normalize test file:

```ts
  it('maps an API-error assistant message to runner_error, not agent_text', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' }] },
    });
    expect(events).toEqual([{ type: 'runner_error', message: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}' }]);
  });

  it('still maps ordinary assistant text to agent_text', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'API errors are worth retrying.' }] },
    });
    expect(events).toEqual([{ type: 'agent_text', text: 'API errors are worth retrying.' }]);
  });
```

- [ ] **Step 2: Run to verify the first fails**

Run: `npm --workspace ferry-server run test -- normalize`
Expected: FAIL — received `agent_text`.

- [ ] **Step 3: Implement the branch in normalize.ts**

In the `m.type === 'assistant'` text-block branch (`normalize.ts:38-39`), replace the single `out.push` with:

```ts
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          // The SDK surfaces API failures (401s etc.) as a synthetic assistant message rather
          // than throwing — without this branch they render as ordinary agent prose (issue #9).
          if (/^API Error\b/.test(block.text)) {
            out.push({ type: 'runner_error', message: block.text });
          } else {
            out.push({ type: 'agent_text', text: block.text });
          }
        } else if (block?.type === 'tool_use') {
```

- [ ] **Step 4: Run server suite**

Run: `npm --workspace ferry-server run test`
Expected: PASS.

- [ ] **Step 5: Scripted runner magic prompt (for the gate e2e)**

In `ferry-server/src/agent/scripted-runner.ts`, at the top of `send(text)`:

```ts
        send(text: string): void {
          if (text === 'trigger-runner-error') {
            // e2e hook: exercise the runner_error → status{state:'error'} path without an SDK.
            emit({ type: 'runner_error', message: 'API Error: 401 (scripted)' }, 10);
            return;
          }
```

- [ ] **Step 6: Chat renders error statuses red**

In `ferry-dashboard/src/chat.tsx`: extend the Block union member (`chat.tsx:12`) to `{ kind: 'status'; key: string; text: string; isError?: boolean }`; in `buildBlocks`'s `case 'status':` set it:

```ts
      case 'status':
        flushTools();
        blocks.push({
          kind: 'status', key,
          text: String(event.payload.detail ?? event.payload.state ?? ''),
          isError: event.payload.state === 'error',
        });
        break;
```

and in the render branch (`chat.tsx:196-198`):

```tsx
          if (block.kind === 'status') {
            return (
              <div key={block.key} className={block.isError ? 'chat__status chat__status--error mono' : 'chat__status mono'}>
                {block.text}
              </div>
            );
          }
```

- [ ] **Step 7: Typecheck + build the dashboard**

Run: `npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run build`
Expected: clean. (The e2e assertion for this lands in the Task 12 gate-test section, where a live chat exists.)

- [ ] **Step 8: Commit**

```bash
git add ferry-server/src/agent/normalize.ts ferry-server/src/agent/scripted-runner.ts ferry-server/tests ferry-dashboard/src/chat.tsx
git commit -m "fix(server,dashboard): surface SDK API errors as a visible error status in chat (issue #9)"
```

### Task 3: agent/work reset after a successful sync (issue #9c root fix)

`agent/work` accumulates commits forever (`branch.ts:12-13` — "never reset"), so every card re-diffs old sessions' work. After a sync, `production` holds current prod content (including pushed fixes) — that is the one safe moment to reset, guarded twice: clean worktree, and no `draft`/`conflict`/`pushing` change rows (a draft's push stages blobs from clone git at its `headSha`; never orphan them).

**Files:**
- Modify: `ferry-server/src/agent/branch.ts`, `ferry-server/src/sync.ts`, `ferry-server/src/app.ts`
- Test: wherever `ensureAgentBranch`/`hasUncommittedAgentWork` tests live (grep under `ferry-server/tests/`; follow that file's temp-git-repo pattern), plus the sync test file for the hook.

**Interfaces:**
- Produces: `resetAgentBranchIfIdle(cloneDir): Promise<boolean>`; `SyncManager` constructor gains `opts?: { afterReady?: (site: Site) => Promise<void> }`.

- [ ] **Step 1: Write failing branch tests** (same temp-repo helper style as the existing branch tests; each repo needs an initial commit on `production` and a distinct commit on `agent/work`)

```ts
  it('resets agent/work to production when the worktree is clean', async () => {
    // repo: production at C1; agent/work at C2 (committed file), clean tree, HEAD on agent/work
    expect(await resetAgentBranchIfIdle(dir)).toBe(true);
    expect(await revParse(dir, 'agent/work')).toBe(await revParse(dir, 'production'));
  });

  it('does not reset when the worktree is dirty', async () => {
    // repo as above + an uncommitted edit
    expect(await resetAgentBranchIfIdle(dir)).toBe(false);
    expect(await revParse(dir, 'agent/work')).not.toBe(await revParse(dir, 'production'));
  });

  it('is a no-op without an agent/work branch and on a non-git dir', async () => {
    expect(await resetAgentBranchIfIdle(bareProductionOnlyDir)).toBe(false);
    expect(await resetAgentBranchIfIdle('/nonexistent')).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure** — `npm --workspace ferry-server run test -- branch` → FAIL (function not defined).

- [ ] **Step 3: Implement in branch.ts**

```ts
/** After a successful sync, `production` holds current prod content (including anything
 *  already pushed), so accumulated agent commits are safe to drop — IF the worktree is clean.
 *  The caller additionally guards on "no draft/conflict/pushing change rows" (issue #9:
 *  per-card file scoping); this function only owns the git-level safety checks. */
export async function resetAgentBranchIfIdle(cloneDir: string): Promise<boolean> {
  try {
    const exists = await git(cloneDir, 'branch', '--list', BRANCH);
    if (exists === '') return false;
    const status = await git(cloneDir, 'status', '--porcelain');
    if (status !== '') return false;
    const current = await git(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (current === BRANCH) await git(cloneDir, 'checkout', 'production');
    await git(cloneDir, 'branch', '-f', BRANCH, 'production');
    return true;
  } catch {
    return false;
  }
}
```

Also update the now-stale doc comment on `ensureAgentBranch` (`branch.ts:12-13`): "Existing agent commits are never reset **mid-session**; after a successful sync with no active change, `resetAgentBranchIfIdle` drops them."

- [ ] **Step 4: Run branch tests** → PASS.

- [ ] **Step 5: SyncManager `afterReady` hook + wiring, with a failing sync test first**

Sync test (stub-engine pattern from the existing sync tests): a successful `start()` → the hook was called with the site; a failing sync → hook not called; a throwing hook → sync still ends `ready`.

Implement: `SyncManager` constructor gains a third param `private readonly opts: { afterReady?: (site: Site) => Promise<void> } = {}`; in `run()`'s success path, after the `ready` emit (`sync.ts:87`):

```ts
      void this.opts.afterReady?.(site)?.catch((err) => console.error('afterReady hook failed:', err));
```

In `app.ts` (`buildApp`, line 87):

```ts
    const sync = new SyncManager(deps.store, deps.engine, {
      afterReady: deps.agent
        ? async (site) => {
            const active = deps.store
              .changesFor(site.id)
              .some((c) => c.status === 'draft' || c.status === 'conflict' || c.status === 'pushing');
            if (!active) await resetAgentBranchIfIdle(deps.agent!.cloneDir(site.slug));
          }
        : undefined,
    });
```

(import `resetAgentBranchIfIdle` from `./agent/branch.js`).

- [ ] **Step 6: Full server suite** — `npm --workspace ferry-server run test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add ferry-server/src/agent/branch.ts ferry-server/src/sync.ts ferry-server/src/app.ts ferry-server/tests
git commit -m "feat(server): reset agent/work to production after sync when no change is active (issue #9)"
```

### Task 4: Persist smoke results on the change row

Screen 10 shows named smoke checks with metrics; today the results only ride the transient `push_done` SSE payload. Persist them.

**Files:**
- Modify: `ferry-cli/src/push-types.ts` (named `SmokeResult`), `ferry-server/src/push/types.ts` (re-export), `ferry-server/src/store.ts`, `ferry-server/src/push-manager.ts`
- Test: `ferry-server/tests/push-manager.test.ts`, plus a store migration test where store tests live.

**Interfaces:**
- Produces: `SmokeResult { label: string; ok: boolean; detail?: string }`; `Change.smokeResult: SmokeResult[] | null`; `SetChangeStatusPatch.smokeResult?: SmokeResult[] | null`.

- [ ] **Step 1: Failing test — pushed outcome persists smoke results**

In `push-manager.test.ts` (scripted-runner style):

```ts
  it('persists the smoke results on a pushed change', async () => {
    // start a push with scriptedPushRunner() and await push_done (existing helper pattern)
    const after = store.changeById(change.id)!;
    expect(after.smokeResult).toEqual([{ label: 'home', ok: true, detail: '200 OK' }]);
  });

  it('persists smoke results on a smoke-failed rollback', async () => {
    // scriptedPushRunner({ smokeFails: true })
    const after = store.changeById(change.id)!;
    expect(after.status).toBe('rolled_back');
    expect(after.smokeResult).toEqual([{ label: 'home', ok: false, detail: '500 · unexpected body' }]);
  });
```

And a store test: constructing `Store` against a DB file created by a previous `Store` instance (pre-column) does not throw and `changeById` returns `smokeResult: null` — plus double-construction idempotence.

- [ ] **Step 2: Run to verify failure** → FAIL (`smokeResult` undefined / column missing).

- [ ] **Step 3: Implement**

`ferry-cli/src/push-types.ts`: add `export interface SmokeResult { label: string; ok: boolean; detail?: string }` and replace the three inline `{label,ok,detail}[]` occurrences inside `PushOutcome` (and the `smoke?` on rolled_back) with `SmokeResult[]`. Re-export `SmokeResult` from `ferry-server/src/push/types.ts` alongside the others.

`store.ts`: in the constructor after the `CREATE TABLE` block, a guarded migration:

```ts
    const changeCols = this.db.prepare('PRAGMA table_info(changes)').all() as { name: string }[];
    if (!changeCols.some((c) => c.name === 'smoke_result_json')) {
      this.db.exec('ALTER TABLE changes ADD COLUMN smoke_result_json TEXT');
    }
```

Add `smokeResult: SmokeResult[] | null` to `Change`; parse in `toChange` (`row.smoke_result_json ? JSON.parse(...) : null`); add `smokeResult?: SmokeResult[] | null` to `SetChangeStatusPatch` and persist it in `setChangeStatus` (same `'smokeResult' in patch` pattern as `conflict`).

`push-manager.ts` `finish()`: include it in the two relevant patches:

```ts
      case 'pushed':
        this.store.setChangeStatus(change.id, 'pushed', {
          backupTxid: outcome.txid, prodRef: outcome.txid.slice(0, 7), pushedAt: now,
          smokeResult: outcome.smoke,
        });
        break;
      ...
      case 'rolled_back':
        this.store.setChangeStatus(change.id, 'rolled_back', { rolledBackAt: now, smokeResult: outcome.smoke ?? null });
        break;
```

- [ ] **Step 4: Full server + cli suites** — `npm --workspace ferry-server run test && npm --workspace ferry-cli run test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/push-types.ts ferry-server/src/push/types.ts ferry-server/src/store.ts ferry-server/src/push-manager.ts ferry-server/tests
git commit -m "feat(server): persist smoke results on the change row for the pushed card"
```

### Task 5: Drift preview — `PushRunner.hashes` + `GET …/drift`

**Files:**
- Modify: `ferry-server/src/push/types.ts`, `ferry-server/src/push/scripted-push-runner.ts`, `ferry-server/src/engine.ts`, `ferry-server/src/routes/changes.ts`
- Test: `ferry-server/tests/changes-routes.test.ts`

**Interfaces:**
- Produces: `PushRunner.hashes?(slug, paths): Promise<Record<string, string | null>>`; scripted formula `` `scripted-${path}` ``; `GET /api/sites/:id/changes/:seq/drift` → `{ checked, mismatches }`.

- [ ] **Step 1: Failing route tests** (testApp helper pattern; seed a draft change via `store.createChange` with `files: [{ path: 'a.php', oldHash: 'scripted-a.php', newHash: 'x' }, { path: 'b.php', oldHash: 'wrong', newHash: 'y' }]`)

```ts
  it('previews drift for a draft change', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes/1/drift`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ checked: 2, mismatches: ['b.php'] });
  });

  it('refuses a drift preview for a non-draft change', async () => { /* status pushed → 409 */ });

  it('502s when the runner cannot reach the site', async () => {
    // push runner whose hashes() rejects → { error: 'Could not reach the site for a drift check.' }
  });
```

- [ ] **Step 2: Run to verify failure** → FAIL (404 route not found).

- [ ] **Step 3: Implement**

`push/types.ts` — on `PushRunner`:

```ts
  /** Targeted drift preview (plugin POST /ferry/v1/hashes): current sha256 per path, null when
   *  the path doesn't resolve. Optional — hand-rolled test fakes may omit it. */
  hashes?(slug: string, paths: string[]): Promise<Record<string, string | null>>;
```

`scripted-push-runner.ts`:

```ts
    async hashes(_slug, paths) {
      // Deterministic formula shared with the e2e seed fixtures: a file whose oldHash is
      // `scripted-${path}` reads as unchanged; anything else reads as drifted.
      return Object.fromEntries(paths.map((p) => [p, `scripted-${p}`]));
    },
```

`engine.ts` `realPushRunner()`:

```ts
    async hashes(slug, paths) {
      const profile = loadProfile(slug);
      const client = new FerryClient(profile.url, profile.secret);
      await client.syncClock();
      const { data } = await client.postJson('/ferry/v1/hashes', { paths });
      return data.hashes as Record<string, string | null>;
    },
```

`routes/changes.ts`:

```ts
  app.get('/api/sites/:id/changes/:seq/drift', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const seq = Number((request.params as { seq: string }).seq);
    const change = deps.store.changeBySeq(site.id, seq);
    if (!change) return reply.code(404).send({ error: 'Change not found.' });
    if (change.status !== 'draft') return reply.code(409).send({ error: 'Only a draft change has a drift preview.' });
    const runner = deps.push?.runner;
    if (!runner?.hashes) return reply.code(502).send({ error: 'Drift preview is not available.' });
    try {
      const hashes = await runner.hashes(site.slug, change.files.map((f) => f.path));
      const mismatches = change.files.filter((f) => (hashes[f.path] ?? null) !== f.oldHash).map((f) => f.path);
      return reply.send({ checked: change.files.length, mismatches });
    } catch {
      return reply.code(502).send({ error: 'Could not reach the site for a drift check.' });
    }
  });
```

- [ ] **Step 4: Full server suite** → PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/push/types.ts ferry-server/src/push/scripted-push-runner.ts ferry-server/src/engine.ts ferry-server/src/routes/changes.ts ferry-server/tests/changes-routes.test.ts
git commit -m "feat(server): drift-preview route over the plugin /hashes endpoint"
```

### Task 6: e2e server seam — push dep, slug-dispatch scripts, seed route

The dashboard e2e server passes no `push` dep, so every `/api/sites/:id/changes*` route 404s there, and nothing can create a change (the scripted agent runner has no `create_change`). Give it: a slug-dispatching scripted push runner (site name controls the script), the captured `AgentManager` (for `change_card` SSE), and a test-only `POST /e2e/changes` seed route.

**Files:**
- Modify: `ferry-dashboard/e2e/server.ts`

**Interfaces:**
- Consumes: `scriptedPushRunner` (+`hashes` from Task 5), `AppDeps.push`, `AppDeps.agent.onManagerReady`, `store.createChange`/`setChangeStatus` (+`smokeResult` patch from Task 4).
- Produces: `POST /e2e/changes` `{ siteId, fields?, status?, conflict?, smokeResult?, backupTxid?, prodRef?, emitCard? }` → `Change`. Slug dispatch: slug containing `conflict` → `conflictOn: 'drift'`; containing `smokefail` → `smokeFails: true`; containing `driftedpreview` → `hashes()` returns `'drifted'` for every path; else happy. Seed default fixture = the design's VAT storyline with `oldHash: 'scripted-${path}'` so the drift preview reads unchanged.

- [ ] **Step 1: Implement in `e2e/server.ts`**

```ts
import type { AgentManager } from '../../ferry-server/src/agent/manager.js';
import { scriptedPushRunner } from '../../ferry-server/src/push/scripted-push-runner.js';
import type { PushRunner } from '../../ferry-server/src/push/types.js';
import type { ChangeStatus, Store } from '../../ferry-server/src/store.js';
import type { Conflict, SmokeResult } from '../../ferry-server/src/push/types.js';

/** Site-slug-dispatched scripts: one server boot serves every scenario. The slug comes from
 *  the site URL the test creates (e.g. https://conflict-shop.example.com). */
function e2ePushRunner(): PushRunner {
  const runnerFor = (slug: string): PushRunner =>
    slug.includes('conflict') ? scriptedPushRunner({ conflictOn: 'drift' })
    : slug.includes('smokefail') ? scriptedPushRunner({ smokeFails: true })
    : scriptedPushRunner();
  return {
    push: (slug, spec, opts) => runnerFor(slug).push(slug, spec, opts),
    rollback: (slug, opts) => runnerFor(slug).rollback(slug, opts),
    txStatus: (slug, txid) => runnerFor(slug).txStatus(slug, txid),
    async hashes(slug, paths) {
      if (slug.includes('driftedpreview')) return Object.fromEntries(paths.map((p) => [p, 'drifted']));
      return Object.fromEntries(paths.map((p) => [p, `scripted-${p}`]));
    },
  };
}
```

Wire into `buildApp`: `push: { runner: e2ePushRunner() }`, and inside `agent: { … }` add:

```ts
    onManagerReady: (m: AgentManager) => { agentManager = m; },
```

with `let agentManager: AgentManager | undefined;` declared above `buildApp`.

- [ ] **Step 2: The seed route + VAT fixture (before `app.listen`)**

```ts
// Design-fixture default (screens 6–12 storyline): two files + one option op. oldHash uses the
// scripted-hashes formula so the drift preview reads "unchanged" unless a test wants otherwise.
const VAT_DIFF = [
  'diff --git a/wp-content/themes/wasgeurtje/functions.php b/wp-content/themes/wasgeurtje/functions.php',
  '--- a/wp-content/themes/wasgeurtje/functions.php',
  '+++ b/wp-content/themes/wasgeurtje/functions.php',
  '@@ -408,13 +408,4 @@',
  " add_action('init', 'wasgeurtje_setup');",
  "-add_filter('woocommerce_calc_tax', 'wg_extra_vat', 20, 3);",
  '-function wg_extra_vat($taxes, $price, $rates) {',
  '-  if ($price > 100) $taxes[1] = $price * 0.21;',
  '-  return $taxes;',
  '-}',
  '+// duplicate VAT hook removed — Woo already adds 21% (Ferry CHANGE-0001)',
  " add_action('wp_enqueue_scripts', 'wg_assets');",
  'diff --git a/wp-content/mu-plugins/woocommerce-tax-overrides.php b/wp-content/mu-plugins/woocommerce-tax-overrides.php',
  '--- a/wp-content/mu-plugins/woocommerce-tax-overrides.php',
  '+++ b/wp-content/mu-plugins/woocommerce-tax-overrides.php',
  '@@ -86,5 +86,6 @@',
  "-$threshold_mode = 'excl';",
  '+// follow the global Woo setting instead of hardcoding',
  "+$threshold_mode = get_option('woocommerce_tax_display_cart');",
].join('\n');

const VAT_FIXTURE = {
  title: 'VAT calculation fixed',
  summary: 'The wrong VAT on orders above €100 was caused by an incorrect setting plus a bug in the theme. I have fixed both.',
  branch: 'agent/work',
  baseSha: 'a3f19c2a3f19c2a3f19c2a3f19c2a3f19c2a3f1',
  headSha: 'f4b81adf4b81adf4b81adf4b81adf4b81adf4b8',
  diffText: VAT_DIFF,
  files: [
    { path: 'wp-content/themes/wasgeurtje/functions.php', oldHash: 'scripted-wp-content/themes/wasgeurtje/functions.php', newHash: 'aaaa' },
    { path: 'wp-content/mu-plugins/woocommerce-tax-overrides.php', oldHash: 'scripted-wp-content/mu-plugins/woocommerce-tax-overrides.php', newHash: 'bbbb' },
  ],
  ops: [{ kind: 'option_set' as const, name: 'woocommerce_tax_display_cart', old: 'incl', new: 'excl' }],
  preconditions: [{ type: 'option' as const, name: 'woocommerce_tax_display_cart', expected: 'incl' }],
  smoke: [
    { label: 'Checkout — VAT on a €120 order is correct', path: '/checkout', expectStatus: 200 },
    { label: 'Order list loads without PHP warnings', path: '/wp-admin/edit.php', expectStatus: 200 },
    { label: 'Product page renders', path: '/product/sample', expectStatus: 200 },
  ],
};

interface SeedBody {
  siteId: number;
  fields?: Partial<typeof VAT_FIXTURE>;
  status?: ChangeStatus;
  conflict?: Conflict[];
  smokeResult?: SmokeResult[];
  backupTxid?: string;
  prodRef?: string;
  emitCard?: boolean;
}

// Test-only seam: exists ONLY in this e2e server, never in app.ts — the product has no way to
// create a change outside the agent's create_change tool.
app.post('/e2e/changes', async (request) => {
  const body = request.body as SeedBody;
  const change = store.createChange(body.siteId, { ...VAT_FIXTURE, ...body.fields });
  if (body.status && body.status !== 'draft') {
    store.setChangeStatus(change.id, body.status, {
      conflict: body.conflict ?? (body.status === 'conflict'
        ? [{ key: 'wp_options · woocommerce_tax_display_cart', expected: 'incl', found: 'excl' }]
        : null),
      backupTxid: body.backupTxid ?? 'a3f19c2b'.repeat(4),
      prodRef: body.prodRef ?? (body.status === 'pushed' ? 'f4b81ad' : null),
      pushedAt: body.status === 'pushed' || body.status === 'rolled_back' ? new Date().toISOString() : undefined,
      rolledBackAt: body.status === 'rolled_back' ? new Date().toISOString() : undefined,
      smokeResult: body.smokeResult ?? (body.status === 'pushed'
        ? [
            { label: 'Checkout — VAT on a €120 order is correct', ok: true, detail: '€24.79' },
            { label: 'Order list loads without PHP warnings', ok: true, detail: '200' },
            { label: 'Product page renders', ok: true, detail: '200 · 340ms' },
          ]
        : null),
    });
  }
  if (body.emitCard) {
    agentManager?.appendSystemEvent(body.siteId, 'change_card', {
      changeId: change.id, seq: change.seq, title: change.title, status: change.status,
    });
  }
  return store.changeById(change.id);
});
```

(Adjust the `setChangeStatus` patch call to the exact `SetChangeStatusPatch` semantics from Task 4 — only include keys being set; `prodRef: null` is a valid explicit value.)

- [ ] **Step 3: Verify by hand**

Run (from `ferry-dashboard/`): `npm run build && npx tsx e2e/server.ts &` then:

```bash
curl -s -c /tmp/c.txt -H 'content-type: application/json' -d '{"email":"seed@example.com","password":"secret123"}' http://127.0.0.1:4173/api/auth/signup
curl -s -b /tmp/c.txt -H 'content-type: application/json' -d '{"name":"Seed","url":"https://seed-shop.example.com"}' http://127.0.0.1:4173/api/sites
curl -s -b /tmp/c.txt -H 'content-type: application/json' -d '{"siteId":1}' http://127.0.0.1:4173/e2e/changes
curl -s -b /tmp/c.txt http://127.0.0.1:4173/api/sites/1/changes
```

Expected: the last call returns `{"changes":[…VAT fixture, status draft, seq 1…]}`. Kill the server afterwards.

- [ ] **Step 4: Typecheck + existing e2e still green**

Run: `npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run e2e`
Expected: 9 passing (needs the DDEV fixture running for the gate test).

- [ ] **Step 5: Commit**

```bash
git add ferry-dashboard/e2e/server.ts
git commit -m "test(dashboard): e2e server gains push runner, slug-dispatched scripts and a change seed route"
```

### Task 7: Changes tab (screen 7) — types, tokens, route, sidebar link + badge

**Files:**
- Modify: `ferry-dashboard/src/api.ts`, `ferry-dashboard/src/ui.css`, `ferry-dashboard/src/main.tsx`, `ferry-dashboard/src/pages/site.tsx`
- Create: `ferry-dashboard/src/change-parts.tsx`, `ferry-dashboard/src/pages/changes.tsx`
- Test: `ferry-dashboard/e2e/changes.spec.ts` (new)

**Interfaces:**
- Consumes: `GET /api/sites/:id/changes(?status=)`, seed route from Task 6.
- Produces: everything under "Interfaces produced" for api.ts and `changeRef`/`timeAgo`/`StatusPill`/`riskOf` from change-parts; routes `/sites/:id/changes`.

- [ ] **Step 1: Write the failing e2e spec**

`e2e/changes.spec.ts` — helpers mirror `dashboard.spec.ts`'s `signUp`; sites/changes are created via `page.request` (shares the browser context's cookies):

```ts
import { expect, test, type Page } from '@playwright/test';

async function signUp(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.getByLabel('Email').fill(`e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('secret123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
}
```

(Copy the exact selector sequence from `dashboard.spec.ts:18-25` — reuse its literals, not this sketch, if they differ.)

```ts
async function createSite(page: Page, name: string, url: string): Promise<number> {
  const res = await page.request.post('/api/sites', { data: { name, url } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as number;
}

async function seedChange(page: Page, siteId: number, extra: Record<string, unknown> = {}): Promise<{ seq: number }> {
  const res = await page.request.post('/e2e/changes', { data: { siteId, ...extra } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test('the changes tab lists changes with status pills, filters and a draft badge', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'List shop', `https://list-${Date.now()}.example.com`);
  await seedChange(page, siteId); // draft
  await seedChange(page, siteId, { status: 'pushed' });
  await seedChange(page, siteId, { status: 'rolled_back' });

  await page.goto(`/sites/${siteId}/changes`);
  await expect(page.locator('.changes__title')).toHaveText('Changes');
  await expect(page.locator('.change-row')).toHaveCount(3);
  await expect(page.locator('.change-row--draft .status-pill')).toHaveText('draft');
  await expect(page.locator('.status-pill--pushed')).toHaveText('pushed');
  await expect(page.locator('.status-pill--rolled_back')).toHaveText('rolled back');
  // draft row: amber border + Push action; others: View
  await expect(page.locator('.change-row--draft').getByRole('button', { name: 'Push' })).toBeVisible();
  await expect(page.locator('.change-row').filter({ hasText: 'pushed' }).first().getByRole('link', { name: 'View' })).toBeVisible();
  // filter pills with counts
  await expect(page.locator('.filter-pill--active')).toHaveText('all 3');
  await page.getByRole('button', { name: 'draft 1' }).click();
  await expect(page.locator('.change-row')).toHaveCount(1);
  // sidebar: Changes is a live link here with the draft-count badge
  await expect(page.locator('.sidebar__badge')).toHaveText('1');
  // standing constraint: no clickable clone URL anywhere
  expect(await page.locator('a[href*="ddev.site"]').count()).toBe(0);
});

test('an empty changes tab shows the empty state', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Empty shop', `https://empty-${Date.now()}.example.com`);
  await page.goto(`/sites/${siteId}/changes`);
  await expect(page.getByText('No changes yet')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify failure** — `npm --workspace ferry-dashboard run e2e -- --grep "changes tab|empty changes"` → FAIL (route redirects to `/`).

- [ ] **Step 3: api.ts — mirrored types + helpers** (append; hand-duplication is the established convention)

```ts
export type ChangeStatus = 'draft' | 'pushing' | 'pushed' | 'conflict' | 'rolled_back' | 'discarded';

export type DbOp =
  | { kind: 'option_set'; name: string; old: string | null; new: string }
  | { kind: 'option_delete'; name: string; old: string | null }
  | { kind: 'postmeta_set'; postId: number; key: string; old: string | null; new: string }
  | { kind: 'postmeta_delete'; postId: number; key: string; old: string | null }
  | { kind: 'row_update'; table: string; pkCol: string; pk: number; old: Record<string, string | null>; new: Record<string, string | null> }
  | { kind: 'row_insert'; table: string; pkCol: string; pk: number; new: Record<string, string | null> }
  | { kind: 'row_delete'; table: string; pkCol: string; pk: number; old: Record<string, string | null> };

export type Precondition =
  | { type: 'option'; name: string; expected: string | null }
  | { type: 'file_hash'; path: string; expected: string }
  | { type: 'row'; table: string; pkCol: string; pk: number; column: string; expected: string | null };

export interface SmokeCheck { label: string; path: string; expectStatus: number; expectText?: string }
export interface SmokeResult { label: string; ok: boolean; detail?: string }
export interface ChangeFile { path: string; newHash: string | null; oldHash: string | null }
export interface Conflict { key: string; expected: string; found: string }

/** Mirror of ferry-server's Change row (store.ts) — same duplication convention as SyncState. */
export interface Change {
  id: number; siteId: number; seq: number; status: ChangeStatus;
  title: string; summary: string; branch: string; baseSha: string; headSha: string;
  diffText: string; files: ChangeFile[]; ops: DbOp[]; preconditions: Precondition[]; smoke: SmokeCheck[];
  backupTxid: string | null; prodRef: string | null; conflict: Conflict[] | null;
  smokeResult: SmokeResult[] | null;
  createdAt: string; pushedAt: string | null; rolledBackAt: string | null;
}

export type PushStep = 'staging' | 'hashes' | 'drift' | 'swap' | 'journal' | 'smoke';
export interface StepEvent { step: PushStep; status: 'start' | 'ok' | 'fail'; detail?: string; durationMs?: number }
export interface PushWireEvent { seq: number; type: 'push_step' | 'push_done'; payload: unknown }
export interface DriftPreview { checked: number; mismatches: string[] }

export const listChanges = (siteId: number, status?: ChangeStatus) =>
  call<{ changes: Change[] }>('GET', `/api/sites/${siteId}/changes${status ? `?status=${status}` : ''}`);
export const getChange = (siteId: number, seq: number) =>
  call<Change>('GET', `/api/sites/${siteId}/changes/${seq}`);
export const pushChange = (siteId: number, seq: number, force = false) =>
  call<{ started: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/push`, { force });
export const rollbackChange = (siteId: number, seq: number) =>
  call<{ rolledBack: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/rollback`);
export const discardChange = (siteId: number, seq: number) =>
  call<{ discarded: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/discard`);
export const retryChange = (siteId: number, seq: number) =>
  call<{ queued: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/retry`);
export const driftPreview = (siteId: number, seq: number) =>
  call<DriftPreview>('GET', `/api/sites/${siteId}/changes/${seq}/drift`);
```

- [ ] **Step 4: change-parts.tsx — shared primitives**

```tsx
import type { ChangeStatus, DbOp } from './api';

export function changeRef(seq: number): string {
  return `CHANGE-${String(seq).padStart(4, '0')}`;
}

export function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const PILL: Record<ChangeStatus, string> = {
  draft: 'draft', pushing: 'pushing', pushed: 'pushed',
  conflict: 'conflict', rolled_back: 'rolled back', discarded: 'discarded',
};

export function StatusPill({ status }: { status: ChangeStatus }) {
  return <span className={`status-pill status-pill--${status} mono`}>{PILL[status]}</span>;
}

export function riskOf(ops: DbOp[]): { label: string; cls: string } {
  return ops.some((op) => op.kind.startsWith('row_'))
    ? { label: 'higher risk', cls: 'risk-chip--higher' }
    : { label: 'low risk', cls: 'risk-chip--low' };
}
```

(`DiffView`, `OpsTable`, `ConfirmDialog`, `InlineChangeCard` join this file in Tasks 8, 10 and 12.)

- [ ] **Step 5: ui.css — token + screens-7 CSS** (append a `/* Changes (screens 7–12) */` section; `--amber-ink` goes in `:root` next to `--amber-weak`)

```css
  --amber-ink: oklch(0.45 0.1 68);
```

```css
/* Changes (screens 7–12) */
.changes-page { display: grid; grid-template-columns: 230px 1fr; height: 100vh; background: var(--surface); }
.changes-main { display: flex; flex-direction: column; min-width: 0; overflow: auto; }
.changes__header { height: 56px; flex: none; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; padding: 0 24px; }
.changes__title { font-weight: 600; font-size: 15px; }
.filter-pill { font-family: var(--mono); font-size: 12px; border: 0; background: none; color: var(--muted); border-radius: 999px; padding: 3px 9px; cursor: pointer; }
.filter-pill--active { background: var(--accent-weak); color: var(--accent-ink); }
.change-list { padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; }
.change-row { display: flex; align-items: center; gap: 14px; border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; background: var(--surface); }
.change-row--draft { border-color: var(--amber); }
.change-row--rolled_back { opacity: 0.9; }
.change-row__icon { width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 12px; font-weight: 600; flex: none; }
.change-row__icon--draft { background: var(--amber-weak); color: var(--amber-ink); }
.change-row__icon--pushed { background: var(--green-weak); color: var(--green); }
.change-row__icon--rolled_back, .change-row__icon--conflict { background: var(--red-weak); color: var(--red); }
.change-row__text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.change-row__title { font-weight: 600; font-size: 14px; }
.change-row__meta { font-family: var(--mono); font-size: 12px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.change-row__meta--failed { color: var(--red); }
.status-pill { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.status-pill--draft { background: var(--amber-weak); color: var(--amber-ink); }
.status-pill--pushing { background: var(--accent-weak); color: var(--accent-ink); }
.status-pill--pushed { background: var(--green-weak); color: var(--green); }
.status-pill--conflict, .status-pill--rolled_back { background: var(--red-weak); color: var(--red); }
.status-pill--discarded { background: var(--panel); color: var(--muted); }
.btn--push { background: var(--green); color: #fff; font-weight: 600; box-shadow: 0 8px 18px -9px var(--green); }
.btn--push:disabled { opacity: 0.6; cursor: default; }
.btn--sm { padding: 6px 12px; font-size: 12.5px; border-radius: 8px; }
.sidebar__badge { margin-left: auto; font-family: var(--mono); font-size: 10.5px; background: var(--amber-weak); color: var(--amber-ink); padding: 1px 6px; border-radius: 5px; }
```

- [ ] **Step 6: pages/changes.tsx**

```tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, listChanges, type Change, type Site } from '../api';
import { changeRef, StatusPill, timeAgo } from '../change-parts';
import { SiteSidebar } from './site';

type Filter = 'all' | 'draft' | 'pushed' | 'rolled_back';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'all' }, { key: 'draft', label: 'draft' },
  { key: 'pushed', label: 'pushed' }, { key: 'rolled_back', label: 'rolled back' },
];

function rowMeta(change: Change): { text: string; failed: boolean } {
  if (change.status === 'rolled_back') {
    return { text: 'smoke test failed → rolled back automatically · no impact on prod', failed: true };
  }
  if (change.status === 'pushed') {
    return { text: `pushed ${timeAgo(change.pushedAt ?? change.createdAt)} · smoke test ✓ · @${change.prodRef ?? ''}`, failed: false };
  }
  const opsLabel = change.ops.length === 0 ? null
    : change.ops.every((o) => o.kind.startsWith('option_'))
      ? `${change.ops.length} setting${change.ops.length === 1 ? '' : 's'}`
      : `${change.ops.length} DB op${change.ops.length === 1 ? '' : 's'}`;
  const parts = [change.branch, `${change.files.length} file${change.files.length === 1 ? '' : 's'}`];
  if (opsLabel) parts.push(opsLabel);
  return { text: parts.join(' · '), failed: false };
}

const ICON: Record<string, string> = { pushed: '✓', rolled_back: '↺', conflict: '!' };

export function ChangesPage() {
  const { id } = useParams();
  const siteId = Number(id);
  const [site, setSite] = useState<Site | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    void api.get<Site>(`/api/sites/${siteId}`).then(setSite).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the site.');
    });
    void listChanges(siteId).then((r) => setChanges(r.changes)).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load changes.');
    });
  }, [siteId]);

  if (loadError) return <div className="page-center"><div className="form-error">{loadError}</div></div>;
  if (!site || !changes) return <div className="page-center" />;

  const visible = changes.filter((c) => c.status !== 'discarded');
  const drafts = visible.filter((c) => c.status === 'draft').length;
  const shown = filter === 'all' ? visible : visible.filter((c) => c.status === filter);
  const countFor = (f: Filter) => (f === 'all' ? visible.length : visible.filter((c) => c.status === f).length);

  return (
    <div className="changes-page">
      <SiteSidebar site={site} active="changes" draftCount={drafts} />
      <main className="changes-main">
        <div className="changes__header">
          <span className="changes__title">Changes</span>
          {FILTERS.map((f) => (
            <button
              key={f.key} type="button"
              className={filter === f.key ? 'filter-pill filter-pill--active' : 'filter-pill'}
              onClick={() => setFilter(f.key)}
            >
              {f.label} {countFor(f.key)}
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <div className="empty">
            <div className="empty__inner">
              <h2>No changes yet</h2>
              <p>When the agent fixes something, the change card appears here for your approval.</p>
            </div>
          </div>
        ) : (
          <div className="change-list">
            {shown.map((c) => {
              const meta = rowMeta(c);
              return (
                <div key={c.id} className={`change-row change-row--${c.status}`}>
                  <span className={`change-row__icon change-row__icon--${c.status}`}>
                    {ICON[c.status] ?? String(c.seq).padStart(2, '0')}
                  </span>
                  <div className="change-row__text">
                    <span className="change-row__title">{c.title}</span>
                    <span className={meta.failed ? 'change-row__meta change-row__meta--failed' : 'change-row__meta'}>{meta.text}</span>
                  </div>
                  <StatusPill status={c.status} />
                  {c.status === 'draft' ? (
                    <Link to={`/sites/${siteId}/changes/${c.seq}`} role="button" className="btn btn--push btn--sm">Push</Link>
                  ) : (
                    <Link to={`/sites/${siteId}/changes/${c.seq}`} role="button" className="btn btn--outline btn--sm">View</Link>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
```

(The draft row's "Push" navigates to the detail page rather than pushing blind from the list — the card is the approval surface; the design's list-row "Push" affordance keeps its label.)

- [ ] **Step 7: Extract `SiteSidebar` from site.tsx and add the live link + badge**

In `src/pages/site.tsx`, extract the current `<aside className="sidebar">…</aside>` block into an exported component (same file), parameterized so both the site page and the changes pages reuse it:

```tsx
export function SiteSidebar({ site, active, draftCount, footer }: {
  site: Site;
  active: 'chat' | 'changes';
  draftCount: number;
  footer?: ReactNode;
}) {
  const chip = CHIP[site.status];
  return (
    <aside className="sidebar">
      <div className="sidebar__brand"><Logo /> <span>Ferry</span></div>
      <Link to="/" className="site-sidebar__back">← All sites</Link>
      <div className="site-card">
        <span className="site-card__avatar mono">{site.name.charAt(0).toUpperCase()}</span>
        <div className="site-card__text">
          <span className="site-card__name">{site.name}</span>
          <span className={`chip ${chip.cls}`}>{chip.label}</span>
        </div>
      </div>
      <nav className="sidebar__nav">
        <span className="sidebar__item sidebar__item--disabled"><span className="sidebar__dot" />Overview</span>
        {active === 'chat' ? (
          <span className="sidebar__item sidebar__item--active"><span className="sidebar__dot sidebar__dot--accent" />Agent chat</span>
        ) : (
          <Link to={`/sites/${site.id}`} className="sidebar__item"><span className="sidebar__dot" />Agent chat</Link>
        )}
        {active === 'changes' ? (
          <span className="sidebar__item sidebar__item--active">
            <span className="sidebar__dot sidebar__dot--accent" />Changes
            {draftCount > 0 && <span className="sidebar__badge">{draftCount}</span>}
          </span>
        ) : (
          <Link to={`/sites/${site.id}/changes`} className="sidebar__item">
            <span className="sidebar__dot" />Changes
            {draftCount > 0 && <span className="sidebar__badge">{draftCount}</span>}
          </Link>
        )}
        <Link to={`/sites/${site.id}/sync`} className="sidebar__item"><span className="sidebar__dot" />Sync &amp; status</Link>
        <span className="sidebar__item sidebar__item--disabled"><span className="sidebar__dot" />Settings</span>
      </nav>
      {footer}
    </aside>
  );
}
```

`SitePage` then renders `<SiteSidebar site={site} active="chat" draftCount={draftCount} footer={…existing .site-sidebar__footer div…} />`, with:

```tsx
  const [draftCount, setDraftCount] = useState(0);
  useEffect(() => {
    void listChanges(Number(id), 'draft').then((r) => setDraftCount(r.changes.length)).catch(() => undefined);
  }, [id]);
```

- [ ] **Step 8: Register the route** — in `src/main.tsx`, inside the `RequireAuth` children:

```tsx
      { path: '/sites/:id/changes', element: <ChangesPage /> },
```

- [ ] **Step 9: Run the new e2e specs** — `npm --workspace ferry-dashboard run e2e -- --grep "changes tab|empty changes"` → PASS. Then typecheck.

- [ ] **Step 10: Commit**

```bash
git add ferry-dashboard/src ferry-dashboard/e2e/changes.spec.ts
git commit -m "feat(dashboard): changes tab (screen 7) with filter pills, status rows and sidebar badge"
```

### Task 8: Change detail page — skeleton + draft state (screen 8)

**Files:**
- Create: `ferry-dashboard/src/pages/change.tsx`
- Modify: `ferry-dashboard/src/change-parts.tsx` (DiffView, OpsTable), `ferry-dashboard/src/ui.css`, `ferry-dashboard/src/main.tsx` (route)
- Test: `ferry-dashboard/e2e/changes.spec.ts`

**Interfaces:**
- Consumes: `getChange`, `discardChange`, `driftPreview`, `pushChange`; Task 6 seed + slug dispatch (`driftedpreview`).
- Produces: route `/sites/:id/changes/:seq`; `DiffView({diffText})`; `OpsTable({ops})`; page states switch on `change.status` (this task: `draft` + a minimal `pushing` placeholder; Tasks 9–11 replace/extend).

- [ ] **Step 1: Failing e2e specs**

```ts
test('a draft change page shows the full card and can be discarded', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Draft shop', `https://draft-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  await expect(page.locator('.breadcrumb__here')).toHaveText('CHANGE-0001');
  await expect(page.locator('.change-head__title')).toHaveText('VAT calculation fixed');
  await expect(page.locator('.change-summary')).toContainText('I have fixed both');
  // diff: two file blocks, add/del coloring
  await expect(page.locator('.diff-file')).toHaveCount(2);
  await expect(page.locator('.diff-line--add').first()).toBeVisible();
  await expect(page.locator('.diff-line--del').first()).toBeVisible();
  await expect(page.getByText('2 files changed')).toBeVisible();
  // DB journal: risk chip + old/new
  await expect(page.locator('.risk-chip')).toHaveText('low risk');
  await expect(page.locator('.ops-table')).toContainText('woocommerce_tax_display_cart');
  await expect(page.locator('.ops-old')).toHaveText('incl');
  await expect(page.locator('.ops-new')).toHaveText('excl');
  // preconditions + smoke plan + drift preview (scripted hashes match)
  await expect(page.locator('.precondition')).toHaveCount(1);
  await expect(page.locator('.drift-strip__state--ok')).toHaveText('production unchanged');
  await expect(page.getByText('if one fails → automatic rollback')).toBeVisible();
  // actions
  await expect(page.getByRole('button', { name: 'Push to production' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}/changes`);
  expect(await page.locator('a[href*="ddev.site"]').count()).toBe(0);
});

test('the drift preview reports a drifted production honestly', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Drifted preview', `https://driftedpreview-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);
  await expect(page.locator('.drift-strip__state--bad')).toContainText('production drifted');
});
```

- [ ] **Step 2: Run → FAIL** (no route).

- [ ] **Step 3: DiffView + OpsTable in change-parts.tsx**

```tsx
interface DiffLine { kind: 'hunk' | 'ctx' | 'add' | 'del'; text: string }
interface DiffFile { path: string; lines: DiffLine[]; adds: number; dels: number }

export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: line.split(' b/').pop() ?? line, lines: [], adds: 0, dels: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    if (line.startsWith('@@')) current.lines.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+')) { current.lines.push({ kind: 'add', text: line }); current.adds++; }
    else if (line.startsWith('-')) { current.lines.push({ kind: 'del', text: line }); current.dels++; }
    else current.lines.push({ kind: 'ctx', text: line });
  }
  return files;
}

export function DiffView({ diffText }: { diffText: string }) {
  const files = parseDiff(diffText);
  return (
    <>
      {files.map((f) => {
        const slash = f.path.lastIndexOf('/');
        return (
          <div key={f.path} className="diff-file">
            <div className="diff-file__head mono">
              <span className="diff-file__dir">{slash >= 0 ? f.path.slice(0, slash + 1) : ''}</span>
              <span className="diff-file__name">{slash >= 0 ? f.path.slice(slash + 1) : f.path}</span>
              <span className="diff-file__stat">
                {f.adds > 0 && <span className="diff-stat--add">+{f.adds}</span>}
                {f.dels > 0 && <span className="diff-stat--del">−{f.dels}</span>}
              </span>
            </div>
            <div className="diff-body mono">
              {f.lines.map((l, i) => <div key={i} className={`diff-line diff-line--${l.kind}`}>{l.text}</div>)}
            </div>
          </div>
        );
      })}
    </>
  );
}

function opCells(op: DbOp): { verb: string; key: string; old: string; new_: string } {
  switch (op.kind) {
    case 'option_set': return { verb: 'UPDATE', key: `options · ${op.name}`, old: op.old ?? '—', new_: op.new };
    case 'option_delete': return { verb: 'DELETE', key: `options · ${op.name}`, old: op.old ?? '—', new_: '—' };
    case 'postmeta_set': return { verb: 'UPDATE', key: `postmeta · post ${op.postId} · ${op.key}`, old: op.old ?? '—', new_: op.new };
    case 'postmeta_delete': return { verb: 'DELETE', key: `postmeta · post ${op.postId} · ${op.key}`, old: op.old ?? '—', new_: '—' };
    case 'row_update': return { verb: 'UPDATE', key: `${op.table} · ${op.pkCol}=${op.pk}`, old: `${Object.keys(op.old).length} columns`, new_: `${Object.keys(op.new).length} columns` };
    case 'row_insert': return { verb: 'INSERT', key: `${op.table} · ${op.pkCol}=${op.pk}`, old: '—', new_: `${Object.keys(op.new).length} columns` };
    case 'row_delete': return { verb: 'DELETE', key: `${op.table} · ${op.pkCol}=${op.pk}`, old: `${Object.keys(op.old).length} columns`, new_: '—' };
  }
}

export function OpsTable({ ops }: { ops: DbOp[] }) {
  return (
    <div className="ops-table">
      <div className="ops-table__row ops-table__row--head mono">
        <span>operation</span><span>key</span><span>old</span><span>new</span>
      </div>
      {ops.map((op, i) => {
        const c = opCells(op);
        return (
          <div key={i} className="ops-table__row mono">
            <span><span className="ops-verb">{c.verb}</span></span>
            <span className="ops-key">{c.key}</span>
            <span className="ops-old">{c.old}</span>
            <span className="ops-new">{c.new_}</span>
          </div>
        );
      })}
    </div>
  );
}
```

(add `DbOp` to the imports from `./api`.)

- [ ] **Step 4: CSS for screen 8** (same section)

```css
.change-shell { min-height: 100vh; background: var(--panel); display: flex; flex-direction: column; }
.change-topbar { height: 56px; flex: none; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 24px; }
.change-topbar__right { display: flex; align-items: center; gap: 10px; }
.change-body { flex: 1; display: flex; justify-content: center; padding: 28px 24px 48px; }
.change-card { width: 100%; max-width: 780px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 10px 30px -20px rgba(22, 24, 44, 0.3); height: fit-content; }
.change-card--pushed { border-color: var(--green); box-shadow: 0 10px 30px -22px var(--green); }
.change-card--conflict { border-color: var(--red); }
.change-section { padding: 18px 22px; border-bottom: 1px solid var(--border); }
.change-section:last-child { border-bottom: 0; }
.change-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.change-head__title { font-weight: 600; font-size: 18px; }
.state-icon { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex: none; }
.state-icon--ok { background: var(--green); color: #fff; }
.state-icon--warn { background: var(--red-weak); color: var(--red); }
.state-icon--neutral { background: var(--panel); border: 1.5px solid var(--border-strong); color: var(--muted); }
.change-summary { background: var(--panel); border-radius: 10px; padding: 12px 14px; font-size: 14px; }
.change-meta { display: flex; gap: 18px; font-family: var(--mono); font-size: 11.5px; color: var(--faint); margin-top: 12px; flex-wrap: wrap; }
.section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.section-head__title { font-weight: 600; font-size: 13.5px; }
.section-head__right { margin-left: auto; font-family: var(--mono); font-size: 11.5px; color: var(--faint); }
.section-label { font-family: var(--mono); font-size: 10.5px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }
.risk-chip { font-family: var(--mono); font-size: 11px; padding: 2px 8px; border-radius: 5px; }
.risk-chip--low { background: var(--green-weak); color: var(--green); }
.risk-chip--higher { background: var(--amber-weak); color: var(--amber-ink); }
.diff-file { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 12px; }
.diff-file__head { display: flex; align-items: center; gap: 4px; background: var(--surface-2); padding: 8px 12px; font-size: 11.5px; border-bottom: 1px solid var(--border); }
.diff-file__dir { color: var(--faint); }
.diff-file__name { font-weight: 600; }
.diff-file__stat { margin-left: auto; display: flex; gap: 8px; }
.diff-stat--add { color: var(--green); }
.diff-stat--del { color: var(--red); }
.diff-body { background: oklch(0.22 0.02 262); padding: 10px 0; font-size: 11.5px; line-height: 1.85; overflow-x: auto; }
.diff-line { padding: 0 14px; white-space: pre; }
.diff-line--hunk { color: oklch(0.6 0.02 262); }
.diff-line--ctx { color: oklch(0.78 0.02 262); }
.diff-line--add { background: oklch(0.3 0.07 155); color: oklch(0.92 0.05 155); }
.diff-line--del { background: oklch(0.3 0.08 25); color: oklch(0.92 0.05 25); }
.ops-table { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.ops-table__row { display: grid; grid-template-columns: 88px 1fr 130px 130px; gap: 10px; padding: 9px 12px; font-size: 11.5px; border-bottom: 1px solid var(--border); align-items: center; }
.ops-table__row:last-child { border-bottom: 0; }
.ops-table__row--head { background: var(--surface-2); font-size: 10.5px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
.ops-verb { background: var(--accent-weak); color: var(--accent-ink); font-size: 11px; padding: 2px 8px; border-radius: 5px; }
.ops-old { color: var(--red); text-decoration: line-through; }
.ops-new { color: var(--green); font-weight: 600; }
.ops-footnote { font-size: 12.5px; color: var(--muted); margin-top: 10px; }
.precondition { display: flex; align-items: center; gap: 9px; padding: 4px 0; font-size: 12.5px; }
.check-dot { width: 15px; height: 15px; border-radius: 50%; background: var(--green-weak); border: 1.5px solid var(--green); color: var(--green); font-size: 9px; display: flex; align-items: center; justify-content: center; flex: none; }
.strip { display: flex; gap: 28px; }
.strip > div { flex: 1; }
.drift-strip__state { display: flex; align-items: center; gap: 8px; font-weight: 500; font-size: 13px; }
.drift-strip__state::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.drift-strip__state--ok { color: var(--green); }
.drift-strip__state--bad { color: var(--red); }
.drift-strip__state--checking, .drift-strip__state--unknown { color: var(--faint); }
.strip__sub { font-size: 11.5px; color: var(--faint); margin-top: 4px; }
.change-actions { display: flex; align-items: center; gap: 10px; background: var(--panel); padding: 14px 22px; border-radius: 0 0 14px 14px; }
.change-actions__note { font-family: var(--mono); font-size: 11.5px; color: var(--faint); margin-right: auto; }
```

- [ ] **Step 5: pages/change.tsx — skeleton + DraftView**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError, discardChange, driftPreview, getChange, pushChange,
  type Change, type DriftPreview,
} from '../api';
import { changeRef, ConfirmDialog, DiffView, OpsTable, riskOf, StatusPill, timeAgo } from '../change-parts';

export function ChangePage() {
  const { id, seq } = useParams();
  const siteId = Number(id);
  const changeSeq = Number(seq);
  const [change, setChange] = useState<Change | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    try {
      setChange(await getChange(siteId, changeSeq));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the change.');
    }
  }, [siteId, changeSeq]);

  useEffect(() => { void reload(); }, [reload]);

  if (loadError) return <div className="page-center"><div className="form-error">{loadError}</div></div>;
  if (!change) return <div className="page-center" />;

  return (
    <div className="change-shell">
      <div className="change-topbar">
        <nav className="breadcrumb">
          <Link to="/">Sites</Link><span className="breadcrumb__sep">/</span>
          <Link to={`/sites/${siteId}`}>site</Link><span className="breadcrumb__sep">/</span>
          <Link to={`/sites/${siteId}/changes`}>Changes</Link><span className="breadcrumb__sep">/</span>
          <span className="breadcrumb__here mono">{changeRef(change.seq)}</span>
        </nav>
        <div className="change-topbar__right">
          <StatusPill status={change.status} />
          <button type="button" className="btn btn--outline btn--sm" onClick={() => navigator.clipboard.writeText(location.href)}>
            Copy link
          </button>
        </div>
      </div>
      <div className="change-body">
        {change.status === 'draft' && (
          <DraftView change={change} siteId={siteId} onReload={reload} actionError={actionError} setActionError={setActionError} navigate={navigate} />
        )}
        {change.status === 'pushing' && <div className="change-card"><div className="change-section">Pushing…</div></div>}
        {/* Tasks 9–11 replace the placeholder above and add pushed / conflict / rolled_back views */}
      </div>
    </div>
  );
}
```

The breadcrumb's second segment shows the literal `site` unless the site name is loaded; fetch it like `ChangesPage` does and render `site.name` (same `api.get<Site>` effect — include it, don't ship the literal).

`DraftView` (same file):

```tsx
function DraftView({ change, siteId, onReload, actionError, setActionError, navigate }: {
  change: Change; siteId: number; onReload: () => Promise<void>;
  actionError: string; setActionError: (e: string) => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [drift, setDrift] = useState<DriftPreview | null>(null);
  const [driftState, setDriftState] = useState<'checking' | 'ok' | 'bad' | 'unknown'>('checking');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const risk = riskOf(change.ops);

  useEffect(() => {
    void driftPreview(siteId, change.seq)
      .then((d) => { setDrift(d); setDriftState(d.mismatches.length === 0 ? 'ok' : 'bad'); })
      .catch(() => setDriftState('unknown'));
  }, [siteId, change.seq]);

  async function push() {
    try {
      await pushChange(siteId, change.seq);
      await onReload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not start the push.');
    }
  }

  async function discard() {
    try {
      await discardChange(siteId, change.seq);
      navigate(`/sites/${siteId}/changes`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not discard the change.');
    }
  }

  const adds = change.diffText.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = change.diffText.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  return (
    <div className="change-card">
      <div className="change-section">
        <div className="change-head">
          <span className="state-icon state-icon--ok">✓</span>
          <span className="change-head__title">{change.title}</span>
        </div>
        <div className="change-summary">“{change.summary}”</div>
        <div className="change-meta">
          <span>{change.branch}</span>
          <span>base production@{change.baseSha.slice(0, 7)}</span>
          <span>{timeAgo(change.createdAt)}</span>
        </div>
      </div>

      <div className="change-section">
        <div className="section-head">
          <span className="section-head__title">▾ {change.files.length} file{change.files.length === 1 ? '' : 's'} changed</span>
          <span className="section-head__right"><span className="diff-stat--add">+{adds}</span> <span className="diff-stat--del">−{dels}</span></span>
        </div>
        <DiffView diffText={change.diffText} />
      </div>

      {change.ops.length > 0 && (
        <div className="change-section">
          <div className="section-head">
            <span className="section-head__title">▾ {change.ops.length} database operation{change.ops.length === 1 ? '' : 's'}</span>
            <span className={`risk-chip ${risk.cls}`}>{risk.label}</span>
            <span className="section-head__right">from binlog journal</span>
          </div>
          <OpsTable ops={change.ops} />
          <div className="ops-footnote"><span className="mono">↺</span> Rollback = replay this journal in reverse. No schema changes, no non-core tables.</div>
        </div>
      )}

      {change.preconditions.length > 0 && (
        <div className="change-section">
          <div className="section-label">The agent’s assumptions (preconditions)</div>
          {change.preconditions.map((p, i) => (
            <div key={i} className="precondition">
              <span className="check-dot">✓</span>
              {p.type === 'option' && <span><span className="mono">{p.name}</span> is still <span className="mono">{p.expected ?? 'absent'}</span></span>}
              {p.type === 'file_hash' && <span><span className="mono">{p.path}</span> hash unchanged (<span className="mono">{p.expected.slice(0, 7)}…</span>)</span>}
              {p.type === 'row' && <span><span className="mono">{p.table}.{p.column}</span> ({p.pkCol}={p.pk}) is still <span className="mono">{p.expected ?? 'absent'}</span></span>}
            </div>
          ))}
        </div>
      )}

      <div className="change-section">
        <div className="strip">
          <div>
            <div className="section-label">Drift check</div>
            {driftState === 'checking' && <div className="drift-strip__state drift-strip__state--checking">checking production…</div>}
            {driftState === 'ok' && <div className="drift-strip__state drift-strip__state--ok">production unchanged</div>}
            {driftState === 'bad' && (
              <div className="drift-strip__state drift-strip__state--bad">
                production drifted — {drift?.mismatches.length} file{drift?.mismatches.length === 1 ? '' : 's'} changed
              </div>
            )}
            {driftState === 'unknown' && <div className="drift-strip__state drift-strip__state--unknown">couldn’t check</div>}
            <div className="strip__sub">re-checked inside the write transaction</div>
          </div>
          <div>
            <div className="section-label">Smoke test after push</div>
            <div style={{ fontSize: 13 }}>{change.smoke.map((s) => s.label).join(' · ') || '—'}</div>
            <div className="strip__sub">if one fails → automatic rollback</div>
          </div>
        </div>
      </div>

      {actionError !== '' && <div className="change-section"><div className="form-error">{actionError}</div></div>}

      <div className="change-actions">
        <span className="change-actions__note">two-phase commit · atomic rename · backup</span>
        <button type="button" className="btn btn--outline" onClick={discard}>Discard</button>
        <button
          type="button" className="btn btn--push"
          onClick={() => (risk.cls === 'risk-chip--higher' ? setConfirmOpen(true) : void push())}
        >
          Push to production
        </button>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="Push higher-risk operations?"
          body="This change writes rows outside the options/postmeta tables. Review the DB journal above — these operations need your explicit confirmation."
          confirmLabel="Push to production"
          danger={false}
          onConfirm={() => { setConfirmOpen(false); void push(); }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
```

`ConfirmDialog` in change-parts.tsx (+ modal CSS):

```tsx
export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel: string; danger: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal__title">{title}</div>
        <div className="modal__body">{body}</div>
        <div className="modal__actions">
          <button type="button" className="btn btn--outline" onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? 'btn btn--danger' : 'btn btn--push'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
```

```css
.modal-overlay { position: fixed; inset: 0; background: rgba(22, 24, 44, 0.4); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { background: var(--surface); border-radius: 14px; box-shadow: var(--shadow); padding: 22px; width: 100%; max-width: 440px; }
.modal__title { font-weight: 600; font-size: 15px; margin-bottom: 8px; }
.modal__body { font-size: 13.5px; color: var(--muted); margin-bottom: 18px; }
.modal__actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn--danger { background: var(--red); color: #fff; font-weight: 600; }
.btn--danger-outline { border: 1.5px solid var(--red); color: var(--red); background: var(--surface); font-weight: 600; }
```

- [ ] **Step 6: Route** — `{ path: '/sites/:id/changes/:seq', element: <ChangePage /> }` in main.tsx.

- [ ] **Step 7: Run e2e** — `npm --workspace ferry-dashboard run e2e -- --grep "draft change page|drifted"` → PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add ferry-dashboard/src ferry-dashboard/e2e/changes.spec.ts
git commit -m "feat(dashboard): change detail page draft state (screen 8) with diff, journal, preconditions and drift preview"
```

### Task 9: Pushing state (screen 9) — SSE, step timeline dedupe, log, elapsed, poll fallback

**Files:**
- Modify: `ferry-dashboard/src/pages/change.tsx`, `ferry-dashboard/src/ui.css`
- Test: `ferry-dashboard/e2e/changes.spec.ts`

**Interfaces:**
- Consumes: `GET /api/sites/:id/push/events?after=`, `PushWireEvent`/`StepEvent` types, scripted runner's 13-event sequence (Task 1).
- Produces: `PushingView` with a state-keyed step reducer (the issue-#9a dedupe).

- [ ] **Step 1: Failing e2e spec**

```ts
test('pushing a draft walks the six steps once each and lands on the pushed card', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Push shop', `https://push-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);
  await page.getByRole('button', { name: 'Push to production' }).click();

  await expect(page.getByText('Nothing is final until the last step succeeds.', { exact: false })).toBeVisible();
  await expect(page.locator('.phase')).toHaveCount(6); // exactly one row per step — duplicate drift start deduped
  await expect(page.locator('.push-log')).toBeVisible();
  // scripted runner finishes in ~120ms; the page transitions to the pushed state
  await expect(page.locator('.status-pill--pushed')).toBeVisible({ timeout: 15_000 });
});
```

- [ ] **Step 2: Run → FAIL** (placeholder has no `.phase` rows).

- [ ] **Step 3: Implement `PushingView`** (replaces the placeholder branch)

Step metadata + reducer (top of change.tsx):

```tsx
const PUSH_STEPS: { id: PushStep; label: string; sub: (c: Change) => string }[] = [
  { id: 'staging', label: 'Diffs to staging directory', sub: (c) => `.ferry-staging/ · ${c.files.length} file${c.files.length === 1 ? '' : 's'}` },
  { id: 'hashes', label: 'Hashes verified', sub: () => '' },
  { id: 'drift', label: 'Drift check — compare-and-swap', sub: (c) => `file hashes + read set of ${c.ops.length + c.preconditions.length} row${c.ops.length + c.preconditions.length === 1 ? '' : 's'}` },
  { id: 'swap', label: 'Atomic rename swap with backup', sub: (c) => `backup → .ferry-backup/${(c.backupTxid ?? '').slice(0, 7)}` },
  { id: 'journal', label: 'Replay DB journal in a single transaction', sub: () => 'SELECT … FOR UPDATE → verify → apply → commit' },
  { id: 'smoke', label: 'Smoke test', sub: (c) => c.smoke.map((s) => s.label).join(' · ') },
];

interface StepState { status: 'pending' | 'active' | 'done' | 'fail'; durationMs?: number; startedAt?: number }
interface ReceivedEvent { event: PushWireEvent; at: number }

/** State-keyed reducer: the real runner emits `drift start` twice (crash-classification marker
 *  at push.ts:124 + the regular re-emission) — keying by step id makes duplicates no-ops
 *  (issue #9: double drift:start SSE emission). */
function reduceSteps(received: ReceivedEvent[]): Record<PushStep, StepState> {
  const steps = Object.fromEntries(PUSH_STEPS.map((s) => [s.id, { status: 'pending' } as StepState])) as Record<PushStep, StepState>;
  for (const { event, at } of received) {
    if (event.type !== 'push_step') continue;
    const p = event.payload as StepEvent;
    const s = steps[p.step];
    if (!s) continue;
    if (p.status === 'start' && s.status === 'pending') { s.status = 'active'; s.startedAt = at; }
    if (p.status === 'ok') { s.status = 'done'; s.durationMs = p.durationMs ?? (s.startedAt !== undefined ? at - s.startedAt : undefined); }
    if (p.status === 'fail') { s.status = 'fail'; s.durationMs = p.durationMs; }
  }
  return steps;
}

function logLines(received: ReceivedEvent[]): { at: number; text: string; ok: boolean }[] {
  const lines: { at: number; text: string; ok: boolean }[] = [];
  for (const { event, at } of received) {
    if (event.type !== 'push_step') continue;
    const p = event.payload as StepEvent;
    if (p.status === 'start' && lines.some((l) => l.text.startsWith(`${p.step}:`) )) continue; // duplicate marker
    lines.push({ at, text: `${p.step}: ${p.status}${p.detail ? ` — ${p.detail}` : ''}`, ok: p.status === 'ok' });
  }
  return lines;
}
```

`PushingView` component:

```tsx
function PushingView({ change, siteId, onDone }: { change: Change; siteId: number; onDone: () => Promise<void> }) {
  const [received, setReceived] = useState<ReceivedEvent[]>([]);
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [startedAt]);

  useEffect(() => {
    esRef.current?.close();
    const es = new EventSource(`/api/sites/${siteId}/push/events?after=0`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as PushWireEvent;
      setReceived((prev) => (prev.some((r) => r.event.seq === event.seq) ? prev : [...prev, { event, at: Date.now() }]));
      if (event.type === 'push_done') void onDone();
    };
    // Poll fallback: boot recovery emits no SSE, and a lost stream must never leave an unknown
    // end state — the change row is the truth (spec §Error handling: never an unknown end state).
    const poll = setInterval(() => void onDone(), 3_000);
    return () => { es.close(); clearInterval(poll); };
  }, [siteId, onDone]);

  const steps = reduceSteps(received);
  const doneCount = PUSH_STEPS.filter((s) => steps[s.id].status === 'done').length;
  const lines = logLines(received);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="push-progress">
      <div className="change-card">
        <div className="change-section">
          <div className="change-head">
            <span className="change-head__title">Pushing to production</span>
            <span className="elapsed-pill mono">pushing · {mm}:{ss}</span>
          </div>
          <p className="card__sub">Nothing is final until the last step succeeds. If anything fails, everything is rolled back.</p>
          <div className="progress"><div className="progress__bar" style={{ width: `${(doneCount / 6) * 100}%` }} /></div>
          <div className="phase-list">
            {PUSH_STEPS.map((meta) => {
              const s = steps[meta.id];
              const cls = s.status === 'done' ? 'phase phase--done' : s.status === 'active' ? 'phase phase--active' : s.status === 'fail' ? 'phase phase--fail' : 'phase phase--pending';
              return (
                <div key={meta.id} className={cls}>
                  <span className="phase__dot">{s.status === 'done' ? '✓' : s.status === 'fail' ? '!' : ''}</span>
                  <span className="phase__text">
                    <span className="phase__label">{meta.label}</span>
                    {meta.sub(change) !== '' && <span className="phase__sub mono">{meta.sub(change)}</span>}
                  </span>
                  {s.durationMs !== undefined && <span className="phase__timing mono">{(s.durationMs / 1000).toFixed(1)}s</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {lines.length > 0 && (
        <div className="push-log terminal">
          {lines.map((l, i) => (
            <div key={i}>
              <span className="terminal__prompt">{new Date(l.at).toLocaleTimeString()}</span>{' '}
              <span className={l.ok ? 'terminal__ok' : undefined}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Wire in `ChangePage`: `{change.status === 'pushing' && <PushingView change={change} siteId={siteId} onDone={reload} />}` — `reload` refetches; when the status left `pushing`, the state switch renders the outcome view. CSS additions:

```css
.push-progress { width: 100%; max-width: 680px; display: flex; flex-direction: column; gap: 14px; }
.elapsed-pill { margin-left: auto; font-size: 11px; font-weight: 600; background: var(--accent-weak); color: var(--accent-ink); padding: 3px 10px; border-radius: 999px; }
.phase--fail { background: var(--red-weak); }
.phase--fail .phase__dot { border-color: var(--red); color: var(--red); }
.phase__timing { font-size: 11px; color: var(--faint); }
.push-log { font-size: 11.5px; }
```

Note: `reload` must be referentially stable (`useCallback` — it already is) or the SSE effect reconnects each render.

- [ ] **Step 4: Run e2e** — `--grep "pushing a draft"` → PASS (the `.phase` count assertion is the dedupe proof: 13 wire events, 6 rows). Typecheck.

- [ ] **Step 5: Commit**

```bash
git add ferry-dashboard/src ferry-dashboard/e2e/changes.spec.ts
git commit -m "feat(dashboard): push progress (screen 9) with deduped step timeline, log and elapsed pill"
```

### Task 10: Pushed state (screen 10) + rollback + rolled-back state (screen 12)

**Files:**
- Modify: `ferry-dashboard/src/pages/change.tsx`, `ferry-dashboard/src/ui.css`
- Test: `ferry-dashboard/e2e/changes.spec.ts`

**Interfaces:**
- Consumes: `Change.smokeResult` (Task 4), `rollbackChange`, seed route `status: 'pushed'`.
- Produces: `PushedView`, `RolledBackView`; navigation with composer prefill state `{ prefill: string }` read by the site page (chat).

- [ ] **Step 1: Failing e2e spec**

```ts
test('a pushed change shows smoke results and rolls back to screen 12', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Pushed shop', `https://pushed-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId, { status: 'pushed' });
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  await expect(page.getByText('Live on production')).toBeVisible();
  await expect(page.locator('.smoke-row')).toHaveCount(3);
  await expect(page.getByText('€24.79')).toBeVisible();
  await expect(page.getByText('2 files · 1 DB operation')).toBeVisible();
  await expect(page.getByText('.ferry-backup/a3f19c2')).toBeVisible();
  await expect(page.getByText('30 days')).toBeVisible();

  await page.getByRole('button', { name: '↺ Roll back' }).click();
  await expect(page.getByText('Your site is back to how it was')).toBeVisible();
  await expect(page.locator('.verify-row')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Back to chat' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Let the agent adjust it' })).toBeVisible();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement both views**

```tsx
function PushedView({ change, siteId, onReload, actionError, setActionError }: {
  change: Change; siteId: number; onReload: () => Promise<void>;
  actionError: string; setActionError: (e: string) => void;
}) {
  const [rollingBack, setRollingBack] = useState(false);

  async function rollBack() {
    setRollingBack(true);
    try {
      await rollbackChange(siteId, change.seq);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not roll back.');
    } finally {
      setRollingBack(false);
      // The route answers { rolledBack: true } even when the plugin-side CAS refused — the
      // change row is the truth; refetch and render whatever status it landed on.
      await onReload();
    }
  }

  return (
    <div className="pushed-wrap">
      <div className="change-card change-card--pushed">
        <div className="change-section">
          <div className="change-head">
            <span className="state-icon state-icon--ok">✓</span>
            <span className="change-head__title">Live on production</span>
          </div>
          <p className="card__sub">The change is live and all smoke checks passed.</p>
          <div className="change-meta">
            {change.pushedAt && <span>{new Date(change.pushedAt).toLocaleTimeString()}</span>}
            {change.prodRef && <span>prod @ {change.prodRef}</span>}
          </div>
        </div>
        <div className="change-section">
          <div className="section-label">Smoke test</div>
          {change.smokeResult === null ? (
            <div className="strip__sub">smoke status unknown after a server restart — verify manually.</div>
          ) : (
            change.smokeResult.map((s, i) => (
              <div key={i} className="smoke-row">
                <span className={s.ok ? 'check-dot' : 'check-dot check-dot--fail'}>{s.ok ? '✓' : '!'}</span>
                <span className="smoke-row__label">{s.label}</span>
                {s.detail && <span className="smoke-row__metric mono">{s.detail}</span>}
              </div>
            ))
          )}
        </div>
        <div className="change-section">
          <div className="strip">
            <div>
              <div className="section-label">Applied</div>
              <div style={{ fontSize: 12.5 }}>{change.files.length} files · {change.ops.length} DB operation{change.ops.length === 1 ? '' : 's'}</div>
            </div>
            <div>
              <div className="section-label">Backup</div>
              <div className="mono" style={{ fontSize: 12.5 }}>.ferry-backup/{(change.backupTxid ?? '').slice(0, 7)}</div>
            </div>
          </div>
        </div>
        {actionError !== '' && <div className="change-section"><div className="form-error">{actionError}</div></div>}
        <div className="change-actions">
          <span className="change-actions__note">Not right? Rolling back is one click — the journal is replayed in reverse.</span>
          <button type="button" className="btn btn--danger-outline" disabled={rollingBack} onClick={rollBack}>↺ Roll back</button>
        </div>
      </div>
      <p className="retention-note">The rollback button stays available as long as the backup exists — <span className="mono">30 days</span>.</p>
    </div>
  );
}

function RolledBackView({ change, siteId }: { change: Change; siteId: number }) {
  return (
    <div className="change-card">
      <div className="change-section">
        <div className="change-head">
          <span className="state-icon state-icon--neutral">↺</span>
          <span className="change-head__title">Your site is back to how it was</span>
        </div>
        <p className="card__sub">Everything from this change has been undone. The change is kept, so you can push it again later or have the agent adjust it.</p>
        <div className="change-meta">
          {change.rolledBackAt && <span>rolled back {new Date(change.rolledBackAt).toLocaleTimeString()}</span>}
          <span>prod @ {change.baseSha.slice(0, 7)}</span>
        </div>
      </div>
      <div className="change-section">
        <div className="verify-row"><span className="check-dot">✓</span><span>{change.files.length} files restored from backup</span><span className="verify-row__value mono">.ferry-backup/{(change.backupTxid ?? '').slice(0, 7)}</span></div>
        <div className="verify-row"><span className="check-dot">✓</span><span>DB journal replayed in reverse</span><span className="verify-row__value mono">{change.ops.length} operation{change.ops.length === 1 ? '' : 's'}</span></div>
        <div className="verify-row"><span className="check-dot">✓</span><span>Verification — hashes match the snapshot</span></div>
      </div>
      <div className="change-actions">
        <span className="change-actions__note">The agent branch <span className="mono">{change.branch}</span> is kept.</span>
        <Link to={`/sites/${siteId}`} role="button" className="btn btn--outline">Back to chat</Link>
        <Link
          to={`/sites/${siteId}`} role="button" className="btn btn--primary"
          state={{ prefill: `${changeRef(change.seq)} ("${change.title}") was rolled back — please take another look and adjust the fix.` }}
        >
          Let the agent adjust it
        </Link>
      </div>
    </div>
  );
}
```

CSS:

```css
.pushed-wrap { width: 100%; max-width: 680px; }
.smoke-row { display: flex; align-items: center; gap: 9px; padding: 5px 0; font-size: 13px; }
.smoke-row__label { flex: 1; }
.smoke-row__metric { font-size: 11px; color: var(--faint); }
.check-dot--fail { background: var(--red-weak); border-color: var(--red); color: var(--red); }
.retention-note { text-align: center; font-size: 12.5px; color: var(--faint); margin-top: 14px; }
.verify-row { display: flex; align-items: center; gap: 9px; padding: 5px 0; font-size: 13px; }
.verify-row__value { margin-left: auto; font-size: 11px; color: var(--faint); }
```

Composer prefill: in `chat.tsx`, initialize the draft from router state — `const location = useLocation();` and `useState(() => (location.state as { prefill?: string } | null)?.prefill ?? '')` for `draft`. (Human presses send — the one-click-to-production principle extends to agent nudges staying human-initiated.)

Wire both views into `ChangePage`'s state switch.

- [ ] **Step 4: Run e2e** — `--grep "pushed change"` → PASS; full dashboard typecheck.

- [ ] **Step 5: Commit**

```bash
git add ferry-dashboard/src ferry-dashboard/e2e/changes.spec.ts
git commit -m "feat(dashboard): pushed (screen 10) and rolled-back (screen 12) card states with rollback flow"
```

### Task 11: Conflict state (screen 11) — Retry + Force, and the force-on-conflict guard fix

**Files:**
- Modify: `ferry-server/src/routes/changes.ts` (guard), `ferry-server/tests/changes-routes.test.ts`
- Modify: `ferry-dashboard/src/pages/change.tsx`, `ferry-dashboard/src/ui.css`
- Test: `ferry-dashboard/e2e/changes.spec.ts`

**Interfaces:**
- Consumes: `Change.conflict`, `retryChange`, `pushChange(force)`, `ConfirmDialog`, seed `status: 'conflict'`.
- Produces: push route accepts `conflict` status when `force: true`.

- [ ] **Step 1: Failing server route tests**

```ts
  it('force-pushes a conflicted change', async () => {
    // seed change, set status conflict, POST push { force: true } → 202; runner sees force: true
  });

  it('refuses a plain push of a conflicted change', async () => {
    // POST push {} on conflict status → 409 'Only a draft change can be pushed.'
  });
```

- [ ] **Step 2: Run → FAIL** (force push gets 409).

- [ ] **Step 3: Guard fix in routes/changes.ts** (push route — move the `force` read above the status guard):

```ts
    const force = !!(request.body as { force?: boolean } | undefined)?.force;
    // Screen 11's Force action pushes a conflicted change; anything else stays draft-only.
    const pushable = change.status === 'draft' || (change.status === 'conflict' && force);
    if (!pushable) return reply.code(409).send({ error: 'Only a draft change can be pushed.' });
```

Run the server suite → PASS.

- [ ] **Step 4: Failing dashboard e2e**

```ts
test('a conflicted change shows the read-set table; Force re-pushes after a confirm', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Conflict view', `https://cview-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId, { status: 'conflict' });
  await page.goto(`/sites/${siteId}/changes/${seq}`);

  await expect(page.getByText('Push stopped — production changed in the meantime')).toBeVisible();
  await expect(page.getByText('Nothing was changed on your site.', { exact: false })).toBeVisible();
  await expect(page.locator('.conflict-table__row--data')).toHaveCount(1);
  await expect(page.getByText('now on prod')).toBeVisible();
  // deferred option is NOT rendered (design decision 3)
  await expect(page.getByText('Push the code only')).toHaveCount(0);
  await expect(page.getByText('no backup needed · no rollback needed · production untouched')).toBeVisible();

  // Retry on a non-ready site surfaces the guard honestly
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.form-error')).toHaveText('Sync the site first.');

  // Force → confirm dialog → scripted happy push → pushed
  await page.getByRole('button', { name: 'Force' }).click();
  await expect(page.getByText('Force overwrite?')).toBeVisible();
  await page.getByRole('button', { name: 'Force push' }).click();
  await expect(page.locator('.status-pill--pushed')).toBeVisible({ timeout: 15_000 });
});

test('a push that hits drift lands on the conflict card', async ({ page }) => {
  await signUp(page);
  const siteId = await createSite(page, 'Conflict push', `https://conflict-${Date.now()}.example.com`);
  const { seq } = await seedChange(page, siteId);
  await page.goto(`/sites/${siteId}/changes/${seq}`);
  await page.getByRole('button', { name: 'Push to production' }).click();
  await expect(page.getByText('Push stopped — production changed in the meantime')).toBeVisible({ timeout: 15_000 });
});
```

(Note: the `conflict` slug drives `conflictOn: 'drift'`; the force-after-confirm in the first test uses the happy runner because `cview` doesn't match any script keyword.)

- [ ] **Step 5: Implement `ConflictView`**

```tsx
function ConflictView({ change, siteId, onReload, actionError, setActionError }: {
  change: Change; siteId: number; onReload: () => Promise<void>;
  actionError: string; setActionError: (e: string) => void;
}) {
  const [forceOpen, setForceOpen] = useState(false);
  const navigate = useNavigate();

  async function retry() {
    try {
      await retryChange(siteId, change.seq);
      navigate(`/sites/${siteId}`); // watch the agent pick the conflict up in chat
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not start the retry.');
    }
  }

  async function force() {
    try {
      await pushChange(siteId, change.seq, true);
      await onReload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not force the push.');
    }
  }

  return (
    <div className="change-card change-card--conflict">
      <div className="change-section">
        <div className="change-head">
          <span className="state-icon state-icon--warn">!</span>
          <span className="change-head__title">Push stopped — production changed in the meantime</span>
        </div>
        <p className="card__sub"><strong>Nothing</strong> was changed on your site. The check and the change happen in one indivisible step; because the check failed, the entire transaction was rolled back.</p>
      </div>
      <div className="change-section">
        <div className="section-label">What no longer matched</div>
        <div className="conflict-table">
          <div className="conflict-table__row conflict-table__row--head mono">
            <span>key from read set</span><span>expected</span><span>now on prod</span>
          </div>
          {(change.conflict ?? []).map((c, i) => (
            <div key={i} className="conflict-table__row conflict-table__row--data mono">
              <span>{c.key}</span>
              <span className="conflict-expected">{c.expected || '—'}</span>
              <span className="conflict-found">{c.found}</span>
            </div>
          ))}
        </div>
        <div className="ops-footnote">Production changed after this fix was drafted, so the fix’s assumptions no longer hold.</div>
      </div>
      <div className="change-section">
        <div className="section-label">How to proceed</div>
        <div className="conflict-option conflict-option--recommended">
          <div className="conflict-option__text">
            <span className="conflict-option__title">Let the agent take another look</span>
            <span className="conflict-option__sub">Ferry fetches the changed rows and the agent adjusts the fix. Recommended.</span>
          </div>
          <button type="button" className="btn btn--primary btn--sm" onClick={retry}>Retry</button>
        </div>
        <div className="conflict-option conflict-option--danger">
          <div className="conflict-option__text">
            <span className="conflict-option__title">Force overwrite</span>
            <span className="conflict-option__sub">Ignore the new value on production. Only if you know what you’re doing.</span>
          </div>
          <button type="button" className="btn btn--danger-outline btn--sm" onClick={() => setForceOpen(true)}>Force</button>
        </div>
      </div>
      {actionError !== '' && <div className="change-section"><div className="form-error">{actionError}</div></div>}
      <div className="change-actions">
        <span className="change-actions__note">no backup needed · no rollback needed · production untouched</span>
      </div>
      {forceOpen && (
        <ConfirmDialog
          title="Force overwrite?"
          body="This ignores what changed on production and applies the fix anyway. The current production values will be overwritten. The apply itself stays transactional."
          confirmLabel="Force push"
          danger
          onConfirm={() => { setForceOpen(false); void force(); }}
          onCancel={() => setForceOpen(false)}
        />
      )}
    </div>
  );
}
```

CSS:

```css
.conflict-table { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.conflict-table__row { display: grid; grid-template-columns: 1fr 130px 130px; gap: 10px; padding: 9px 12px; font-size: 11.5px; border-bottom: 1px solid var(--border); }
.conflict-table__row:last-child { border-bottom: 0; }
.conflict-table__row--head { background: var(--surface-2); font-size: 10.5px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
.conflict-table__row--data { background: var(--red-weak); }
.conflict-expected { color: var(--muted); }
.conflict-found { color: var(--red); font-weight: 600; }
.conflict-option { display: flex; align-items: center; gap: 14px; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
.conflict-option--recommended { border-color: var(--accent); background: var(--accent-weak); }
.conflict-option--recommended .conflict-option__title, .conflict-option--recommended .conflict-option__sub { color: var(--accent-ink); }
.conflict-option--danger { border-color: var(--red); }
.conflict-option__text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.conflict-option__title { font-weight: 600; font-size: 13.5px; }
.conflict-option__sub { font-size: 12.5px; color: var(--muted); }
```

Wire into the state switch. A forced push flips status to `pushing` → the Task 9 view takes over automatically on reload.

- [ ] **Step 6: Run e2e** — `--grep "conflicted change|hits drift"` → PASS; server + dashboard suites green.

- [ ] **Step 7: Commit**

```bash
git add ferry-server/src/routes/changes.ts ferry-server/tests/changes-routes.test.ts ferry-dashboard/src ferry-dashboard/e2e/changes.spec.ts
git commit -m "feat(dashboard,server): conflict card (screen 11) with Retry + confirmed Force; allow force-push of a conflicted change"
```

### Task 12: Turn-scoped push exclusivity (5a gap — blocks the hero flow)

`AgentManager.isActive` returns `this.hot.has(siteId)` — true for the whole hot-session lifetime (idle timeout: 30 min default, 60 s in e2e). The push route 409s on it, so **chat → card → Push is blocked for up to 30 minutes after any chat turn** — the exact flow screens 6→9 sell, and the §6 acceptance's one click. The spec's wording is "sync, agent **turn**, and push are pairwise exclusive"; implement the turn reading for the push guard. (The sync route's stricter hot-session guard is pre-existing Plan-4 behavior and stays untouched — surgical change only.)

**Files:**
- Modify: `ferry-server/src/agent/manager.ts`, `ferry-server/src/routes/changes.ts`
- Test: `ferry-server/tests/changes-routes.test.ts`

**Interfaces:**
- Produces: `AgentManager.isMidTurn(siteId): boolean` — true only while a turn is running (session row status `'running'`, set on `send()`, cleared on `turn_end`/`runner_error`; boot recovery already resets stuck sessions).

- [ ] **Step 1: Failing route test**

```ts
  it('allows a push while the agent session is hot but idle', async () => {
    // site with agent deps (scripted runner): send a message, await the scripted turn_end
    // (poll store.currentAgentSession(site.id) until status === 'idle'), then POST push.
    // Expected: 202 { started: true } — NOT the 409 'The agent is working…'.
  });

  it('refuses a push mid-turn', async () => {
    // A runner whose send() never emits turn_end (hand-rolled, like fakeRunner in
    // push-manager.test.ts): send, then POST push immediately.
    // Expected: 409 'The agent is working on this site — finish or start a new session first.'
  });
```

- [ ] **Step 2: Run → FAIL** (first test gets 409).

- [ ] **Step 3: Implement**

`agent/manager.ts`, next to `isActive`:

```ts
  /** True only while a turn is actually running (spec: sync, agent TURN and push are pairwise
   *  exclusive) — a hot-but-idle SDK subprocess doesn't touch the site, so it must not block
   *  the chat → card → push flow. Session status is set 'running' on send() and cleared on
   *  turn_end/runner_error; boot recovery resets stuck 'running' rows. */
  isMidTurn(siteId: number): boolean {
    return this.store.currentAgentSession(siteId)?.status === 'running';
  }
```

`routes/changes.ts` push route: replace `agents?.isActive(site.id)` with `agents?.isMidTurn(site.id)` (same 409 copy — it is accurate for a running turn). Leave every other `isActive` call site untouched.

- [ ] **Step 4: Full server suite** — adjust any existing test that asserted the 409 via a hot-but-idle session (it now must use a mid-turn runner) → PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/agent/manager.ts ferry-server/src/routes/changes.ts ferry-server/tests/changes-routes.test.ts
git commit -m "fix(server): push exclusivity is turn-scoped — a hot idle agent session no longer blocks the one click"
```

### Task 13: Inline change card in chat (screen 6b) + gate-test 5b section

**Files:**
- Modify: `ferry-dashboard/src/chat.tsx`, `ferry-dashboard/src/change-parts.tsx`, `ferry-dashboard/src/ui.css`
- Test: `ferry-dashboard/e2e/dashboard.spec.ts` (gate test — requires the DDEV fixture)

**Interfaces:**
- Consumes: persisted `change_card` event `{changeId, seq, title, status}` (note: `payload.seq` is the CHANGE seq, distinct from the wire event's own `seq`), `getChange`, `pushChange`; seed route `emitCard: true` (live session required — `appendSystemEvent` is a no-op without one).
- Produces: `InlineChangeCard({siteId, changeSeq, title})`; chat Block kind `change_card`.

- [ ] **Step 1: Failing gate-test additions** (in `dashboard.spec.ts`'s long happy-path test, after the existing chat assertions; the site there is paired + synced + has a live scripted session)

```ts
  // ---- 5b: runner errors are visible (issue #9) ----
  await page.getByPlaceholder('Ask a follow-up or request another fix…').fill('trigger-runner-error');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.chat__status--error')).toContainText('The agent hit an internal error');

  // ---- 5b: inline change card over live SSE ----
  const siteId = Number(page.url().match(/sites\/(\d+)/)![1]);
  const seedRes = await page.request.post('/e2e/changes', { data: { siteId, emitCard: true } });
  expect(seedRes.ok()).toBeTruthy();
  const seeded = await seedRes.json();
  await expect(page.locator('.ccard')).toBeVisible();
  await expect(page.locator('.ccard__title')).toHaveText('VAT calculation fixed');
  await expect(page.locator('.ccard')).toContainText('2 files changed');
  await expect(page.locator('.ccard')).toContainText('nothing goes to production automatically');
  // composer stays usable with the card in the feed
  await expect(page.getByPlaceholder('Ask a follow-up or request another fix…')).toBeEnabled();

  // replayed from history after a reload
  await page.reload();
  await expect(page.locator('.ccard')).toBeVisible();

  // View diff navigates to the change page
  await page.getByRole('link', { name: 'View diff' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}/changes/${seeded.seq}`);
  await expect(page.locator('.change-head__title')).toHaveText('VAT calculation fixed');
  await page.goBack();

  // ---- 5b: the one click, straight from the card (turn-scoped guard, Task 12) ----
  // The chat session is hot but idle — this must NOT 409.
  await page.locator('.ccard').getByRole('button', { name: 'Push to production' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}/changes/${seeded.seq}`);
  await expect(page.locator('.status-pill--pushed')).toBeVisible({ timeout: 15_000 });
  await page.goBack();

  // ---- 5b: retry posts the conflict into the chat ----
  const conflictSeed = await page.request.post('/e2e/changes', { data: { siteId, status: 'conflict' } });
  const conflictChange = await conflictSeed.json();
  await page.goto(`/sites/${siteId}/changes/${conflictChange.seq}`);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page).toHaveURL(`/sites/${siteId}`);
  await expect(page.locator('.chat__msg--user').last()).toContainText('hit a conflict');
```

(Scope selectors with classes if `getByText` collides — the strict-mode warnings at `dashboard.spec.ts:130,139` apply here too.)

- [ ] **Step 2: Run → FAIL** (no `.ccard` renders; the error status may already pass after Task 2 — keep it here as the end-to-end proof).

- [ ] **Step 3: `InlineChangeCard` in change-parts.tsx**

```tsx
import { Link } from 'react-router-dom';
import { getChange, pushChange, ApiError, type Change } from './api';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function InlineChangeCard({ siteId, changeSeq, title }: { siteId: number; changeSeq: number; title: string }) {
  const [change, setChange] = useState<Change | null>(null);
  const [pushError, setPushError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    void getChange(siteId, changeSeq).then(setChange).catch(() => undefined);
  }, [siteId, changeSeq]);

  async function push() {
    try {
      await pushChange(siteId, changeSeq);
      navigate(`/sites/${siteId}/changes/${changeSeq}`); // watch the six steps on the change page
    } catch (err) {
      setPushError(err instanceof ApiError ? err.message : 'Could not start the push.');
    }
  }

  const files = change?.files ?? [];
  const optionOps = (change?.ops ?? []).filter((o) => o.kind === 'option_set' || o.kind === 'option_delete');

  return (
    <div className="ccard">
      <div className="ccard__head">
        <span className="state-icon state-icon--ok">✓</span>
        <span className="ccard__title">{change?.title ?? title}</span>
        <span className="ccard__ref mono">{changeRef(changeSeq)} · {change ? change.status : '…'}</span>
      </div>
      {change && (
        <>
          <div className="ccard__summary">“{change.summary}”</div>
          <div className="ccard__row">
            <span className="ccard__row-label">▸ {files.length} file{files.length === 1 ? '' : 's'} changed</span>
            {/* honest files list: everything the push would apply, including carried-over work */}
            <span className="ccard__row-detail mono">{files.map((f) => f.path.split('/').pop()).join(' · ')}</span>
          </div>
          {change.ops.length > 0 && (
            <div className="ccard__row">
              <span className="ccard__row-label">▸ {change.ops.length} {change.ops.length === optionOps.length ? `setting${change.ops.length === 1 ? '' : 's'}` : `DB operation${change.ops.length === 1 ? '' : 's'}`}</span>
              {optionOps.length === 1 && optionOps[0].kind === 'option_set' && (
                <span className="ccard__row-detail mono">
                  {optionOps[0].name} <span className="ccard__old">{optionOps[0].old}</span> → <span className="ccard__new">{optionOps[0].new}</span>
                </span>
              )}
            </div>
          )}
          <div className="ccard__row">
            <span className="ccard__row-label">✓ Drift check</span>
            <span className="ccard__row-detail">verified at push time inside the write transaction</span>
          </div>
          {change.smoke.length > 0 && (
            <div className="ccard__row">
              <span className="ccard__row-label mono">⚑</span>
              <span className="ccard__row-detail">
                After push I test: <strong>{change.smoke.map((s) => s.label).join(' · ')}</strong>. If the smoke test fails → automatic rollback.
              </span>
            </div>
          )}
          {pushError !== '' && <div className="ccard__row"><span className="ccard__row-detail" style={{ color: 'var(--red)' }}>{pushError}</span></div>}
          <div className="ccard__footer">
            <span className="ccard__note mono">nothing goes to production automatically</span>
            <Link to={`/sites/${siteId}/changes/${changeSeq}`} role="link" className="btn btn--outline btn--sm">View diff</Link>
            {change.status === 'draft' && (
              <button type="button" className="btn btn--push btn--sm" onClick={push}>Push to production</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

CSS:

```css
.ccard { max-width: 92%; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); box-shadow: 0 10px 30px -18px rgba(22, 24, 44, 0.35); overflow: hidden; }
.ccard__head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.ccard__head .state-icon { width: 22px; height: 22px; }
.ccard__title { font-weight: 600; font-size: 15px; flex: 1; }
.ccard__ref { font-size: 10.5px; background: var(--panel); color: var(--muted); padding: 2px 8px; border-radius: 999px; }
.ccard__summary { margin: 12px 18px; background: var(--panel); border-radius: 9px; padding: 10px 12px; font-size: 13.5px; }
.ccard__row { display: flex; align-items: baseline; gap: 8px; padding: 9px 18px; border-top: 1px solid var(--border); font-size: 13px; }
.ccard__row-label { font-weight: 500; white-space: nowrap; }
.ccard__row-detail { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
.ccard__old { color: var(--red); text-decoration: line-through; }
.ccard__new { color: var(--green); }
.ccard__footer { display: flex; align-items: center; gap: 10px; padding: 12px 18px; background: var(--panel); border-top: 1px solid var(--border); }
.ccard__note { font-size: 11.5px; color: var(--faint); margin-right: auto; }
```

- [ ] **Step 4: chat.tsx wiring**

Block union: `| { kind: 'change_card'; key: string; changeSeq: number; title: string }`. In `buildBlocks`:

```ts
      case 'change_card':
        flushTools();
        blocks.push({
          kind: 'change_card', key,
          changeSeq: Number(event.payload.seq ?? 0), // the CHANGE seq, not the wire seq
          title: String(event.payload.title ?? ''),
        });
        break;
```

Render branch (before the status branch), with `siteId` in scope:

```tsx
          if (block.kind === 'change_card') {
            return <InlineChangeCard key={block.key} siteId={siteId} changeSeq={block.changeSeq} title={block.title} />;
          }
```

- [ ] **Step 5: Run the gate test** (fixture running, `NODE_EXTRA_CA_CERTS` exported): `npm --workspace ferry-dashboard run e2e -- --grep "3b gate"` → PASS. Then the full e2e suite.

- [ ] **Step 6: Commit**

```bash
git add ferry-dashboard/src ferry-dashboard/e2e/dashboard.spec.ts
git commit -m "feat(dashboard): inline change card in chat (screen 6) with live SSE, replay, view-diff and push"
```

### Task 14: Full verification + §6 acceptance runbook

**Files:**
- Create: `docs/runbooks/2026-08-10-plan5b-acceptance.md`

- [ ] **Step 1: Run every suite and typecheck**

```bash
npm --workspace ferry-plugin-tests run test 2>/dev/null || (cd ferry-plugin && ./vendor/bin/phpunit)
npm --workspace ferry-cli run test && npm --workspace ferry-cli run typecheck 2>/dev/null || true
npm --workspace ferry-server run test && npm --workspace ferry-server run typecheck
npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run e2e
```

(Resolve the plugin/cli command names from the workspace `package.json`s / `composer.json` — run whatever the repo's own scripts are; the counts to match or exceed: plugin 203, cli 141, server 159, dashboard e2e 9, plus every test this plan added.)
Expected: all green. Fix anything red before proceeding.

- [ ] **Step 2: Write the acceptance runbook** — `docs/runbooks/2026-08-10-plan5b-acceptance.md`, covering the base-doc §6 criterion end-to-end with the real fixture:

1. **Fixture prep** (`~/ferry-e2e/prod`, official-zip discipline — never `ddev wp core download`): install WooCommerce from the official wordpress.org zip via `ddev wp plugin install woocommerce --activate` equivalent zip flow, seed 3 products, enable guest checkout + a flat tax rate (21%).
2. **Plant the bug**: the design's double-VAT hook (a `woocommerce_calc_tax` filter adding 21% above €100) appended to the active theme's `functions.php` via the documented edit script.
3. **Order loop**: a small shell/Node script placing a checkout order every ~20s against the fixture URL for the whole session (record order ids + totals to a log file for the proof).
4. **Session**: dev servers up (`ferry-server` :4000 with `NODE_EXTRA_CA_CERTS` exported at process start + `FERRY_AGENT_MAX_BUDGET_USD=2`, dashboard :5173; check both ports for stale listeners first); paired clone site synced; human asks the agent to investigate the VAT bug; agent fixes on `agent/work`, runs `db_journal` → `create_change`; the inline card appears in chat.
5. **The one click**: human clicks **Push to production** on the card; watch screens 8 → 9 → 10 live.
6. **Proof queries** (run against the fixture DB): every order placed during the session intact (count + totals match the order-loop log, before and after the push window); the fix live (option value + hook removed); `wp_options` shows no unexpected writes outside the journal's keys; backup dir exists.
7. **Honest conflict**: create a second change, manually edit the target option in wp-admin, push → screen 11 renders the real conflict; verify nothing was applied; Force path exercised once, then rolled back.
8. **Rollback proof**: roll the pushed change back from screen 10; verify prod files + option restored; orders still intact.

Each step gets its exact commands/SQL in the runbook (write them concretely — order counts via `wc_get_orders`/SQL on the orders tables, option via `wp option get`).

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/2026-08-10-plan5b-acceptance.md
git commit -m "docs: Plan 5b acceptance runbook (base doc §6 criterion)"
```

- [ ] **Step 4: Hand back to the human** — the runbook's execution (WooCommerce install, order loop, the one click, proof queries) is the human gate; do not run it autonomously. Also queue the screens 3–5 manual design pass while both dev servers are up.

---

## Self-review checklist (run after writing, before sign-off)

- Spec §Dashboard (5b) coverage: Changes tab ✓ (T7) · change page states 8/9/10/11/12 ✓ (T8/T9/T10/T11/T10) · inline card ✓ (T13) · badge ✓ (T7) · `--amber-ink` token ✓ (T7) · no cost UI ✓ (nothing renders cost anywhere).
- Issue #9 fold-ins: drift:start dedupe ✓ (T1 fake + T9 reducer + e2e count) · runner auth errors ✓ (T2 + T13 e2e) · per-card file scoping ✓ (T3 root fix + honest files list in T13/T8).
- 5a gaps surfaced by this plan: force-on-conflict guard ✓ (T11) · turn-scoped push exclusivity ✓ (T12) · smoke results not persisted ✓ (T4) · drift preview unexposed ✓ (T5).
- Error handling (spec §Error handling): 409s render inline (T8/T10/T11) · SSE + poll fallback, never an unknown end state (T9) · rollback CAS refusal renders whatever status the row lands on (T10).
- Deferred, deliberately: "Push the code only" (decision 3) · screenshots (decision 2) · list projection route (decision 10) · sites-list open-change count (screen 5 belongs to the 3–5 design pass).

