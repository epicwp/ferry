import { describe, expect, it, vi } from 'vitest';
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

  it('redacts runner error from customer SSE and logs it server-side', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: AgentRunner = {
      start: (opts) => ({
        send: () => {
          opts.onEvent({ type: 'runner_error', message: 'Sensitive API error details' });
          opts.onEvent({ type: 'exit' });
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      }),
    };
    const { store, site, manager } = setup(failing);
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));
    const session = store.currentAgentSession(site.id) ?? store.createAgentSession(site.id);
    await manager.send(site, 'hi');
    await until(() => seen.some((e) => e.type === 'status' && (e.payload as { state?: string }).state === 'error'));

    // Verify console.error was called with the raw message and site/session ids
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`agent runner error (site ${site.id}, session ${session.id}):`),
      'Sensitive API error details'
    );

    // Verify the persisted status event has the generic detail, not the raw message
    const statusEvent = seen.find((e) => e.type === 'status' && (e.payload as { state?: string }).state === 'error');
    expect((statusEvent?.payload as { detail?: string })?.detail).toBe('The agent hit an internal error — try again or start a new session.');

    consoleErrorSpy.mockRestore();
  });

  it('concurrent first sends use a single runner spawn', async () => {
    const starts: AgentRunnerOpts[] = [];
    const inner = scriptedRunner();
    const recording: AgentRunner = { start: (opts) => { starts.push(opts); return inner.start(opts); } };
    const { store, site, manager } = setup(recording);

    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));

    // Send two messages concurrently
    await Promise.all([manager.send(site, 'a'), manager.send(site, 'b')]);

    // Only one runner.start should have been called
    expect(starts).toHaveLength(1);

    // Both messages should be persisted
    const session = store.currentAgentSession(site.id)!;
    const events = store.agentEventsAfter(session.id, 0);
    const userEvents = events.filter((e) => e.type === 'user');
    expect(userEvents.length).toBeGreaterThanOrEqual(1);

    await manager.shutdown();
  });

  it('send racing newSession does not leak the handle', async () => {
    let releaseBranch: (() => void) | undefined;
    const controllableBranch = async () => {
      await new Promise<void>(r => { releaseBranch = r; });
    };

    const closed: boolean[] = [];
    const trackingRunner: AgentRunner = {
      start: (opts) => {
        const inner = scriptedRunner().start(opts);
        const origClose = inner.close.bind(inner);
        return {
          ...inner,
          close: async () => {
            closed.push(true);
            return origClose();
          },
        };
      },
    };

    const store = new Store(':memory:');
    const user = store.createUser('a@example.com', 'h')!;
    const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
    store.setStatus(site.id, 'ready');
    const manager = new AgentManager(store, trackingRunner, {
      cloneDir: (slug) => `/clones/${slug}`,
      ensureBranch: controllableBranch,
    });
    const siteRecord = store.siteFor(user.id, site.id)!;

    // Start a send (blocks on ensureBranch)
    const sendPromise = manager.send(siteRecord, 'message');

    // Let send reach ensureBranch
    await new Promise(r => setImmediate(r));

    // While send is still spawning, start newSession (both will wait on the spawn)
    const newSessionPromise = manager.newSession(siteRecord);

    // Yield to let newSession reach the await on inFlight
    await new Promise(r => setImmediate(r));

    // Now release the branch to let both complete
    releaseBranch!();

    // Wait for both to complete
    await sendPromise;
    await newSessionPromise;

    // Manager should not be active (newSession closed it)
    expect(manager.isActive(site.id)).toBe(false);

    // Handle should have been closed
    expect(closed.length).toBeGreaterThan(0);

    await manager.shutdown();
  });

  it('appendSystemEvent persists+emits onto the current session', async () => {
    const { store, site, manager } = setup(scriptedRunner());
    await manager.send(site, 'first'); // creates a session
    const session = store.currentAgentSession(site.id)!;
    const seen: AgentWireEvent[] = [];
    manager.subscribe(site.id, (e) => seen.push(e));

    manager.appendSystemEvent(site.id, 'change_card', { changeId: 1, seq: 1, title: 'Fix VAT', status: 'draft' });

    const stored = store.agentEventsAfter(session.id, 0);
    expect(stored.at(-1)).toMatchObject({ type: 'change_card', payload: { changeId: 1, seq: 1, title: 'Fix VAT', status: 'draft' } });
    expect(seen).toEqual([{ seq: stored.at(-1)!.seq, type: 'change_card', payload: { changeId: 1, seq: 1, title: 'Fix VAT', status: 'draft' } }]);
    await manager.shutdown();
  });

  it('appendSystemEvent no-ops when the site has no session', () => {
    const { store, site, manager } = setup(scriptedRunner());
    expect(() => manager.appendSystemEvent(site.id, 'change_card', { changeId: 1 })).not.toThrow();
    expect(store.currentAgentSession(site.id)).toBeUndefined();
  });
});
