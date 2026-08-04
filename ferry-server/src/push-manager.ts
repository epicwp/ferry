import type { ChangeSpec, PushOutcome, PushRunner, StepEvent } from './push/types.js';
import type { Change, PushRun, Site, Store } from './store.js';

export interface PushWireEvent {
  seq: number;
  type: 'push_step' | 'push_done';
  payload: unknown;
}

type Listener = (e: PushWireEvent) => void;

export interface PushManagerOpts {
  specFor(change: Change): ChangeSpec;
}

/** Detail prefix push.ts (ferry-cli) uses when smoke failed AND the automatic rollback it then
 *  attempts also failed - the one PushOutcome('error') case that must NOT read as a silent
 *  return-to-draft (nothing was applied there; here production may be left mid-write). */
const ROLLBACK_FAILED_PREFIX = 'smoke failed AND automatic rollback failed';

/**
 * Per-site push state machine (design §Write-back). Mirrors SyncManager's shape (active state
 * in memory, durable outcome in the store, synchronous busy-throw + fire-and-forget run) and
 * AgentManager's SSE fan-out (subscribe/emit, seq'd events for replay-then-live routes).
 */
export class PushManager {
  private pushing = new Set<number>();
  private listeners = new Map<number, Set<Listener>>();
  private buffers = new Map<number, PushWireEvent[]>();
  private seqCounters = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly runner: PushRunner,
    private readonly opts: PushManagerOpts,
  ) {}

  isPushing(siteId: number): boolean {
    return this.pushing.has(siteId);
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

  /** Buffered events (this run only) after `after` - the durable side of the SSE replay path
   *  the /push/events route uses, mirroring store.agentEventsAfter for the agent SSE route. */
  eventsAfter(siteId: number, after: number): PushWireEvent[] {
    return (this.buffers.get(siteId) ?? []).filter((e) => e.seq > after);
  }

  start(site: Site, change: Change, opts: { force?: boolean } = {}): void {
    if (this.isPushing(site.id)) throw new Error('busy');
    this.pushing.add(site.id);
    this.buffers.set(site.id, []);
    this.seqCounters.set(site.id, 0);
    this.store.setChangeStatus(change.id, 'pushing');
    const run = this.store.createPushRun(change.id, 'running');
    void this.execute(site, change, run, opts);
  }

  private async execute(site: Site, change: Change, run: PushRun, opts: { force?: boolean }): Promise<void> {
    try {
      const steps: StepEvent[] = [];
      const spec = this.opts.specFor(change);
      const outcome = await this.runner.push(site.slug, spec, {
        headSha: change.headSha,
        force: opts.force,
        onStep: (e) => {
          steps.push(e);
          this.store.updatePushRun(run.id, { steps: [...steps] });
          this.emit(site.id, 'push_step', e);
        },
      });
      this.finish(site, change, run, outcome);
    } finally {
      this.pushing.delete(site.id);
    }
  }

  private finish(site: Site, change: Change, run: PushRun, outcome: PushOutcome): void {
    const now = new Date().toISOString();
    switch (outcome.status) {
      case 'pushed':
        this.store.setChangeStatus(change.id, 'pushed', {
          backupTxid: outcome.txid, prodRef: outcome.txid.slice(0, 7), pushedAt: now,
        });
        break;
      case 'conflict':
        this.store.setChangeStatus(change.id, 'conflict', { conflict: outcome.conflicts });
        break;
      case 'rolled_back':
        // The real push() already ran the automatic rollback before this outcome reached us.
        this.store.setChangeStatus(change.id, 'rolled_back', { rolledBackAt: now });
        break;
      case 'error':
        if (outcome.detail.startsWith(ROLLBACK_FAILED_PREFIX)) {
          // Smoke failed AND the automatic rollback failed - nothing here is safe to assume;
          // surface loudly rather than silently returning to draft (decision: Task 11 ledger).
          this.store.setChangeStatus(change.id, 'conflict', {
            conflict: [{ key: 'rollback', expected: 'reverted', found: outcome.detail }],
          });
        } else {
          // apply_error or denied: nothing was applied - back to draft, detail lives on the push_run.
          this.store.setChangeStatus(change.id, 'draft');
        }
        break;
    }
    this.store.updatePushRun(run.id, {
      status: outcome.status, finishedAt: now,
      logText: outcome.status === 'error' ? outcome.detail : undefined,
    });
    this.emit(site.id, 'push_done', outcome);
  }

  /** Manual rollback route (pushed -> rolled_back only, guarded by the caller): inverts
   *  `change.ops` (the forward ops that were pushed) via the runner, same as push()'s own
   *  automatic rollback path. */
  async rollback(site: Site, change: Change): Promise<void> {
    const result = await this.runner.rollback(site.slug, { txid: change.backupTxid!, ops: change.ops });
    if (result.ok) {
      this.store.setChangeStatus(change.id, 'rolled_back', { rolledBackAt: new Date().toISOString() });
    } else {
      this.store.setChangeStatus(change.id, 'conflict', { conflict: result.conflicts ?? [] });
    }
  }

  /** Boot recovery: a change stuck at 'pushing' means the server died mid-push. Ask the plugin
   *  what actually happened to that transaction rather than guessing. */
  async recover(): Promise<void> {
    for (const row of this.store.recoverInterruptedPushes()) {
      const change = this.store.changeById(row.changeId);
      if (!change) continue;
      const site = this.store.siteById(change.siteId);
      if (!site) continue;
      await this.recoverOne(site, change, row.backupTxid);
    }
  }

  private async recoverOne(site: Site, change: Change, backupTxid: string | null): Promise<void> {
    const now = new Date().toISOString();
    if (!backupTxid) {
      // Died before a transaction id was even recorded - nothing to ask the plugin about.
      this.store.setChangeStatus(change.id, 'conflict', {
        conflict: [{ key: 'push', expected: '', found: 'interrupted before a transaction id was recorded — verify site state manually.' }],
      });
      return;
    }
    const status = await this.runner.txStatus(site.slug, backupTxid);
    if (status === 'committed') {
      console.log(`push recovered as pushed (change ${change.id}) — smoke status unknown after the restart, verify manually.`);
      this.store.setChangeStatus(change.id, 'pushed', {
        backupTxid, prodRef: backupTxid.slice(0, 7), pushedAt: now,
      });
      return;
    }
    if (status === 'rolled_back') {
      this.store.setChangeStatus(change.id, 'rolled_back', { rolledBackAt: now });
      return;
    }
    if (status === 'dirty' || status === 'staged') {
      const rb = await this.runner.rollback(site.slug, { txid: backupTxid, ops: change.ops });
      if (rb.ok) {
        this.store.setChangeStatus(change.id, 'rolled_back', { rolledBackAt: now });
      } else {
        this.store.setChangeStatus(change.id, 'conflict', { conflict: rb.conflicts ?? [] });
      }
      return;
    }
    // 'unknown'
    this.store.setChangeStatus(change.id, 'conflict', {
      conflict: [{ key: 'push', expected: '', found: 'transaction status unknown after restart — verify site state manually.' }],
    });
  }

  private emit(siteId: number, type: 'push_step' | 'push_done', payload: unknown): void {
    const seq = (this.seqCounters.get(siteId) ?? 0) + 1;
    this.seqCounters.set(siteId, seq);
    const event: PushWireEvent = { seq, type, payload };
    this.buffers.get(siteId)?.push(event);
    for (const fn of this.listeners.get(siteId) ?? []) {
      try {
        fn(event);
      } catch (err) {
        console.error('push SSE listener error:', err);
      }
    }
  }
}
