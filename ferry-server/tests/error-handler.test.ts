import { describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers/testApp.js';

describe('global error handler', () => {
  it('returns a generic 500 and logs the detail server-side', async () => {
    const { app } = makeApp();
    app.get('/boom', () => {
      throw new Error('secret-internal-detail');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal server error' });
    expect(res.body).not.toContain('secret-internal-detail');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('GET /boom'), expect.any(Error));
    spy.mockRestore();
  });

  it('passes 4xx throws through with their message', async () => {
    const { app } = makeApp();
    app.get('/teapot', () => {
      const err = new Error('I refuse.') as Error & { statusCode: number };
      err.statusCode = 418;
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/teapot' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: 'I refuse.' });
  });
});
