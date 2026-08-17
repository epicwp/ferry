import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sitedCanonical } from '../src/app.js';

export const SECRET = 'test-secret';

export function signedHeaders(
  method: string,
  path: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const nonce = randomBytes(8).toString('hex');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', SECRET).update(sitedCanonical(method, path, {}, bodyHash, ts, nonce)).digest('hex');
  return { 'x-ferry-timestamp': String(ts), 'x-ferry-nonce': nonce, 'x-ferry-signature': sig, 'content-type': 'application/json' };
}

/** Signs and injects a POST to `path` with a JSON `payload`, as sited's clients would. */
export function inject(app: FastifyInstance, method: string, path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const headers = signedHeaders(method, path, body);
  return app.inject({ method: method as InjectOptions['method'], url: path, headers, payload: body });
}
