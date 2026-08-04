import type { ChangeSpec, Conflict, DbOp, PushOutcome, StepEvent } from '../../../ferry-cli/src/push-types.js';

export type { ChangeSpec, Conflict, DbOp, PushOutcome, PushStep, StepEvent } from '../../../ferry-cli/src/push-types.js';

/** Server-side seam over ferry-cli's push()/rollback() (spec §8) — lets PushManager drive a
 *  real production write-back or a scripted fake without knowing which. */
export interface PushRunner {
  push(
    slug: string,
    spec: ChangeSpec,
    opts: { headSha: string; force?: boolean; onStep: (e: StepEvent) => void },
  ): Promise<PushOutcome>;
  rollback(slug: string, opts: { txid: string; ops: DbOp[] }): Promise<{ ok: boolean; conflicts?: Conflict[] }>;
  txStatus(slug: string, txid: string): Promise<'committed' | 'dirty' | 'staged' | 'rolled_back' | 'unknown'>;
}
