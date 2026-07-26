import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
    tool(
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
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  push(item: SDKUserMessage): void { this.items.push(item); this.wake?.(); }
  end(): void { this.done = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
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
      const ferry = createSdkMcpServer({ name: 'ferry', tools: buildFerryTools(opts.slug, deps) as never });
      const q = query({
        prompt: input,
        options: {
          cwd: opts.cloneDir,
          model: config.model,
          maxTurns: config.maxTurns,
          maxBudgetUsd: config.maxBudgetUsd,
          resume: opts.resumeSdkSessionId,
          includePartialMessages: true,
          settingSources: [], // hermetic: never load ~/.claude nor the clone's .claude/ (design: security)
          systemPrompt: { type: 'preset', preset: 'claude_code', append: groundRules(opts.slug) },
          permissionMode: 'bypassPermissions',
          disallowedTools: ['WebSearch', 'WebFetch', 'Bash(git push:*)'],
          mcpServers: { ferry },
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: config.configDir, // transcripts under FERRY_HOME (spec §13)
          },
          hooks: {
            PreToolUse: [{
              matcher: 'Bash',
              hooks: [async (hookInput) => {
                if (hookInput.hook_event_name !== 'PreToolUse') return {};
                const toolInput = hookInput.tool_input as { command?: unknown } | null | undefined;
                const command = typeof toolInput?.command === 'string' ? toolInput.command : '';
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
          input.push({ type: 'user', message: { role: 'user', content: userText }, parent_tool_use_id: null });
        },
        async interrupt(): Promise<void> {
          await q.interrupt();
        },
        async close(): Promise<void> {
          input.end();
          q.close();
          await pump.catch(() => undefined);
        },
      };
    },
  };
}
