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
  });
});
