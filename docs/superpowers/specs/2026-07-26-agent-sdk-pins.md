# Claude Agent SDK — pinned surface (Plan 4, Task 1)

**Date:** 2026-07-26 · Pinned from the **installed package's actual `.d.ts`**, not docs or memory.
Source file: `ferry-server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (hoisted to the
workspace root `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` by npm workspaces).
Supersedes the ⚠️-marked "unverified" spots in
`docs/superpowers/specs/2026-07-26-claude-agent-sdk-capabilities.md`.

## Installed version

`ferry-server/node_modules/@anthropic-ai/claude-agent-sdk/package.json`:

```json
"name": "@anthropic-ai/claude-agent-sdk",
"version": "0.3.220",
"claudeCodeVersion": "2.1.220"
```

Peer deps (auto-installed by npm, all satisfied):

```json
"peerDependencies": {
  "@anthropic-ai/sdk": ">=0.93.0",
  "@modelcontextprotocol/sdk": "^1.29.0",
  "zod": "^4.0.0"
}
```

Resolved: `@anthropic-ai/sdk@0.115.0`, `@modelcontextprotocol/sdk@1.29.0`, `zod@4.4.3` (all deduped
to one copy — no conflicting versions in the tree). `ferry-server/package.json` now declares
`"zod": "^4.4.3"` directly (matches the peer range, no override needed).

Note on zod: the SDK's `tool()` accepts a raw shape typed as `ZodRawShape | ZodRawShape_2`
(imports from both plain `zod` and `zod/v4`). Since the installed root `zod` package (4.4.3) *is*
v4 (its `.` export points at the v4 implementation), plain `import { z } from 'zod'` is the correct
import for schemas passed to `tool()` — no need for the `zod/v4` subpath.

## `query()` signature

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

`Query extends AsyncGenerator<SDKMessage, void>` plus control methods (see "Query control
methods" below). `prompt` as a plain `string` is single-shot; `prompt` as an
`AsyncIterable<SDKUserMessage>` is streaming-input mode, required for our long-lived
one-session-per-site chat.

## `Options` fields we use (verbatim doc comments + types)

```ts
/** Current working directory for the session. Defaults to `process.cwd()`. */
cwd?: string;

/** Claude model to use. Defaults to the CLI default model.
 *  Examples: 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5' */
model?: string;

/** Maximum number of conversation turns before the query stops.
 *  A turn consists of a user message and assistant response. */
maxTurns?: number;

/** Maximum budget in USD for the query. The query will stop if this
 *  budget is exceeded, returning an `error_max_budget_usd` result. */
maxBudgetUsd?: number;
```

**PIN CONFIRMED:** the brief's guessed name `maxBudgetUsd` is exactly right — it exists in the
installed typings (`sdk.d.ts:1683`), sibling to `maxTurns` (`sdk.d.ts:1678`). No fallback to
"`maxTurns` only" is needed. Its stop condition produces `SDKResultMessage.subtype ===
'error_max_budget_usd'` (see `TerminalReason` = `'budget_exhausted'` in the parallel enum at
`sdk.d.ts:6909`).

```ts
/** systemPrompt (preset form) */
systemPrompt?: string | string[] | {
    type: 'preset';
    preset: 'claude_code';
    append?: string;
    excludeDynamicSections?: boolean;
};

/** Control which filesystem settings to load.
 *  - 'user' - Global user settings (~/.claude/settings.json)
 *  - 'project' - Project settings (.claude/settings.json)
 *  - 'local' - Local settings (.claude/settings.local.json)
 *  When omitted, all sources are loaded (matches CLI defaults).
 *  Pass [] to disable filesystem settings (SDK isolation mode).
 *  Must include 'project' to load CLAUDE.md files. */
settingSources?: SettingSource[];

