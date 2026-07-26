# Claude Agent SDK — capabilities vs Ferry Plan 4 needs

**Date:** 2026-07-26 · **Phase 0 research artifact for Plan 4 (agent chat).**
Sources: official Agent SDK docs (code.claude.com/docs/en/agent-sdk) via three research passes.
Exact TS signatures below are as documented; anything marked ⚠️ must be re-pinned against the
installed package's `.d.ts` during implementation (the three passes disagreed on minor shapes).

## Verdict

The SDK is Claude Code as a library: `query()` spawns a bundled CLI subprocess that runs the full
agent loop (Read/Write/Edit/Bash/Glob/Grep + hooks + permissions + sessions) in a `cwd` we choose.
The clone (`FERRY_HOME/clones/<slug>`: full WP root, git with `production` branch, DDEV, wp-cli via
`ddev wp`) is exactly the environment it was built for — spec §10's bet holds. No blocker found.

## Capability map

| Ferry need | SDK answer | Notes / decisions to make |
|---|---|---|
| One session per site, many chat turns | Streaming-input mode: `prompt` as `AsyncIterable<SDKUserMessage>` keeps ONE session alive; push turns via the generator / `streamInput()`. Alternative: `resume: sessionId` per turn (loads transcript from disk, no API replay) | **Design choice:** long-lived process vs resume-per-turn. Resume survives server restarts for free; long-lived is simpler mid-conversation. Hybrid likely: long-lived while active, resume after restart/idle |
| Session persistence per site (spec §13: readable files) | Transcripts auto-persist as JSONL at `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`; `session_id` arrives in the `system/init` and `result` messages | Point `CLAUDE_CONFIG_DIR` into `FERRY_HOME` so agent state sits next to site state. Store `site → session_id` in the server DB. No TTL on transcripts |
| Chat streaming → dashboard SSE (screen 6) | Message stream: `assistant` (text + `tool_use` blocks), `user` (`tool_result` blocks), `stream_event` token deltas when `includePartialMessages: true`, final `result` | Server relays SDK messages → per-site SSE channel (same hijack+heartbeat pattern as sync SSE). Tool log rows on screen 6 = `tool_use.name/input` + paired `tool_result` |
| Ferry commands as tools (spec §10) | In-process MCP: `createSdkMcpServer({name, tools})` + `tool(name, desc, zodShape, handler)`; registered via `options.mcpServers`, exposed as `mcp__ferry__<tool>` | No subprocess needed; handlers run in ferry-server and can call engine code directly. Read-only set for Plan 4 (e.g. fetch-uploads, site/provenance info) |
| Read-only bridge until Plan 5 | Enforced by construction: simply don't register write tools. Plus `disallowedTools` patterns (e.g. `Bash(git push:*)`) and PreToolUse hooks returning `permissionDecision: 'deny'` with a reason the model sees | Guardrails are app-level, not OS-level (see isolation row) |
| Headless permissions (no interactive UI) | `permissionMode`: `default` routes unpermitted tools to a `canUseTool` callback; `dontAsk` denies silently; `acceptEdits`/`bypassPermissions` auto-approve. `allowedTools`/`disallowedTools` rules with scoped patterns and path anchors (`Edit(//abs/**)`, `Bash(rm *)`) | ⚠️ `canUseTool` return shape reported inconsistently ('approve'/'deny' strings vs result objects) — pin at implementation. Likely stance: broad allow inside the clone + explicit deny rules + hook guardrails |
| Guardrail hooks | `hooks` option, incl. `PreToolUse` (deny/allow/updatedInput), `PostToolUse`, `SessionStart/End`, `PreCompact`, `Stop`; matchers per tool name | Use for: block `git push`/network verbs, confine paths, audit log per site |
| Clone ground rules (auto-placed `CLAUDE.md`) | Loaded only when `settingSources` includes `'project'` (default loads `user`+`project`+`local`!). Independent of the `systemPrompt` preset | 🔴 **Security finding:** `'project'` also loads `.claude/` (settings/hooks/skills) **from the clone dir — customer-controlled content**. A hostile site could ship `.claude/settings.json` hooks that execute on our server. Safer: `settingSources: []` + inject ground rules via `systemPrompt: {preset: 'claude_code', append}` — and keep the clone CLAUDE.md for humans/local Claude Code use |
| Hermetic from operator config | `settingSources: []` skips `~/.claude`; relocate global state via `CLAUDE_CONFIG_DIR`; `env` option controls the subprocess environment | Required server-side: never inherit the operator's `~/.claude` into customer sessions |
| Sandboxing | **None in the SDK** — file tools respect `cwd` + `additionalDirectories`, but Bash is a real host shell (can `cd` anywhere); network open | Matches spec §11: DDEV-only now (trusted own sites), Firecracker at VM level in Plan 6. Plan 4 must not pretend otherwise — guardrails are advisory, isolation is Plan 6 |
| wp-cli / git / shell in the clone | Built-in `Bash` with `cwd` = clone dir; wp-cli runs as `ddev wp …` from there | Ground rules must say "use `ddev wp`"; agent works on its own git branch (server ensures branch before session start) |
| Token bill on our account, attributable per site (spec §10) | Subprocess reads `ANTHROPIC_API_KEY` from env. Every `result` message carries `total_cost_usd`, `usage` (in/out/cache tokens), `num_turns`, `duration_ms`; per-assistant-message `usage` too. `modelUsage` breaks down per model incl. subagents | Record per-turn cost against the site row. Caps: `maxTurns`, `maxBudgetUsd` (stop subtypes `error_max_turns`, `error_max_budget_usd`) |
| Prompt caching | Automatic for system prompt/CLAUDE.md content; sessions resume from disk without API replay | Cost profile favors persistent sessions; nothing to configure for v1 |
| Model choice | `model` option (aliases like `'sonnet'`/`'opus'` or full IDs), `effort`/`thinking` knobs, per-subagent `model` | Design decision: default model + effort for a WP-debugging agent |
| Subagents | `agents: Record<name, {description, prompt, tools, model, …}>`; invoked via the Agent tool; activity appears in parent stream with `parent_tool_use_id` | Available but **not needed for the Plan 4 slice** — defer |
| Long sessions | Auto-compaction built in; `PreCompact` hookable | Nothing to build for v1 |
| Interrupt / stop | `query.interrupt()` (streaming-input mode); `maxTurns`/`maxBudgetUsd` as rails | Wire a "stop" affordance server-side even if UI ships later |
| Runtime | Node 18+; CLI binary bundled in the npm package (no separate install); one subprocess per active session, ~0.5–1 GiB RSS each | Capacity note for Plan 6; fine for local dev now |

