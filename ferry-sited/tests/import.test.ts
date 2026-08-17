import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildSited, sitedCanonical, type SitedDeps } from '../src/app.js';
import { SECRET } from './helpers.js';

/** Signs and injects a raw-byte-body request, as sited's clients would for /db/import and /files. */
function injectRaw(app: FastifyInstance, method: string, path: string, body: Buffer) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', SECRET).update(sitedCanonical(method, path, {}, bodyHash, ts, nonce)).digest('hex');
  const headers = {
    'x-ferry-timestamp': String(ts),
    'x-ferry-nonce': nonce,
    'x-ferry-signature': sig,
    'content-type': 'application/octet-stream',
  };
  return app.inject({ method: method as InjectOptions['method'], url: path, headers, payload: body });
}

describe('POST /db/import', () => {
  it('pipes the raw body into mysql db and returns 204', async () => {
    const sql = Buffer.from('CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n', 'utf8');
    const exec: SitedDeps['exec'] = async (cmd, args, opts) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db']);
      expect(opts?.input).toEqual(sql);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const res = await injectRaw(app, 'POST', '/db/import', sql);
    expect(res.statusCode).toBe(204);
  });

  it('propagates a failing import as 500 with stderr excerpt', async () => {
    const exec: SitedDeps['exec'] = async () => ({ stdout: '', stderr: 'ERROR 1064 (42000): syntax error near X', exitCode: 1 });
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const res = await injectRaw(app, 'POST', '/db/import', Buffer.from('BAD SQL;'));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'ERROR 1064 (42000): syntax error near X' });
  });
});
