# Ferry Plan 4 — Agent chat: design

**Date:** 2026-07-26 · **Status:** approved in brainstorming, pending spec review
**Inputs:** roadmap §Plan 4 · SaaS spec §10/§12/§13 · design screen 6 (chat portion) ·
`2026-07-26-claude-agent-sdk-capabilities.md` (Phase 0 research)

**Done when (roadmap):** a user chats with the ferry agent about their cloned site; the agent
greps/reads/edits/runs wp-cli in the clone and reports a plan and a fix on its own branch.

## Decisions (from brainstorming, 2026-07-26)

1. **Full liveness:** tool-log rows stream the moment they run; assistant prose streams
   token-by-token (`includePartialMessages`).
2. **Rolling session per site + "New session" escape hatch.** No session list/switcher.
3. **Model `sonnet`** (alias, not a dated ID) with cost rails; per-site override deferred.
4. **Hybrid state model:** live SDK process per hot site with the SDK's own transcript for
   agent memory/resume; every normalized chat event is **also appended to SQLite**, and the
   dashboard reads history from SQLite only. Rationale: 3-month product horizon — audit trail,
   search, Plan-6 VM move, and change-card links all want server-side rows; we already
   normalize every event for SSE, so persisting them is marginal work. We never parse the
   SDK's internal JSONL for rendering.
5. **Web tools (WebSearch/WebFetch) off in v1** — web content is a prompt-injection vector
   while the agent holds a host shell. Re-enabled in Plan 6 behind VM isolation + proxied
   egress (recorded in the roadmap).
6. **Bridge stays read-only** (until Plan 5): the agent edits only the clone, on its own git
   branch; ferry tools exposed to it are read-only.

## Architecture

New `AgentManager` in `ferry-server` (sibling of `SyncManager`), one instance per process,
holding per-site agent state:

```
dashboard ──POST /agent/messages──► AgentManager ──streamInput──► SDK query() subprocess
    ▲                                   │                            (cwd = clone dir)
    │◄──SSE /agent/events── fan-out ◄───┤ normalize SDK messages
    │                                   ├──append──► SQLite agent_events
GET /agent/history ◄────────────────────┴──────────► agent_sessions pointer
```

- **Hot session:** first message for a site spawns `query()` in streaming-input mode
  (`prompt` = AsyncIterable fed by the manager). Later messages push into the same stream —
  the SDK queues them if the agent is mid-turn; the composer therefore never blocks.
- **Idle teardown:** after `FERRY_AGENT_IDLE_MS` (default 30 min) without activity the
  subprocess is closed. The session is *not* over — the next message spawns a new `query()`
  with `resume: session_id` (transcript loads from disk; no API replay cost).
- **Restart recovery:** same path — `session_id` lives in SQLite, transcripts under
  `FERRY_HOME` (see hermetic config), so a server restart resumes cleanly.
- **New session:** `POST /agent/sessions` interrupts any hot process, clears the pointer;
  the next message starts a fresh SDK session. Old events/transcript stay on disk.
