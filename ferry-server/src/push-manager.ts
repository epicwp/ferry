import { randomBytes } from 'node:crypto';
import { ROLLBACK_FAILED_PREFIX } from './push/types.js';
import type { ChangeSpec, PushOutcome, PushRunner, PushStep, StepEvent } from './push/types.js';
import type { Change, PushRun, Site, Store } from './store.js';

// Steps push() (ferry-cli/src/push.ts) emits BEFORE the single /commit call - if the runner
// throws having gotten no further than these, nothing was applied on the plugin side yet.
const PRE_COMMIT_STEPS = new Set<PushStep>(['staging', 'hashes']);

export interface PushWireEvent {
  seq: number;
  type: 'push_step' | 'push_done';
  payload: unknown;
}

type Listener = (e: PushWireEvent) => void;

export interface PushManagerOpts {
  specFor(change: Change): ChangeSpec;
}

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
    // Minted here (not inside the runner) and persisted before the push even starts, so a
    // server crash mid-push leaves a real txid on the row for boot recovery's /tx lookup
    // instead of NULL (which made the recoverOne 'dirty'/'staged' branch unreachable).
    const txid = randomBytes(16).toString('hex');
    this.store.setChangeStatus(change.id, 'pushing', { backupTxid: txid });
    const run = this.store.createPushRun(change.id, 'running');
    void this.execute(site, change, run, txid, opts);
  }

  private async execute(site: Site, change: Change, run: PushRun, txid: string, opts: { force?: boolean }): Promise<void> {
    try {
      const steps: StepEvent[] = [];
      const spec = this.opts.specFor(change);
      let outcome: PushOutcome;
      try {
        outcome = await this.runner.push(site.slug, spec, {
          headSha: change.headSha,
          force: opts.force,
          txid,
          onStep: (e) => {
            steps.push(e);
            this.store.updatePushRun(run.id, { steps: [...steps] });
            this.emit(site.id, 'push_step', e);
          },
        });
      } catch (err) {
        // The runner threw instead of resolving (e.g. FerryClient.postJson on a network
        // failure/non-200) - there is no PushOutcome to interpret. Whether anything was
        // actually applied depends on how far the steps got: nothing emitted yet, or only
        // pre-commit steps (staging/hashes), means the single /commit call was never reached
        // (or never returned) - safe to release the change back to draft. Anything past that
        // means /commit may have succeeded server-side before the response was lost - treat
        // as a conflict rather than silently discarding a possibly-applied write.
        const message = err instanceof Error ? err.message : String(err);
        const lastStep = steps.length > 0 ? steps[steps.length - 1]!.step : undefined;
        const pastCommit = lastStep !== undefined && !PRE_COMMIT_STEPS.has(lastStep);
        const now = new Date().toISOString();
        if (pastCommit) {
          this.store.setChangeStatus(change.id, 'conflict', {
            conflict: [{ key: 'push', expected: '', found: message }],
          });
        } else {
          this.store.setChangeStatus(change.id, 'draft');
        }
        this.store.updatePushRun(run.id, { status: 'error', logText: message, finishedAt: now });
        this.emit(site.id, 'push_done', { status: 'error', txid, detail: message });
        return;
      }
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
    if (this.isPushing(site.id)) throw new Error('busy');
    this.pushing.add(site.id);
    try {
      const result = await this.runner.rollback(site.slug, { txid: change.backupTxid!, ops: change.ops });
      if (result.ok) {
        this.store.setChangeStatus(change.id, 'rolled_back', { rolledBackAt: new Date().toISOString() });
      } else {
        this.store.setChangeStatus(change.id, 'conflict', { conflict: result.conflicts ?? [] });
      }
    } finally {
      this.pushing.delete(site.id);
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
      // Boot recovery is itself an in-flight write-back operation on this site (it may call
      // runner.rollback()) - hold the busy flag for its duration so a fresh push started before
      // recovery finishes can't race it (isPushing would otherwise read false the whole time).
      this.pushing.add(site.id);
      try {
        await this.recoverOne(site, change, row.backupTxid);
      } finally {
        this.pushing.delete(site.id);
      }
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
