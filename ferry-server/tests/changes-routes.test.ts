import { describe, expect, it } from 'vitest';
import { scriptedRunner } from '../src/agent/scripted-runner.js';
import type { AgentRunner, AgentWireEvent } from '../src/agent/types.js';
import { scriptedPushRunner } from '../src/push/scripted-push-runner.js';
import type { PushWireEvent } from '../src/push-manager.js';
import type { StepEvent } from '../src/push/types.js';
import type { Change } from '../src/store.js';
import { agentDeps, makeApp, signup, stubEngine } from './helpers/testApp.js';

type TestApp = ReturnType<typeof makeApp>;

const FIELDS = {
  title: 'Fix VAT calc', summary: 'VAT was computed pre-discount.', branch: 'agent/work',
  baseSha: 'aaa', headSha: 'bbb', diffText: '--- a\n+++ b\n',
  files: [], ops: [{ kind: 'option_set' as const, name: 'blogname', old: 'A', new: 'B' }],
  preconditions: [], smoke: [{ label: 'home', path: '/', expectStatus: 200 }],
};

async function readySite(app: TestApp['app'], cookie: string, store: TestApp['store']) {
  const res = await app.inject({
    method: 'POST', url: '/api/sites', headers: { cookie },
    payload: { name: 'S', url: 'https://klant.nl' },
  });
  const site = res.json() as { id: number };
  store.setStatus(site.id, 'ready');
  return site;
}

function draftChange(store: TestApp['store'], siteId: number): Change {
  return store.createChange(siteId, FIELDS);
}

async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sseEvents<T>(body: string): T[] {
  return body.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice('data: '.length)) as T);
}

