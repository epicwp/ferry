import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { request } from 'undici';
import { FerryClient } from './client.js';
import { loadProfile } from './profile.js';
import type { ChangeFile, ChangeSpec, Conflict, DbOp, PushOutcome, PushStep, SmokeCheck, StepEvent } from './push-types.js';

/** ~2MB of base64 payload per /stage call (spec §8). */
const STAGE_BATCH_MAX_B64 = 2 * 1024 * 1024;

interface CommitStep { name: string; ok: boolean; durationMs: number }
interface CommitResponse {
  committed: boolean;
  steps: CommitStep[];
  conflicts: Conflict[];
  apply_error?: { key: string; detail: string };
  denied?: { path: string; code: string }[];
}

export interface PushOpts {
  headSha: string;
  onStep?: (e: StepEvent) => void;
  force?: boolean;
  client?: FerryClient;
  blobFor?: (path: string) => Promise<Buffer>;
}

const execFileP = promisify(execFile);

/** Reads the exact committed bytes for `path` at `headSha` - bypasses `runGit` (git.ts), which
 *  string-decodes and `.trim()`s stdout, corrupting trailing-newline text files and mangling
 *  binary blobs via UTF-8 replacement. */
export function defaultBlobFor(clonePath: string, headSha: string): (path: string) => Promise<Buffer> {
  return async (path: string) => {
    const { stdout } = await execFileP('git', ['show', `${headSha}:${path}`], {
      cwd: clonePath,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  };
}

/** Groups items into batches whose accumulated `size` stays under `maxBytes` - a lone
 *  oversized item simply gets its own batch (there is no chunked /stage). */
function batchBySize<T>(items: T[], size: (item: T) => number, maxBytes: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const s = size(item);
    if (bytes + s > maxBytes && current.length > 0) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += s;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function findStep(steps: CommitStep[], name: string): CommitStep | undefined {
  return steps.find((s) => s.name === name);
}

/** §8: the write-back sequence - stage, one /commit call (hashes/drift/backup/swap/journal, all
 *  server-side), a smoke test, and an automatic rollback if smoke fails. */
export async function push(slug: string, spec: ChangeSpec, opts: PushOpts): Promise<PushOutcome> {
  const profile = loadProfile(slug);
  let client = opts.client;
  if (!client) {
    client = new FerryClient(profile.url, profile.secret);
    await client.syncClock();
  }
  const blobFor = opts.blobFor ?? defaultBlobFor(profile.clonePath, opts.headSha);
  const onStep = opts.onStep ?? (() => {});
  const txid = randomBytes(16).toString('hex');

  // staging: batch every non-delete file's blob (~2MB base64 per call).
  onStep({ step: 'staging', status: 'start' });
  const nonDelete = spec.files.filter((f) => f.newHash !== null);
  const encoded = await Promise.all(
    nonDelete.map(async (f) => ({ path: f.path, hash: f.newHash as string, data_b64: (await blobFor(f.path)).toString('base64') })),
  );
  const batches = batchBySize(encoded, (e) => e.data_b64.length, STAGE_BATCH_MAX_B64);
  const staged = new Set<string>();
  const rejected: { path: string; code: string }[] = [];
  for (const batch of batches) {
    const res = await client.postJson('/ferry/v1/stage', {
      txid,
      files: batch.map(({ path, hash, data_b64 }) => ({ path, hash, data_b64 })),
    });
    for (const p of res.data.staged ?? []) staged.add(p);
    for (const r of res.data.rejected ?? []) rejected.push(r);
  }
  onStep({ step: 'staging', status: 'ok' });

  // hashes: every non-delete path must have staged cleanly - anything else means nothing gets
  // applied (a malformed/refused file, not a drift conflict).
  onStep({ step: 'hashes', status: 'start' });
  const missing = nonDelete.filter((f) => !staged.has(f.path));
  if (missing.length > 0) {
    const detail = rejected.length > 0
      ? `rejected: ${rejected.map((r) => `${r.path} (${r.code})`).join(', ')}`
      : `not staged: ${missing.map((f) => f.path).join(', ')}`;
    onStep({ step: 'hashes', status: 'fail', detail });
    return { status: 'error', txid, detail };
  }
  onStep({ step: 'hashes', status: 'ok' });

  // one /commit call: hashes/drift/backup/swap/journal all run server-side.
  const commitRes = await client.postJson('/ferry/v1/commit', {
    txid,
    files: spec.files.map((f: ChangeFile) => ({ path: f.path, new_hash: f.newHash, old_hash: f.oldHash })),
    ops: spec.ops,
    preconditions: spec.preconditions,
    force: !!opts.force,
  });
  const c = commitRes.data as CommitResponse;

  if (c.denied && c.denied.length > 0) {
    return { status: 'error', txid, detail: `denied: ${c.denied.map((d) => `${d.path} (${d.code})`).join(', ')}` };
  }
  if (c.apply_error) {
    return { status: 'error', txid, detail: `apply_error at ${c.apply_error.key}: ${c.apply_error.detail}` };
  }
  if (!c.committed) {
    return { status: 'conflict', txid, conflicts: c.conflicts ?? [] };
  }

  // re-emit the plugin's per-step results: its own 'hashes' step folds into ours above;
  // backup+swap fold into a single 'swap' StepEvent (durations summed).
  const drift = findStep(c.steps, 'drift');
  emitCommitStep(onStep, 'drift', drift?.ok !== false, drift?.durationMs);
  const backup = findStep(c.steps, 'backup');
  const swap = findStep(c.steps, 'swap');
  emitCommitStep(onStep, 'swap', backup?.ok !== false && swap?.ok !== false, (backup?.durationMs ?? 0) + (swap?.durationMs ?? 0));
  const journal = findStep(c.steps, 'journal');
  emitCommitStep(onStep, 'journal', journal?.ok !== false, journal?.durationMs);

  // smoke: any failing check triggers an automatic rollback.
  onStep({ step: 'smoke', status: 'start' });
  const smoke = await runSmoke(profile.url, spec.smoke);
  const smokeOk = smoke.every((s) => s.ok);
  onStep({ step: 'smoke', status: smokeOk ? 'ok' : 'fail' });

  if (!smokeOk) {
    const rb = await rollback(slug, { txid, ops: spec.ops, client });
    if (!rb.ok) {
      const conflictKeys = (rb.conflicts ?? []).map((c) => c.key).join(', ');
      return { status: 'error', txid, detail: `smoke failed AND automatic rollback failed: ${conflictKeys}` };
    }
    return { status: 'rolled_back', txid, reason: 'smoke_failed', smoke };
  }
  return { status: 'pushed', txid, smoke };
}

function emitCommitStep(onStep: (e: StepEvent) => void, step: PushStep, ok: boolean, durationMs?: number): void {
  onStep({ step, status: 'start' });
  onStep({ step, status: ok ? 'ok' : 'fail', durationMs });
}

/** Inverts ops locally and POSTs /rollback - `ops` are the FORWARD ops that were pushed. */
export async function rollback(
  slug: string,
  opts: { txid: string; ops: DbOp[]; client?: FerryClient },
): Promise<{ ok: boolean; conflicts?: Conflict[] }> {
  let client = opts.client;
  if (!client) {
    const profile = loadProfile(slug);
    client = new FerryClient(profile.url, profile.secret);
    await client.syncClock();
  }
  const res = await client.postJson('/ferry/v1/rollback', { txid: opts.txid, ops: opts.ops.map(invertOp) });
  return { ok: res.data.rolled_back, conflicts: res.data.conflicts };
}

/** set↔set with old/new swapped (absent-marker aware); insert↔delete. */
export function invertOp(op: DbOp): DbOp {
  switch (op.kind) {
    case 'option_set':
      return op.old === null
        ? { kind: 'option_delete', name: op.name, old: op.new }
        : { kind: 'option_set', name: op.name, old: op.new, new: op.old };
    case 'option_delete':
      return { kind: 'option_set', name: op.name, old: null, new: op.old };
    case 'postmeta_set':
      return op.old === null
        ? { kind: 'postmeta_delete', postId: op.postId, key: op.key, old: op.new }
        : { kind: 'postmeta_set', postId: op.postId, key: op.key, old: op.new, new: op.old };
    case 'postmeta_delete':
      return { kind: 'postmeta_set', postId: op.postId, key: op.key, old: null, new: op.old };
    case 'row_update':
      return { kind: 'row_update', table: op.table, pkCol: op.pkCol, pk: op.pk, old: op.new, new: op.old };
    case 'row_insert':
      return { kind: 'row_delete', table: op.table, pkCol: op.pkCol, pk: op.pk, old: op.new };
    case 'row_delete':
      return { kind: 'row_insert', table: op.table, pkCol: op.pkCol, pk: op.pk, new: op.old };
  }
}

/** One undici GET per check; ok = status matches and (no expectText or body includes it). */
export async function runSmoke(baseUrl: string, checks: SmokeCheck[]): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const results: { label: string; ok: boolean; detail: string }[] = [];
  for (const check of checks) {
    const t0 = Date.now();
    try {
      const res = await request(new URL(check.path, baseUrl));
      const body = await res.body.text();
      const ms = Date.now() - t0;
      const ok = res.statusCode === check.expectStatus && (!check.expectText || body.includes(check.expectText));
      results.push({
        label: check.label,
        ok,
        detail: ok ? `${res.statusCode} · ${ms}ms` : `${res.statusCode} · ${ms}ms · ${body.slice(0, 80)}`,
      });
    } catch (err) {
      results.push({ label: check.label, ok: false, detail: `error: ${(err as Error).message}` });
    }
  }
  return results;
}
