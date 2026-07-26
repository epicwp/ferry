# Ferry Plan 4 — Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user chats with the ferry agent about their cloned site; the agent greps/reads/edits/runs wp-cli in the clone and reports a plan and a fix on its own branch (`agent/work`), streamed live into the dashboard.

**Architecture:** A new `AgentManager` in ferry-server (sibling of `SyncManager`) owns one Claude Agent SDK subprocess per hot site (streaming-input mode, idle teardown + resume). Every SDK message is normalized to a small event vocabulary, appended to SQLite (`agent_events`), and fanned out over per-site SSE. The dashboard's new site-detail screen renders history from SQLite and live events (including token deltas) from SSE. An `AgentRunner` seam isolates the SDK so all tests run against a scripted fake — no test spends tokens.

**Tech Stack:** Fastify 5, better-sqlite3, vitest (ferry-server), React 19 + react-router 7 + Playwright (ferry-dashboard), `@anthropic-ai/claude-agent-sdk` + `zod` (new deps, ferry-server only).

**Design (binding):** `docs/superpowers/specs/2026-07-26-ferry-plan4-agent-chat-design.md`
**SDK research:** `docs/superpowers/specs/2026-07-26-claude-agent-sdk-capabilities.md`

## Global Constraints

- Branch: `feat/agent-chat` (exists). Commit style: `feat:`/`fix:`/`docs:` prefixes, imperative.
- ESM everywhere: relative imports end in `.js`; ferry-server imports engine code via `../../ferry-cli/src/<file>.js` (existing pattern).
- No new dependencies beyond `@anthropic-ai/claude-agent-sdk` and `zod`, both in `ferry-server` only.
- All dashboard copy in English.
- Bridge is READ-ONLY: no tool the agent gets may write to production. Web tools (`WebSearch`, `WebFetch`) stay off (Plan 6 re-enables them).
- The clone's `.claude/` and `CLAUDE.md` must never be loaded by the SDK (`settingSources: []`) — customer-controlled content.
- Existing suites must stay green throughout: `npm --workspace ferry-cli test` (93), `npm --workspace ferry-server test` (36 + new), `npm --workspace ferry-server run typecheck`, `npm --workspace ferry-dashboard run typecheck`, `npm --workspace ferry-dashboard run e2e` (9 + new; needs the ferry-prod fixture running, `ddev delete -Oy ferry-prod-ddev-site` first, `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`).
- ⚠️ **PIN markers:** the SDK's exact option/field names were researched from docs but not compiled against. Task 1 pins them from the installed package's `.d.ts`; later tasks contain reference code with `// PIN:` comments — adjust those lines to the pinned truth, never our own interfaces (`src/agent/types.ts` is frozen after Task 1).

---

### Task 1: SDK dependency + pins + the frozen `AgentRunner` seam

**Files:**
- Modify: `ferry-server/package.json` (deps)
- Create: `ferry-server/src/agent/types.ts`
- Create: `docs/superpowers/specs/2026-07-26-agent-sdk-pins.md`

**Interfaces (Produces — frozen for all later tasks):**

```ts
// ferry-server/src/agent/types.ts
export type RunnerEvent =
  | { type: 'sdk_session'; sdkSessionId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'agent_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: string }
  | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean }
  | { type: 'turn_end'; subtype: string; totalCostUsd: number | null; inputTokens: number; outputTokens: number; numTurns: number; durationMs: number }
  | { type: 'runner_error'; message: string }
  | { type: 'exit' };

export interface AgentRunnerOpts {
  cloneDir: string;
  slug: string;
  resumeSdkSessionId?: string;
  onEvent: (event: RunnerEvent) => void;
}

export interface AgentHandle {
  send(text: string): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRunner {
  start(opts: AgentRunnerOpts): AgentHandle;
}

/** What goes over SSE and into agent_events.payload. text_delta is SSE-only (no seq). */
export interface AgentWireEvent {
  seq?: number;
  type: string;
  payload: Record<string, unknown>;
}
```

- [ ] **Step 1: Install deps**

```bash
cd /Users/robbertvermeulen/Projects/ferry
npm --workspace ferry-server install @anthropic-ai/claude-agent-sdk zod
```

If the SDK lists `zod` as its own dependency/peer at a conflicting version, match that version.

- [ ] **Step 2: Write `ferry-server/src/agent/types.ts`** exactly as in Interfaces above.

- [ ] **Step 3: Pin the SDK surface.** Open `ferry-server/node_modules/@anthropic-ai/claude-agent-sdk/` type declarations (`sdk.d.ts` or `dist/index.d.ts`) and record in `docs/superpowers/specs/2026-07-26-agent-sdk-pins.md`, verbatim from the typings:
  - installed package version
  - `query()` signature and the exact `Options` fields we use: `cwd`, `model`, `maxTurns`, budget cap (**PIN: `maxBudgetUsd` — confirm exact name; if absent, note it and we rely on `maxTurns` only**), `systemPrompt` (preset form), `settingSources`, `permissionMode` values, `allowedTools`/`disallowedTools`, `tools` (if it exists as an availability filter), `mcpServers`, `hooks` (PreToolUse matcher + return shape), `includePartialMessages`, `resume`, `env`, `pathToClaudeCodeExecutable`
  - the `SDKMessage` union: exact discriminators and shapes for system/init, assistant, user (tool_result), stream_event, result (incl. usage + cost fields)
  - the streaming-input mode: exact `SDKUserMessage` shape to push, and `Query.interrupt()`/close semantics
  - `createSdkMcpServer` + `tool()` signatures
  - how `CLAUDE_CONFIG_DIR` is honored (env passthrough)
- [ ] **Step 4: Verify it compiles**

```bash
npm --workspace ferry-server run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ferry-server/package.json package-lock.json ferry-server/src/agent/types.ts docs/superpowers/specs/2026-07-26-agent-sdk-pins.md
git commit -m "feat: agent SDK dependency, pinned surface, frozen AgentRunner seam"
```

---

### Task 2: Store — agent sessions + events

**Files:**
- Modify: `ferry-server/src/store.ts`
- Test: `ferry-server/tests/agent-store.test.ts`

**Interfaces:**
- Consumes: existing `Store` class/patterns (`SCHEMA` string, snake_case rows, `toSite`-style mappers).
- Produces:

```ts
export type AgentSessionStatus = 'idle' | 'running' | 'error';
export interface AgentSession {
  id: number; siteId: number; sdkSessionId: string | null;
  status: AgentSessionStatus; createdAt: string; lastActivityAt: string;
}
export interface AgentEventRow {
  seq: number; sessionId: number; type: string;
  payload: Record<string, unknown>; createdAt: string;
}
// Store methods:
createAgentSession(siteId: number): AgentSession
currentAgentSession(siteId: number): AgentSession | undefined   // newest row per site
setAgentSessionSdkId(id: number, sdkSessionId: string): void
setAgentSessionStatus(id: number, status: AgentSessionStatus): void
touchAgentSession(id: number): void                             // lastActivityAt = now
appendAgentEvent(sessionId: number, type: string, payload: Record<string, unknown>): AgentEventRow
agentEventsAfter(sessionId: number, afterSeq: number): AgentEventRow[]
recoverInterruptedAgentSessions(): number                       // running -> idle, returns changes
```

- [ ] **Step 1: Write the failing tests**

```ts
// ferry-server/tests/agent-store.test.ts
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

function setup() {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  return { store, site };
}

describe('agent sessions', () => {
  it('creates and returns the current (newest) session per site', () => {
    const { store, site } = setup();
    expect(store.currentAgentSession(site.id)).toBeUndefined();
    const s1 = store.createAgentSession(site.id);
    expect(s1).toMatchObject({ siteId: site.id, sdkSessionId: null, status: 'idle' });
    const s2 = store.createAgentSession(site.id);
    expect(store.currentAgentSession(site.id)!.id).toBe(s2.id);
  });

  it('updates sdk id, status and lastActivityAt', () => {
    const { store, site } = setup();
    const s = store.createAgentSession(site.id);
    store.setAgentSessionSdkId(s.id, 'sdk-abc');
    store.setAgentSessionStatus(s.id, 'running');
    store.touchAgentSession(s.id);
    const cur = store.currentAgentSession(site.id)!;
    expect(cur.sdkSessionId).toBe('sdk-abc');
    expect(cur.status).toBe('running');
    expect(Date.parse(cur.lastActivityAt)).toBeGreaterThan(0);
  });

  it('appends events with increasing seq and pages after a seq', () => {
    const { store, site } = setup();
    const s = store.createAgentSession(site.id);
    const e1 = store.appendAgentEvent(s.id, 'user', { text: 'hi' });
    const e2 = store.appendAgentEvent(s.id, 'agent_text', { text: 'hello' });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect(e1.payload).toEqual({ text: 'hi' });
    const page = store.agentEventsAfter(s.id, e1.seq);
    expect(page.map((e) => e.seq)).toEqual([e2.seq]);
    expect(store.agentEventsAfter(s.id, 0)).toHaveLength(2);
  });

  it('scopes events to their session', () => {
    const { store, site } = setup();
    const s1 = store.createAgentSession(site.id);
    store.appendAgentEvent(s1.id, 'user', { text: 'old' });
    const s2 = store.createAgentSession(site.id);
    expect(store.agentEventsAfter(s2.id, 0)).toHaveLength(0);
  });

  it('recovers interrupted sessions at boot', () => {
    const { store, site } = setup();
    const s = store.createAgentSession(site.id);
    store.setAgentSessionStatus(s.id, 'running');
    expect(store.recoverInterruptedAgentSessions()).toBe(1);
    expect(store.currentAgentSession(site.id)!.status).toBe('idle');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm --workspace ferry-server test -- agent-store`
Expected: FAIL — `createAgentSession is not a function`.

- [ ] **Step 3: Implement.** In `store.ts`: append to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  sdk_session_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Add the interfaces + a `toAgentSession(row)` mapper (snake→camel, like `toSite`), then the methods:

```ts
createAgentSession(siteId: number): AgentSession {
  const now = new Date().toISOString();
  const info = this.db
    .prepare('INSERT INTO agent_sessions (site_id, status, created_at, last_activity_at) VALUES (?, ?, ?, ?)')
    .run(siteId, 'idle', now, now);
  return this.currentAgentSession(siteId)!; // newest row is the one just inserted
}

currentAgentSession(siteId: number): AgentSession | undefined {
  const row = this.db
    .prepare('SELECT * FROM agent_sessions WHERE site_id = ? ORDER BY id DESC LIMIT 1')
    .get(siteId) as AgentSessionRow | undefined;
  return row ? toAgentSession(row) : undefined;
}

setAgentSessionSdkId(id: number, sdkSessionId: string): void {
  this.db.prepare('UPDATE agent_sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
}

setAgentSessionStatus(id: number, status: AgentSessionStatus): void {
  this.db.prepare('UPDATE agent_sessions SET status = ? WHERE id = ?').run(status, id);
}

touchAgentSession(id: number): void {
  this.db.prepare('UPDATE agent_sessions SET last_activity_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

appendAgentEvent(sessionId: number, type: string, payload: Record<string, unknown>): AgentEventRow {
  const now = new Date().toISOString();
  const info = this.db
    .prepare('INSERT INTO agent_events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, type, JSON.stringify(payload), now);
  return { seq: Number(info.lastInsertRowid), sessionId, type, payload, createdAt: now };
}

agentEventsAfter(sessionId: number, afterSeq: number): AgentEventRow[] {
  const rows = this.db
    .prepare('SELECT * FROM agent_events WHERE session_id = ? AND id > ? ORDER BY id')
    .all(sessionId, afterSeq) as AgentEventRowRaw[];
  return rows.map((r) => ({
    seq: r.id, sessionId: r.session_id, type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>, createdAt: r.created_at,
  }));
}

recoverInterruptedAgentSessions(): number {
  return this.db.prepare("UPDATE agent_sessions SET status = 'idle' WHERE status = 'running'").run().changes;
}
```

- [ ] **Step 4: Run tests**

Run: `npm --workspace ferry-server test` — all pass (old 36 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/store.ts ferry-server/tests/agent-store.test.ts
git commit -m "feat: agent session + event persistence in the store"
```

---

### Task 3: SDK message normalizer + ground rules

**Files:**
- Create: `ferry-server/src/agent/normalize.ts`
- Create: `ferry-server/src/agent/ground-rules.ts`
- Test: `ferry-server/tests/agent-normalize.test.ts`

**Interfaces:**
- Consumes: `RunnerEvent` from `src/agent/types.ts` (Task 1).
- Produces:

```ts
// normalize.ts
export const TOOL_INPUT_MAX = 2000;   // chars kept of tool input JSON
export const TOOL_OUTPUT_MAX = 4000;  // chars kept of tool result text
export function normalizeSdkMessage(msg: unknown): RunnerEvent[]
// ground-rules.ts
export function groundRules(slug: string): string
```

- [ ] **Step 1: Write the failing tests.** Fixtures are SDK-shaped plain objects (shapes per the Task 1 pins doc — adjust fixture field names there if the pins differ, the expected `RunnerEvent`s stay):

```ts
// ferry-server/tests/agent-normalize.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeSdkMessage, TOOL_OUTPUT_MAX } from '../src/agent/normalize.js';

describe('normalizeSdkMessage', () => {
  it('maps system init to sdk_session', () => {
    expect(normalizeSdkMessage({ type: 'system', subtype: 'init', session_id: 's-1' }))
      .toEqual([{ type: 'sdk_session', sdkSessionId: 's-1' }]);
  });

  it('maps assistant text and tool_use blocks', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'Diving in.' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'calculate_tax' } },
      ] },
    });
    expect(events).toEqual([
      { type: 'agent_text', text: 'Diving in.' },
      { type: 'tool_use', toolUseId: 't1', name: 'Grep', input: JSON.stringify({ pattern: 'calculate_tax' }) },
    ]);
  });

  it('maps tool results (string and block-array content) and truncates long output', () => {
    const long = 'x'.repeat(TOOL_OUTPUT_MAX + 50);
    const events = normalizeSdkMessage({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: long, is_error: false },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'boom' }], is_error: true },
      ] },
    });
    expect(events[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1', isError: false });
    expect((events[0] as { output: string }).output).toHaveLength(TOOL_OUTPUT_MAX);
    expect(events[1]).toMatchObject({ type: 'tool_result', toolUseId: 't2', output: 'boom', isError: true });
  });

  it('maps stream text deltas and ignores other stream events', () => {
    expect(normalizeSdkMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'VA' } },
    })).toEqual([{ type: 'text_delta', text: 'VA' }]);
    expect(normalizeSdkMessage({
      type: 'stream_event',
      event: { type: 'content_block_start' },
    })).toEqual([]);
  });

  it('maps result to turn_end incl. error subtypes', () => {
    expect(normalizeSdkMessage({
      type: 'result', subtype: 'success', total_cost_usd: 0.0123, num_turns: 3, duration_ms: 4500,
      usage: { input_tokens: 100, output_tokens: 50 },
    })).toEqual([{ type: 'turn_end', subtype: 'success', totalCostUsd: 0.0123, inputTokens: 100, outputTokens: 50, numTurns: 3, durationMs: 4500 }]);
    expect(normalizeSdkMessage({ type: 'result', subtype: 'error_max_budget_usd', usage: {} })[0])
      .toMatchObject({ type: 'turn_end', subtype: 'error_max_budget_usd', totalCostUsd: null });
  });

  it('returns [] for unknown message types', () => {
    expect(normalizeSdkMessage({ type: 'whatever' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm --workspace ferry-server test -- agent-normalize` → FAIL (module not found).

- [ ] **Step 3: Implement `normalize.ts`** (defensive property access; never throw on odd shapes):

```ts
import type { RunnerEvent } from './types.js';

export const TOOL_INPUT_MAX = 2000;
export const TOOL_OUTPUT_MAX = 4000;

/* eslint-disable @typescript-eslint/no-explicit-any */
function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

/** Pure mapping from raw SDK messages to our RunnerEvent vocabulary. Field names
 *  follow docs/superpowers/specs/2026-07-26-agent-sdk-pins.md — keep in sync. */
export function normalizeSdkMessage(msg: unknown): RunnerEvent[] {
  const m = msg as any;
  if (!m || typeof m.type !== 'string') return [];
  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    return [{ type: 'sdk_session', sdkSessionId: m.session_id }];
  }
  if (m.type === 'assistant') {
    const out: RunnerEvent[] = [];
    for (const block of m.message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        out.push({ type: 'agent_text', text: block.text });
      } else if (block?.type === 'tool_use') {
        out.push({
          type: 'tool_use', toolUseId: String(block.id ?? ''), name: String(block.name ?? ''),
          input: JSON.stringify(block.input ?? {}).slice(0, TOOL_INPUT_MAX),
        });
      }
    }
    return out;
  }
  if (m.type === 'user') {
    const out: RunnerEvent[] = [];
    for (const block of m.message?.content ?? []) {
      if (block?.type === 'tool_result') {
        out.push({
          type: 'tool_result', toolUseId: String(block.tool_use_id ?? ''),
          output: flattenResultContent(block.content).slice(0, TOOL_OUTPUT_MAX),
          isError: Boolean(block.is_error),
        });
      }
    }
    return out;
  }
  if (m.type === 'stream_event') {
    const delta = m.event?.delta;
    if (m.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ type: 'text_delta', text: delta.text }];
    }
    return [];
  }
  if (m.type === 'result') {
    return [{
      type: 'turn_end', subtype: String(m.subtype ?? 'success'),
      totalCostUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
      inputTokens: Number(m.usage?.input_tokens ?? 0), outputTokens: Number(m.usage?.output_tokens ?? 0),
      numTurns: Number(m.num_turns ?? 0), durationMs: Number(m.duration_ms ?? 0),
    }];
  }
  return [];
}
```

- [ ] **Step 4: Implement `ground-rules.ts`** (content mirrors the clone `CLAUDE.md` in `ferry-cli/src/git.ts` — the SDK session runs hermetic and never reads that file):

```ts
/** System-prompt append for agent sessions. The clone's CLAUDE.md (ferry-cli/src/git.ts)
 *  carries the same rules for humans; the SDK session must not read files the customer
 *  controls, so the rules ride in the system prompt instead. */
export function groundRules(slug: string): string {
  return `# Ferry clone — agent session ground rules

You are the Ferry agent, working in a clone of the production WordPress site "${slug}".
Work as you would in any WordPress codebase: grep, read, and edit files; run shell commands.

- wp-cli runs as \`ddev wp <args>\` from the clone root. Plain \`wp\` is not installed here.
- You are on the git branch \`agent/work\`. Commit your changes there with clear messages.
  NEVER run \`git push\`. Never commit to or reset the \`production\` branch —
  \`git diff production\` is exactly what would ship to production.
- The database is a point-in-time snapshot. Production owns the live data — do not assume
  orders, users, or options here are current.
- The clone is airtight: outbound email and HTTP are blocked; license checks (EDD, Freemius,
  WooCommerce.com) are answered locally with valid stubs. This is expected, not a bug.
  Missing uploads are fetched from production on first request; use the ferry
  \`fetch_uploads\` tool to bulk-fetch.
- Never edit ferry/DDEV artifacts: \`wp-config.php\`, anything under \`.ddev/\`,
  \`wp-content/mu-plugins/ferry-*\`, \`ferry-uploads-fallback.php\`. Drop-ins renamed to
  \`*.php.ferry-disabled\` are disabled on purpose.
- When asked to fix something: state a short plan first, implement it on \`agent/work\`,
  verify inside the clone (\`ddev wp\`, or request the page), then summarize what changed
  and why in plain language.`;
}
```

- [ ] **Step 5: Run tests** — `npm --workspace ferry-server test` → all pass.
- [ ] **Step 6: Commit**

```bash
git add ferry-server/src/agent/normalize.ts ferry-server/src/agent/ground-rules.ts ferry-server/tests/agent-normalize.test.ts
git commit -m "feat: SDK message normalizer and agent ground rules"
```

---

### Task 4: Git helper — `ensureAgentBranch`

**Files:**
- Create: `ferry-server/src/agent/branch.ts`
- Test: `ferry-server/tests/agent-branch.test.ts`

**Interfaces:**
- Produces: `export async function ensureAgentBranch(cloneDir: string): Promise<void>` — creates `agent/work` from `production` if missing, checks it out; no-op if already on it. Never resets an existing `agent/work`.

- [ ] **Step 1: Write the failing tests** (build a real temp repo — fast, no network):

```ts
// ferry-server/tests/agent-branch.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureAgentBranch } from '../src/agent/branch.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function makeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-branch-'));
  git(dir, 'init', '-b', 'production');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'index.php'), '<?php // wp');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'pull');
  return dir;
}

