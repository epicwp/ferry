import type { ChangeSpec, Conflict, DbOp, PushOutcome, StepEvent } from '../../../ferry-cli/src/push-types.js';

export type { ChangeSpec, Conflict, DbOp, PushOutcome, PushStep, SmokeResult, StepEvent } from '../../../ferry-cli/src/push-types.js';
// Value (not type-only) re-export: PushManager string-matches this exact prefix, so it must
// come from the same source ferry-cli's push() builds it from, not a hand-copied literal.
export { ROLLBACK_FAILED_PREFIX } from '../../../ferry-cli/src/push-types.js';

/** Server-side seam over ferry-cli's push()/rollback() (spec §8) — lets PushManager drive a
 *  real production write-back or a scripted fake without knowing which. */
export interface PushRunner {
  push(
    slug: string,
    spec: ChangeSpec,
    opts: { headSha: string; force?: boolean; txid?: string; onStep: (e: StepEvent) => void },
  ): Promise<PushOutcome>;
  rollback(slug: string, opts: { txid: string; ops: DbOp[] }): Promise<{ ok: boolean; conflicts?: Conflict[] }>;
  txStatus(slug: string, txid: string): Promise<'committed' | 'dirty' | 'staged' | 'rolled_back' | 'unknown'>;
  /** Targeted drift preview (plugin POST /ferry/v1/hashes): current sha256 per path, null when
   *  the path doesn't resolve. Optional — hand-rolled test fakes may omit it. */
  hashes?(slug: string, paths: string[]): Promise<Record<string, string | null>>;
}
