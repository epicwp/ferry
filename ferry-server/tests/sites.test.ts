import { describe, expect, it } from 'vitest';
import { makeApp, signup } from './helpers/testApp.js';

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
});