describe('ensureAgentBranch', () => {
  it('creates agent/work from production and checks it out', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/work');
    expect(git(dir, 'rev-parse', 'agent/work')).toBe(git(dir, 'rev-parse', 'production'));
  });

  it('is idempotent and never resets existing agent work', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    writeFileSync(join(dir, 'fix.php'), '<?php // fix');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'agent fix');
    const head = git(dir, 'rev-parse', 'HEAD');
    await ensureAgentBranch(dir);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head); // unchanged
  });

  it('checks agent/work back out when the tree sits on production', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    git(dir, 'checkout', 'production'); // a sync leaves the tree here
    await ensureAgentBranch(dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/work');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm --workspace ferry-server test -- agent-branch` → FAIL.

- [ ] **Step 3: Implement**

```ts
// ferry-server/src/agent/branch.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BRANCH = 'agent/work';

async function git(cloneDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: cloneDir });
  return stdout.trim();
}

/** The agent works on agent/work, branched from production (design: Git branch policy).
 *  Existing agent commits are never reset — a sync only moves `production`. */
export async function ensureAgentBranch(cloneDir: string): Promise<void> {
  const exists = await git(cloneDir, 'branch', '--list', BRANCH);
  if (exists === '') {
    await git(cloneDir, 'branch', BRANCH, 'production');
  }
  const current = await git(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== BRANCH) {
    await git(cloneDir, 'checkout', BRANCH);
  }
}
```

- [ ] **Step 4: Run tests** — pass.
- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/agent/branch.ts ferry-server/tests/agent-branch.test.ts
git commit -m "feat: ensureAgentBranch keeps agent work on its own branch"
```

---

### Task 5: SDK runner + ferry MCP tools + scripted runner

**Files:**
- Create: `ferry-server/src/agent/sdk-runner.ts`
- Create: `ferry-server/src/agent/scripted-runner.ts`
- Test: `ferry-server/tests/agent-runners.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `AgentHandle`, `AgentRunnerOpts`, `RunnerEvent` (Task 1); `normalizeSdkMessage`, `groundRules` (Task 3).
- Produces:

```ts
// sdk-runner.ts
export interface SdkRunnerConfig {
  model: string;                 // e.g. 'sonnet'
  maxTurns: number;
  maxBudgetUsd: number;
  configDir: string;             // becomes CLAUDE_CONFIG_DIR for the subprocess
}
export interface SdkRunnerDeps {   // injected so tool handlers are unit-testable
  fetchUploads: (slug: string, opts: { prefix?: string; all?: boolean }) => Promise<unknown>;
  loadProfile: (slug: string) => { url: string; info?: unknown };
}
export function sdkRunner(config: SdkRunnerConfig, deps?: Partial<SdkRunnerDeps>): AgentRunner
export function buildFerryTools(slug: string, deps: SdkRunnerDeps): unknown[]  // the tool() list, exported for tests

// scripted-runner.ts — deterministic fake for tests and dashboard e2e
export function scriptedRunner(): AgentRunner
```

- [ ] **Step 1: Write the failing tests** (scripted runner behavior + ferry tool handlers; the SDK path itself is compile-checked here and exercised only in the manual acceptance runbook):

```ts
// ferry-server/tests/agent-runners.test.ts
import { describe, expect, it } from 'vitest';
import { scriptedRunner } from '../src/agent/scripted-runner.js';
import { buildFerryTools } from '../src/agent/sdk-runner.js';
import type { RunnerEvent } from '../src/agent/types.js';

async function drain(events: RunnerEvent[], until: RunnerEvent['type'], timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!events.some((e) => e.type === until)) {
    if (Date.now() - start > timeoutMs) throw new Error(`no ${until} event`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('scriptedRunner', () => {
  it('emits a full canned turn for every send, echoing the user text', async () => {
    const events: RunnerEvent[] = [];
    const handle = scriptedRunner().start({
      cloneDir: '/tmp/x', slug: 's', onEvent: (e) => events.push(e),
    });
    handle.send('Why is VAT wrong?');
    await drain(events, 'turn_end');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('sdk_session');
    expect(types).toEqual(expect.arrayContaining(['text_delta', 'tool_use', 'tool_result', 'agent_text', 'turn_end']));
    const text = events.find((e) => e.type === 'agent_text') as { text: string };
    expect(text.text).toContain('Why is VAT wrong?');
    const turn = events.find((e) => e.type === 'turn_end') as { totalCostUsd: number | null };
    expect(turn.totalCostUsd).not.toBeNull();
    await handle.close();
  });

  it('resumes with the same sdk session id and interrupts quietly', async () => {
    const events: RunnerEvent[] = [];
    const runner = scriptedRunner();
    const h1 = runner.start({ cloneDir: '/tmp/x', slug: 's', onEvent: (e) => events.push(e) });
    h1.send('a');
    await drain(events, 'turn_end');
    await h1.interrupt();
    await h1.close();
    const sdk1 = events.find((e) => e.type === 'sdk_session') as { sdkSessionId: string };
    events.length = 0;
    const h2 = runner.start({
      cloneDir: '/tmp/x', slug: 's', resumeSdkSessionId: sdk1.sdkSessionId, onEvent: (e) => events.push(e),
    });
    h2.send('b');
    await drain(events, 'sdk_session');
    expect((events[0] as { sdkSessionId: string }).sdkSessionId).toBe(sdk1.sdkSessionId);
    await h2.close();
  });
});

describe('buildFerryTools handlers', () => {
  it('fetch_uploads calls the engine with slug and args', async () => {
    const calls: unknown[] = [];
    const tools = buildFerryTools('klant-nl', {
      fetchUploads: async (slug, opts) => { calls.push([slug, opts]); return { fetched: 3 }; },
      loadProfile: () => ({ url: 'https://klant.nl' }),
    });
    // tool() wraps { name, handler } — invoke the handler directly (shape per pins doc)
    const fetchTool = (tools as { name: string; handler: (a: unknown) => Promise<unknown> }[])
      .find((t) => t.name === 'fetch_uploads')!;
    await fetchTool.handler({ prefix: '2026/07' });
    expect(calls).toEqual([['klant-nl', { prefix: '2026/07', all: undefined }]]);
  });

  it('site_info reports profile facts without secrets', async () => {
    const tools = buildFerryTools('klant-nl', {
      fetchUploads: async () => ({}),
      loadProfile: () => ({
        url: 'https://klant.nl',
        info: { wp: '6.5', php: { version: '8.2' }, db: { server: 'mariadb', version: '10.6' }, multisite: false, prefix: 'wp_' },
      }),
    });
    const infoTool = (tools as { name: string; handler: (a: unknown) => Promise<{ content: { type: string; text: string }[] }> }[])
      .find((t) => t.name === 'site_info')!;
    const result = await infoTool.handler({});
    const text = result.content[0]!.text;
    expect(text).toContain('6.5');
    expect(text).not.toContain('secret');
  });
});
```

> Note: the exact accessor for a `tool()` definition's name/handler comes from the Task 1 pins doc. If the SDK's `SdkMcpToolDefinition` nests them differently, adapt the two test accessors (and only those) to reach the same handler.

- [ ] **Step 2: Run to verify failure** — FAIL (modules not found).

- [ ] **Step 3: Implement `scripted-runner.ts`** (deterministic, timer-driven; used by unit tests, route tests, and the dashboard e2e server):

```ts
import type { AgentHandle, AgentRunner, AgentRunnerOpts, RunnerEvent } from './types.js';

/** Deterministic AgentRunner for tests and the dashboard e2e server: every send() yields
 *  one canned turn (deltas -> tool pair -> text echoing the prompt -> turn_end). */
export function scriptedRunner(): AgentRunner {
  let counter = 0;
  return {
    start(opts: AgentRunnerOpts): AgentHandle {
      const sdkSessionId = opts.resumeSdkSessionId ?? `scripted-${++counter}`;
      let closed = false;
      const timers = new Set<NodeJS.Timeout>();
      const emit = (event: RunnerEvent, delay: number): void => {
        const t = setTimeout(() => { timers.delete(t); if (!closed) opts.onEvent(event); }, delay);
        timers.add(t);
      };
      emit({ type: 'sdk_session', sdkSessionId }, 0);
      return {
        send(text: string): void {
          emit({ type: 'text_delta', text: 'Looking' }, 10);
          emit({ type: 'text_delta', text: ' into it…' }, 20);
          emit({ type: 'tool_use', toolUseId: 'tu-1', name: 'Grep', input: '{"pattern":"calculate_tax"}' }, 30);
          emit({ type: 'tool_result', toolUseId: 'tu-1', output: 'functions.php:412', isError: false }, 40);
          emit({ type: 'agent_text', text: `Looking into it… You asked: "${text}". Plan: check the tax settings, then the theme hooks.` }, 50);
          emit({ type: 'turn_end', subtype: 'success', totalCostUsd: 0.0123, inputTokens: 100, outputTokens: 50, numTurns: 1, durationMs: 60 }, 60);
        },
        async interrupt(): Promise<void> { /* canned turns finish instantly; nothing to stop */ },
        async close(): Promise<void> {
          closed = true;
          for (const t of timers) clearTimeout(t);
          timers.clear();
        },
      };
    },
  };
}
```

- [ ] **Step 4: Implement `sdk-runner.ts`.** Reference code below — every `// PIN:` line must be checked against `docs/superpowers/specs/2026-07-26-agent-sdk-pins.md` and adjusted there if the installed typings differ. Our exported interfaces do not change.

```ts
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'; // PIN: import names
import { z } from 'zod';
import { fetchUploads as realFetchUploads } from '../../../ferry-cli/src/fetch-uploads.js';
import { loadProfile as realLoadProfile } from '../../../ferry-cli/src/profile.js';
import { groundRules } from './ground-rules.js';
import { normalizeSdkMessage } from './normalize.js';
import type { AgentHandle, AgentRunner, AgentRunnerOpts } from './types.js';

export interface SdkRunnerConfig {
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  configDir: string;
}

export interface SdkRunnerDeps {
  fetchUploads: (slug: string, opts: { prefix?: string; all?: boolean }) => Promise<unknown>;
  loadProfile: (slug: string) => { url: string; info?: unknown };
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export function buildFerryTools(slug: string, deps: SdkRunnerDeps): unknown[] {
  return [
    tool( // PIN: tool() signature (name, description, zod shape, handler)
      'fetch_uploads',
      'Bulk-fetch missing uploads from production into the clone (read-only). Pass a path prefix like "2026/07", or all: true.',
      { prefix: z.string().optional(), all: z.boolean().optional() },
      async (args: { prefix?: string; all?: boolean }) => {
        const result = await deps.fetchUploads(slug, { prefix: args.prefix, all: args.all });
        return text(JSON.stringify(result));
      },
    ),
    tool(
      'site_info',
      'Environment facts for this site: WordPress/PHP/DB versions, table prefix, multisite flag.',
      {},
      async () => {
        const profile = deps.loadProfile(slug);
        const info = (profile.info ?? {}) as Record<string, unknown>;
        const php = (info.php ?? {}) as Record<string, unknown>;
        const db = (info.db ?? {}) as Record<string, unknown>;
        return text(JSON.stringify({
          url: profile.url, wp: info.wp, php: php.version,
          db: db.server ? `${String(db.server)} ${String(db.version ?? '')}`.trim() : undefined,
          tablePrefix: info.prefix, multisite: info.multisite,
        }));
      },
    ),
  ];
}

/** A push-driven async iterable feeding the SDK's streaming-input mode. */
class InputQueue implements AsyncIterable<unknown> {
  private items: unknown[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  push(item: unknown): void { this.items.push(item); this.wake?.(); }
  end(): void { this.done = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

export function sdkRunner(config: SdkRunnerConfig, depsOverride?: Partial<SdkRunnerDeps>): AgentRunner {
  const deps: SdkRunnerDeps = {
    fetchUploads: (slug, opts) => realFetchUploads(slug, opts),
    loadProfile: (slug) => realLoadProfile(slug),
    ...depsOverride,
  };
  return {
    start(opts: AgentRunnerOpts): AgentHandle {
      const input = new InputQueue();
      const ferry = createSdkMcpServer({ name: 'ferry', tools: buildFerryTools(opts.slug, deps) as never }); // PIN: createSdkMcpServer shape
      const q = query({
        prompt: input as never, // PIN: streaming-input type
        options: {
          cwd: opts.cloneDir,
          model: config.model,
          maxTurns: config.maxTurns,
          maxBudgetUsd: config.maxBudgetUsd, // PIN: exact option name; drop if the SDK has none
          resume: opts.resumeSdkSessionId,
          includePartialMessages: true,
          settingSources: [], // hermetic: never load ~/.claude nor the clone's .claude/ (design: security)
          systemPrompt: { type: 'preset', preset: 'claude_code', append: groundRules(opts.slug) }, // PIN: preset shape
          permissionMode: 'bypassPermissions',
          disallowedTools: ['WebSearch', 'WebFetch', 'Bash(git push:*)'], // PIN: rule syntax
          mcpServers: { ferry },
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: config.configDir, // transcripts under FERRY_HOME (spec §13)
          },
          hooks: { // PIN: hook registration + output shape
            PreToolUse: [{
              matcher: 'Bash',
              hooks: [async (hookInput: { tool_input?: { command?: string } }) => {
                const command = hookInput.tool_input?.command ?? '';
                if (/\bgit\s+push\b/.test(command)) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'git push is not allowed — changes ship via the ferry change card (Plan 5).',
                    },
                  };
                }
                return {};
              }],
            }],
          },
        },
      });
      const pump = (async () => {
        try {
          for await (const message of q) {
            for (const event of normalizeSdkMessage(message)) opts.onEvent(event);
          }
        } catch (err) {
          opts.onEvent({ type: 'runner_error', message: err instanceof Error ? err.message : String(err) });
        } finally {
          opts.onEvent({ type: 'exit' });
        }
      })();
      return {
        send(userText: string): void {
          // PIN: exact SDKUserMessage shape for streaming input
          input.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } });
        },
        async interrupt(): Promise<void> {
          await (q as { interrupt?: () => Promise<unknown> }).interrupt?.(); // PIN
        },
        async close(): Promise<void> {
          input.end();
          await pump.catch(() => undefined);
        },
      };
    },
  };
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm --workspace ferry-server test && npm --workspace ferry-server run typecheck`
Expected: all pass, clean compile (fix PIN lines against the pins doc until it does).

- [ ] **Step 6: Commit**

```bash
git add ferry-server/src/agent/sdk-runner.ts ferry-server/src/agent/scripted-runner.ts ferry-server/tests/agent-runners.test.ts
git commit -m "feat: SDK agent runner with ferry MCP tools, plus scripted test runner"
```

---

### Task 6: AgentManager

**Files:**
- Create: `ferry-server/src/agent/manager.ts`
- Test: `ferry-server/tests/agent-manager.test.ts`

**Interfaces:**
- Consumes: Store agent methods (Task 2), `AgentRunner`/`RunnerEvent`/`AgentWireEvent` (Task 1).
- Produces:

```ts
export interface AgentManagerOpts {
  cloneDir: (slug: string) => string;
  ensureBranch: (cloneDir: string) => Promise<void>;
  idleMs?: number; // default 30 * 60_000
}
export class AgentManager {
  constructor(store: Store, runner: AgentRunner, opts: AgentManagerOpts)
  isActive(siteId: number): boolean                       // hot subprocess exists (sync exclusion)
  subscribe(siteId: number, fn: (e: AgentWireEvent) => void): () => void
  send(site: Site, text: string): Promise<void>           // persists 'user' event, feeds runner
  newSession(site: Site): Promise<void>                   // escape hatch
  shutdown(): Promise<void>
}
```

- [ ] **Step 1: Write the failing tests** (use `scriptedRunner` and a hand-rolled recording runner):

```ts
// ferry-server/tests/agent-manager.test.ts
import { describe, expect, it } from 'vitest';
import { AgentManager } from '../src/agent/manager.js';
import { scriptedRunner } from '../src/agent/scripted-runner.js';
import type { AgentRunner, AgentRunnerOpts, AgentWireEvent, RunnerEvent } from '../src/agent/types.js';
import { Store } from '../src/store.js';

function setup(runner: AgentRunner, idleMs = 60_000) {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  store.setStatus(site.id, 'ready');
  const branchCalls: string[] = [];
  const manager = new AgentManager(store, runner, {
    cloneDir: (slug) => `/clones/${slug}`,
    ensureBranch: async (dir) => { branchCalls.push(dir); },
    idleMs,
  });
  return { store, site: store.siteFor(user.id, site.id)!, manager, branchCalls };
}

async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('AgentManager', () => {
  it('creates a session, persists user + turn events, and fans out incl. deltas', async () => {
    const { store, site, manager, branchCalls } = setup(scriptedRunner());
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    await manager.send(site, 'Why is VAT wrong?');
    expect(branchCalls).toEqual(['/clones/klant-nl']);
    expect(manager.isActive(site.id)).toBe(true);
    await until(() => seen.some((e) => e.type === 'turn_end'));
    const session = store.currentAgentSession(site.id)!;
    expect(session.sdkSessionId).toMatch(/^scripted-/);
    expect(session.status).toBe('idle'); // back to idle after turn_end
    const stored = store.agentEventsAfter(session.id, 0).map((e) => e.type);
    expect(stored).toEqual(['user', 'tool_use', 'tool_result', 'agent_text', 'turn_end']);
    expect(seen.some((e) => e.type === 'text_delta' && e.seq === undefined)).toBe(true); // deltas not persisted
    expect(seen.filter((e) => e.seq !== undefined).map((e) => e.type)).toEqual(stored);
  });

  it('tears down after idle timeout and resumes with the stored sdk session id', async () => {
    const starts: AgentRunnerOpts[] = [];
    const inner = scriptedRunner();
    const recording: AgentRunner = { start: (opts) => { starts.push(opts); return inner.start(opts); } };
    const { site, manager } = setup(recording, 30); // 30ms idle
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    await manager.send(site, 'first');
    await until(() => seen.some((e) => e.type === 'turn_end'));
    await until(() => !manager.isActive(site.id), 2000); // idle teardown fired
    await manager.send(site, 'second');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.resumeSdkSessionId).toBe('scripted-1');
    await manager.shutdown();
  });

  it('newSession interrupts the hot process and starts a fresh session row', async () => {
    const { store, site, manager } = setup(scriptedRunner());
    await manager.send(site, 'first');
    const s1 = store.currentAgentSession(site.id)!;
    await manager.newSession(site);
    expect(manager.isActive(site.id)).toBe(false);
    const s2 = store.currentAgentSession(site.id)!;
    expect(s2.id).not.toBe(s1.id);
    const events = store.agentEventsAfter(s2.id, 0);
    expect(events[0]).toMatchObject({ type: 'status' });
    await manager.send(site, 'fresh start');
    expect(store.currentAgentSession(site.id)!.id).toBe(s2.id);
    await manager.shutdown();
  });

  it('records a runner error as a status event and marks the session error', async () => {
    const failing: AgentRunner = {
      start: (opts) => ({
        send: () => {
          opts.onEvent({ type: 'runner_error', message: 'API key invalid' });
          opts.onEvent({ type: 'exit' });
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      }),
    };
    const { store, site, manager } = setup(failing);
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    await manager.send(site, 'hi');
    await until(() => seen.some((e) => e.type === 'status' && (e.payload as { state?: string }).state === 'error'));
    expect(store.currentAgentSession(site.id)!.status).toBe('error');
    expect(manager.isActive(site.id)).toBe(false); // exit dropped the handle
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (module not found).

- [ ] **Step 3: Implement `manager.ts`**

```ts
import type { Site, Store } from '../store.js';
import type { AgentHandle, AgentRunner, AgentWireEvent, RunnerEvent } from './types.js';

export interface AgentManagerOpts {
  cloneDir: (slug: string) => string;
  ensureBranch: (cloneDir: string) => Promise<void>;
  idleMs?: number;
}

type Listener = (e: AgentWireEvent) => void;
interface Hot { sessionId: number; handle: AgentHandle; idleTimer?: NodeJS.Timeout }

/**
 * Per-site agent session machine (design §Architecture). Hot state (the SDK subprocess)
 * lives in memory; the durable chat record goes to the store; SSE consumers get every
 * persisted event plus SSE-only text deltas.
 */
export class AgentManager {
  private hot = new Map<number, Hot>();
  private listeners = new Map<number, Set<Listener>>();
  private readonly idleMs: number;

  constructor(
    private readonly store: Store,
    private readonly runner: AgentRunner,
    private readonly opts: AgentManagerOpts,
  ) {
    this.idleMs = opts.idleMs ?? 30 * 60_000;
  }

  isActive(siteId: number): boolean {
    return this.hot.has(siteId);
  }

  subscribe(siteId: number, fn: Listener): () => void {
    let set = this.listeners.get(siteId);
    if (!set) {
      set = new Set();
      this.listeners.set(siteId, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  async send(site: Site, text: string): Promise<void> {
    const session = this.store.currentAgentSession(site.id) ?? this.store.createAgentSession(site.id);
    const hot = await this.ensureHot(site, session.id, session.sdkSessionId);
    const row = this.store.appendAgentEvent(session.id, 'user', { text });
    this.emit(site.id, { seq: row.seq, type: 'user', payload: { text } });
    this.store.setAgentSessionStatus(session.id, 'running');
    this.store.touchAgentSession(session.id);
    hot.handle.send(text);
    this.resetIdle(site.id);
  }

  async newSession(site: Site): Promise<void> {
    const hot = this.hot.get(site.id);
    if (hot) {
      clearTimeout(hot.idleTimer);
      this.hot.delete(site.id);
      await hot.handle.interrupt().catch(() => undefined);
      await hot.handle.close().catch(() => undefined);
    }
    const session = this.store.createAgentSession(site.id);
    const payload = { state: 'idle', detail: 'New session started.' };
    const row = this.store.appendAgentEvent(session.id, 'status', payload);
    this.emit(site.id, { seq: row.seq, type: 'status', payload });
  }

  async shutdown(): Promise<void> {
    for (const hot of this.hot.values()) {
      clearTimeout(hot.idleTimer);
      await hot.handle.close().catch(() => undefined);
    }
    this.hot.clear();
  }

  private async ensureHot(site: Site, sessionId: number, sdkSessionId: string | null): Promise<Hot> {
    const existing = this.hot.get(site.id);
    if (existing && existing.sessionId === sessionId) return existing;
    if (existing) {
      clearTimeout(existing.idleTimer);
      this.hot.delete(site.id);
      await existing.handle.close().catch(() => undefined);
    }
    const cloneDir = this.opts.cloneDir(site.slug);
    await this.opts.ensureBranch(cloneDir);
    const hot: Hot = { sessionId, handle: undefined as unknown as AgentHandle };
    hot.handle = this.runner.start({
      cloneDir,
      slug: site.slug,
      resumeSdkSessionId: sdkSessionId ?? undefined,
      onEvent: (event) => this.onRunnerEvent(site.id, sessionId, event),
    });
    this.hot.set(site.id, hot);
    return hot;
  }

  private onRunnerEvent(siteId: number, sessionId: number, event: RunnerEvent): void {
    const hot = this.hot.get(siteId);
    if (event.type !== 'exit' && (!hot || hot.sessionId !== sessionId)) return; // superseded session
    this.resetIdle(siteId);
    switch (event.type) {
      case 'sdk_session':
        this.store.setAgentSessionSdkId(sessionId, event.sdkSessionId);
        return;
      case 'text_delta':
        this.emit(siteId, { type: 'text_delta', payload: { text: event.text } });
        return;
      case 'agent_text':
        this.persistAndEmit(siteId, sessionId, 'agent_text', { text: event.text });
        return;
      case 'tool_use':
        this.persistAndEmit(siteId, sessionId, 'tool_use', {
          toolUseId: event.toolUseId, name: event.name, input: event.input,
        });
        return;
      case 'tool_result':
        this.persistAndEmit(siteId, sessionId, 'tool_result', {
          toolUseId: event.toolUseId, output: event.output, isError: event.isError,
        });
        return;
      case 'turn_end':
        this.persistAndEmit(siteId, sessionId, 'turn_end', {
          subtype: event.subtype, totalCostUsd: event.totalCostUsd,
          inputTokens: event.inputTokens, outputTokens: event.outputTokens,
          numTurns: event.numTurns, durationMs: event.durationMs,
        });
        this.store.setAgentSessionStatus(sessionId, 'idle');
        this.store.touchAgentSession(sessionId);
        return;
      case 'runner_error':
        this.persistAndEmit(siteId, sessionId, 'status', { state: 'error', detail: event.message });
        this.store.setAgentSessionStatus(sessionId, 'error');
        return;
      case 'exit': {
        const current = this.hot.get(siteId);
        if (current && current.sessionId === sessionId) {
          clearTimeout(current.idleTimer);
          this.hot.delete(siteId);
        }
        return;
      }
    }
  }

  private persistAndEmit(siteId: number, sessionId: number, type: string, payload: Record<string, unknown>): void {
    const row = this.store.appendAgentEvent(sessionId, type, payload);
    this.emit(siteId, { seq: row.seq, type, payload });
  }

  private resetIdle(siteId: number): void {
    const hot = this.hot.get(siteId);
    if (!hot) return;
    clearTimeout(hot.idleTimer);
    hot.idleTimer = setTimeout(() => {
      this.hot.delete(siteId);
      void hot.handle.close().catch(() => undefined);
    }, this.idleMs);
    hot.idleTimer.unref?.();
  }

  private emit(siteId: number, event: AgentWireEvent): void {
    for (const fn of this.listeners.get(siteId) ?? []) {
      try {
        fn(event);
      } catch (err) {
        console.error('agent SSE listener error:', err);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests** — `npm --workspace ferry-server test` → all pass.
- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/agent/manager.ts ferry-server/tests/agent-manager.test.ts
git commit -m "feat: AgentManager — hot sessions, idle resume, event persistence and fan-out"
```

---

### Task 7: Agent routes, app wiring, sync mutual exclusion, main.ts

**Files:**
- Create: `ferry-server/src/routes/agent.ts`
- Modify: `ferry-server/src/app.ts` (AppDeps + wiring)
- Modify: `ferry-server/src/routes/sync.ts` (409 when agent is active)
- Modify: `ferry-server/src/main.ts` (env config, real runner, boot recovery)
- Modify: `ferry-server/tests/helpers/testApp.ts` (agent deps helper)
- Test: `ferry-server/tests/agent-routes.test.ts`

**Interfaces:**
- Consumes: `AgentManager` (Task 6), `scriptedRunner` (Task 5), `ensureAgentBranch` (Task 4), `sdkRunner` (Task 5).
- Produces:
  - `AppDeps.agent?: { runner: AgentRunner; cloneDir: (slug: string) => string; ensureBranch: (cloneDir: string) => Promise<void>; idleMs?: number }`
  - `buildApp` constructs `AgentManager` when `deps.agent` is set and passes it to both `syncRoutes` (new 4th param, optional) and the new `agentRoutes(app, deps, agents, sync)`.
  - HTTP: `POST /api/sites/:id/agent/messages` `{text}` → 202 `{queued:true}` | 400 empty/overlong (>4000 chars) | 409 `{error:'A sync is running for this site.'}` | 409 `{error:'Sync the site first.'}` when `site.status !== 'ready'`; `POST /api/sites/:id/agent/sessions` → 200 `{created:true}`; `GET /api/sites/:id/agent/history?after=` → 200 `{sessionId: number|null, events: AgentWireEvent[]}`; `GET /api/sites/:id/agent/events?after=` → SSE of `AgentWireEvent` JSON lines.
  - `POST /api/sites/:id/sync` now returns 409 `{error:'The agent is working on this site — finish or start a new session first.'}` when `agents.isActive(site.id)`.

- [ ] **Step 1: Extend the test helper.** In `tests/helpers/testApp.ts` add:

```ts
import type { AgentRunner } from '../../src/agent/types.js';

export function agentDeps(runner: AgentRunner, idleMs = 60_000) {
  return {
    runner,
    cloneDir: (slug: string) => `/clones/${slug}`,
    ensureBranch: async () => undefined,
    idleMs,
  };
}
```

- [ ] **Step 2: Write the failing route tests**

```ts
// ferry-server/tests/agent-routes.test.ts
import { describe, expect, it } from 'vitest';
import { scriptedRunner } from '../src/agent/scripted-runner.js';
import type { AgentWireEvent } from '../src/agent/types.js';
import { agentDeps, makeApp, signup, stubEngine } from './helpers/testApp.js';

type TestApp = ReturnType<typeof makeApp>;

async function readySite(app: TestApp['app'], cookie: string, store: TestApp['store']) {
  const res = await app.inject({
    method: 'POST', url: '/api/sites', headers: { cookie },
    payload: { name: 'S', url: 'https://klant.nl' },
  });
  const site = res.json() as { id: number };
  store.setStatus(site.id, 'ready');
  return site;
}

function sseEvents(body: string): AgentWireEvent[] {
  return body.split('\n\n').filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice('data: '.length)) as AgentWireEvent);
}

describe('agent routes', () => {
  it('accepts a message, persists the turn, serves history', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const send = await app.inject({
      method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie },
      payload: { text: 'Why is VAT wrong?' },
    });
    expect(send.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 150)); // scripted turn completes
    const history = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/agent/history`, headers: { cookie } });
    expect(history.statusCode).toBe(200);
    const body = history.json() as { sessionId: number; events: AgentWireEvent[] };
    expect(body.events.map((e) => e.type)).toEqual(['user', 'tool_use', 'tool_result', 'agent_text', 'turn_end']);
    const after = await app.inject({
      method: 'GET', url: `/api/sites/${site.id}/agent/history?after=${body.events[2]!.seq}`, headers: { cookie },
    });
    expect((after.json() as { events: AgentWireEvent[] }).events.map((e) => e.type)).toEqual(['agent_text', 'turn_end']);
  });

  it('validates input and status', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const empty = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: '  ' } });
    expect(empty.statusCode).toBe(400);
    store.setStatus(site.id, 'paired');
    const notReady = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'hi' } });
    expect(notReady.statusCode).toBe(409);
    expect((notReady.json() as { error: string }).error).toBe('Sync the site first.');
  });

  it('starts a new session via the escape hatch', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'a' } });
    await new Promise((r) => setTimeout(r, 150));
    const s1 = store.currentAgentSession(site.id)!.id;
    const fresh = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/sessions`, headers: { cookie } });
    expect(fresh.statusCode).toBe(200);
    expect(store.currentAgentSession(site.id)!.id).not.toBe(s1);
    const history = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/agent/history`, headers: { cookie } });
    expect((history.json() as { events: AgentWireEvent[] }).events.map((e) => e.type)).toEqual(['status']); // fresh session
  });

  it('replays persisted events over SSE with ?after and no duplicates', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'a' } });
    await new Promise((r) => setTimeout(r, 150));
    const res = await app.inject({
      method: 'GET', url: `/api/sites/${site.id}/agent/events?after=0`, headers: { cookie },
      payloadAsStream: true,
    });
    // fastify inject with a hijacked SSE reply: read what has been written, then the test ends.
    const chunks: Buffer[] = [];
    const stream = res.stream();
    stream.on('data', (c: Buffer) => chunks.push(c));
    await new Promise((r) => setTimeout(r, 100));
    stream.destroy();
    const events = sseEvents(Buffer.concat(chunks).toString('utf8'));
    const seqs = events.filter((e) => e.seq !== undefined).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate replays
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['user', 'agent_text', 'turn_end']));
  });

  it('mutually excludes sync and agent per site', async () => {
    let releasePull: () => void = () => undefined;
    const engine = stubEngine({
      pull: () => new Promise((resolve) => { releasePull = () => resolve({ url: 'https://x.ddev.site' } as never); }),
      verifyClone: async () => true,
    });
    const { app, store } = makeApp({ engine, agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    // agent active -> sync refused
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'a' } });
    const syncWhileAgent = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    expect(syncWhileAgent.statusCode).toBe(409);
    // fresh site: sync running -> agent refused
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/sessions`, headers: { cookie } }); // drops hot handle
    const syncStart = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    expect(syncStart.statusCode).toBe(202);
    const msgWhileSync = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'b' } });
    expect(msgWhileSync.statusCode).toBe(409);
    releasePull();
  });
});
```

> If `payloadAsStream`/`res.stream()` gives trouble with the hijacked reply under `app.inject`, fall back to testing the SSE handler through a real listener: `await app.listen({ port: 0 })`, `fetch` the SSE URL with the session cookie, read from `res.body`, then `await app.close()`. Keep the same assertions.

- [ ] **Step 3: Run to verify failure** — FAIL (`agent` not in AppDeps, route 404s).

- [ ] **Step 4: Implement.**

`src/routes/agent.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { AgentManager } from '../agent/manager.js';
import type { AgentWireEvent } from '../agent/types.js';
import type { SyncManager } from '../sync.js';

