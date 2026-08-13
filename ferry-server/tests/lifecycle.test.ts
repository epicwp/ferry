import { describe, expect, it } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

describe('Lifecycle', () => {
  it('registers, closes, and unregisters SSE enders', () => {
    const lc = new Lifecycle();
    const closed: string[] = [];
    lc.registerSse(() => closed.push('a'));
    const unregisterB = lc.registerSse(() => closed.push('b'));
    unregisterB();
    lc.closeAllSse();
    expect(closed).toEqual(['a']);
    lc.closeAllSse(); // second call is a no-op
    expect(closed).toEqual(['a']);
  });

  it('a throwing ender does not block the others', () => {
    const lc = new Lifecycle();
    const closed: string[] = [];
    lc.registerSse(() => { throw new Error('boom'); });
    lc.registerSse(() => closed.push('ok'));
    lc.closeAllSse();
    expect(closed).toEqual(['ok']);
  });
});

describe('shutdown 503 guard', () => {
  it('refuses work-starting routes with 503 once shuttingDown flips', async () => {
    const lifecycle = new Lifecycle();
    const { app } = makeApp({ engine: stubEngine(), lifecycle });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://example.com' } });
    const siteId = created.json().id as number;
    lifecycle.shuttingDown = true;
    for (const url of [`/api/sites/${siteId}/sync`, `/api/sites/${siteId}/pair`]) {
      const res = await app.inject({ method: 'POST', url, headers: { cookie }, payload: { code: 'AAAA-AAAA' } });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'Server is shutting down.' });
    }
    // reads stay available during the drain
    const read = await app.inject({ method: 'GET', url: `/api/sites/${siteId}`, headers: { cookie } });
    expect(read.statusCode).toBe(200);
  });
});
