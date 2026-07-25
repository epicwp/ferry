import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers/testApp.js';

function appWithDist() {
  const dist = mkdtempSync(join(tmpdir(), 'ferry-dist-'));
  writeFileSync(join(dist, 'index.html'), '<html><body>ferry-dashboard</body></html>');
  return makeApp({ staticDir: dist });
}

describe('static dashboard serving', () => {
  it('serves index.html at the root', async () => {
    const { app } = appWithDist();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ferry-dashboard');
  });

  it('falls back to index.html for SPA routes', async () => {
    const { app } = appWithDist();
    const res = await app.inject({ method: 'GET', url: '/sites/12/sync' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ferry-dashboard');
  });

  it('keeps unknown API routes as JSON 404s', async () => {
    const { app } = appWithDist();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
  });
});
