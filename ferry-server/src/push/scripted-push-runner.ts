import { randomBytes } from 'node:crypto';
import type { Conflict, PushStep } from '../../../ferry-cli/src/push-types.js';
import type { PushRunner } from './types.js';

const STEPS: PushStep[] = ['staging', 'hashes', 'drift', 'swap', 'journal', 'smoke'];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic PushRunner for tests and the dashboard e2e server: every push() walks the
 *  same 6-step start/ok sequence as the real push() (ferry-cli/src/push.ts), on short timers,
 *  mirroring scripted-runner.ts's shape. `script.conflictOn` short-circuits at that step into a
 *  conflict outcome instead of continuing; `script.smokeFails` runs every step clean but fails
 *  the smoke check, yielding a rolled_back outcome (the real push() already auto-rolls-back). */
export function scriptedPushRunner(script: { conflictOn?: PushStep; smokeFails?: boolean } = {}): PushRunner {
  return {
    async push(_slug, _spec, opts) {
      const txid = opts.txid ?? randomBytes(16).toString('hex');
      for (const step of STEPS) {
        // Faithful to push.ts:124: the real runner emits an extra 'drift' start immediately
        // before the single /commit call (crash classification) — consumers see two starts.
        if (step === 'drift') opts.onStep({ step: 'drift', status: 'start' });
        opts.onStep({ step, status: 'start' });
        await wait(5);
        const conflict = script.conflictOn === step;
        const smokeFail = step === 'smoke' && !!script.smokeFails;
        opts.onStep({ step, status: conflict || smokeFail ? 'fail' : 'ok' });
        await wait(5);
        if (conflict) {
          const conflicts: Conflict[] = [{ key: `${step}-drift`, expected: 'expected-value', found: 'found-value' }];
          return { status: 'conflict', txid, conflicts };
        }
        if (smokeFail) {
          return {
            status: 'rolled_back',
            txid,
            reason: 'smoke_failed',
            smoke: [{ label: 'home', ok: false, detail: '500 · unexpected body' }],
          };
        }
      }
      return { status: 'pushed', txid, smoke: [{ label: 'home', ok: true, detail: '200 OK' }] };
    },
    async rollback() {
      return { ok: true };
    },
    async txStatus() {
      return 'unknown';
    },
  };
}