const MESSAGE_MAX = 4000;

export function agentRoutes(app: FastifyInstance, deps: AppDeps, agents: AgentManager, sync: SyncManager): void {
  app.post('/api/sites/:id/agent/messages', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status !== 'ready') return reply.code(409).send({ error: 'Sync the site first.' });
    if (sync.isRunning(site.id)) return reply.code(409).send({ error: 'A sync is running for this site.' });
    const text = String((request.body as { text?: unknown } | undefined)?.text ?? '').trim();
    if (text === '' || text.length > MESSAGE_MAX) {
      return reply.code(400).send({ error: `Message must be 1–${MESSAGE_MAX} characters.` });
    }
    await agents.send(site, text);
    return reply.code(202).send({ queued: true });
  });

  app.post('/api/sites/:id/agent/sessions', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    await agents.newSession(site);
    return reply.send({ created: true });
  });

  app.get('/api/sites/:id/agent/history', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const after = Number((request.query as { after?: string }).after ?? 0) || 0;
    const session = deps.store.currentAgentSession(site.id);
    if (!session) return reply.send({ sessionId: null, events: [] });
    const events: AgentWireEvent[] = deps.store.agentEventsAfter(session.id, after)
      .map((row) => ({ seq: row.seq, type: row.type, payload: row.payload }));
    return reply.send({ sessionId: session.id, events });
  });

  app.get('/api/sites/:id/agent/events', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const after = Number((request.query as { after?: string }).after ?? 0) || 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (e: AgentWireEvent): void => { reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); };

    // Subscribe first and buffer, then replay the store, then flush — no gap, no duplicates.
    let replaying = true;
    let lastSeq = after;
    const buffer: AgentWireEvent[] = [];
    const unsubscribe = agents.subscribe(site.id, (e) => {
      if (replaying) buffer.push(e);
      else send(e);
    });
    const session = deps.store.currentAgentSession(site.id);
    if (session) {
      for (const row of deps.store.agentEventsAfter(session.id, after)) {
        send({ seq: row.seq, type: row.type, payload: row.payload });
        lastSeq = row.seq;
      }
    }
    replaying = false;
    for (const e of buffer) {
      if (e.seq === undefined || e.seq > lastSeq) send(e);
    }

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
```

`src/app.ts` — extend `AppDeps` and wiring:

```ts
import { AgentManager } from './agent/manager.js';
import type { AgentRunner } from './agent/types.js';
import { agentRoutes } from './routes/agent.js';

