export type DbOp =
  | { kind: 'option_set'; name: string; old: string | null; new: string }      // old null = absent before
  | { kind: 'option_delete'; name: string; old: string }
  | { kind: 'postmeta_set'; postId: number; key: string; old: string | null; new: string }
  | { kind: 'postmeta_delete'; postId: number; key: string; old: string }
  | { kind: 'row_update'; table: string; pkCol: string; pk: number; old: Record<string, string | null>; new: Record<string, string | null> }
  | { kind: 'row_insert'; table: string; pkCol: string; pk: number; new: Record<string, string | null> }
  | { kind: 'row_delete'; table: string; pkCol: string; pk: number; old: Record<string, string | null> };
export type RiskClass = 'low' | 'higher' | 'refused';
export type Precondition =
  | { type: 'option'; name: string; expected: string | null }
  | { type: 'file_hash'; path: string; expected: string }                       // sha256 hex
  | { type: 'row'; table: string; pkCol: string; pk: number; column: string; expected: string | null };
export interface SmokeCheck { label: string; path: string; expectStatus: number; expectText?: string }
export interface ChangeFile { path: string; newHash: string | null; oldHash: string | null } // newHash null = delete; oldHash null = new file
export interface ChangeSpec { files: ChangeFile[]; ops: DbOp[]; preconditions: Precondition[]; smoke: SmokeCheck[] }
export type PushStep = 'staging' | 'hashes' | 'drift' | 'swap' | 'journal' | 'smoke';
export interface StepEvent { step: PushStep; status: 'start' | 'ok' | 'fail'; detail?: string; durationMs?: number }
export interface Conflict { key: string; expected: string; found: string }
/** Detail prefix for the one PushOutcome('error') case where smoke failed AND the automatic
 *  rollback push() then attempted also failed - nothing here is safe to assume (production may
 *  be left mid-write). ferry-server's PushManager string-matches this exact prefix to decide
 *  draft (safe, nothing applied) vs conflict (surface loudly); shared here so the two workspaces
 *  can't drift apart on the wording. */
export const ROLLBACK_FAILED_PREFIX = 'smoke failed AND automatic rollback failed';
export type PushOutcome =
  | { status: 'pushed'; txid: string; smoke: { label: string; ok: boolean; detail: string }[] }
  | { status: 'conflict'; txid: string; conflicts: Conflict[] }
  | { status: 'rolled_back'; txid: string; reason: string; smoke?: { label: string; ok: boolean; detail: string }[] }
  // Controller decision (Task 11): /commit's `apply_error` (locks held, a statement failed, plugin
  // reverted everything) or `denied` (malformed/hostile change) - neither is a drift conflict, and
  // nothing was applied. Task 13 maps this back to draft with `detail` recorded.
  | { status: 'error'; txid: string; detail: string };
