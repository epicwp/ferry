import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptedRunner } from '../src/agent/scripted-runner.js';
import type { AgentWireEvent } from '../src/agent/types.js';
import { agentDeps, makeApp, signup, stubEngine } from './helpers/testApp.js';

type TestApp = ReturnType<typeof makeApp>;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** A clone on agent/work, optionally with an uncommitted change (Finding 2: dirty-worktree gate). */
function makeAgentClone(dirty: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-sync-agent-'));
  git(dir, 'init', '-b', 'production');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'index.php'), '<?php // wp');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'pull');
  git(dir, 'branch', 'agent/work');
  git(dir, 'checkout', 'agent/work');
  if (dirty) writeFileSync(join(dir, 'fix.php'), '<?php // wip');
  return dir;
}

async function readySite(app: TestApp['app'], cookie: string, store: TestApp['store']) {
  const res = await app.inject({
    method: 'POST', url: '/api/sites', headers: { cookie },
    payload: { name: 'S', url: 'https://klant.nl' },
  });
  const site = res.json() as { id: number };
  store.setStatus(site.id, 'ready');
  return site;
}

function sseEvents(body: string): AgentWireEvent[] {
  return body.split('\n\n').filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice('data: '.length)) as AgentWireEvent);
}

describe('agent routes', () => {
  it('accepts a message, persists the turn, serves history', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const send = await app.inject({
      method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie },
      payload: { text: 'Why is VAT wrong?' },
    });
    expect(send.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 150)); // scripted turn completes
    const history = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/agent/history`, headers: { cookie } });
    expect(history.statusCode).toBe(200);
    const body = history.json() as { sessionId: number; events: AgentWireEvent[] };
    expect(body.events.map((e) => e.type)).toEqual(['user', 'tool_use', 'tool_result', 'agent_text', 'turn_end']);
    const after = await app.inject({
      method: 'GET', url: `/api/sites/${site.id}/agent/history?after=${body.events[2]!.seq}`, headers: { cookie },
    });
    expect((after.json() as { events: AgentWireEvent[] }).events.map((e) => e.type)).toEqual(['agent_text', 'turn_end']);
  });

  it('validates input and status', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const empty = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: '  ' } });
    expect(empty.statusCode).toBe(400);
    store.setStatus(site.id, 'paired');
    const notReady = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'hi' } });
    expect(notReady.statusCode).toBe(409);
    expect((notReady.json() as { error: string }).error).toBe('Sync the site first.');
  });

  it('starts a new session via the escape hatch', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'a' } });
    await new Promise((r) => setTimeout(r, 150));
    const s1 = store.currentAgentSession(site.id)!.id;
    const fresh = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/sessions`, headers: { cookie } });
    expect(fresh.statusCode).toBe(200);
    expect(store.currentAgentSession(site.id)!.id).not.toBe(s1);
    const history = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/agent/history`, headers: { cookie } });
    expect((history.json() as { events: AgentWireEvent[] }).events.map((e) => e.type)).toEqual(['status']); // fresh session
  });

  it('replays persisted events over SSE with ?after and no duplicates', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'a' } });
    await new Promise((r) => setTimeout(r, 150));
    const res = await app.inject({
      method: 'GET', url: `/api/sites/${site.id}/agent/events?after=0`, headers: { cookie },
      payloadAsStream: true,
    });
    // fastify inject with a hijacked SSE reply: read what has been written, then the test ends.
    const chunks: Buffer[] = [];
    const stream = res.stream();
    stream.on('data', (c: Buffer) => chunks.push(c));
    await new Promise((r) => setTimeout(r, 100));
    stream.destroy();
    const events = sseEvents(Buffer.concat(chunks).toString('utf8'));
    const seqs = events.filter((e) => e.seq !== undefined).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate replays
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['user', 'agent_text', 'turn_end']));
  });

  it('mutually excludes sync and agent per site', async () => {
    let releasePull: () => void = () => undefined;
    const engine = stubEngine({
      pull: () => new Promise((resolve) => { releasePull = () => resolve({ url: 'https://x.ddev.site' } as never); }),
      verifyClone: async () => ({ ok: true }),
    });
    const { app, store } = makeApp({ engine, agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    // agent active -> sync refused
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'a' } });
    const syncWhileAgent = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    expect(syncWhileAgent.statusCode).toBe(409);
    // fresh site: sync running -> agent refused
    await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/sessions`, headers: { cookie } }); // drops hot handle
    const syncStart = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    expect(syncStart.statusCode).toBe(202);
    const msgWhileSync = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie }, payload: { text: 'b' } });
    expect(msgWhileSync.statusCode).toBe(409);
    expect((msgWhileSync.json() as { error: string }).error).toBe('A sync is running for this site.');
    releasePull();
  });

  it('refuses to sync when the agent clone has uncommitted work on agent/work', async () => {
    const dir = makeAgentClone(true);
    const engine = stubEngine({ pull: async () => ({ url: 'https://x.ddev.site' } as never), verifyClone: async () => ({ ok: true }) });
    const { app, store } = makeApp({ engine, agent: { ...agentDeps(scriptedRunner()), cloneDir: () => dir } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('The agent has uncommitted work — ask it to commit, or start a new session first.');
  });

  it('allows sync when the agent clone is clean', async () => {
    const dir = makeAgentClone(false);
    const engine = stubEngine({ pull: async () => ({ url: 'https://x.ddev.site' } as never), verifyClone: async () => ({ ok: true }) });
    const { app, store } = makeApp({ engine, agent: { ...agentDeps(scriptedRunner()), cloneDir: () => dir } });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    const res = await app.inject({ method: 'POST', url: `/api/sites/${site.id}/sync`, headers: { cookie } });
    expect(res.statusCode).toBe(202);
  });

  it('streams live events over SSE, each exactly once, including a text_delta', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const site = await readySite(app, cookie, store);
    // Open the SSE connection BEFORE any message exists, so what follows exercises the
    // live subscribe path (not the persisted-history replay path).
    const res = await app.inject({
      method: 'GET', url: `/api/sites/${site.id}/agent/events?after=0`, headers: { cookie },
      payloadAsStream: true,
    });
    const chunks: Buffer[] = [];
    const stream = res.stream();
    stream.on('data', (c: Buffer) => chunks.push(c));
    await app.inject({
      method: 'POST', url: `/api/sites/${site.id}/agent/messages`, headers: { cookie },
      payload: { text: 'a' },
    });
    await new Promise((r) => setTimeout(r, 150)); // scripted turn completes
    stream.destroy();
    const events = sseEvents(Buffer.concat(chunks).toString('utf8'));
    const seqs = events.filter((e) => e.seq !== undefined).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    for (const type of ['user', 'tool_use', 'tool_result', 'agent_text', 'turn_end']) {
      expect(events.filter((e) => e.type === type)).toHaveLength(1); // each live event exactly once
    }
    expect(events.some((e) => e.type === 'text_delta' && e.seq === undefined)).toBe(true);
  });

  it('context returns 409 for a non-ready site', async () => {
    const { app, store } = makeApp({ engine: stubEngine(), agent: agentDeps(scriptedRunner()) });
    const cookie = await signup(app);
    const res0 = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
    const site = res0.json() as { id: number };
    const res = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/agent/context`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });
});
