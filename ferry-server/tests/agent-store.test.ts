import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

function setup() {
  const store = new Store(':memory:');
  const user = store.createUser('a@example.com', 'h')!;
  const site = store.createSite(user.id, 'S', 'https://klant.nl', 'klant-nl')!;
  return { store, site };
}

describe('agent sessions', () => {
  it('creates and returns the current (newest) session per site', () => {
    const { store, site } = setup();
    expect(store.currentAgentSession(site.id)).toBeUndefined();
    const s1 = store.createAgentSession(site.id);
    expect(s1).toMatchObject({ siteId: site.id, sdkSessionId: null, status: 'idle' });
    const s2 = store.createAgentSession(site.id);
    expect(store.currentAgentSession(site.id)!.id).toBe(s2.id);
  });

  it('updates sdk id, status and lastActivityAt', () => {
    const { store, site } = setup();
    const s = store.createAgentSession(site.id);
    store.setAgentSessionSdkId(s.id, 'sdk-abc');
    store.setAgentSessionStatus(s.id, 'running');
    store.touchAgentSession(s.id);
    const cur = store.currentAgentSession(site.id)!;
    expect(cur.sdkSessionId).toBe('sdk-abc');
    expect(cur.status).toBe('running');
    expect(Date.parse(cur.lastActivityAt)).toBeGreaterThan(0);
  });

  it('appends events with increasing seq and pages after a seq', () => {
    const { store, site } = setup();
    const s = store.createAgentSession(site.id);
    const e1 = store.appendAgentEvent(s.id, 'user', { text: 'hi' });
    const e2 = store.appendAgentEvent(s.id, 'agent_text', { text: 'hello' });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect(e1.payload).toEqual({ text: 'hi' });
    const page = store.agentEventsAfter(s.id, e1.seq);
    expect(page.map((e) => e.seq)).toEqual([e2.seq]);
    expect(store.agentEventsAfter(s.id, 0)).toHaveLength(2);
  });

  it('scopes events to their session', () => {
    const { store, site } = setup();
    const s1 = store.createAgentSession(site.id);
    store.appendAgentEvent(s1.id, 'user', { text: 'old' });
    const s2 = store.createAgentSession(site.id);
    expect(store.agentEventsAfter(s2.id, 0)).toHaveLength(0);
  });

  it('recovers interrupted sessions at boot', () => {
    const { store, site } = setup();
    const s = store.createAgentSession(site.id);
    store.setAgentSessionStatus(s.id, 'running');
    expect(store.recoverInterruptedAgentSessions()).toBe(1);
    expect(store.currentAgentSession(site.id)!.status).toBe('idle');
  });
});
