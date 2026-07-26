import Database from 'better-sqlite3';

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
}
