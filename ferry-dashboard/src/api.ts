export type SiteStatus = 'new' | 'paired' | 'syncing' | 'ready' | 'error' | 'refused_multisite';

export interface Site {
  id: number;
  name: string;
  url: string;
  slug: string;
  status: SiteStatus;
  lastError: string | null;
  lastSyncAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** Mirror of ferry-server's SyncState — every SSE message is this full shape. */
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

export interface TestResult { wp: string; php: string; db: string; server: string }

export interface AgentWireEvent { seq?: number; type: string; payload: Record<string, unknown> }
export interface AgentContext {
  branch: string; baseCommit: string; shortstat: string;
  files: { status: string; path: string }[];
  environment: { wp?: string; php?: string; db?: string; webServer?: string };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json: { error?: string } | null = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(json?.error ?? `Request failed (${res.status})`, res.status);
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
};

export const agentHistory = (siteId: number, after = 0) =>
  call<{ sessionId: number | null; events: AgentWireEvent[] }>('GET', `/api/sites/${siteId}/agent/history?after=${after}`);
export const agentSend = (siteId: number, text: string) =>
  call<{ queued: boolean }>('POST', `/api/sites/${siteId}/agent/messages`, { text });
export const agentNewSession = (siteId: number) =>
  call<{ created: boolean }>('POST', `/api/sites/${siteId}/agent/sessions`);
export const agentContext = (siteId: number) =>
  call<AgentContext>('GET', `/api/sites/${siteId}/agent/context`);

export type ChangeStatus = 'draft' | 'pushing' | 'pushed' | 'conflict' | 'rolled_back' | 'discarded';

export type DbOp =
  | { kind: 'option_set'; name: string; old: string | null; new: string }
  | { kind: 'option_delete'; name: string; old: string | null }
  | { kind: 'postmeta_set'; postId: number; key: string; old: string | null; new: string }
  | { kind: 'postmeta_delete'; postId: number; key: string; old: string | null }
  | { kind: 'row_update'; table: string; pkCol: string; pk: number; old: Record<string, string | null>; new: Record<string, string | null> }
  | { kind: 'row_insert'; table: string; pkCol: string; pk: number; new: Record<string, string | null> }
  | { kind: 'row_delete'; table: string; pkCol: string; pk: number; old: Record<string, string | null> };

export type Precondition =
  | { type: 'option'; name: string; expected: string | null }
  | { type: 'file_hash'; path: string; expected: string }
  | { type: 'row'; table: string; pkCol: string; pk: number; column: string; expected: string | null };

export interface SmokeCheck { label: string; path: string; expectStatus: number; expectText?: string }
export interface SmokeResult { label: string; ok: boolean; detail?: string }
export interface ChangeFile { path: string; newHash: string | null; oldHash: string | null }
export interface Conflict { key: string; expected: string; found: string }

/** Mirror of ferry-server's Change row (store.ts) — same duplication convention as SyncState. */
export interface Change {
  id: number; siteId: number; seq: number; status: ChangeStatus;
  title: string; summary: string; branch: string; baseSha: string; headSha: string;
  diffText: string; files: ChangeFile[]; ops: DbOp[]; preconditions: Precondition[]; smoke: SmokeCheck[];
  backupTxid: string | null; prodRef: string | null; conflict: Conflict[] | null;
  smokeResult: SmokeResult[] | null;
  createdAt: string; pushedAt: string | null; rolledBackAt: string | null;
}

export type PushStep = 'staging' | 'hashes' | 'drift' | 'swap' | 'journal' | 'smoke';
export interface StepEvent { step: PushStep; status: 'start' | 'ok' | 'fail'; detail?: string; durationMs?: number }
export interface PushWireEvent { seq: number; type: 'push_step' | 'push_done'; payload: unknown }
export interface DriftPreview { checked: number; mismatches: string[] }

export const listChanges = (siteId: number, status?: ChangeStatus) =>
  call<{ changes: Change[] }>('GET', `/api/sites/${siteId}/changes${status ? `?status=${status}` : ''}`);
export const getChange = (siteId: number, seq: number) =>
  call<Change>('GET', `/api/sites/${siteId}/changes/${seq}`);
export const pushChange = (siteId: number, seq: number, force = false) =>
  call<{ started: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/push`, { force });
export const rollbackChange = (siteId: number, seq: number) =>
  call<{ rolledBack: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/rollback`);
export const discardChange = (siteId: number, seq: number) =>
  call<{ discarded: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/discard`);
export const retryChange = (siteId: number, seq: number) =>
  call<{ queued: boolean }>('POST', `/api/sites/${siteId}/changes/${seq}/retry`);
export const driftPreview = (siteId: number, seq: number) =>
  call<DriftPreview>('GET', `/api/sites/${siteId}/changes/${seq}/drift`);
