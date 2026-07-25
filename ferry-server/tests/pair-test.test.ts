import { describe, expect, it } from 'vitest';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

async function makeSite(app: import('fastify').FastifyInstance, cookie: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://klant.nl' } });
  return res.json().id as number;
}

describe('pairing', () => {
  it('pairs a site with a valid code', async () => {
    const linked: string[] = [];
    const { app } = makeApp({ engine: stubEngine({ link: async (url, code) => { linked.push(`${url}|${code}`); } }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('paired');
    expect(linked).toEqual(['https://klant.nl|ABCD2345']);
  });

  it('maps multisite refusal to refused_multisite + 422', async () => {
    const { app } = makeApp({
      engine: stubEngine({ link: async () => { throw new Error('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.'); } }),
    });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(422);
    const detail = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie } });
    expect(detail.json().status).toBe('refused_multisite');
  });

  it('keeps status new on a wrong code and refuses re-pairing', async () => {
    const { app } = makeApp({ engine: stubEngine({ link: async () => { throw new Error('Pairing failed (403).'); } }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    let res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'WRONG234' } });
    expect(res.statusCode).toBe(400);
    let detail = await app.inject({ method: 'GET', url: `/api/sites/${id}`, headers: { cookie } });
    expect(detail.json().status).toBe('new');
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(400); // missing code
  });

  it('refuses pairing an already-paired site', async () => {
    const { app } = makeApp({ engine: stubEngine({ link: async () => {} }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    expect(res.statusCode).toBe(409);
  });
});

describe('connection test', () => {
  const info = {
    wp: '6.8', php: { version: '8.1.27', extensions: [], ini: {} },
    db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: '', bytes: 1 },
    server: 'nginx', constants: {}, multisite: false, prefix: 'wp_', abspath: '/', siteurl: 'https://klant.nl',
  };

  it('reports versions for a paired site', async () => {
    const { app } = makeApp({ engine: stubEngine({ link: async () => {}, siteInfo: async () => info as never }) });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    const res = await app.inject({ method: 'POST', url: `/api/sites/${id}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wp: '6.8', php: '8.1.27', db: 'mariadb 10.6.16', server: 'nginx' });
  });

  it('refuses testing an unpaired site and hints on 403', async () => {
    const { app } = makeApp({
      engine: stubEngine({ link: async () => {}, siteInfo: async () => { throw new Error('GET /ferry/v1/info failed (403): blocked'); } }),
    });
    const cookie = await signup(app);
    const id = await makeSite(app, cookie);
    let res = await app.inject({ method: 'POST', url: `/api/sites/${id}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/sites/${id}/pair`, headers: { cookie }, payload: { code: 'ABCD2345' } });
    res = await app.inject({ method: 'POST', url: `/api/sites/${id}/test`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('security plugin');
  });
});
