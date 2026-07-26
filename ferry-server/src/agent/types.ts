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