export declare type SettingSource = 'user' | 'project' | 'local';
```

Confirms the design doc's security finding: `settingSources: ['project']` loads CLAUDE.md **and**
`.claude/` (settings/hooks/skills) from the clone dir. `systemPrompt: {type:'preset',
preset:'claude_code', append}` + `settingSources: []` stays hermetic.

```ts
export declare type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

**Discrepancy from the brief's doc-comment source:** the `Options.permissionMode` JSDoc
(`sdk.d.ts:1731-1739`) only prose-documents 5 values (`default`, `acceptEdits`,
`bypassPermissions`, `plan`, `dontAsk`) — `'auto'` is missing from that comment but **is** in the
type union. It's separately documented on `SDKSystemMessage.permissionMode`
(`sdk.d.ts:4427`): `'auto' - Use a model classifier to approve/deny permission prompts.` The type
is the source of truth; there are 6 literals, not 5.

```ts
/** List of tool names that are auto-allowed without prompting for permission. */
allowedTools?: string[];

/** List of tool names that are disallowed. Removed from the model's context. */
disallowedTools?: string[];

/** Specify the base set of available built-in tools.
 *  - string[] - Array of specific tool names (e.g., ['Bash', 'Read', 'Edit'])
 *  - [] (empty array) - Disable all built-in tools
 *  - { type: 'preset'; preset: 'claude_code' } - Use all default Claude Code tools */
tools?: string[] | {
    type: 'preset';
    preset: 'claude_code';
};
```

`tools` exists as an availability filter, distinct from `allowedTools`/`disallowedTools` (which
gate permission prompting, not availability).

```ts
/** MCP (Model Context Protocol) server configurations. Keys are server names. */
mcpServers?: Record<string, McpServerConfig>;

export declare type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance;
```

```ts
/** Hook callbacks for responding to various events during execution. */
hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

export declare interface HookCallbackMatcher {
    matcher?: string;
    hooks: HookCallback[];
    /** Timeout in seconds for all hooks in this matcher */
    timeout?: number;
}

export declare type HookCallback = (input: HookInput, toolUseID: string | undefined, options: {
    signal: AbortSignal;
}) => Promise<HookJSONOutput>;

export declare type PreToolUseHookInput = BaseHookInput & {
    hook_event_name: 'PreToolUse';
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
};

export declare type PreToolUseHookSpecificOutput = {
    hookEventName: 'PreToolUse';
    permissionDecision?: HookPermissionDecision;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
};

export declare type HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer';

export declare type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

export declare type SyncHookJSONOutput = {
    continue?: boolean;
    suppressOutput?: boolean;
    stopReason?: string;
    decision?: 'approve' | 'block';
    systemMessage?: string;
    terminalSequence?: string;
    reason?: string;
    hookSpecificOutput?: PreToolUseHookSpecificOutput | /* ...other event's SpecificOutput... */ ;
};

export declare type AsyncHookJSONOutput = {
    async: true;
    asyncTimeout?: number;
};
```

`BaseHookInput` (all hook inputs extend this): `{ session_id: string; transcript_path: string;
cwd: string; prompt_id?: string; permission_mode?: string; agent_id?: string; agent_type?: string;
effort?: { level: string } }`.

For our PreToolUse guardrails: return a `SyncHookJSONOutput` with
`hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '...' }`
to block a tool call with a reason the model sees.

```ts
/** Include partial/streaming message events in the output.
 *  When true, `SDKPartialAssistantMessage` events will be emitted during streaming. */
includePartialMessages?: boolean;

/** Session ID to resume. Loads the conversation history from the specified session. */
resume?: string;

/** Environment variables for the Claude Code process.
 *  When set, this value REPLACES the subprocess environment entirely — it is
 *  not merged with `process.env`. Spread `process.env` yourself if the
 *  subprocess still needs inherited variables like `PATH`, `HOME`, or
 *  `ANTHROPIC_API_KEY`. When omitted, the subprocess inherits `process.env`. */
env?: {
    [envVar: string]: string | undefined;
};

/** Path to the Claude Code executable. Uses the built-in executable if not specified. */
pathToClaudeCodeExecutable?: string;
```