- **Sync mutual exclusion:** a site's sync and agent cannot run at the same time —
  starting a sync while the agent is mid-turn returns 409, and vice versa (a pull rewrites
  the `production` branch under the agent's feet).

## Agent configuration (hermetic)

Per Phase 0 security finding: the SDK's default `settingSources` loads `.claude/` from the
cwd — which is **customer-controlled clone content** (a hostile site could ship
`.claude/settings.json` hooks that execute on our server). Therefore:

- `settingSources: []` — never load operator (`~/.claude`) or clone (`.claude/`) config.
- Ground rules delivered via `systemPrompt: { type: 'preset', preset: 'claude_code', append }`.
  The append is the clone `CLAUDE.md` content (source of truth: `ferry-cli/src/git.ts`)
  plus agent-specific rules: wp-cli runs as `ddev wp …` from the clone root; work only on
  your agent branch, never `git push`, never touch `production`; the DB is a snapshot;
  never edit ferry/DDEV artifacts. The auto-placed clone `CLAUDE.md` stays (for humans and
  local Claude Code use) but the server session does not depend on it.
- `CLAUDE_CONFIG_DIR = join(ferryHome(), 'agent')` — transcripts and SDK state live inside
  `FERRY_HOME` (spec §13: readable files per site), not the operator homedir.
- `cwd` = `join(ferryHome(), 'clones', slug)`; `env` passes only what the session needs
  (PATH, HOME, ANTHROPIC_API_KEY, DDEV requirements) — audited at implementation.
- `model: FERRY_AGENT_MODEL` (default `'sonnet'`), `maxTurns: FERRY_AGENT_MAX_TURNS`
  (default 50), `maxBudgetUsd: FERRY_AGENT_MAX_BUDGET_USD` (default 5) per session-run.

## Guardrails & permissions

Isolation is Plan 6; these are app-level rails, not a sandbox — stated plainly in the doc
and code comments.

- `permissionMode: 'bypassPermissions'` (headless; no interactive prompts) **plus**:
- Deny rules: `git push` (`Bash(git push:*)` pattern), `WebSearch`, `WebFetch` disabled
  (via `disallowedTools` / omitting from `tools`).
- `PreToolUse` hook as second line: denies `git push`/remote-mutating git and network
  commands with a reason the model sees; logs every tool use per site (audit).
- Exact rule syntax pinned against installed SDK typings at implementation (Phase 0 flagged
  minor inconsistencies).

## Ferry MCP tools (in-process, read-only)

`createSdkMcpServer({ name: 'ferry' })` registered in `options.mcpServers`; handlers call
engine code directly:

- `mcp__ferry__fetch_uploads` — materialize missing uploads (wraps `fetchUploads`;
  prefix or `--all`).
- `mcp__ferry__site_info` — profile + provenance + last-sync summary for the site.

Nothing else in v1. No write/bridge tools until Plan 5.

## Git branch policy

- One agent branch per site: `agent/work`, created from `production` on first session start
  if missing; the manager checks out `agent/work` before the first turn.
- Sync keeps committing pulls to `production`; `git diff production` on the clone remains
  "exactly what the agent changed". Topical branches (`agent/vat-fix`) are Plan 5 territory
  (change cards own naming then).
- Honest caveat: once a post-agent sync moves `production` forward, `git diff production`
  includes that divergence too (not just the agent's changes) until Plan 5 rebases
  `agent/work` or otherwise reconciles it.

## Data model (SQLite, `store.ts`)

```
agent_sessions: id, site_id (FK), sdk_session_id (nullable until init), status
                ('idle'|'running'|'error'), created_at, last_activity_at
agent_events:   id (autoincrement = SSE seq), session_id (FK), type, payload (JSON),
                created_at
```

Persisted event types (also the SSE wire shape):

| type | payload | source |
|---|---|---|
| `user` | `{text}` | composer |
| `agent_text` | `{text}` | complete assistant text block |
| `tool_use` | `{toolUseId, name, input}` (input truncated for display) | assistant `tool_use` block |
| `tool_result` | `{toolUseId, output, isError}` (output truncated) | `tool_result` block |
| `turn_end` | `{subtype, totalCostUsd, inputTokens, outputTokens, numTurns, durationMs}` | SDK `result` message |
| `status` | `{state, detail?}` | manager — emitted only for the new-session notice and error; no separate running/idle/budget/resume states are emitted in v1 |

SSE-only, never persisted: `text_delta` `{text}` (token streaming for the in-flight
assistant block; the following `agent_text` event is the authoritative text).

## HTTP API (all under `requireUser` + site ownership, like existing routes)

- `POST /api/sites/:id/agent/messages` `{text}` → 202. Spawns/resumes as needed, appends
  `user` event, feeds the stream. 409 while a sync runs.
- `POST /api/sites/:id/agent/sessions` → 200. New-session escape hatch (interrupt + pointer).
- `GET  /api/sites/:id/agent/history?after=<seq>` → page of persisted events for the
  current session (dashboard reload).
- `GET  /api/sites/:id/agent/events?after=<seq>` → SSE. Replays persisted events after
  `seq` from SQLite, then live events incl. `text_delta`. Same hijack + 15s heartbeat
  pattern as sync SSE.

## Dashboard (screen 6, chat portion)

- New route `/sites/:id` — site-detail shell per screen 6: site-scoped sidebar (site card,
  nav with Agent chat active; Changes/Sync/Settings entries rendered but disabled —
  non-navigating — until their plans land), chat column, right context rail (Environment
  from profile data; Containment card; git-diff panel as a `git diff production --stat`
  read from the clone by a small server endpoint — cut it if it drags, it's rail garnish,
  not chat).
- Chat column: user bubbles, agent messages, inline mono tool-log rows (`tool_use` +
  paired `tool_result`), token-streamed assistant text (accumulate `text_delta`, replace
  with `agent_text` on arrival), "SSE live" indicator with a **visible error state**
  (fixes 3b's silent-freeze `es.onerror` triage item), composer (enabled while agent runs —
  messages queue), "New session" action.
- All copy in English.
- **Fold-ins while touching these surfaces** (3b triage): pairing input `aria-label`;
  dead `ui.css` tokens removed (`--amber*` now used by screen 6 chips — verify before
  deleting; `--radius`, `--shadow`, `.chip--asleep` if still dead); `e2e/` + config files
  brought under typecheck in both web workspaces.

## Error handling

- SDK error results (`error_max_turns`, `error_max_budget_usd`, `error_during_execution`)
  → `status` event with a human-readable detail, rendered as a system line in the chat —
  never a frozen spinner. Session stays resumable; "New session" always works.
- Subprocess crash → session `status: 'error'` + event; next message attempts resume.
- Auth/key failures surface in server logs loudly (operator problem, not user problem);
  chat shows "agent unavailable".
- Boot recovery: any `agent_sessions.status = 'running'` at server start → `'idle'`
  (mirrors sync's restart recovery).

## Cost accounting

`turn_end` events carry `totalCostUsd` + token usage per turn (SDK `result` message).
Per-site/per-session cost = SQL sum over events — no separate billing table in v1.

## Testing & acceptance

- **Seam:** `AgentRunner` injected via `AppDeps` (like `staticDir`): production impl wraps
  the SDK; tests inject a scripted fake emitting a canned message sequence. No test ever
  calls the Anthropic API.
- **Unit/route tests (ferry-server):** manager lifecycle (spawn/queue/idle/resume/new
  session/409-vs-sync), event persistence, SSE replay+live, history paging, boot recovery.
- **Playwright (ferry-dashboard):** chat flow against the fake runner — send, see tool rows
  + streamed text, reload restores history, error state visible, new session works.
- **Acceptance (manual runbook, real fixture + real API):** the roadmap's Done-when —
  chat about ferry-prod, agent greps/reads/edits/runs `ddev wp`, commits a fix on
  `agent/work`, reports plan + fix. Runbook committed next to the plan docs.
- All existing suites stay green (ferry-cli 93, ferry-server 36+, dashboard e2e 9+).

## Out of scope / deferred

- Change card + Changes tab, write-back, push (Plan 5).
- Subagents, skills, per-site model override, session list/switcher, stop-button UI
  (server can interrupt; "New session" is the v1 escape hatch).
- Web tools → Plan 6 (VM isolation + proxied egress); hard isolation itself → Plan 6.
- Secure cookie flag: prereq for whichever plan first deploys behind TLS — not this one.

## Implementation pins (first task of the plan)

Install `@anthropic-ai/claude-agent-sdk`, pin against real typings: exact `canUseTool` and
hook signatures, deny-rule syntax, `CLAUDE_CONFIG_DIR` behavior, `SDKMessage` shapes,
package version — then freeze them in the plan's tasks.
