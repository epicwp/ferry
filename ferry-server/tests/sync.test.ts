import { describe, expect, it, vi } from 'vitest';
import type { PullProgress, PullResult } from '../../ferry-cli/src/pull.js';
import { SyncManager, type SyncState } from '../src/sync.js';
import { Store, type Site } from '../src/store.js';
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

function setup(engineOverrides: Parameters<typeof stubEngine>[0], opts?: ConstructorParameters<typeof SyncManager>[2]) {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  store.setStatus(site.id, 'paired');
  const sync = new SyncManager(store, stubEngine(engineOverrides), opts);
  return { store, user, site: store.siteFor(user.id, site.id)!, sync };
}

describe('SyncManager', () => {
  it('runs a sync to ready, forwarding progress and verifying the clone', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => { emit = opts.onProgress; return done.promise; },
      verifyClone: async () => ({ ok: true }),
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
    const { store, user, site, sync } = setup({ pull: async () => RESULT, verifyClone: async () => ({ ok: false }) });
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.siteFor(user.id, site.id)!.status).toBe('error');
    expect(store.siteFor(user.id, site.id)!.lastError).toContain('did not answer');
  });

  it('refuses a second concurrent sync and replays state to late subscribers', async () => {
    const done = deferred<PullResult>();
    const { store, user, site, sync } = setup({ pull: async () => done.promise, verifyClone: async () => ({ ok: true }) });
    sync.start(site);
    expect(() => sync.start(site)).toThrow('already_syncing');
    const seen: SyncState[] = [];
    // Routes always re-fetch the site fresh before subscribing (routes/sync.ts) — mirror that,
    // since snapshot() now keys the running frame off the DB status, not just the active map.
    sync.subscribe(store.siteFor(user.id, site.id)!, (s) => seen.push(s)); // subscribe mid-sync
    expect(seen[0]!.status).toBe('syncing');
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.at(-1)!.status).toBe('ready');
  });

  it('clears the stale lastError the moment a retry enters syncing', async () => {
    const { app, store } = makeApp({
      engine: stubEngine({ pull: () => new Promise(() => {}), cloneUrl: (s) => `https://${s}.ddev.site` }),
    });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://retry.example' } });
    const id = created.json().id as number;
    store.setStatus(id, 'error', { lastError: 'previous failure' });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
    const detail = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie } });
    expect(detail.json().status).toBe('syncing');
    expect(detail.json().lastError).toBeNull();
  });

  it('a late onProgress tick after a failed pull cannot resurrect the active entry', async () => {
    let emit: ((e: PullProgress) => void) | undefined;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => {
        opts.onProgress!({ phase: 'files', current: 1, total: 2 });
        emit = opts.onProgress;
        throw new Error('manifest made no progress - aborting');
      },
    });
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s));
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20)); // run() catches, deletes the active entry
    expect(sync.isRunning(site.id)).toBe(false);
    expect(store.siteFor(user.id, site.id)!.status).toBe('error');

    // A concurrent transfer worker fires onProgress after the run already ended.
    emit!({ phase: 'files', current: 2, total: 2 });
    expect(sync.isRunning(site.id)).toBe(false); // must not resurrect the leaked entry
    expect(seen.at(-1)!.status).toBe('error'); // no stale 'syncing' frame emitted either

    // The 409 guard is clear — a retry can start.
    expect(() => sync.start(site)).not.toThrow();
  });

  it('a late onProgress tick from an old run does not clobber a new run started after retry', async () => {
    const done1 = deferred<PullResult>();
    const done2 = deferred<PullResult>();
    let emit1: ((e: PullProgress) => void) | undefined;
    let emit2: ((e: PullProgress) => void) | undefined;
    let call = 0;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => {
        call += 1;
        if (call === 1) { emit1 = opts.onProgress; return done1.promise; }
        emit2 = opts.onProgress;
        return done2.promise;
      },
    });
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s));

    // Run 1: gets a progress tick, then fails — active is repopulated with a
    // fresh entry, and its terminal error path deletes it again.
    sync.start(site);
    emit1!({ phase: 'files', current: 1, total: 5 });
    done1.reject(new Error('run 1 failed'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sync.isRunning(site.id)).toBe(false);

    // Retry: run 2 starts (active repopulated for the NEW run) and reports its
    // own live progress.
    sync.start(store.siteFor(user.id, site.id)!);
    emit2!({ phase: 'db', current: 3, total: 10 });

    // Run 1's concurrent worker is still alive and fires a late tick belonging
    // to the OLD run — `active.has(site.id)` is true again (run 2 owns it), but
    // this tick must not be mistaken for run 2's progress.
    emit1!({ phase: 'files', current: 5, total: 5 });

    expect(seen.at(-1)).toMatchObject({ status: 'syncing', phase: 'db', current: 3, total: 10 }); // run 2's frame intact
    expect(sync.isRunning(site.id)).toBe(true); // run 2 still active, untouched

    done2.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('isolates throwing subscribers and ensures other subscribers receive final state', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => { emit = opts.onProgress; return done.promise; },
      verifyClone: async () => ({ ok: true }),
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
      verifyClone: async () => ({ ok: true }),
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

describe('SyncManager afterReady hook', () => {
  it('calls afterReady with the site after a successful sync', async () => {
    const calls: Site[] = [];
    const { site, sync } = setup(
      { pull: async () => RESULT, verifyClone: async () => ({ ok: true }) },
      { afterReady: async (s) => { calls.push(s); } },
    );
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([site]);
  });

  it('does not call afterReady after a failed sync', async () => {
    const calls: Site[] = [];
    const { store, user, site, sync } = setup(
      { pull: async () => { throw new Error('manifest made no progress - aborting'); } },
      { afterReady: async (s) => { calls.push(s); } },
    );
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    expect(store.siteFor(user.id, site.id)!.status).toBe('error');
  });

  it('still ends ready when afterReady throws', async () => {
    const { site, sync } = setup(
      { pull: async () => RESULT, verifyClone: async () => ({ ok: true }) },
      { afterReady: async () => { throw new Error('hook failed'); } },
    );
    const seen: SyncState[] = [];
    sync.subscribe(site, (s) => seen.push(s));
    sync.start(site);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.at(-1)!.status).toBe('ready');
  });

  it('isRunning stays true while the afterReady hook runs; ready emits after it', async () => {
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
    const { store, site, sync } = setup(
      { pull: async () => RESULT, verifyClone: async () => ({ ok: true }) },
      { afterReady: () => hookGate },
    );
    const states: string[] = [];
    sync.subscribe(site, (s) => states.push(s.status));
    sync.start(site);
    await vi.waitFor(() => expect(store.siteById(site.id)!.status).toBe('ready'));
    expect(sync.isRunning(site.id)).toBe(true); // hook still pending — turn starts stay blocked
    expect(states).not.toContain('ready'); // ready not emitted yet
    releaseHook();
    await vi.waitFor(() => expect(states).toContain('ready'));
    expect(sync.isRunning(site.id)).toBe(false);
  });

  it('a throwing afterReady hook still lands the sync as ready', async () => {
    const { site, sync } = setup(
      { pull: async () => RESULT, verifyClone: async () => ({ ok: true }) },
      { afterReady: async () => { throw new Error('hook boom'); } },
    );
    const states: string[] = [];
    sync.subscribe(site, (s) => states.push(s.status));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sync.start(site);
    await vi.waitFor(() => expect(states).toContain('ready'));
    expect(sync.isRunning(site.id)).toBe(false);
    spy.mockRestore();
  });
});

describe('SyncManager snapshot authority', () => {
  it('prefers a persisted error status over a stale active entry', async () => {
    const done = deferred<PullResult>();
    const { store, user, site, sync } = setup({ pull: async () => done.promise });
    sync.start(site);
    expect(sync.isRunning(site.id)).toBe(true);
    // Simulate a leaked active entry (Bug 1): the DB has already moved to 'error'
    // while `active` still holds a stale 'syncing' entry.
    store.setStatus(site.id, 'error', { lastError: 'boom' });
    const staleSite = store.siteFor(user.id, site.id)!;
    expect(sync.snapshot(staleSite)).toMatchObject({ status: 'error', error: 'boom' });
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('prefers a persisted ready status over a stale active entry', async () => {
    const done = deferred<PullResult>();
    const { store, user, site, sync } = setup({ pull: async () => done.promise, verifyClone: async () => ({ ok: true }) });
    sync.start(site);
    const now = new Date().toISOString();
    store.setStatus(site.id, 'ready', { lastError: null, lastSyncAt: now, verifiedAt: now });
    const staleSite = store.siteFor(user.id, site.id)!;
    expect(sync.snapshot(staleSite)).toMatchObject({ status: 'ready', cloneUrl: 'https://klant-nl.ddev.site', verifiedAt: now });
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
  });

  it('returns the running frame when the DB status is genuinely syncing (no regression)', async () => {
    const done = deferred<PullResult>();
    let emit: ((e: PullProgress) => void) | undefined;
    const { store, user, site, sync } = setup({
      pull: async (_slug, opts) => { emit = opts.onProgress; return done.promise; },
    });
    sync.start(site);
    emit!({ phase: 'files', current: 1, total: 2 });
    const syncingSite = store.siteFor(user.id, site.id)!;
    expect(syncingSite.status).toBe('syncing');
    expect(sync.snapshot(syncingSite)).toMatchObject({ status: 'syncing', phase: 'files', current: 1, total: 2 });
    done.resolve(RESULT);
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('sync routes', () => {
  it('starts a sync over HTTP and refuses unpaired sites', async () => {
    const done = deferred<PullResult>();
    const { app } = makeApp({ engine: stubEngine({ link: async () => {}, pull: async () => done.promise, verifyClone: async () => ({ ok: true }) }) });
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
      engine: stubEngine({ link: async () => {}, pull: async (_s, opts) => { emit = opts.onProgress; return done.promise; }, verifyClone: async () => ({ ok: true }) }),
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