**Important footgun:** `env`, if passed at all, **replaces** `process.env` wholesale for the
subprocess (not merged). If we ever set `env`, we must spread `...process.env` ourselves or the
subprocess loses `PATH`/`HOME`/`ANTHROPIC_API_KEY`.

## `SDKMessage` union (exact discriminators + shapes we use)

Full union has ~40 variants (`sdk.d.ts:4019`); listing only the ones the brief asks for.

**`system` / `init`** (`sdk.d.ts:4412-4456`):
```ts
export declare type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';
    agents?: string[];
    apiKeySource: ApiKeySource;
    betas?: string[];
    claude_code_version: string;
    cwd: string;
    tools: string[];
    mcp_servers: { name: string; status: string }[];
    model: string;
    permissionMode: PermissionMode;
    slash_commands: string[];
    output_style: string;
    skills: string[];
    plugins: { name: string; path: string; version?: string }[];
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
    capabilities?: string[];
    uuid: UUID;
    session_id: string;
};
```
`session_id` here is our `RunnerEvent.sdk_session.sdkSessionId`.

**`assistant`** (`sdk.d.ts:2854-2899`):
```ts
export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
    request_id?: string;
    resumed_from_incomplete_thinking?: true;
    supersedes?: UUID[];
    aborted?: true;
    subagent_type?: string;
    task_description?: string;
    timestamp?: string;
};
```
`message: BetaMessage` (from `@anthropic-ai/sdk/resources/beta/messages/messages.mjs`) has
`content: Array<BetaContentBlock>`. The two block shapes we care about:
```ts
// text block
{ type: 'text', text: string }
// tool_use block
export interface BetaToolUseBlock {
    id: string;
    input: unknown;
    name: string;
    type: 'tool_use';
    caller?: BetaDirectCaller | BetaServerToolCaller | BetaServerToolCaller20260120;
}
```
Maps to our `RunnerEvent`: text block → `agent_text`, tool_use block → `tool_use` (`toolUseId:
id`, `name`, `input: JSON.stringify(input)` since `input` is typed `unknown`).

**`user`** (`sdk.d.ts:4583-4627`) — carries `tool_result`:
```ts
export declare type SDKUserMessage = {
    type: 'user';
    message: MessageParam;
    parent_tool_use_id: string | null;
    isSynthetic?: boolean;
    tool_use_result?: unknown;
    priority?: 'now' | 'next' | 'later';
    origin?: SDKMessageOrigin;
    shouldQuery?: boolean;
    timestamp?: string;
    uuid?: UUID;
    session_id?: string;
    subagent_type?: string;
    task_description?: string;
};
```
`message: MessageParam` (from `@anthropic-ai/sdk/resources`, the **non-beta** path — note this
differs from `SDKAssistantMessage.message: BetaMessage`):
```ts
export interface MessageParam {
    content: string | Array<ContentBlockParam>;
    role: 'user' | 'assistant' | 'system';
}
export interface ToolResultBlockParam {
    tool_use_id: string;
    type: 'tool_result';
    cache_control?: CacheControlEphemeral | null;
    content?: string | Array<TextBlockParam | ImageBlockParam | SearchResultBlockParam | DocumentBlockParam | ToolReferenceBlockParam>;
    is_error?: boolean;
}
```
Maps to `RunnerEvent.tool_result`: `toolUseId: tool_use_id`, `output` (stringify `content`),
`isError: is_error ?? false`.

