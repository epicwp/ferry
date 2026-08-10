import { describe, expect, it } from 'vitest';
import { ROLLBACK_FAILED_PREFIX } from '../src/push/types.js';
import type { ChangeSpec, Conflict, PushOutcome, PushRunner, StepEvent } from '../src/push/types.js';
import { scriptedPushRunner } from '../src/push/scripted-push-runner.js';
import type { PushWireEvent } from '../src/push-manager.js';
import { PushManager } from '../src/push-manager.js';
import type { Change, Site } from '../src/store.js';
import { Store } from '../src/store.js';

const FIELDS = {
  title: 'Fix VAT calc', summary: 'VAT was computed pre-discount.', branch: 'agent/work',
  baseSha: 'aaa', headSha: 'bbb', diffText: '--- a\n+++ b\n',
  files: [], ops: [{ kind: 'option_set' as const, name: 'blogname', old: 'A', new: 'B' }],
  preconditions: [], smoke: [{ label: 'home', path: '/', expectStatus: 200 }],
};

function specFor(change: Change): ChangeSpec {
  return { files: change.files, ops: change.ops, preconditions: change.preconditions, smoke: change.smoke };
}

function setup(runner: PushRunner) {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  const change = store.createChange(site.id, FIELDS);
  const manager = new PushManager(store, runner, { specFor });
  return { store, site, change, manager };
}

async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Minimal PushRunner literal for scenarios scriptedPushRunner can't script (raw 'error'
 *  outcomes, controllable txStatus/rollback for recover()). */
function fakeRunner(over: Partial<PushRunner>): PushRunner {
  return {
    push: async () => { throw new Error('not stubbed'); },
    rollback: async () => ({ ok: true }),
    txStatus: async () => 'unknown',
    ...over,
  };
}

