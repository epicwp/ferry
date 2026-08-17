import type { Site, Store } from '../store.js';
import type { AgentHandle, AgentRunner, AgentWireEvent, RunnerEvent } from './types.js';

export interface AgentManagerOpts {
  cloneDir: (slug: string) => string;
  ensureBranch: (cloneDir: string) => Promise<void>;
  idleMs?: number;
  /** Fired fire-and-forget after each turn ends (e.g. FlyEnv.deployFiles pushing the clone's
   *  working tree to the site's Fly machine). Errors are logged, never surfaced to the chat. */
  afterTurn?: (slug: string) => Promise<void>;
}

type Listener = (e: AgentWireEvent) => void;
interface Hot { sessionId: number; slug: string; handle: AgentHandle; idleTimer?: NodeJS.Timeout }

/**
 * Per-site agent session machine (design §Architecture). Hot state (the SDK subprocess)
 * lives in memory; the durable chat record goes to the store; SSE consumers get every
 * persisted event plus SSE-only text deltas.
 */
export class AgentManager {
  private hot = new Map<number, Hot>();
  private spawning = new Map<number, Promise<Hot>>();
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

  /** True only while a turn is actually running (spec: sync, agent TURN and push are pairwise
   *  exclusive) — a hot-but-idle SDK subprocess doesn't touch the site, so it must not block
   *  the chat → card → push flow. Session status is set 'running' on send() and cleared on
   *  turn_end/runner_error; boot recovery resets stuck 'running' rows. */
  isMidTurn(siteId: number): boolean {
    return this.store.currentAgentSession(siteId)?.status === 'running';
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
    // First, wait for any in-flight spawn to complete, then close it
    const inFlight = this.spawning.get(site.id);
    if (inFlight) {
      const hot = await inFlight;
      clearTimeout(hot.idleTimer);
      this.hot.delete(site.id);
      await hot.handle.interrupt().catch(() => undefined);
      await hot.handle.close().catch(() => undefined);
    }
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
    // If spawn already in flight for this site, await it and validate
    const inFlight = this.spawning.get(site.id);
    if (inFlight) {
      const hot = await inFlight;
      if (hot.sessionId === sessionId) {
        return hot;
      }
      // Superseded - close and fall through to spawn fresh
      clearTimeout(hot.idleTimer);
      this.hot.delete(site.id);
      await hot.handle.close().catch(() => undefined);
    }

    // Check current hot (it might have been set while we awaited inFlight or earlier)
    const existing = this.hot.get(site.id);
    if (existing && existing.sessionId === sessionId) return existing;
    if (existing) {
      clearTimeout(existing.idleTimer);
      this.hot.delete(site.id);
      await existing.handle.close().catch(() => undefined);
    }

    // Create spawn promise and register it BEFORE starting async work
    const spawnPromise = (async () => {
      const cloneDir = this.opts.cloneDir(site.slug);
      await this.opts.ensureBranch(cloneDir);
      const hot: Hot = { sessionId, slug: site.slug, handle: undefined as unknown as AgentHandle };
      hot.handle = this.runner.start({
        cloneDir,
        slug: site.slug,
        resumeSdkSessionId: sdkSessionId ?? undefined,
        onEvent: (event) => this.onRunnerEvent(site.id, sessionId, event),
      });
      this.hot.set(site.id, hot);
      return hot;
    })();

    this.spawning.set(site.id, spawnPromise);
    try {
      return await spawnPromise;
    } finally {
      this.spawning.delete(site.id);
    }
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
        if (this.opts.afterTurn && hot?.slug) {
          this.opts.afterTurn(hot.slug).catch((err) => console.error('afterTurn failed:', err));
        }
        return;
      case 'runner_error':
        console.error(`agent runner error (site ${siteId}, session ${sessionId}):`, event.message);
        this.persistAndEmit(siteId, sessionId, 'status', { state: 'error', detail: 'The agent hit an internal error — try again or start a new session.' });
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

  /** Persist+emit onto the current session (e.g. a change_card from ChangeService.create);
   *  no-op when the site has no session yet - there's nothing live to attach the event to. */
  appendSystemEvent(siteId: number, type: string, payload: Record<string, unknown>): void {
    const session = this.store.currentAgentSession(siteId);
    if (!session) return;
    this.persistAndEmit(siteId, session.id, type, payload);
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