export interface AppDeps {
  store: Store;
  engine?: Engine;
  pluginZip?: Buffer;
  staticDir?: string;
  agent?: {
    runner: AgentRunner;
    cloneDir: (slug: string) => string;
    ensureBranch: (cloneDir: string) => Promise<void>;
    idleMs?: number;
  };
}
// in buildApp(), replace the `if (deps.engine)` block:
if (deps.engine) {
  const sync = new SyncManager(deps.store, deps.engine);
  const agents = deps.agent
    ? new AgentManager(deps.store, deps.agent.runner, {
        cloneDir: deps.agent.cloneDir,
        ensureBranch: deps.agent.ensureBranch,
        idleMs: deps.agent.idleMs,
      })
    : undefined;
  syncRoutes(app, deps, sync, agents);
  if (agents) agentRoutes(app, deps, agents, sync);
}
```

`src/routes/sync.ts` — new optional param + guard in the POST handler (before `sync.start(site)`):

```ts
export function syncRoutes(app: FastifyInstance, deps: AppDeps, sync: SyncManager, agents?: AgentManager): void {
// ...
    if (agents?.isActive(site.id)) {
      return reply.code(409).send({ error: 'The agent is working on this site — finish or start a new session first.' });
    }
```

`src/main.ts` — next to the existing engine/store wiring add (keep existing structure; only additions shown):

```ts
import { join } from 'node:path';
import { ferryHome, slugFromUrl } from '../../ferry-cli/src/profile.js';
import { ensureAgentBranch } from './agent/branch.js';
import { sdkRunner } from './agent/sdk-runner.js';

const agentDepsForMain = process.env.ANTHROPIC_API_KEY
  ? {
      runner: sdkRunner({
        model: process.env.FERRY_AGENT_MODEL ?? 'sonnet',
        maxTurns: Number(process.env.FERRY_AGENT_MAX_TURNS ?? 50),
        maxBudgetUsd: Number(process.env.FERRY_AGENT_MAX_BUDGET_USD ?? 5),
        configDir: join(ferryHome(), 'agent'),
      }),
      cloneDir: (slug: string) => join(ferryHome(), 'clones', slug),
      ensureBranch: ensureAgentBranch,
      idleMs: Number(process.env.FERRY_AGENT_IDLE_MS ?? 30 * 60_000),
    }
  : undefined;
if (!agentDepsForMain) {
  console.warn('ANTHROPIC_API_KEY is not set — agent chat is disabled.');
}
// pass `agent: agentDepsForMain` into buildApp deps
// next to store.recoverInterruptedSyncs():
store.recoverInterruptedAgentSessions();
```

(`slugFromUrl` import only if not already there; drop it if unused.)

- [ ] **Step 5: Run tests + typecheck** — `npm --workspace ferry-server test && npm --workspace ferry-server run typecheck` → all pass.
- [ ] **Step 6: Commit**

```bash
git add ferry-server/src/routes/agent.ts ferry-server/src/routes/sync.ts ferry-server/src/app.ts ferry-server/src/main.ts ferry-server/tests/helpers/testApp.ts ferry-server/tests/agent-routes.test.ts
git commit -m "feat: agent chat API — messages, sessions, history, SSE, sync exclusion"
```

---

### Task 8: Context endpoint (right rail data)

**Files:**
- Create: `ferry-server/src/agent/context.ts`
- Modify: `ferry-server/src/routes/agent.ts` (one more route)
- Test: `ferry-server/tests/agent-context.test.ts`

**Interfaces:**
- Produces:

```ts
// context.ts
export interface AgentContext {
  branch: string;                 // 'agent/work'
  baseCommit: string;             // short sha of production
  shortstat: string;              // e.g. '2 files changed, 4 insertions(+), 11 deletions(-)' or ''
  files: { status: string; path: string }[];  // git diff --name-status vs production, max 20
  environment: { wp?: string; php?: string; db?: string; webServer?: string };
}
export async function siteContext(
  slug: string, cloneDir: string,
  loadProfileFn?: (slug: string) => { info?: unknown },
): Promise<AgentContext>
// route: GET /api/sites/:id/agent/context -> 200 AgentContext | 409 'Sync the site first.' when not ready
```

- [ ] **Step 1: Write the failing tests** (reuse the temp-repo helper style from Task 4; write a fake profile loader):

```ts
// ferry-server/tests/agent-context.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureAgentBranch } from '../src/agent/branch.js';
import { siteContext } from '../src/agent/context.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function makeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-ctx-'));
  git(dir, 'init', '-b', 'production');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'functions.php'), '<?php add_filter();');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'pull');
  return dir;
}

