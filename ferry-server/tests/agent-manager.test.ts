import { describe, expect, it } from 'vitest';
import { AgentManager } from '../src/agent/manager.js';
import { scriptedRunner } from '../src/agent/scripted-runner.js';
import type { AgentRunner, AgentRunnerOpts, AgentWireEvent, RunnerEvent } from '../src/agent/types.js';
import { Store } from '../src/store.js';

function setup(runner: AgentRunner, idleMs = 60_000) {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  store.setStatus(site.id, 'ready');
  const branchCalls: string[] = [];
  const manager = new AgentManager(store, runner, {
    cloneDir: (slug) => `/clones/${slug}`,
    ensureBranch: async (dir) => { branchCalls.push(dir); },
    idleMs,
  });
  return { store, site: store.siteFor(user.id, site.id)!, manager, branchCalls };
}

async function until(fn: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('AgentManager', () => {
  it('creates a session, persists user + turn events, and fans out incl. deltas', async () => {
    const { store, site, manager, branchCalls } = setup(scriptedRunner());
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    await manager.send(site, 'Why is VAT wrong?');
    expect(branchCalls).toEqual(['/clones/klant-nl']);
    expect(manager.isActive(site.id)).toBe(true);
    await until(() => seen.some((e) => e.type === 'turn_end'));
    const session = store.currentAgentSession(site.id)!;
    expect(session.sdkSessionId).toMatch(/^scripted-/);
    expect(session.status).toBe('idle'); // back to idle after turn_end
    const stored = store.agentEventsAfter(session.id, 0).map((e) => e.type);
    expect(stored).toEqual(['user', 'tool_use', 'tool_result', 'agent_text', 'turn_end']);
    expect(seen.some((e) => e.type === 'text_delta' && e.seq === undefined)).toBe(true); // deltas not persisted
    expect(seen.filter((e) => e.seq !== undefined).map((e) => e.type)).toEqual(stored);
  });

  it('tears down after idle timeout and resumes with the stored sdk session id', async () => {
    const starts: AgentRunnerOpts[] = [];
    const inner = scriptedRunner();
    const recording: AgentRunner = { start: (opts) => { starts.push(opts); return inner.start(opts); } };
    const { site, manager } = setup(recording, 30); // 30ms idle
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    await manager.send(site, 'first');
    await until(() => seen.some((e) => e.type === 'turn_end'));
    await until(() => !manager.isActive(site.id), 2000); // idle teardown fired
    await manager.send(site, 'second');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.resumeSdkSessionId).toBe('scripted-1');
    await manager.shutdown();
  });

  it('newSession interrupts the hot process and starts a fresh session row', async () => {
    const { store, site, manager } = setup(scriptedRunner());
    await manager.send(site, 'first');
    const s1 = store.currentAgentSession(site.id)!;
    await manager.newSession(site);
    expect(manager.isActive(site.id)).toBe(false);
    const s2 = store.currentAgentSession(site.id)!;
    expect(s2.id).not.toBe(s1.id);
    const events = store.agentEventsAfter(s2.id, 0);
    expect(events[0]).toMatchObject({ type: 'status' });
    await manager.send(site, 'fresh start');
    expect(store.currentAgentSession(site.id)!.id).toBe(s2.id);
    await manager.shutdown();
  });

  it('records a runner error as a status event and marks the session error', async () => {
    const failing: AgentRunner = {
      start: (opts) => ({
        send: () => {
          opts.onEvent({ type: 'runner_error', message: 'API key invalid' });
          opts.onEvent({ type: 'exit' });
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      }),
    };
    const { store, site, manager } = setup(failing);
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    await manager.send(site, 'hi');
    await until(() => seen.some((e) => e.type === 'status' && (e.payload as { state?: string }).state === 'error'));
    expect(store.currentAgentSession(site.id)!.status).toBe('error');
    expect(manager.isActive(site.id)).toBe(false); // exit dropped the handle
  });
});
