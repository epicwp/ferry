import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link, MultisiteError } from '../src/link.js';
import { loadProfile } from '../src/profile.js';

let server: Server;
let home: string;

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferry-'));
  process.env.FERRY_HOME = home;
});

afterEach(() => {
  server?.close();
  delete process.env.FERRY_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('link', () => {
  it('exchanges the code and stores a profile', async () => {
    const base = await listen((req, res) => {
      expect(req.url).toBe('/wp-json/ferry/v1/pair');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        expect(JSON.parse(body)).toEqual({ code: '7K2P-9QXM' });
        res.end(JSON.stringify({ secret: 's3cret', siteurl: base }));
      });
    });
    const profile = await link(base, '7K2P-9QXM');
    expect(profile.secret).toBe('s3cret');
    expect(loadProfile(profile.slug).secret).toBe('s3cret');
  });

  it('maps the multisite refusal to a typed error', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 'ferry_multisite', message: 'Multisite is not supported.' }));
    });
    const err = await link(base, 'XXXX-XXXX').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultisiteError);
    expect(String((err as Error).message)).toMatch(/multisite/i);
  });

  it('maps a bad code to a clear error', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 403;
      res.end(JSON.stringify({ code: 'ferry_bad_code', message: 'Invalid or expired pairing code.' }));
    });
    await expect(link(base, 'WRON-GCOD')).rejects.toThrowError(/Invalid or expired pairing code/);
  });
});