const profileFn = () => ({
  info: { wp: '6.5', php: { version: '8.2' }, db: { server: 'mariadb', version: '10.6' }, server: 'nginx' },
});

describe('siteContext', () => {
  it('reports branch, base and a clean diff on a fresh clone', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    const ctx = await siteContext('s', dir, profileFn);
    expect(ctx.branch).toBe('agent/work');
    expect(ctx.baseCommit).toBe(git(dir, 'rev-parse', '--short', 'production'));
    expect(ctx.files).toEqual([]);
    expect(ctx.environment).toEqual({ wp: '6.5', php: '8.2', db: 'mariadb 10.6', webServer: 'nginx' });
  });

  it('reports agent changes vs production', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    writeFileSync(join(dir, 'functions.php'), '<?php // fixed');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'fix');
    const ctx = await siteContext('s', dir, profileFn);
    expect(ctx.files).toEqual([{ status: 'M', path: 'functions.php' }]);
    expect(ctx.shortstat).toContain('1 file changed');
  });

  it('survives a missing profile info block', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    const ctx = await siteContext('s', dir, () => ({}));
    expect(ctx.environment).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement `context.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProfile } from '../../../ferry-cli/src/profile.js';

const run = promisify(execFile);

export interface AgentContext {
  branch: string;
  baseCommit: string;
  shortstat: string;
  files: { status: string; path: string }[];
  environment: { wp?: string; php?: string; db?: string; webServer?: string };
}

async function git(cloneDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: cloneDir });
  return stdout.trim();
}

export async function siteContext(
  slug: string,
  cloneDir: string,
  loadProfileFn: (slug: string) => { info?: unknown } = loadProfile,
): Promise<AgentContext> {
  const [branch, baseCommit, shortstat, nameStatus] = await Promise.all([
    git(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(cloneDir, 'rev-parse', '--short', 'production'),
    git(cloneDir, 'diff', '--shortstat', 'production'),
    git(cloneDir, 'diff', '--name-status', 'production'),
  ]);
  const files = nameStatus === '' ? [] : nameStatus.split('\n').slice(0, 20).map((line) => {
    const [status = '', ...rest] = line.split('\t');
    return { status, path: rest.join('\t') };
  });
  let environment: AgentContext['environment'] = {};
  try {
    const info = (loadProfileFn(slug).info ?? {}) as Record<string, unknown>;
    const php = (info.php ?? {}) as Record<string, unknown>;
    const db = (info.db ?? {}) as Record<string, unknown>;
    environment = {
      ...(typeof info.wp === 'string' ? { wp: info.wp } : {}),
      ...(typeof php.version === 'string' ? { php: php.version } : {}),
      ...(db.server ? { db: `${String(db.server)} ${String(db.version ?? '')}`.trim() } : {}),
      ...(typeof info.server === 'string' ? { webServer: info.server } : {}),
    };
  } catch {
    environment = {};
  }
  return { branch, baseCommit, shortstat, files, environment };
}
```

Route (in `agentRoutes`, needs `deps.agent` for `cloneDir` — pass it via the existing `deps` param):

```ts
app.get('/api/sites/:id/agent/context', { preHandler: app.requireUser }, async (request, reply) => {
  const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
  if (!site) return reply.code(404).send({ error: 'Site not found.' });
  if (site.status !== 'ready') return reply.code(409).send({ error: 'Sync the site first.' });
  try {
    return await siteContext(site.slug, deps.agent!.cloneDir(site.slug));
  } catch (err) {
    return reply.code(500).send({ error: 'Could not read the clone.' });
  }
});
```

Add a route test to `agent-routes.test.ts` only for the 409 (the happy path is covered by the unit tests above; route-level git fixtures aren't worth the wiring):

```ts
it('context returns 409 for a non-ready site', async () => {
  const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
  const cookie = await signup(app);
  const res0 = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
  const site = res0.json() as { id: number };
  const res = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/agent/context`, headers: { cookie } });
  expect(res.statusCode).toBe(409);
});
```

- [ ] **Step 4: Run tests + typecheck** — all pass.
- [ ] **Step 5: Commit**

```bash
git add ferry-server/src/agent/context.ts ferry-server/src/routes/agent.ts ferry-server/tests/agent-context.test.ts ferry-server/tests/agent-routes.test.ts
git commit -m "feat: agent context endpoint for the site-detail rail"
```

---

### Task 9: Dashboard — site detail shell + chat

**Files:**
- Modify: `ferry-dashboard/src/api.ts` (agent API + types)
- Create: `ferry-dashboard/src/pages/site.tsx` (shell: sidebar + chat + rail)
- Create: `ferry-dashboard/src/chat.tsx` (chat column component)
- Modify: `ferry-dashboard/src/main.tsx` (route `/sites/:id`)
- Modify: `ferry-dashboard/src/pages/sites.tsx` (`targetFor`: ready → detail)
- Modify: `ferry-dashboard/src/ui.css` (chat styles; use `--radius`/`--shadow`)

**Interfaces:**
- Consumes: Task 7/8 HTTP API.
- Produces (api.ts):

```ts
export interface AgentWireEvent { seq?: number; type: string; payload: Record<string, unknown> }
export interface AgentContext {
  branch: string; baseCommit: string; shortstat: string;
  files: { status: string; path: string }[];
  environment: { wp?: string; php?: string; db?: string; webServer?: string };
}
export function agentHistory(siteId: number, after?: number): Promise<{ sessionId: number | null; events: AgentWireEvent[] }>
export function agentSend(siteId: number, text: string): Promise<{ queued: boolean }>
export function agentNewSession(siteId: number): Promise<{ created: boolean }>
export function agentContext(siteId: number): Promise<AgentContext>
```

This task's verification is `typecheck` + `vite build` + manual dev-server smoke; the Playwright coverage lands in Task 10.

- [ ] **Step 1: api.ts additions** — add the types above and (following the existing `call<T>` helper style):

```ts
export const agentHistory = (siteId: number, after = 0) =>
  call<{ sessionId: number | null; events: AgentWireEvent[] }>('GET', `/api/sites/${siteId}/agent/history?after=${after}`);