describe('changes routes', () => {
  it('lists and reads changes, optionally filtered by status', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const c1 = draftChange(store, site.id);
    store.setChangeStatus(c1.id, 'pushed', { pushedAt: new Date().toISOString() });
    const c2 = draftChange(store, site.id);

    const list = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes`, headers: { cookie } });
    expect((list.json() as { changes: Change[] }).changes.map((c) => c.seq)).toEqual([c1.seq, c2.seq]);

    const filtered = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes?status=draft`, headers: { cookie } });
    expect((filtered.json() as { changes: Change[] }).changes.map((c) => c.seq)).toEqual([c2.seq]);

    const detail = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes/${c1.seq}`, headers: { cookie } });
    expect((detail.json() as Change).status).toBe('pushed');
  });

  it('pushes a draft change (202), then refuses a second concurrent push (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    const first = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    expect(second.statusCode).toBe(409);

    await until(() => store.changeBySeq(site.id, change.seq)!.status !== 'pushing');
    expect(store.changeBySeq(site.id, change.seq)!.status).toBe('pushed');
  });

  it('allows a push while the agent session is hot but idle', async () => {
    const { app, store } = makeApp({
      engine: stubEngine(), agent: agentDeps(scriptedRunner()), push: { runner: scriptedPushRunner() },
    });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'hi' } });
    await until(() => store.currentAgentSession(site.id)?.status === 'idle');
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
  });

  it('refuses a push mid-turn', async () => {
    const runner: AgentRunner = {
      start: (_opts) => ({
        send: () => { /* never emits turn_end - the turn never completes */ },
        interrupt: async () => undefined,
        close: async () => undefined,
      }),
    };
    const { app, store } = makeApp({
      engine: stubEngine(), agent: agentDeps(runner), push: { runner: scriptedPushRunner() },
    });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'hi' } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'The agent is working on this site — finish or start a new session first.' });
  });

  it('refuses to push while a sync is running (409)', async () => {
    const engine = stubEngine({ pull: () => new Promise(() => {}), verifyClone: async () => ({ ok: true }) });
    const { app, store } = makeApp({ engine, push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('refuses to push a non-draft change (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);
    store.setChangeStatus(change.id, 'discarded');

    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('force-pushes a conflicted change', async () => {
    const base = scriptedPushRunner();
    let sawForce: boolean | undefined;
    const runner = {
      ...base,
      push: (slug: string, spec: Parameters<typeof base.push>[1], opts: Parameters<typeof base.push>[2]) => {
        sawForce = opts.force;
        return base.push(slug, spec, opts);
      },
    };
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);
    store.setChangeStatus(change.id, 'conflict', { conflict: [{ key: 'wp_options.blogname', expected: 'A', found: 'C' }] });

    const res = await app.inject({
      method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie }, payload: { force: true },
    });
    expect(res.statusCode).toBe(202);
    await until(() => store.changeBySeq(site.id, change.seq)!.status !== 'pushing');
    expect(sawForce).toBe(true);
  });

  it('refuses a plain push of a conflicted change', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);
    store.setChangeStatus(change.id, 'conflict', { conflict: [{ key: 'wp_options.blogname', expected: 'A', found: 'C' }] });

    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Only a draft change can be pushed.' });
  });

  it('mutually excludes push against sync and agent in the other direction too', async () => {
    const engine = stubEngine({ pull: () => new Promise(() => {}), verifyClone: async () => ({ ok: true }) });
    const { app, store } = makeApp({ engine, agent: agentDeps(scriptedRunner()), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    const syncRes = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    expect(syncRes.statusCode).toBe(409);
    const msgRes = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'hi' } });
    expect(msgRes.statusCode).toBe(409);
  });

  it('discards a draft change, but refuses a pushed one (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const draft = draftChange(store, site.id);
    const pushed = draftChange(store, site.id);
    store.setChangeStatus(pushed.id, 'pushed', { pushedAt: new Date().toISOString() });

    const ok = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${draft.seq}/discard`, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(store.changeBySeq(site.id, draft.seq)!.status).toBe('discarded');

    const refused = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${pushed.seq}/discard`, headers: { cookie } });
    expect(refused.statusCode).toBe(409);
  });

  it('rolls back a pushed change, but refuses anything other than exactly pushed (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const draft = draftChange(store, site.id);
    const refusedOnDraft = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${draft.seq}/rollback`, headers: { cookie } });
    expect(refusedOnDraft.statusCode).toBe(409);

    const pushed = draftChange(store, site.id);
    store.setChangeStatus(pushed.id, 'pushed', { backupTxid: 'txabc', pushedAt: new Date().toISOString() });
    const ok = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${pushed.seq}/rollback`, headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(store.changeBySeq(site.id, pushed.seq)!.status).toBe('rolled_back');

    // A second rollback of the now-rolled-back change must be refused, not wedge the plugin tx.
    const second = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${pushed.seq}/rollback`, headers: { cookie } });
    expect(second.statusCode).toBe(409);
  });

  it('refuses to roll back while a (different) push is in progress for the site (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const pushed = draftChange(store, site.id);
    store.setChangeStatus(pushed.id, 'pushed', { backupTxid: 'txabc', pushedAt: new Date().toISOString() });
    const pushing = draftChange(store, site.id);

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${pushing.seq}/push`, headers: { cookie } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${pushed.seq}/rollback`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(store.changeBySeq(site.id, pushed.seq)!.status).toBe('pushed'); // untouched
  });

  it('retry sends a message containing the conflicting key, and leaves the change conflicted', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);
    store.setChangeStatus(change.id, 'conflict', { conflict: [{ key: 'wp_options.blogname', expected: 'A', found: 'C' }] });

    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/retry`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 20));

    const history = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/agent/history`, headers: { cookie } });
    const events = (history.json() as { events: AgentWireEvent[] }).events;
    const userEvent = events.find((e) => e.type === 'user')!;
    expect((userEvent.payload as { text: string }).text).toContain('wp_options.blogname');
    expect(store.changeBySeq(site.id, change.seq)!.status).toBe('conflict');
  });

  it('refuses retry on a non-conflicted change (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/retry`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('refuses retry while a sync is running (409)', async () => {
    const engine = stubEngine({ pull: () => new Promise(() => {}), verifyClone: async () => ({ ok: true }) });
    const { app, store } = makeApp({ engine, agent: agentDeps(scriptedRunner()), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);
    store.setChangeStatus(change.id, 'conflict', { conflict: [{ key: 'wp_options.blogname', expected: 'A', found: 'C' }] });

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/retry`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('refuses retry while a push is in progress for the site (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const conflicted = draftChange(store, site.id);
    store.setChangeStatus(conflicted.id, 'conflict', { conflict: [{ key: 'wp_options.blogname', expected: 'A', found: 'C' }] });
    const pushing = draftChange(store, site.id);

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${pushing.seq}/push`, headers: { cookie } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${conflicted.seq}/retry`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('replays push events over SSE with ?after and no duplicates', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    await until(() => store.changeBySeq(site.id, change.seq)!.status !== 'pushing');

    const res = await app.inject({
      method: 'GET', url: `/api/sites/${site.id}/push/events?after=0`, headers: { cookie },
      payloadAsStream: true,
    });
    const chunks: Buffer[] = [];
    const stream = res.stream();
    stream.on('data', (c: Buffer) => chunks.push(c));
    await new Promise((r) => setTimeout(r, 50));
    stream.destroy();
    const events = sseEvents<PushWireEvent>(Buffer.concat(chunks).toString('utf8'));
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.filter((e) => e.type === 'push_step')).toHaveLength(13); // 6 steps x (start + ok) + the drift crash-marker start (push.ts:124)
    const driftStarts = events.filter((e) => e.type === 'push_step')
      .map((e) => e.payload as StepEvent)
      .filter((p) => p.step === 'drift' && p.status === 'start');
    expect(driftStarts).toHaveLength(2); // faithful to the real runner — the UI must dedupe
    expect(events.filter((e) => e.type === 'push_done')).toHaveLength(1);
  });

  it('streams live push events over SSE, each exactly once', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    // Connect before the push starts, so this exercises the live subscribe path.
    const res = await app.inject({
      method: 'GET', url: `/api/sites/${site.id}/push/events?after=0`, headers: { cookie },
      payloadAsStream: true,
    });
    const chunks: Buffer[] = [];
    const stream = res.stream();
    stream.on('data', (c: Buffer) => chunks.push(c));

    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/changes/${change.seq}/push`, headers: { cookie } });
    await until(() => store.changeBySeq(site.id, change.seq)!.status !== 'pushing');
    stream.destroy();

    const events = sseEvents<PushWireEvent>(Buffer.concat(chunks).toString('utf8'));
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.filter((e) => e.type === 'push_step')).toHaveLength(13); // 6 steps x (start + ok) + the drift crash-marker start (push.ts:124)
    expect(events.filter((e) => e.type === 'push_done')).toHaveLength(1);
  });

  it('previews drift for a draft change', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = store.createChange(site.id, {
      ...FIELDS,
      files: [
        { path: 'a.php', oldHash: 'scripted-a.php', newHash: 'x' },
        { path: 'b.php', oldHash: 'wrong', newHash: 'y' },
      ],
    });

    const res = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes/${change.seq}/drift`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ checked: 2, mismatches: ['b.php'] });
  });

  it('refuses a drift preview for a non-draft change (409)', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner: scriptedPushRunner() } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);
    store.setChangeStatus(change.id, 'pushed', { pushedAt: new Date().toISOString() });

    const res = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes/${change.seq}/drift`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('502s when the runner cannot reach the site', async () => {
    const runner = scriptedPushRunner();
    const { app, store } = makeApp({
      engine: stubEngine(),
      push: { runner: { ...runner, hashes: async () => { throw new Error('unreachable'); } } },
    });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    const res = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes/${change.seq}/drift`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Could not reach the site for a drift check.' });
  });

  it('502s when the runner has no drift preview support', async () => {
    const base = scriptedPushRunner();
    const runner = { push: base.push, rollback: base.rollback, txStatus: base.txStatus };
    const { app, store } = makeApp({ engine: stubEngine(), push: { runner } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const change = draftChange(store, site.id);

    const res = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/changes/${change.seq}/drift`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Drift preview is not available.' });
  });
});
