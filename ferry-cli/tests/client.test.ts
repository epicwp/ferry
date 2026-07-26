import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FerryClient } from '../src/client.js';
import { sign } from '../src/signing.js';

const SECRET = 'test-secret';
let server: Server;

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(() => server?.close());

describe('FerryClient', () => {
  it('signs requests with server-derived time and a valid signature', async () => {
    const skewMs = 120_000; // server clock 2 minutes ahead - beyond the 60s window without syncClock
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      const serverNow = Math.floor((Date.now() + skewMs) / 1000);
      res.setHeader('Date', new Date(Date.now() + skewMs).toUTCString());
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      const ts = req.headers['x-ferry-timestamp'] as string;
      const nonce = req.headers['x-ferry-nonce'] as string;
      const query = Object.fromEntries(url.searchParams);
      const expected = sign(SECRET, 'GET', '/ferry/v1/info', query, '', Number(ts), nonce);
      const fresh = Math.abs(serverNow - Number(ts)) <= 60;
      const valid = expected === req.headers['x-ferry-signature'] && fresh;
      res.statusCode = valid ? 200 : 401;
      res.end(JSON.stringify({ valid }));
    });
    const client = new FerryClient(base, SECRET);
    await client.syncClock();
    const { data } = await client.getJson('/ferry/v1/info');
    expect(data.valid).toBe(true);
  });

  it('retries retryable statuses with backoff', async () => {
    let calls = 0;
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      calls++;
      if (calls === 1) {
        res.statusCode = 503;
        res.setHeader('Retry-After', '0');
        res.end('busy');
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const client = new FerryClient(base, SECRET);
    const { data } = await client.getJson('/ferry/v1/info');
    expect(data.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('uses a fresh nonce on each retried attempt', async () => {
    const nonces: string[] = [];
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      nonces.push(req.headers['x-ferry-nonce'] as string);
      if (nonces.length === 1) {
        res.statusCode = 503;
        res.setHeader('Retry-After', '0');
        res.end('busy');
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const client = new FerryClient(base, SECRET);
    const { data } = await client.getJson('/ferry/v1/info');
    expect(data.ok).toBe(true);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('throws an actionable error on a non-retryable failure', async () => {
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      res.statusCode = 403;
      res.end('{"code":"ferry_unpaired"}');
    });
    const client = new FerryClient(base, SECRET);
    await expect(client.getJson('/ferry/v1/info')).rejects.toThrowError(/403.*ferry_unpaired/s);
  });

  it('throws allowlist guidance when retryable statuses exhaust all attempts', async () => {
    let calls = 0;
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      calls++;
      res.statusCode = 503;
      res.setHeader('Retry-After', '0');
      res.end('rate limited');
    });
    const client = new FerryClient(base, SECRET);
    await expect(client.getJson('/ferry/v1/info')).rejects.toThrowError(/allowlist.*ferry\/v1/s);
    expect(calls).toBe(5);
  });
});