export const agentSend = (siteId: number, text: string) =>
  call<{ queued: boolean }>('POST', `/api/sites/${siteId}/agent/messages`, { text });
export const agentNewSession = (siteId: number) =>
  call<{ created: boolean }>('POST', `/api/sites/${siteId}/agent/sessions`);
export const agentContext = (siteId: number) =>
  call<AgentContext>('GET', `/api/sites/${siteId}/agent/context`);
```

- [ ] **Step 2: `src/chat.tsx`** — the chat column. Behavior contract (implement exactly; visual style follows screen 6 of the design):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentHistory, agentNewSession, agentSend, type AgentWireEvent } from './api';

type ConnState = 'connecting' | 'live' | 'lost';

interface ToolRow { toolUseId: string; name: string; input: string; output?: string; isError?: boolean }

export function AgentChat({ siteId }: { siteId: number }) {
  const [events, setEvents] = useState<AgentWireEvent[]>([]);
  const [streamText, setStreamText] = useState('');
  const [conn, setConn] = useState<ConnState>('connecting');
  const [draft, setDraft] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const connect = useCallback(async () => {
    setConn('connecting');
    const history = await agentHistory(siteId);
    setEvents(history.events);
    const lastSeq = history.events.at(-1)?.seq ?? 0;
    const es = new EventSource(`/api/sites/${siteId}/agent/events?after=${lastSeq}`);
    esRef.current = es;
    es.onopen = () => setConn('live');
    es.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as AgentWireEvent;
      if (event.type === 'text_delta') {
        setStreamText((t) => t + String(event.payload.text ?? ''));
        return;
      }
      if (event.type === 'agent_text') setStreamText(''); // authoritative text replaces the accumulation
      setEvents((prev) => (event.seq !== undefined && prev.some((p) => p.seq === event.seq) ? prev : [...prev, event]));
    };
    es.onerror = () => setConn('lost'); // 3b fold-in: the silent-freeze fix — visible state + retry button
  }, [siteId]);

  useEffect(() => {
    void connect();
    return () => esRef.current?.close();
  }, [connect]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events, streamText]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (text === '') return;
    setDraft('');
    await agentSend(siteId, text); // optimistic render not needed: the 'user' event echoes over SSE
  }

  async function newSession() {
    await agentNewSession(siteId);
    setEvents([]);
    setStreamText('');
    esRef.current?.close();
    void connect();
  }

  // render: walk `events`, pairing tool_use/tool_result into ToolRow blocks by toolUseId,
  // then user bubbles / agent text / status lines; streamText renders as the in-flight
  // agent message with a blinking caret; turn_end renders only for error subtypes:
  //   error_max_turns / error_max_budget_usd / error_during_execution ->
  //   "The agent stopped (<reason>). Send a message to continue, or start a new session."
  // header right side: conn === 'live' ? green "SSE live" dot : conn === 'lost'
  //   ? red "connection lost" + <button onClick={connect}>Reconnect</button> : "connecting…"
  // composer: input placeholder "Ask a follow-up or request another fix…",
  //   hint "wp-cli · git · shell", submit button "↑" (aria-label="Send message"),
  //   plus a "New session" button (aria-label="Start a new session") calling newSession.
  ...
}
```

The `...` body is ordinary JSX per the contract in the comments — pair tool events as they arrive (a `tool_use` without its `tool_result` yet renders as a running row), keep all class names in `ui.css`.

- [ ] **Step 3: `src/pages/site.tsx`** — the shell. Loads the site (`GET /api/sites` list is already in api.ts — reuse the existing sites fetch or add `siteById` via the list), renders the screen-6 grid `230px 1fr 300px`:
  - **Sidebar:** Ferry mark, "← All sites" link to `/`, site card (initial, name, status chip — reuse existing chip classes), nav: Overview (disabled), **Agent chat** (active), Changes (disabled), Sync & status (link to `/sites/:id/sync`), Settings (disabled); footer mono block: `branch agent/work`, `base production@<baseCommit>` from `agentContext`.
  - **Center:** `<AgentChat siteId={...} />`.
  - **Rail:** Environment card (`wp/php/db/webServer` + clone host as plain mono text — **never an `<a>`**), Containment card (static three lines: "Egress blocked for the clone", "Mail & HTTP blocked", "License stubs active (EDD, Freemius, WC.com)"), Changes card (`shortstat` + `files` list from `agentContext`).
  - If `agentContext` 409s (not ready), redirect to `/sites/:id/sync`.

