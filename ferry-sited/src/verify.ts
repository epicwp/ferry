import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const WINDOW_S = 300;
const MAX_NONCES = 10_000;

export function sitedCanonical(
  method: string,
  path: string,
  query: Record<string, string>,
  bodySha256Hex: string,
  timestamp: number,
  nonce: string,
): string {
  const pairs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`);
  return `${method.toUpperCase()}\n${path}\n${pairs.join('&')}\n${bodySha256Hex}\n${timestamp}\n${nonce}`;
}

/** Signed-request gate. The canonical embeds a body HASH (not the body) so multi-MB
 *  tar/sql payloads can be hashed streaming on the client without double-buffering. */
export function makeVerify(secret: string) {
  const seen = new Set<string>();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ts = Number(request.headers['x-ferry-timestamp']);
    const nonce = String(request.headers['x-ferry-nonce'] ?? '');
    const sig = String(request.headers['x-ferry-signature'] ?? '');
    const deny = () => reply.code(401).send({ error: 'unauthorized' });
    if (!Number.isFinite(ts) || nonce === '' || sig === '') return deny();
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > WINDOW_S) return deny();
    if (seen.has(nonce)) return deny();
    const rawBody = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    const url = new URL(request.url, 'http://sited.local');
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const expected = createHmac('sha256', secret)
      .update(sitedCanonical(request.method, url.pathname, query, bodyHash, ts, nonce))
      .digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny();
    if (seen.size >= MAX_NONCES) seen.clear(); // bounded memory; window check still limits replay
    seen.add(nonce);
  };
}
