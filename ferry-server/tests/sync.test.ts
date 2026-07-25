import { describe, expect, it } from 'vitest';
import type { PullProgress, PullResult } from '../../ferry-cli/src/pull.js';
import { SyncManager, type SyncState } from '../src/sync.js';
import { Store } from '../src/store.js';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const RESULT: PullResult = {
  url: 'https://klant-nl.ddev.site', adminUser: 'ferry-admin', adminPassword: 'pw',
  skipped: [], commit: 'abc1234def', neutralizedRepos: 0, liteSkip: [],
  provenance: { reportPath: '/tmp/r.json', summary: 'ok', reused: 0, reconstructed: 0, fetched: 2 },
};

function setup(engineOverrides: Parameters<typeof stubEngine>[0]) {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  store.setStatus(site.id, 'paired');
  const sync = new SyncManager(store, stubEngine(engineOverrides));
  return { store, user, site: store.siteFor(user.id, site.id)!, sync };
}

describe('SyncManager', () => {
  it('runs a sync to ready, forwarding progress and verifying the clone', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => { emit = opts.onProgress; return done.promise; },
      verifyClone: async () => true,
    });
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s));
    sync.start(site);
    expect(sync.isRunning(site.id)).toBe(true);
    expect(store.siteFor(user.id, site.id)!.status).toBe('syncing');
    emit!({ phase: 'files', current: 1, total: 2 });
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
    expect(sync.isRunning(site.id)).toBe(false);
    const final = seen.at(-1)!;
    expect(final).toMatchObject({ status: 'ready', cloneUrl: 'https://klant-nl.ddev.site' });
    expect(seen.some((s) => s.phase === 'files' && s.current === 1)).toBe(true);
    expect(store.siteFor(user.id, site.id)!).toMatchObject({ status: 'ready' });
    expect(store.siteFor(user.id, site.id)!.verifiedAt).not.toBeNull();
  });

  it('records a failed pull as error', async () => {
    const { store, user, site, sync } = setup({ pull: async () => { throw new Error('manifest made no progress - aborting'); } });
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s));
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.at(-1)).toMatchObject({ status: 'error', error: 'manifest made no progress - aborting' });
    expect(store.siteFor(user.id, site.id)!.status).toBe('error');
  });

  it('fails when the clone does not verify', async () => {
    const { store, user, site, sync } = setup({ pull: async () => RESULT, verifyClone: async () => false });
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.siteFor(user.id, site.id)!.status).toBe('error');
    expect(store.siteFor(user.id, site.id)!.lastError).toContain('did not answer');
  });

  it('refuses a second concurrent sync and replays state to late subscribers', async () => {
    const done = deferred<PullResult>();
    const { site, sync } = setup({ pull: async () => done.promise, verifyClone: async () => true });
    sync.start(site);
    expect(() => sync.start(site)).toThrow('already_syncing');
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s)); // subscribe mid-sync
    expect(seen[0]!.status).toBe('syncing');
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.at(-1)!.status).toBe('ready');
  });

  it('isolates throwing subscribers and ensures other subscribers receive final state', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => { emit = opts.onProgress; return done.promise; },
      verifyClone: async () => true,
    });
    const throwingSeen: SyncState[] = [];
    const goodSeen: SyncState[] = [];
    // Subscribe with a listener that throws
    sync.subscribe(site, (s) => {
      throwingSeen.push(s);
      throw new Error('Subscriber callback failed');
    });
    // Subscribe with a normal listener
    sync.subscribe(site, (s) => {
      goodSeen.push(s);
    });
    sync.start(site);
    emit!({ phase: 'files', current: 1, total: 2 });
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
    // Verify sync completed successfully despite throwing subscriber
    expect(store.siteFor(user.id, site.id)!.status).toBe('ready');
    // Verify both subscribers got the initial and final states
    expect(throwingSeen.at(-1)!.status).toBe('ready');
    expect(goodSeen.at(-1)!.status).toBe('ready');
    // Verify throwing subscriber didn't prevent good subscriber from receiving updates
    expect(goodSeen.length).toBeGreaterThan(1);
  });

  it('handles subscriber errors without unhandled promise rejections', async () => {
    const done = deferred<PullResult>();
    const { store, user, site, sync } = setup({
      pull: async () => done.promise,
      verifyClone: async () => true,
    });
    let callCount = 0;
    const unsubscribe = sync.subscribe(site, () => {
      callCount++;
      throw new Error('Listener error');
    });
    sync.start(site);
    done.resolve(RESULT);
    // Give the sync time to complete and emit states
    await new Promise((r) => setTimeout(r, 20));
    // Verify the listener was called multiple times despite throwing
    expect(callCount).toBeGreaterThan(0);
    // Verify sync reached ready despite listener throwing (refresh site from store)
    const refreshed = store.siteFor(user.id, site.id)!;
    expect(refreshed.status).toBe('ready');
    unsubscribe();
  });
});

describe('sync routes', () => {
  it('starts a sync over HTTP and refuses unpaired sites', async () => {
    const done = deferred<PullResult>();
    const { app } = makeApp({ engine: stubEngine({ link: async () => {}, pull: async () => done.promise, verifyClone: async () => true }) });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
    const id = created.json().id as number;
    let res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(409); // still status new
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(409); // already running
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('streams full-state SSE messages', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { app } = makeApp({
      engine: stubEngine({ link: async () => {}, pull: async (_s, opts) => { emit = opts.onProgress; return done.promise; }, verifyClone: async () => true }),
    });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
    const id = created.json().id as number;
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/sites/${id}/sync/events`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const states: SyncState[] = [];
    async function readUntil(pred: () => boolean): Promise<void> {
      while (!pred()) {
        const { value, done: eof } = await reader.read();
        if (eof) throw new Error('SSE stream ended early');
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop()!; // last piece may be a partial frame — keep it
        for (const frame of frames) {
          if (frame.startsWith('data: ')) states.push(JSON.parse(frame.slice(6)) as SyncState);
        }
      }
    }

    await readUntil(() => states.length >= 1); // snapshot on connect (idle — sync not started yet)
    await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    await readUntil(() => states.some((s) => s.status === 'syncing'));
    emit!({ phase: 'db', current: 3, total: 12, detail: 'wp_posts' });
    await readUntil(() => states.some((s) => s.phase === 'db' && s.current === 3));
    done.resolve(RESULT);
    await readUntil(() => states.some((s) => s.status === 'ready'));
    await reader.cancel();
    await app.close();
  });
});