- [ ] **Step 4: Route + list link.** In `main.tsx` add `{ path: '/sites/:id', element: <SitePage /> }` inside the `RequireAuth` children. In `pages/sites.tsx` `targetFor`, add before the final return: `if (site.status === 'ready') return `/sites/${site.id}`;`

- [ ] **Step 5: `ui.css`** — add chat classes (`.chat`, `.chat__msg--user`, `.chat__msg--agent`, `.chat__toolblock`, `.chat__toolrow`, `.chat__status`, `.chat__composer`, `.site-grid`, `.rail-card`, …) styled per screen 6 (user bubble = accent bg, radius `14px 14px 4px 14px`; tool block = bordered mono table rows; panel cards use `var(--radius)` and `var(--shadow)` — this makes those two tokens used, per the design's fold-in resolution).

- [ ] **Step 6: Verify**

```bash
npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run build
```

Expected: clean. Optional manual smoke: `npm --workspace ferry-server run dev` + `npm --workspace ferry-dashboard run dev`, open a ready site.

- [ ] **Step 7: Commit**

```bash
git add ferry-dashboard/src
git commit -m "feat: site detail screen with live agent chat (screen 6, chat portion)"
```

---

### Task 10: Dashboard e2e — chat flow with the scripted runner

**Files:**
- Modify: `ferry-dashboard/e2e/server.ts` (wire scripted agent deps)
- Modify: `ferry-dashboard/e2e/dashboard.spec.ts` (extend the real-fixture happy path with the chat flow)

**Interfaces:**
- Consumes: `scriptedRunner` from `ferry-server/src/agent/scripted-runner.js`, `AppDeps.agent` (Task 7).

- [ ] **Step 1: Wire the e2e server.** In `e2e/server.ts` add to the `buildApp` deps:

```ts
import { scriptedRunner } from '../../ferry-server/src/agent/scripted-runner.js';
// The chat e2e uses the scripted runner (no tokens spent); ensureBranch is real —
// the happy-path sync produces a real clone with a production branch.
import { ensureAgentBranch } from '../../ferry-server/src/agent/branch.js';
import { join } from 'node:path';

// inside buildApp deps:
agent: {
  runner: scriptedRunner(),
  cloneDir: (slug: string) => join(process.env.FERRY_HOME!, 'clones', slug),
  ensureBranch: ensureAgentBranch,
  idleMs: 60_000,
},
```

- [ ] **Step 2: Extend the happy-path spec.** In `dashboard.spec.ts`, after the existing "Clone verified" assertions in the real-fixture test, append the chat flow (same test — the site is `ready` there and the suite runs with one worker):

```ts
// --- Plan 4: agent chat on the ready site (scripted runner — no API tokens) ---
await page.goto('/');
await page.getByRole('button', { name: 'Open' }).click();          // ready site -> /sites/:id
await expect(page.getByText('Agent chat')).toBeVisible();
await expect(page.getByText('SSE live')).toBeVisible();

const composer = page.getByPlaceholder('Ask a follow-up or request another fix…');
await composer.fill('Why is VAT wrong on orders above €100?');
await page.getByRole('button', { name: 'Send message' }).click();

await expect(page.getByText('Why is VAT wrong on orders above €100?')).toBeVisible(); // user bubble via SSE echo
await expect(page.getByText('Grep')).toBeVisible();                 // tool row
await expect(page.getByText('functions.php:412')).toBeVisible();    // tool result
await expect(page.getByText(/Plan: check the tax settings/)).toBeVisible(); // final agent text

// history survives reload
await page.reload();
await expect(page.getByText(/Plan: check the tax settings/)).toBeVisible();

// SSE error state is visible, not a silent freeze (3b fold-in)
await page.context().setOffline(true);
await expect(page.getByText('connection lost')).toBeVisible();
await page.context().setOffline(false);
await page.getByRole('button', { name: 'Reconnect' }).click();
await expect(page.getByText('SSE live')).toBeVisible();

// new session escape hatch clears the thread
await page.getByRole('button', { name: 'Start a new session' }).click();
await expect(page.getByText(/Plan: check the tax settings/)).not.toBeVisible();
await expect(page.getByText('New session started.')).toBeVisible();
```

- [ ] **Step 3: Run the gate** (fixture preconditions from Global Constraints first):

```bash
ddev delete -Oy ferry-prod-ddev-site
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
npm --workspace ferry-dashboard run e2e
```

Expected: all tests pass (9 existing + extended happy path).

- [ ] **Step 4: Commit**

```bash
git add ferry-dashboard/e2e
git commit -m "test: e2e chat flow over the scripted agent runner"
```

---

### Task 11: 3b triage fold-ins

**Files:**
- Modify: `ferry-dashboard/src/pages/pair.tsx` (aria-label)
- Modify: `ferry-dashboard/src/ui.css` (delete `.chip--asleep`)
- Modify: `ferry-dashboard/tsconfig.json`, `ferry-server/tsconfig.json` (typecheck coverage)

- [ ] **Step 1: Pairing input label.** In `pair.tsx`, the code `<input className="input mono pair-panel__code" …>` gets `aria-label="Pairing code"`.
- [ ] **Step 2: Dead token.** In `ui.css` line ~73, change `.chip--new, .chip--asleep {` to `.chip--new {`. Verify `--amber*`, `--radius`, `--shadow` are now referenced (chat/rail styles from Task 9; `grep -n 'var(--amber\|var(--radius\|var(--shadow' ferry-dashboard/src/ui.css`) — they must be, else the design decision says keep and use them, not delete.
- [ ] **Step 3: Typecheck coverage.** Extend `include` in both workspaces' `tsconfig.json` to cover `e2e/**/*.ts`, `playwright.config.ts` (dashboard) and `e2e/**/*.ts` (server). Fix any errors this surfaces (they are the point of the task). If Playwright/vite config types need `"types"` additions, add them to the tsconfig, not as `// @ts-ignore`.
- [ ] **Step 4: Verify**

```bash
npm --workspace ferry-server run typecheck && npm --workspace ferry-dashboard run typecheck && npm --workspace ferry-dashboard run build
```

- [ ] **Step 5: Commit**

```bash
git add ferry-dashboard/src/pages/pair.tsx ferry-dashboard/src/ui.css ferry-dashboard/tsconfig.json ferry-server/tsconfig.json
git commit -m "fix: 3b triage — pairing aria-label, dead chip class, e2e under typecheck"
```

---

### Task 12: Acceptance runbook + whole-branch verification

**Files:**
- Create: `docs/superpowers/plans/2026-07-26-ferry-plan4-acceptance-runbook.md`

- [ ] **Step 1: Write the runbook** — the roadmap's Done-when, manually, with real tokens (the only place they're spent):

```markdown
# Plan 4 acceptance runbook — real agent against the ferry-prod fixture

Preconditions: fixture running at ~/ferry-e2e/prod; `ddev delete -Oy ferry-prod-ddev-site`;
`export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`; `export ANTHROPIC_API_KEY=<key>`.
Optional caps for the run: `FERRY_AGENT_MAX_BUDGET_USD=2`.

1. `npm --workspace ferry-server run dev` and `npm --workspace ferry-dashboard run dev`.
2. Sign up at http://localhost:5173, add `https://ferry-prod.ddev.site`, pair
   (`cd ~/ferry-e2e/prod && ddev wp eval 'print(json_encode(\Ferry\Auth::issue_pairing_code()));'`),
   run the initial sync to Ready.
3. Open the site → Agent chat. Ask: "The site title looks wrong on the homepage —
   can you find where it's set and fix a typo in it?" (or any small, real defect you
   plant in the fixture theme first).
4. PASS criteria — all of:
   - tool rows stream live (grep/read/ddev wp visible while it works); prose streams token-wise
   - the agent states a plan before editing
   - `git -C $FERRY_HOME/clones/ferry-prod-ddev-site log agent/work` shows its commit(s);
     `git diff production` shows exactly the fix
   - the agent verified inside the clone (`ddev wp` or an HTTP check) and said so
   - a turn_end event with cost lands in agent_events (check the DB or the SSE stream)
   - `git push` attempts (if any) were denied and the agent recovered
5. Restart the ferry-server dev process mid-session; send a follow-up message —
   the session resumes with context intact.
6. Press "New session" — thread clears; a fresh question starts clean.

Record the observed total cost for the session in the PR description.
```

- [ ] **Step 2: Whole-branch verification**

```bash
npm --workspace ferry-cli test          # 93 pass
npm --workspace ferry-server test       # 36 + new pass
npm --workspace ferry-server run typecheck
npm --workspace ferry-dashboard run typecheck
ddev delete -Oy ferry-prod-ddev-site && npm --workspace ferry-dashboard run e2e
```

All green. Then run the acceptance runbook manually (human + real key) before merge.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-26-ferry-plan4-acceptance-runbook.md
git commit -m "docs: Plan 4 acceptance runbook (real-agent gate)"
```

---

## Plan self-review notes

- Spec coverage: decisions 1–6, architecture, hermetic config, guardrails, MCP tools, branch policy, data model, API, dashboard incl. fold-ins, errors, cost, testing — each maps to Tasks 1–12. The design's "boot recovery" lands in Task 7 (`recoverInterruptedAgentSessions` in main.ts + Task 2 store method). The design's stop-affordance deferral and Plan-5/6 items are intentionally absent.
- The one deliberate deviation from full TDD: Task 9 (dashboard) has no unit test layer because the workspace has none; its behavior is covered by Task 10's Playwright flow.
- PIN discipline: only Task 1 and Task 5 touch the real SDK; every PIN line lists its authority (the pins doc). Our `types.ts` seam is frozen so Tasks 6–10 cannot be invalidated by SDK drift.