describe('PushManager', () => {
  it('runs a happy push: 6 ok steps persisted, subscribers get push_step x N then push_done, status pushed', async () => {
    const { store, site, change, manager } = setup(scriptedPushRunner());
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    expect(manager.isPushing(site.id)).toBe(true);
    await until(() => seen.some((e) => e.type === 'push_done'));
    expect(manager.isPushing(site.id)).toBe(false);

    const okSteps = seen.filter((e) => e.type === 'push_step' && (e.payload as { status: string }).status === 'ok');
    expect(okSteps).toHaveLength(6);
    expect(seen.at(-1)!.type).toBe('push_done');
    // seq is contiguous, no gaps/duplicates
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));

    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('pushed');
    expect(stored.backupTxid).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.prodRef).toBe(stored.backupTxid!.slice(0, 7));
    expect(stored.pushedAt).not.toBeNull();
  });

  it('a conflict script yields status conflict with conflict_json', async () => {
    const { store, site, change, manager } = setup(scriptedPushRunner({ conflictOn: 'drift' }));
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));

    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('conflict');
    expect(stored.conflict).toEqual([{ key: 'drift-drift', expected: 'expected-value', found: 'found-value' }]);
  });

  it('a drift conflict emits only the marker start, no regular start or fail (faithful to push.ts)', async () => {
    const { site, change, manager } = setup(scriptedPushRunner({ conflictOn: 'drift' }));
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));

    const driftEvents = seen
      .filter((e) => e.type === 'push_step')
      .map((e) => e.payload as StepEvent)
      .filter((p) => p.step === 'drift');
    // Exactly one start event (the crash-marker), no fail (conflict returned early)
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0]).toEqual({ step: 'drift', status: 'start' });
  });

  it('a smokeFails script yields status rolled_back (the real push() already auto-rolled-back)', async () => {
    const { store, site, change, manager } = setup(scriptedPushRunner({ smokeFails: true }));
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));

    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('rolled_back');
    expect(stored.rolledBackAt).not.toBeNull();
  });

  it('persists the smoke results on a pushed change', async () => {
    const { store, site, change, manager } = setup(scriptedPushRunner());
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));

    const after = store.changeById(change.id)!;
    expect(after.smokeResult).toEqual([{ label: 'home', ok: true, detail: '200 OK' }]);
  });

  it('persists smoke results on a smoke-failed rollback', async () => {
    const { store, site, change, manager } = setup(scriptedPushRunner({ smokeFails: true }));
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));

    const after = store.changeById(change.id)!;
    expect(after.status).toBe('rolled_back');
    expect(after.smokeResult).toEqual([{ label: 'home', ok: false, detail: '500 · unexpected body' }]);
  });

  it('throws busy when a push is already running for the site', () => {
    const { site, change, manager } = setup(scriptedPushRunner());
    manager.start(site, change, {});
    expect(() => manager.start(site, change, {})).toThrow('busy');
  });

  // ---- final-review fix 3: the txid is minted and persisted before the runner is invoked ----

  it('persists a real backupTxid on the change row while pushing, before the runner resolves', () => {
    const { store, site, change, manager } = setup(scriptedPushRunner());
    manager.start(site, change, {});
    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('pushing');
    expect(stored.backupTxid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('recover() finds the real txid persisted by start() and takes the txStatus branch', async () => {
    // Simulate a crash mid-push: start() persists backupTxid synchronously, then the runner
    // hangs forever (as if the process died before push() ever resolved). A fresh PushManager
    // (a server restart) must recover using the txid that was actually persisted, not a
    // hand-set test fixture.
    const store = new Store(':memory:');
    const user = store.createUser('a@example.com', 'h')!;
    const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
    const change = store.createChange(site.id, FIELDS);
    const crashedManager = new PushManager(store, fakeRunner({ push: () => new Promise(() => {}) }), { specFor });
    crashedManager.start(site, change, {});
    const persistedTxid = store.changeBySeq(site.id, change.seq)!.backupTxid!;
    expect(persistedTxid).toMatch(/^[0-9a-f]{32}$/);

    let txStatusCalledWith: string | undefined;
    const freshManager = new PushManager(store, fakeRunner({
      txStatus: async (_slug, txid) => { txStatusCalledWith = txid; return 'committed'; },
    }), { specFor });
    await freshManager.recover();

    expect(txStatusCalledWith).toBe(persistedTxid);
    expect(store.changeBySeq(site.id, change.seq)!.status).toBe('pushed');
  });

  // ---- final-review fix 2: a throw from runner.push() is caught, not an unhandled rejection ----

  it('a runner that throws before the commit call releases the change back to draft', async () => {
    const { store, site, change, manager } = setup(fakeRunner({
      push: async (_s, _spec, opts) => {
        opts.onStep({ step: 'staging', status: 'start' });
        opts.onStep({ step: 'staging', status: 'ok' });
        opts.onStep({ step: 'hashes', status: 'start' });
        opts.onStep({ step: 'hashes', status: 'ok' });
        throw new Error('network down');
      },
    }));
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));

    expect(store.changeBySeq(site.id, change.seq)!.status).toBe('draft');
    const pushDone = seen.find((e) => e.type === 'push_done')!;
    expect((pushDone.payload as { status: string; detail: string }).status).toBe('error');
    expect((pushDone.payload as { status: string; detail: string }).detail).toBe('network down');
    expect(manager.isPushing(site.id)).toBe(false);
  });

  it('a runner that throws after the commit step surfaces as conflict, not draft', async () => {
    const { store, site, change, manager } = setup(fakeRunner({
      push: async (_s, _spec, opts) => {
        opts.onStep({ step: 'staging', status: 'ok' });
        opts.onStep({ step: 'hashes', status: 'ok' });
        opts.onStep({ step: 'drift', status: 'ok' });
        throw new Error('lost connection after commit');
      },
    }));
    manager.start(site, change, {});
    await until(() => store.changeBySeq(site.id, change.seq)!.status !== 'pushing');
    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('conflict');
    expect(stored.conflict).toEqual([{ key: 'push', expected: '', found: 'lost connection after commit' }]);
  });

  // ---- final-fix-wave 2: a throw during /commit (lost response) must not read back as draft ----

  it('a runner that throws right after drift:start (lost /commit response) surfaces as conflict, not draft', async () => {
    const { store, site, change, manager } = setup(fakeRunner({
      push: async (_s, _spec, opts) => {
        opts.onStep({ step: 'staging', status: 'ok' });
        opts.onStep({ step: 'hashes', status: 'ok' });
        opts.onStep({ step: 'drift', status: 'start' });
        throw new Error('lost /commit response');
      },
    }));
    manager.start(site, change, {});
    await until(() => store.changeBySeq(site.id, change.seq)!.status !== 'pushing');
    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('conflict');
    expect(stored.conflict).toEqual([{ key: 'push', expected: '', found: 'lost /commit response' }]);
  });

  it('does not produce an unhandled rejection when the runner throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { manager, site, change } = setup(fakeRunner({ push: async () => { throw new Error('boom'); } }));
      manager.start(site, change, {});
      await until(() => !manager.isPushing(site.id));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // ---- final-review fix 4: manual rollback holds the busy flag for its duration ----

  it('manual rollback holds the busy flag - a concurrent push start throws busy', async () => {
    let releaseRollback: (v: { ok: boolean }) => void = () => undefined;
    const { store, site, change, manager } = setup(fakeRunner({
      rollback: () => new Promise((resolve) => { releaseRollback = resolve; }),
    }));
    store.setChangeStatus(change.id, 'pushed', { backupTxid: 'txabc', pushedAt: new Date().toISOString() });
    const pushed = store.changeBySeq(site.id, change.seq)!;

    expect(manager.isPushing(site.id)).toBe(false);
    const rollbackPromise = manager.rollback(site, pushed);
    await new Promise((r) => setImmediate(r));
    expect(manager.isPushing(site.id)).toBe(true);
    expect(() => manager.start(site, pushed, {})).toThrow('busy');

    releaseRollback({ ok: true });
    await rollbackPromise;
    expect(manager.isPushing(site.id)).toBe(false);
    expect(store.changeBySeq(site.id, change.seq)!.status).toBe('rolled_back');
  });

  it('an apply_error/denied error outcome returns the change to draft, detail on the push_run', async () => {
    const outcome: PushOutcome = { status: 'error', txid: 'tx1', detail: 'apply_error at wp_options.blogname: locked' };
    const { store, site, change, manager } = setup(fakeRunner({ push: async (_s, _spec, opts) => { opts.onStep({ step: 'staging', status: 'start' }); return outcome; } }));
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));
    expect(store.changeBySeq(site.id, change.seq)!.status).toBe('draft');
  });

  it('a failed-auto-rollback error outcome surfaces loudly as conflict, not draft', async () => {
    // Built from the constant ferry-cli's push() actually uses (push-types.ts), not a
    // hand-copied literal - a wording drift between the two workspaces must fail this test.
    const detail = `${ROLLBACK_FAILED_PREFIX}: wp_options.blogname`;
    const outcome: PushOutcome = { status: 'error', txid: 'tx2', detail };
    const { store, site, change, manager } = setup(fakeRunner({ push: async (_s, _spec, opts) => { opts.onStep({ step: 'smoke', status: 'start' }); return outcome; } }));
    const seen: PushWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    manager.start(site, change, {});
    await until(() => seen.some((e) => e.type === 'push_done'));
    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('conflict');
    expect(stored.conflict).toEqual([{ key: 'rollback', expected: 'reverted', found: detail }]);
  });

  it('manual rollback(): success moves pushed -> rolled_back', async () => {
    const { store, site, change, manager } = setup(fakeRunner({ rollback: async () => ({ ok: true }) }));
    store.setChangeStatus(change.id, 'pushed', { backupTxid: 'txabc', pushedAt: new Date().toISOString() });
    const pushed = store.changeBySeq(site.id, change.seq)!;
    await manager.rollback(site, pushed);
    const stored = store.changeBySeq(site.id, change.seq)!;
    expect(stored.status).toBe('rolled_back');
    expect(stored.rolledBackAt).not.toBeNull();
  });

  it('manual rollback(): failure moves to conflict with the runner conflicts', async () => {
    const conflicts: Conflict[] = [{ key: 'wp_options.blogname', expected: 'B', found: 'C' }];
    const { store, site, change, manager } = setup(fakeRunner({ rollback: async () => ({ ok: false, conflicts }) }));
    store.setChangeStatus(change.id, 'pushed', { backupTxid: 'txabc', pushedAt: new Date().toISOString() });
    const pushed = store.changeBySeq(site.id, change.seq)!;
    await manager.rollback(site, pushed);
    expect(store.changeBySeq(site.id, change.seq)!.conflict).toEqual(conflicts);
  });

  describe('recover()', () => {
    function interrupted(store: Store, site: Site) {
      const change = store.createChange(site.id, FIELDS);
      store.setChangeStatus(change.id, 'pushing', { backupTxid: 'tx-interrupted' });
      return change;
    }

    it('committed -> pushed (smoke unknown)', async () => {
      const { store, site } = setup(scriptedPushRunner());
      const change = interrupted(store, site);
      const manager = new PushManager(store, fakeRunner({ txStatus: async () => 'committed' }), { specFor });
      await manager.recover();
      const stored = store.changeBySeq(site.id, change.seq)!;
      expect(stored.status).toBe('pushed');
      expect(stored.backupTxid).toBe('tx-interrupted');
      expect(stored.pushedAt).not.toBeNull();
    });

    it('marks the site as pushing for the duration of recovery, so a fresh push during it is busy', async () => {
      const { store, site } = setup(scriptedPushRunner());
      interrupted(store, site); // seeds a change stuck at 'pushing'
      const otherDraft = store.createChange(site.id, FIELDS);
      let releaseTxStatus: (status: 'committed') => void = () => undefined;
      const slowManager = new PushManager(store, fakeRunner({
        txStatus: () => new Promise((resolve) => { releaseTxStatus = resolve; }),
      }), { specFor });

      expect(slowManager.isPushing(site.id)).toBe(false);
      const recovering = slowManager.recover();
      await new Promise((r) => setImmediate(r)); // let recover() reach the pending txStatus call
      expect(slowManager.isPushing(site.id)).toBe(true);
      expect(() => slowManager.start(site, otherDraft, {})).toThrow('busy');

      releaseTxStatus('committed');
      await recovering;
      expect(slowManager.isPushing(site.id)).toBe(false);
    });

    it('dirty -> rollback called, ok -> rolled_back', async () => {
      const { store, site } = setup(scriptedPushRunner());
      const change = interrupted(store, site);
      const rollbackCalls: unknown[] = [];
      const manager = new PushManager(store, fakeRunner({
        txStatus: async () => 'dirty',
        rollback: async (slug, opts) => { rollbackCalls.push({ slug, opts }); return { ok: true }; },
      }), { specFor });
      await manager.recover();
      expect(rollbackCalls).toHaveLength(1);
      expect(store.changeBySeq(site.id, change.seq)!.status).toBe('rolled_back');
    });

    it('staged -> rollback called, ok -> rolled_back', async () => {
      const { store, site } = setup(scriptedPushRunner());
      const change = interrupted(store, site);
      const manager = new PushManager(store, fakeRunner({ txStatus: async () => 'staged', rollback: async () => ({ ok: true }) }), { specFor });
      await manager.recover();
      expect(store.changeBySeq(site.id, change.seq)!.status).toBe('rolled_back');
    });

    it('dirty + a failing rollback -> conflict', async () => {
      const { store, site } = setup(scriptedPushRunner());
      const change = interrupted(store, site);
      const conflicts: Conflict[] = [{ key: 'k', expected: 'e', found: 'f' }];
      const manager = new PushManager(store, fakeRunner({ txStatus: async () => 'dirty', rollback: async () => ({ ok: false, conflicts }) }), { specFor });
      await manager.recover();
      const stored = store.changeBySeq(site.id, change.seq)!;
      expect(stored.status).toBe('conflict');
      expect(stored.conflict).toEqual(conflicts);
    });

    it('rolled_back -> rolled_back (no rollback call needed)', async () => {
      const { store, site } = setup(scriptedPushRunner());
      const change = interrupted(store, site);
      const rollbackCalls: unknown[] = [];
      const manager = new PushManager(store, fakeRunner({
        txStatus: async () => 'rolled_back',
        rollback: async (...args) => { rollbackCalls.push(args); return { ok: true }; },
      }), { specFor });
      await manager.recover();
      expect(rollbackCalls).toHaveLength(0);
      expect(store.changeBySeq(site.id, change.seq)!.status).toBe('rolled_back');
    });

    it('unknown -> conflict', async () => {
      const { store, site } = setup(scriptedPushRunner());
      const change = interrupted(store, site);
      const manager = new PushManager(store, fakeRunner({ txStatus: async () => 'unknown' }), { specFor });
      await manager.recover();
      expect(store.changeBySeq(site.id, change.seq)!.status).toBe('conflict');
    });

    it('no backupTxid recorded -> conflict, without calling the runner', async () => {
      const { store, site } = setup(scriptedPushRunner());
      const change = store.createChange(site.id, FIELDS);
      store.setChangeStatus(change.id, 'pushing'); // crashed before a txid was ever recorded
      let txStatusCalled = false;
      const manager = new PushManager(store, fakeRunner({ txStatus: async () => { txStatusCalled = true; return 'unknown'; } }), { specFor });
      await manager.recover();
      expect(txStatusCalled).toBe(false);
      expect(store.changeBySeq(site.id, change.seq)!.status).toBe('conflict');
    });

    it('no-ops when there is nothing interrupted', async () => {
      const { store, site, manager } = setup(scriptedPushRunner());
      const before = store.changesFor(site.id).map((c) => c.status);
      await manager.recover();
      expect(store.changesFor(site.id).map((c) => c.status)).toEqual(before);
    });
  });
});
