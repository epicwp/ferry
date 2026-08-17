import { describe, expect, it } from 'vitest';
import { buildSited, type SitedDeps } from '../src/app.js';
import { SECRET, signedHeaders } from './helpers.js';

const okExec: SitedDeps['exec'] = async () => ({ stdout: '', stderr: '', exitCode: 0 });

describe('sited transport', () => {
  it('health is open and empty', async () => {
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec: okExec });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects a missing or wrong signature with 401', async () => {
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec: okExec });
    let res = await app.inject({ method: 'POST', url: '/sql', payload: { kind: 'binlog-status' } });
    expect(res.statusCode).toBe(401);
    const headers = signedHeaders('POST', '/sql', JSON.stringify({ kind: 'binlog-status' }));
    headers['x-ferry-signature'] = 'deadbeef';
    res = await app.inject({ method: 'POST', url: '/sql', headers, payload: { kind: 'binlog-status' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects stale timestamps and replayed nonces', async () => {
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec: okExec });
    const body = JSON.stringify({ kind: 'binlog-status' });
    const stale = signedHeaders('POST', '/sql', body, Math.floor(Date.now() / 1000) - 600);
    expect((await app.inject({ method: 'POST', url: '/sql', headers: stale, payload: body })).statusCode).toBe(401);
    const fresh = signedHeaders('POST', '/sql', body);
    expect((await app.inject({ method: 'POST', url: '/sql', headers: fresh, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/sql', headers: fresh, payload: body })).statusCode).toBe(401); // replay
  });
});
