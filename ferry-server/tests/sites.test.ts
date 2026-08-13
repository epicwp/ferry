import { describe, expect, it } from 'vitest';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

describe('site routes', () => {
  it('creates a site with derived slug and lists it', async () => {
    const { app } = makeApp();
    const cookie = await signup(app);
    let res = await app.inject({
      method: 'POST', url: '/api/sites', headers: { cookie },
      payload: { name: 'My Shop', url: 'https://www.klant.nl' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'My Shop', url: 'https://www.klant.nl', slug: 'klant-nl', status: 'new' });
    expect(JSON.stringify(res.json())).not.toContain('secret');
    res = await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } });
    expect(res.json()).toHaveLength(1);
  });

  it('rejects invalid input and duplicate slugs', async () => {
    const { app } = makeApp();
    const cookie = await signup(app);
    let res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: '', url: 'https://a.example' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'X', url: 'not a url' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'X', url: 'ftp://a.example' } });
    expect(res.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'A', url: 'https://dup.example' } });
    res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'B', url: 'https://dup.example' } });
    expect(res.statusCode).toBe(409);
  });

  it('hides other users\' sites', async () => {
    const { app } = makeApp();
    const cookieA = await signup(app, 'a@example.com');
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie: cookieA }, payload: { name: 'A', url: 'https://a.example' } });
    const id = created.json().id as number;
    const cookieB = await signup(app, 'b@example.com');
    let res = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(res.statusCode).toBe(401);
  });

  it('rate-limits pairing to 5 attempts per site and stops calling the site', async () => {
    let linkCalls = 0;
    const engine = stubEngine({
      link: () => { linkCalls++; return Promise.reject(new Error('Invalid or expired pairing code.')); },
    });
    const { app } = makeApp({ engine });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://example.com' } });
    const siteId = created.json().id as number;
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: `/api/sites/${siteId}/pair`, headers: { cookie }, payload: { code: 'AAAA-AAAA' } });
      expect(res.statusCode).toBe(400); // engine.link rejected — attempt consumed
    }
    const limited = await app.inject({ method: 'POST', url: `/api/sites/${siteId}/pair`, headers: { cookie }, payload: { code: 'AAAA-AAAA' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'Too many pairing attempts. Try again later.' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(linkCalls).toBe(5);
  });
});
