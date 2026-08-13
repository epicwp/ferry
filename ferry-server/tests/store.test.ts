import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';

describe('Store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferry-store-'));
    store = new Store(join(dir, 'server.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates users and rejects duplicate emails', () => {
    const user = store.createUser('a@example.com', 'salt:hash');
    expect(user?.email).toBe('a@example.com');
    expect(store.createUser('a@example.com', 'other')).toBeUndefined();
    expect(store.userByEmail('a@example.com')?.id).toBe(user!.id);
  });

  it('round-trips sessions and expires them', () => {
    const user = store.createUser('a@example.com', 'h')!;
    store.createSession('tok1', user.id, new Date(Date.now() + 60_000).toISOString());
    expect(store.userForSession('tok1')?.id).toBe(user.id);
    store.createSession('tok2', user.id, new Date(Date.now() - 1_000).toISOString());
    expect(store.userForSession('tok2')).toBeUndefined();
    store.deleteSession('tok1');
    expect(store.userForSession('tok1')).toBeUndefined();
  });

  it('creates sites with ownership and unique slugs', () => {
    const a = store.createUser('a@example.com', 'h')!;
    const b = store.createUser('b@example.com', 'h')!;
    const site = store.createSite(a.id, 'Shop', 'https://shop.example', 'shop-example')!;
    expect(site.status).toBe('new');
    expect(store.createSite(b.id, 'Dup', 'https://shop.example', 'shop-example')).toBeUndefined();
    expect(store.sitesFor(a.id)).toHaveLength(1);
    expect(store.siteFor(b.id, site.id)).toBeUndefined(); // not the owner
    expect(store.siteFor(a.id, site.id)?.slug).toBe('shop-example');
  });

  it('looks up sites unscoped by user, by id and by slug', () => {
    const a = store.createUser('a@example.com', 'h')!;
    const site = store.createSite(a.id, 'Shop', 'https://shop.example', 'shop-example')!;
    expect(store.siteById(site.id)?.slug).toBe('shop-example');
    expect(store.siteById(-1)).toBeUndefined();
    expect(store.siteBySlug('shop-example')?.id).toBe(site.id);
    expect(store.siteBySlug('unknown')).toBeUndefined();
  });

  it('patches status fields', () => {
    const a = store.createUser('a@example.com', 'h')!;
    const site = store.createSite(a.id, 'Shop', 'https://shop.example', 'shop-example')!;
    store.setStatus(site.id, 'error', { lastError: 'boom' });
    expect(store.siteFor(a.id, site.id)).toMatchObject({ status: 'error', lastError: 'boom' });
    store.setStatus(site.id, 'ready', { lastError: null, lastSyncAt: '2026-07-25T00:00:00.000Z', verifiedAt: '2026-07-25T00:00:01.000Z' });
    expect(store.siteFor(a.id, site.id)).toMatchObject({ status: 'ready', lastError: null, verifiedAt: '2026-07-25T00:00:01.000Z' });
  });

  it('recovers interrupted syncs at boot', () => {
    const a = store.createUser('a@example.com', 'h')!;
    const site = store.createSite(a.id, 'Shop', 'https://shop.example', 'shop-example')!;
    store.setStatus(site.id, 'syncing');
    expect(store.recoverInterruptedSyncs()).toBe(1);
    expect(store.siteFor(a.id, site.id)).toMatchObject({
      status: 'error',
      lastError: 'Sync interrupted by a server restart — run it again.',
    });
    expect(store.recoverInterruptedSyncs()).toBe(0);
  });

  it('rethrows non-constraint errors instead of swallowing them', () => {
    const store = new Store(':memory:');
    store.close();
    expect(() => store.createUser('x@example.com', 'hash')).toThrow();
    expect(() => store.createSite(1, 'X', 'https://x.example', 'x-example')).toThrow();
  });

  it('creates the agent_events session_id index on fresh database', () => {
    const db = new Database(join(dir, 'server.db'));
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_events_session'"
    ).all();
    db.close();
    expect(result).toHaveLength(1);
  });

  describe('changes', () => {
    const fields = {
      title: 'Fix VAT calc', summary: 'VAT was computed pre-discount.', branch: 'agent/work',
      baseSha: 'aaa', headSha: 'bbb', diffText: '--- a\n+++ b\n', files: [], ops: [], preconditions: [], smoke: [],
    };

    it('allocates seq per site independently, starting at 1', () => {
      const a = store.createUser('a@example.com', 'h')!;
      const siteA = store.createSite(a.id, 'A', 'https://a.example', 'a')!;
      const siteB = store.createSite(a.id, 'B', 'https://b.example', 'b')!;
      const c1 = store.createChange(siteA.id, fields);
      const c2 = store.createChange(siteA.id, fields);
      const c3 = store.createChange(siteB.id, fields);
      expect(c1.seq).toBe(1);
      expect(c2.seq).toBe(2);
      expect(c3.seq).toBe(1); // independent counter for site B
      expect(c1.status).toBe('draft');
      expect(c1.title).toBe(fields.title);
    });

    it('enforces UNIQUE(site_id, seq)', () => {
      const a = store.createUser('a@example.com', 'h')!;
      const site = store.createSite(a.id, 'A', 'https://a.example', 'a')!;
      store.createChange(site.id, fields); // seq 1
      // Reach the constraint directly (createChange always self-allocates the next seq) via a
      // second raw connection to the same file, mirroring the schema-inspection test above.
      const raw = new Database(join(dir, 'server.db'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO changes (site_id, seq, status, title, summary, branch, base_sha, head_sha, diff_text, files_json, ops_json, preconditions_json, smoke_json, created_at)
             VALUES (?, 1, 'draft', 't', 's', 'agent/work', 'a', 'b', 'd', '[]', '[]', '[]', '[]', ?)`,
          )
          .run(site.id, new Date().toISOString()),
      ).toThrow();
      raw.close();
    });

    it('reads changes by site (optionally filtered by status) and by seq', () => {
      const a = store.createUser('a@example.com', 'h')!;
      const site = store.createSite(a.id, 'A', 'https://a.example', 'a')!;
      const c1 = store.createChange(site.id, fields);
      store.setChangeStatus(c1.id, 'pushed', { pushedAt: '2026-08-04T00:00:00.000Z' });
      const c2 = store.createChange(site.id, fields);
      expect(store.changesFor(site.id).map((c) => c.seq)).toEqual([1, 2]);
      expect(store.changesFor(site.id, 'draft').map((c) => c.seq)).toEqual([2]);
      expect(store.changeBySeq(site.id, 1)).toMatchObject({ status: 'pushed', pushedAt: '2026-08-04T00:00:00.000Z' });
      expect(store.changeBySeq(site.id, c2.seq)?.id).toBe(c2.id);
    });

    it('creates and updates push_runs for a change', () => {
      const a = store.createUser('a@example.com', 'h')!;
      const site = store.createSite(a.id, 'A', 'https://a.example', 'a')!;
      const change = store.createChange(site.id, fields);
      const run = store.createPushRun(change.id, 'running');
      expect(run.status).toBe('running');
      expect(() =>
        store.updatePushRun(run.id, { status: 'pushed', steps: [{ step: 'smoke', status: 'ok' }], finishedAt: '2026-08-04T00:00:01.000Z' }),
      ).not.toThrow();
    });

    it('recovers interrupted (status=pushing) changes', () => {
      const a = store.createUser('a@example.com', 'h')!;
      const site = store.createSite(a.id, 'A', 'https://a.example', 'a')!;
      const change = store.createChange(site.id, fields);
      expect(store.recoverInterruptedPushes()).toEqual([]);
      store.setChangeStatus(change.id, 'pushing', { backupTxid: 'tx123' });
      expect(store.recoverInterruptedPushes()).toEqual([{ changeId: change.id, backupTxid: 'tx123' }]);
    });

    it('migrates a database created before smoke_result_json existed, idempotently', () => {
      const dbPath = join(dir, 'legacy.db');
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE changes (
          id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL,
          seq INTEGER NOT NULL, status TEXT NOT NULL,
          title TEXT NOT NULL, summary TEXT NOT NULL, branch TEXT NOT NULL,
          base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, diff_text TEXT NOT NULL,
          files_json TEXT NOT NULL, ops_json TEXT NOT NULL,
          preconditions_json TEXT NOT NULL, smoke_json TEXT NOT NULL,
          backup_txid TEXT, prod_ref TEXT, conflict_json TEXT,
          created_at TEXT NOT NULL, pushed_at TEXT, rolled_back_at TEXT,
          UNIQUE(site_id, seq)
        );
      `);
      raw
        .prepare(
          `INSERT INTO changes (site_id, seq, status, title, summary, branch, base_sha, head_sha, diff_text, files_json, ops_json, preconditions_json, smoke_json, created_at)
           VALUES (1, 1, 'draft', 't', 's', 'agent/work', 'a', 'b', 'd', '[]', '[]', '[]', '[]', ?)`,
        )
        .run(new Date().toISOString());
      raw.close();

      const migrated = new Store(dbPath);
      expect(migrated.changeById(1)).toMatchObject({ smokeResult: null });
      migrated.close();

      // Re-opening (column now present) must not throw - the ALTER TABLE guard is idempotent.
      expect(() => new Store(dbPath).close()).not.toThrow();
    });
  });

  describe('session hashing and purge', () => {
    it('stores only the sha256 of the token, and authenticates by raw token', () => {
      const store = new Store(':memory:');
      const user = store.createUser('s@example.com', 'x:y')!;
      store.createSession('raw-token-1', user.id, '2099-01-01T00:00:00.000Z');
      const rows = (store as any).db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).toBe(createHash('sha256').update('raw-token-1').digest('hex'));
      expect(store.userForSession('raw-token-1')?.id).toBe(user.id);
      store.deleteSession('raw-token-1');
      expect(store.userForSession('raw-token-1')).toBeUndefined();
    });

    it('purges expired sessions and keeps live ones', () => {
      const store = new Store(':memory:');
      const user = store.createUser('p@example.com', 'x:y')!;
      store.createSession('expired', user.id, '2000-01-01T00:00:00.000Z');
      store.createSession('live', user.id, '2099-01-01T00:00:00.000Z');
      expect(store.purgeExpiredSessions()).toBe(1);
      expect(store.userForSession('live')).toBeDefined();
    });

    it('migrates a pre-6a plaintext sessions table by dropping it', () => {
      const path = join(mkdtempSync(join(tmpdir(), 'ferry-store-')), 's.db');
      const raw = new Database(path);
      raw.exec('CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL)');
      raw.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('plain', 1, '2099-01-01T00:00:00.000Z');
      raw.close();
      const store = new Store(path);
      const cols = (store as any).db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      expect(cols.some((c) => c.name === 'token_hash')).toBe(true);
      expect(cols.some((c) => c.name === 'token')).toBe(false);
      expect((store as any).db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
      store.close();
    });
  });
});
