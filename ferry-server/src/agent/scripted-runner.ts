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
