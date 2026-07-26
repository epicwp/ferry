import type { PullProgress } from '../../ferry-cli/src/pull.js';
import type { Engine } from './engine.js';
import type { Site, Store } from './store.js';

export interface SyncState {
  status: 'idle' | 'syncing' | 'ready' | 'error';
  phase?: string;
  current?: number;
  total?: number;
  detail?: string;
  error?: string | null;
  cloneUrl?: string;
  verifiedAt?: string | null;
}

type Listener = (state: SyncState) => void;

/**
 * Per-site sync state machine. Active state lives in memory (spec §3.3);
 * the durable outcome goes to the store. Every emitted state is complete —
 * SSE consumers just render the last message they received.
 */
export class SyncManager {
  private active = new Map<number, SyncState>();
  private listeners = new Map<number, Set<Listener>>();

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
  ) {}

  isRunning(siteId: number): boolean {
    return this.active.has(siteId);
  }

  snapshot(site: Site): SyncState {
    const running = this.active.get(site.id);
    if (running) return running;
    if (site.status === 'ready') {
      return { status: 'ready', cloneUrl: this.engine.cloneUrl(site.slug), verifiedAt: site.verifiedAt, error: null };
    }
    if (site.status === 'error') return { status: 'error', error: site.lastError };
    return { status: 'idle', error: null };
  }

  start(site: Site): void {
    if (this.active.has(site.id)) throw new Error('already_syncing');
    const state: SyncState = { status: 'syncing', phase: 'info' };
    this.active.set(site.id, state);
    this.store.setStatus(site.id, 'syncing', { lastError: null });
    this.emit(site.id, state);
    void this.run(site);
  }

  subscribe(site: Site, fn: Listener): () => void {
    try {
      fn(this.snapshot(site));
    } catch (err) {
      // Swallow initial call error to prevent broken subscribers from preventing subscription.
      console.error('SSE listener error:', err);
    }
    let set = this.listeners.get(site.id);
    if (!set) {
      set = new Set();
      this.listeners.set(site.id, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  private async run(site: Site): Promise<void> {
    try {
      const result = await this.engine.pull(site.slug, {
        onProgress: (e: PullProgress) => {
          const state: SyncState = { status: 'syncing', phase: e.phase, current: e.current, total: e.total, detail: e.detail };
          this.active.set(site.id, state);
          this.emit(site.id, state);
        },
      });
      const verified = await this.engine.verifyClone(result.url);
      if (!verified.ok) {
        throw new Error(`Clone did not answer at ${result.url}.${verified.detail ? ` ${verified.detail}` : ''}`);
      }
      const now = new Date().toISOString();
      this.store.setStatus(site.id, 'ready', { lastError: null, lastSyncAt: now, verifiedAt: now });
      this.active.delete(site.id);
      this.emit(site.id, { status: 'ready', cloneUrl: result.url, verifiedAt: now, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.setStatus(site.id, 'error', { lastError: message });
      this.active.delete(site.id);
      this.emit(site.id, { status: 'error', error: message });
    }
  }

  private emit(siteId: number, state: SyncState): void {
    for (const fn of this.listeners.get(siteId) ?? []) {
      try {
        fn(state);
      } catch (err) {
        // Swallow listener errors to prevent broken subscribers from affecting sync outcome or crashing the process.
        console.error('SSE listener error:', err);
      }
    }
  }
}
