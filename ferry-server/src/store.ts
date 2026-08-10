import Database from 'better-sqlite3';
import type { ChangeFile, Conflict, DbOp, Precondition, SmokeCheck } from '../../ferry-cli/src/push-types.js';

export interface User { id: number; email: string; passwordHash: string }

export type SiteStatus = 'new' | 'paired' | 'syncing' | 'ready' | 'error' | 'refused_multisite';

export interface Site {
  id: number;
  userId: number;
  name: string;
  url: string;
  slug: string;
  status: SiteStatus;
  lastError: string | null;
  lastSyncAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export type AgentSessionStatus = 'idle' | 'running' | 'error';

export interface AgentSession {
  id: number;
  siteId: number;
  sdkSessionId: string | null;
  status: AgentSessionStatus;
  createdAt: string;
  lastActivityAt: string;
}

export interface AgentEventRow {
  seq: number;
  sessionId: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ChangeStatus = 'draft' | 'pushing' | 'pushed' | 'conflict' | 'rolled_back' | 'discarded';

export interface Change {
  id: number;
  siteId: number;
  seq: number;
  status: ChangeStatus;
  title: string;
  summary: string;
  branch: string;
  baseSha: string;
  headSha: string;
  diffText: string;
  files: ChangeFile[];
  ops: DbOp[];
  preconditions: Precondition[];
  smoke: SmokeCheck[];
  backupTxid: string | null;
  prodRef: string | null;
  conflict: Conflict[] | null;
  createdAt: string;
  pushedAt: string | null;
  rolledBackAt: string | null;
}

export interface CreateChangeFields {
  title: string;
  summary: string;
  branch: string;
  baseSha: string;
  headSha: string;
  diffText: string;
  files: ChangeFile[];
  ops: DbOp[];
  preconditions: Precondition[];
  smoke: SmokeCheck[];
}

export interface SetChangeStatusPatch {
  backupTxid?: string | null;
  prodRef?: string | null;
  conflict?: Conflict[] | null;
  pushedAt?: string;
  rolledBackAt?: string;
}

export interface PushRun {
  id: number;
  changeId: number;
  status: string;
  steps: unknown[];
  logText: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface UpdatePushRunPatch {
  status?: string;
  steps?: unknown[];
  logText?: string;
  finishedAt?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  last_sync_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  sdk_session_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id),
  seq INTEGER NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL, branch TEXT NOT NULL,
  base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, diff_text TEXT NOT NULL,
  files_json TEXT NOT NULL, ops_json TEXT NOT NULL,
  preconditions_json TEXT NOT NULL, smoke_json TEXT NOT NULL,
  backup_txid TEXT, prod_ref TEXT, conflict_json TEXT,
  created_at TEXT NOT NULL, pushed_at TEXT, rolled_back_at TEXT,
  UNIQUE(site_id, seq)
);
CREATE TABLE IF NOT EXISTS push_runs (
  id INTEGER PRIMARY KEY, change_id INTEGER NOT NULL REFERENCES changes(id),
  status TEXT NOT NULL, steps_json TEXT NOT NULL, log_text TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT
);
`;

interface SiteRow {
  id: number; user_id: number; name: string; url: string; slug: string; status: string;
  last_error: string | null; last_sync_at: string | null; verified_at: string | null; created_at: string;
}

interface AgentSessionRow {
  id: number;
  site_id: number;
  sdk_session_id: string | null;
  status: string;
  created_at: string;
  last_activity_at: string;
}

interface AgentEventRowRaw {
  id: number;
  session_id: number;
  type: string;
  payload: string;
  created_at: string;
}

interface ChangeRow {
  id: number; site_id: number; seq: number; status: string;
  title: string; summary: string; branch: string;
  base_sha: string; head_sha: string; diff_text: string;
  files_json: string; ops_json: string; preconditions_json: string; smoke_json: string;
  backup_txid: string | null; prod_ref: string | null; conflict_json: string | null;
  created_at: string; pushed_at: string | null; rolled_back_at: string | null;
}

function isConstraintError(err: unknown): boolean {
  return err instanceof Error && String((err as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT');
}

function toSite(row: SiteRow): Site {
  return {
    id: row.id, userId: row.user_id, name: row.name, url: row.url, slug: row.slug,
    status: row.status as SiteStatus, lastError: row.last_error,
    lastSyncAt: row.last_sync_at, verifiedAt: row.verified_at, createdAt: row.created_at,
  };
}

function toAgentSession(row: AgentSessionRow): AgentSession {
  return {
    id: row.id, siteId: row.site_id, sdkSessionId: row.sdk_session_id,
    status: row.status as AgentSessionStatus, createdAt: row.created_at, lastActivityAt: row.last_activity_at,
  };
}

function toChange(row: ChangeRow): Change {
  return {
    id: row.id, siteId: row.site_id, seq: row.seq, status: row.status as ChangeStatus,
    title: row.title, summary: row.summary, branch: row.branch,
    baseSha: row.base_sha, headSha: row.head_sha, diffText: row.diff_text,
    files: JSON.parse(row.files_json) as ChangeFile[],
    ops: JSON.parse(row.ops_json) as DbOp[],
    preconditions: JSON.parse(row.preconditions_json) as Precondition[],
    smoke: JSON.parse(row.smoke_json) as SmokeCheck[],
    backupTxid: row.backup_txid, prodRef: row.prod_ref,
    conflict: row.conflict_json ? (JSON.parse(row.conflict_json) as Conflict[]) : null,
    createdAt: row.created_at, pushedAt: row.pushed_at, rolledBackAt: row.rolled_back_at,
  };
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createUser(email: string, passwordHash: string): User | undefined {
    try {
      const info = this.db
        .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
        .run(email, passwordHash, new Date().toISOString());
      return { id: Number(info.lastInsertRowid), email, passwordHash };
    } catch (err) {
      if (isConstraintError(err)) return undefined; // UNIQUE violation: email already registered
      throw err;
    }
  }

  userByEmail(email: string): User | undefined {
    const row = this.db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as
      | { id: number; email: string; password_hash: string }
      | undefined;
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : undefined;
  }

  createSession(token: string, userId: number, expiresAt: string): void {
    this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  }

  userForSession(token: string): User | undefined {
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, u.password_hash FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, new Date().toISOString()) as { id: number; email: string; password_hash: string } | undefined;
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  createSite(userId: number, name: string, url: string, slug: string): Site | undefined {
    try {
      const info = this.db
        .prepare('INSERT INTO sites (user_id, name, url, slug, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, name, url, slug, 'new', new Date().toISOString());
      return this.siteFor(userId, Number(info.lastInsertRowid));
    } catch (err) {
      if (isConstraintError(err)) return undefined; // UNIQUE violation: slug already registered on this server
      throw err;
    }
  }

  sitesFor(userId: number): Site[] {
    const rows = this.db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY id').all(userId) as SiteRow[];
    return rows.map(toSite);
  }

  siteFor(userId: number, id: number): Site | undefined {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(id, userId) as SiteRow | undefined;
    return row ? toSite(row) : undefined;
  }

  /** Unscoped by user - for boot-time recovery (PushManager.recover()), which runs outside
   *  any request/user context and only has a Change's siteId to work from. */
  siteById(id: number): Site | undefined {
    const row = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow | undefined;
    return row ? toSite(row) : undefined;
  }

  /** Unscoped by user - slug is globally unique (UNIQUE constraint), and the agent's
   *  create_change tool only knows its own site's slug, not the owning user. */
  siteBySlug(slug: string): Site | undefined {
    const row = this.db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug) as SiteRow | undefined;
    return row ? toSite(row) : undefined;
  }

  setStatus(
    id: number,
    status: SiteStatus,
    patch: { lastError?: string | null; lastSyncAt?: string; verifiedAt?: string } = {},
  ): void {
    this.db.prepare('UPDATE sites SET status = ? WHERE id = ?').run(status, id);
    if ('lastError' in patch) {
      this.db.prepare('UPDATE sites SET last_error = ? WHERE id = ?').run(patch.lastError, id);
    }
    if (patch.lastSyncAt !== undefined) {
      this.db.prepare('UPDATE sites SET last_sync_at = ? WHERE id = ?').run(patch.lastSyncAt, id);
    }
    if (patch.verifiedAt !== undefined) {
      this.db.prepare('UPDATE sites SET verified_at = ? WHERE id = ?').run(patch.verifiedAt, id);
    }
  }

  recoverInterruptedSyncs(): number {
    const info = this.db
      .prepare("UPDATE sites SET status = 'error', last_error = ? WHERE status = 'syncing'")
      .run('Sync interrupted by a server restart — run it again.');
    return info.changes;
  }

  createAgentSession(siteId: number): AgentSession {
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO agent_sessions (site_id, status, created_at, last_activity_at) VALUES (?, ?, ?, ?)')
      .run(siteId, 'idle', now, now);
    return this.currentAgentSession(siteId)!;
  }

  currentAgentSession(siteId: number): AgentSession | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_sessions WHERE site_id = ? ORDER BY id DESC LIMIT 1')
      .get(siteId) as AgentSessionRow | undefined;
    return row ? toAgentSession(row) : undefined;
  }

  setAgentSessionSdkId(id: number, sdkSessionId: string): void {
    this.db.prepare('UPDATE agent_sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
  }

  setAgentSessionStatus(id: number, status: AgentSessionStatus): void {
    this.db.prepare('UPDATE agent_sessions SET status = ? WHERE id = ?').run(status, id);
  }

  touchAgentSession(id: number): void {
    this.db.prepare('UPDATE agent_sessions SET last_activity_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  appendAgentEvent(sessionId: number, type: string, payload: Record<string, unknown>): AgentEventRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare('INSERT INTO agent_events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, type, JSON.stringify(payload), now);
    return { seq: Number(info.lastInsertRowid), sessionId, type, payload, createdAt: now };
  }

  agentEventsAfter(sessionId: number, afterSeq: number): AgentEventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_events WHERE session_id = ? AND id > ? ORDER BY id')
      .all(sessionId, afterSeq) as AgentEventRowRaw[];
    return rows.map((r) => ({
      seq: r.id,
      sessionId: r.session_id,
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  recoverInterruptedAgentSessions(): number {
    return this.db.prepare("UPDATE agent_sessions SET status = 'idle' WHERE status = 'running'").run().changes;
  }

  createChange(siteId: number, fields: CreateChangeFields): Change {
    const now = new Date().toISOString();
    const insert = this.db.transaction((): number => {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM changes WHERE site_id = ?')
        .get(siteId) as { next: number };
      const info = this.db
        .prepare(
          `INSERT INTO changes (
             site_id, seq, status, title, summary, branch, base_sha, head_sha, diff_text,
             files_json, ops_json, preconditions_json, smoke_json, created_at
           ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          siteId, next, fields.title, fields.summary, fields.branch, fields.baseSha, fields.headSha, fields.diffText,
          JSON.stringify(fields.files), JSON.stringify(fields.ops),
          JSON.stringify(fields.preconditions), JSON.stringify(fields.smoke), now,
        );
      return Number(info.lastInsertRowid);
    });
    return this.changeById(insert())!;
  }

  changeById(id: number): Change | undefined {
    const row = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as ChangeRow | undefined;
    return row ? toChange(row) : undefined;
  }

  changesFor(siteId: number, status?: ChangeStatus): Change[] {
    const rows = status
      ? (this.db.prepare('SELECT * FROM changes WHERE site_id = ? AND status = ? ORDER BY seq').all(siteId, status) as ChangeRow[])
      : (this.db.prepare('SELECT * FROM changes WHERE site_id = ? ORDER BY seq').all(siteId) as ChangeRow[]);
    return rows.map(toChange);
  }

  changeBySeq(siteId: number, seq: number): Change | undefined {
    const row = this.db.prepare('SELECT * FROM changes WHERE site_id = ? AND seq = ?').get(siteId, seq) as ChangeRow | undefined;
    return row ? toChange(row) : undefined;
  }

  setChangeStatus(id: number, status: ChangeStatus, patch: SetChangeStatusPatch = {}): void {
    this.db.prepare('UPDATE changes SET status = ? WHERE id = ?').run(status, id);
    if ('backupTxid' in patch) {
      this.db.prepare('UPDATE changes SET backup_txid = ? WHERE id = ?').run(patch.backupTxid, id);
    }
    if ('prodRef' in patch) {
      this.db.prepare('UPDATE changes SET prod_ref = ? WHERE id = ?').run(patch.prodRef, id);
    }
    if ('conflict' in patch) {
      this.db.prepare('UPDATE changes SET conflict_json = ? WHERE id = ?').run(patch.conflict ? JSON.stringify(patch.conflict) : null, id);
    }
    if (patch.pushedAt !== undefined) {
      this.db.prepare('UPDATE changes SET pushed_at = ? WHERE id = ?').run(patch.pushedAt, id);
    }
    if (patch.rolledBackAt !== undefined) {
      this.db.prepare('UPDATE changes SET rolled_back_at = ? WHERE id = ?').run(patch.rolledBackAt, id);
    }
  }

  createPushRun(changeId: number, status: string): PushRun {
    const now = new Date().toISOString();
    const info = this.db
      .prepare('INSERT INTO push_runs (change_id, status, steps_json, log_text, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(changeId, status, '[]', '', now);
    return { id: Number(info.lastInsertRowid), changeId, status, steps: [], logText: '', startedAt: now, finishedAt: null };
  }

  updatePushRun(id: number, patch: UpdatePushRunPatch): void {
    if (patch.status !== undefined) {
      this.db.prepare('UPDATE push_runs SET status = ? WHERE id = ?').run(patch.status, id);
    }
    if (patch.steps !== undefined) {
      this.db.prepare('UPDATE push_runs SET steps_json = ? WHERE id = ?').run(JSON.stringify(patch.steps), id);
    }
    if (patch.logText !== undefined) {
      this.db.prepare('UPDATE push_runs SET log_text = ? WHERE id = ?').run(patch.logText, id);
    }
    if (patch.finishedAt !== undefined) {
      this.db.prepare('UPDATE push_runs SET finished_at = ? WHERE id = ?').run(patch.finishedAt, id);
    }
  }

  recoverInterruptedPushes(): { changeId: number; backupTxid: string | null }[] {
    const rows = this.db
      .prepare("SELECT id, backup_txid FROM changes WHERE status = 'pushing'")
      .all() as { id: number; backup_txid: string | null }[];
    return rows.map((r) => ({ changeId: r.id, backupTxid: r.backup_txid }));
  }
}