## Screen 6 mapping (chat portion only — change card is Plan 5)

| Design element | Backing |
|---|---|
| Chat column: user bubbles, agent messages with state label ("investigating…", "plan") | `assistant` text blocks; state label derivable (tool activity ⇒ investigating; plain text ⇒ answer/plan) — keep heuristic simple or drop labels in v1 |
| Inline mono tool-log rows (`grep …` → result, `wp option get …` → result) | `tool_use` (name + input) paired with `tool_result` via `tool_use_id`; truncate long results |
| "SSE live" indicator, "session · today" header | SSE connection state + stored session metadata. Fold in the 3b triage item: `es.onerror` feedback instead of silent freeze |
| Composer ("Ask a follow-up…", `wp-cli · git · shell` hint) | POST message → push into the session's input stream; queueing while agent is running |
| Sidebar: branch `agent/…`, base `production@<sha>`, site-scoped nav | Clone git state (server ensures agent branch); site record. "microVM · Firecracker" line is aspirational — Plan 6 |
| Right rail: Environment (PHP/DB/media), Containment, git diff panel | Site profile + provenance data (exists); `git diff production --stat` in clone; containment card reflects harness stubs (exists) |
| Changes badge / inline change card | **Plan 5 — out of scope** |

## Open design questions (input for brainstorming)

1. Session model: long-lived streaming-input process per active site vs `resume` per turn; idle teardown policy.
2. Chat history source of truth: replay SDK JSONL transcript vs mirror messages into ferry-server SQLite (dashboard needs history on reload; transcript is already on disk and readable — spec §13 leans transcript).
3. SSE protocol: one event shape for chat (like sync's full-state pushes) vs incremental events; whether token-level deltas (`includePartialMessages`) are worth it for v1.
4. Permission stance: exact allow/deny/hook set for the read-only phase; whether `canUseTool` is even needed if rules cover everything.
5. Ground-rules delivery: `systemPrompt` append (hermetic, avoids the `.claude/` security hole) vs `settingSources: ['project']`.
6. Which ferry tools ship in v1 (minimum useful read-only set).
7. Model + effort + cost caps per session/site.

## Caveats

- All three research passes flagged UNVERIFIED spots (exact `canUseTool` signature, `sandbox` option shape, thinking-block streaming shape, current package version). First implementation task: `npm i @anthropic-ai/claude-agent-sdk` and pin these against the real typings before design-doc details harden.
- Subagent reports may drift from the shipped SDK version; treat the tables above as the map, the package typings as the territory.
