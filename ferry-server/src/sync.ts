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
  // Bumped on every start() so a late onProgress tick from an old (already-ended)
  // run can be told apart from the run that currently owns `active` — the
  // `active.has(id)` check alone can't tell the two apart once a retry has
  // repopulated the entry for a new run.
  private gen = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly opts: { afterReady?: (site: Site) => Promise<void> } = {},
  ) {}

  isRunning(siteId: number): boolean {
    return this.active.has(siteId);
  }

  snapshot(site: Site): SyncState {
    // A persisted terminal status is authoritative — it must win over a stale
    // `active` entry (e.g. a leaked one) so a fresh snapshot never reports a
    // run as still going when the DB already recorded how it ended.
    if (site.status === 'ready') {
      return { status: 'ready', cloneUrl: this.engine.cloneUrl(site.slug), verifiedAt: site.verifiedAt, error: null };
    }
    if (site.status === 'error') return { status: 'error', error: site.lastError };
    if (site.status === 'syncing') {
      const running = this.active.get(site.id);
      if (running) return running;
    }
    return { status: 'idle', error: null };
  }

  start(site: Site): void {
    if (this.active.has(site.id)) throw new Error('already_syncing');
    const myGen = (this.gen.get(site.id) ?? 0) + 1;
    this.gen.set(site.id, myGen);
    const state: SyncState = { status: 'syncing', phase: 'info' };
    this.active.set(site.id, state);
    this.store.setStatus(site.id, 'syncing', { lastError: null });
    this.emit(site.id, state);
    void this.run(site, myGen);
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

  private async run(site: Site, myGen: number): Promise<void> {
    try {
      const result = await this.engine.pull(site.slug, {
        onProgress: (e: PullProgress) => {
          // A late tick from a still-running concurrent worker must not resurrect
          // an entry whose run() has already reached a terminal state (see run()'s
          // success/error paths, which delete from `active`) — nor, if a retry has
          // since repopulated `active` for a NEW run, be mistaken for that run's
          // progress. Both checks are needed: `active.has` alone can't tell an old
          // run's late tick apart from a new run that happens to own the same id.
          if (!this.active.has(site.id) || this.gen.get(site.id) !== myGen) return;
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
      // Issue #11: run the hook while isRunning() still reads true — its ~50ms git window
      // must not overlap a turn started the instant the ready emit lands. A hook failure
      // logs and the sync still lands as ready.
      if (this.opts.afterReady) {
        try {
          await this.opts.afterReady(site);
        } catch (err) {
          console.error('afterReady hook failed:', err);
        }
      }
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
