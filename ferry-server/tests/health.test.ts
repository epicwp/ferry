import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers/testApp.js';

describe('GET /api/health', () => {
  it('returns 200 {ok:true} without a session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns a generic 500 when the DB is unavailable', async () => {
    const { app, store } = makeApp();
    store.close();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal server error' });
  });
});