**`stream_event`** (`sdk.d.ts:4150-4157`) — only emitted when `includePartialMessages: true`:
```ts
export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';
    event: BetaRawMessageStreamEvent;
    parent_tool_use_id: string | null;
    uuid: UUID;
    session_id: string;
    ttft_ms?: number;
};
```
`event: BetaRawMessageStreamEvent` is the raw Anthropic streaming event union
(`content_block_delta` with `delta.type === 'text_delta'` / `delta.text` is the token-delta case
we care about for `RunnerEvent.text_delta`). We treat this as SSE-only per the frozen
`AgentWireEvent` doc comment — no `seq`, not persisted to `agent_events`.

**`result`** (`sdk.d.ts:4269-4322`) — union of success/error, both `type: 'result'`:
```ts
export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;

export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    result: string;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    terminal_reason?: TerminalReason;
    uuid: UUID;
    session_id: string;
    // + several timing-detail fields (ttft_ms, warm_spare_claimed, etc.) not needed by us
};

export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: TerminalReason;
    uuid: UUID;
    session_id: string;
};

export declare type NonNullableUsage = { [K in keyof BetaUsage]: NonNullable<BetaUsage[K]> };
// BetaUsage relevant fields: input_tokens: number; output_tokens: number;
```
Maps to our `RunnerEvent.turn_end`: `subtype` verbatim, `totalCostUsd: total_cost_usd` (both
subtypes have it as `number`, never `null` — our frozen type says `number | null`, which is a
superset; safe), `inputTokens: usage.input_tokens`, `outputTokens: usage.output_tokens`,
`numTurns: num_turns`, `durationMs: duration_ms`.

## Streaming-input mode: `SDKUserMessage` to push + interrupt/close

To push a turn into a running streaming-input `Query`, construct the object matching
`SDKUserMessage` above and yield it from the `AsyncIterable` passed as `prompt`, or call:
```ts
streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
```
Minimal shape to push a plain-text user turn:
```ts
{ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
```
(`uuid`, `session_id`, `tool_use_result`, etc. are all optional and can be omitted for a
host-originated turn.)

**`interrupt()`** — **note: returns a value, is not `void`:**
```ts
interrupt(): Promise<SDKControlInterruptResponse | undefined>;
```
Resolves to `undefined` on CLIs that don't advertise the `interrupt_receipt_v1` capability;
otherwise resolves to `{ still_queued: string[]; cancelled?: string[] }` (uuids of async user
messages that will still run unless cancelled). Our frozen `AgentHandle.interrupt(): Promise<void>`
is a narrower wrapper — the runner implementation awaits `query.interrupt()` and discards the
resolved value.

