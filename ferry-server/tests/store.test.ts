import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(store.indexExists('idx_agent_events_session')).toBe(true);
  });
});