**`close()`** — **note: synchronous, not a `Promise`:**
```ts
close(): void;
```
"Close the query and terminate the underlying process. ... After calling close(), no further
messages will be received." Our frozen `AgentHandle.close(): Promise<void>` is again a wrapper;
the runner implementation calls `query.close()` synchronously and can immediately resolve (or
resolve after observing the `exit`/generator-done state, implementation's choice).

## `createSdkMcpServer` + `tool()` signatures

```ts
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;

declare type CreateSdkMcpServerOptions = {
    name: string;
    version?: string;
    instructions?: string;
    tools?: Array<SdkMcpToolDefinition<any>>;
    alwaysLoad?: boolean;
};

export declare function tool<Schema extends AnyZodRawShape>(
    _name: string,
    _description: string,
    _inputSchema: Schema,
    _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
    _extras?: {
        annotations?: ToolAnnotations;
        searchHint?: string;
        alwaysLoad?: boolean;
    }
): SdkMcpToolDefinition<Schema>;

export declare type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
    name: string;
    description: string;
    inputSchema: Schema;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};
```

**`tool()`'s return shape** is `SdkMcpToolDefinition<Schema>` — a plain object (`{name,
description, inputSchema, handler, ...}`), not a class instance or the handler itself. Pass an
array of these to `createSdkMcpServer({name, tools: [...]})`, then reference the result under
`Options.mcpServers: { <serverName>: mcpServerConfigWithInstance }`.

`CallToolResult` (from `@modelcontextprotocol/sdk/types.js`, via `CallToolResultSchema`) — the
handler's return type — shape:
```ts
{
  content: Array<
    | { type: 'text'; text: string; annotations?: {...}; _meta?: {...} }
    | { type: 'image'; data: string; mimeType: string; ... }
    | { type: 'audio'; data: string; mimeType: string; ... }
    // + a few more block types
  >; // defaults to [] if omitted
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: {...};
}
```
For a simple text-returning ferry tool: `{ content: [{ type: 'text', text: '...' }] }`.

## `CLAUDE_CONFIG_DIR` handling

`CLAUDE_CONFIG_DIR` is **not a dedicated `Options` field** — it's an environment variable read by
the bundled Claude Code CLI subprocess itself, referenced only in doc comments:

- `sdk.d.ts:1589` (on `Options.sessionStore`): "the subprocess still writes to CLAUDE_CONFIG_DIR
  (set it to /tmp for ephemeral local copy)"
- `sdk.d.ts:4782` / `sdk.d.ts:4789` (on `SessionStore`): "The subprocess still writes to local disk
  (set CLAUDE_CONFIG_DIR=/tmp for ephemeral local copy) ... Local-disk transcripts under
  CLAUDE_CONFIG_DIR are swept by the existing cleanupPeriodDays setting"

Session transcripts (JSONL) persist under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`
(default `~/.claude` when unset). To point this at `FERRY_HOME` (per the capabilities doc's
decision), we must pass it via `Options.env`, and because `env` **replaces** `process.env`
wholesale when set (see the `env` footgun above), the runner must do:
```ts
env: { ...process.env, CLAUDE_CONFIG_DIR: '<FERRY_HOME>/agent-config' }
```
Omitting `Options.env` entirely inherits `process.env` as-is, so setting
`process.env.CLAUDE_CONFIG_DIR` once at server startup (before any `query()` call) also works and
avoids needing the spread — either is valid; the spread form is more explicit/local to the runner.

## Query control methods relevant to us (full context for `interrupt`/`close`)

```ts
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    interrupt(): Promise<SDKControlInterruptResponse | undefined>;
    close(): void;
    streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
    // ...many more control methods (setPermissionMode, setModel, mcpServerStatus, etc.)
    // not needed for the frozen AgentRunner seam
}
```

## Discrepancies vs the brief / prior design doc — summary

1. **`maxBudgetUsd` confirmed** — matches the brief's guessed name exactly (`sdk.d.ts:1683`). No
   fallback needed.
2. **`PermissionMode` has 6 literals, not 5** — `'auto'` is a real member of the type union
   (`sdk.d.ts:2092`) even though the `Options.permissionMode` JSDoc prose only lists 5. Any
   exhaustive switch/mapping over `PermissionMode` must handle `'auto'`.
3. **`Query.interrupt()` is not `void`** — resolves `Promise<SDKControlInterruptResponse |
   undefined>`. Our frozen `AgentHandle.interrupt(): Promise<void>` intentionally narrows this;
   implementers must not assume the underlying call is fire-and-forget in a way that discards a
   meaningful value silently — it's a deliberate simplification, not an oversight.
4. **`Query.close()` is synchronous** (`void`, not `Promise<void>`) — our frozen
   `AgentHandle.close(): Promise<void>` again wraps a sync call.
5. **`env` replaces, not merges** — required reading for both the ferry API key and
   `CLAUDE_CONFIG_DIR` passthrough; confirmed directly in the JSDoc, not assumed.
6. **`SDKUserMessage.message` uses non-beta `MessageParam`** while `SDKAssistantMessage.message`
   uses `BetaMessage` — two different import paths (`@anthropic-ai/sdk/resources` vs
   `@anthropic-ai/sdk/resources/beta/messages/messages.mjs`) for what is conceptually the same
   "one turn of conversation" shape. Worth knowing if we ever hand-roll message construction.
