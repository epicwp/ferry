import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';

export interface MockPlugin {
  base: string;
  requests: { files: string[][]; db: Record<string, string>[]; manifest: Record<string, string>[] };
  close(): void;
}

export interface DbBatchFixture { sql: string; lastKey: number; complete: boolean; }
export interface DbTableFixture {
  name: string; rows: number; bytes: number;
  pk: string | null; maxpk: number | null;
  batches: DbBatchFixture[];
}

/**
 * In-memory stand-in for the plugin's REST surface, serving files from a
 * fixture directory. Ignores signatures (client auth is covered by the
 * client tests); implements the wire contract of Task 9.
 */
export async function startMockPlugin(
  fixtureDir: string,
  opts: {
    partialFirstBatch?: boolean;
    dbTables?: DbTableFixture[];
    info?: object;
    manifest?: { path: string; size: number; hash: string | null }[];
    skipSupported?: boolean;
  } = {},
): Promise<MockPlugin> {
  let firstFilesCall = true;
  const requests = { files: [] as string[][], db: [] as Record<string, string>[], manifest: [] as Record<string, string>[] };

  async function buildBatch(paths: string[], complete: boolean, nextIndex: number): Promise<Buffer> {
    const staging = mkdtempSync(join(tmpdir(), 'ferry-mock-'));
    for (const p of paths) {
      const dest = join(staging, p);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(fixtureDir, p), dest);
    }
    writeFileSync(
      join(staging, '.ferry-meta.json'),
      JSON.stringify({ complete, next_index: nextIndex, skipped: [] }),
    );
    const chunks: Buffer[] = [];
    const stream = tar.create({ gzip: true, cwd: staging }, [...paths, '.ferry-meta.json']);
    for await (const c of stream) {
      chunks.push(c as Buffer);
    }
    rmSync(staging, { recursive: true, force: true });
    return Buffer.concat(chunks);
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/wp-json/ferry/v1/db/tables' && req.method === 'GET') {
      const tables = (opts.dbTables ?? []).map(({ batches, ...t }) => t);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tables }));
      return;
    }
    if (url.pathname === '/wp-json/ferry/v1/db' && req.method === 'GET') {
      const table = (opts.dbTables ?? []).find((t) => t.name === url.searchParams.get('table'));
      if (!table) {
        res.statusCode = 404;
        res.end('{"code":"ferry_unknown_table"}');
        return;
      }
      requests.db.push(Object.fromEntries(url.searchParams.entries()));
      const skip = url.searchParams.get('skip');
      if (skip !== null && opts.skipSupported !== false) {
        res.setHeader('X-Ferry-Skip', skip);
      }
      if (table.pk !== null && url.searchParams.get('before') !== String(table.maxpk)) {
        res.statusCode = 500;
        res.end('missing or wrong before= snapshot bound');
        return;
      }
      const after = Number(url.searchParams.get('after'));
      const batch = table.batches.find((b, i) => (i === 0 ? after === 0 : after === table.batches[i - 1].lastKey));
      if (!batch) {
        res.statusCode = 500;
        res.end(`no scripted batch for after=${after}`);
        return;
      }
      res.setHeader('content-type', 'application/gzip');
      res.setHeader('X-Complete', batch.complete ? '1' : '0');
      res.setHeader('X-Last-Key', String(batch.lastKey));
      res.end(gzipSync(Buffer.from(batch.sql)));
      return;
    }
    if (url.pathname === '/wp-json/ferry/v1/info' && req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(opts.info ?? {}));
      return;
    }
    if (url.pathname === '/wp-json/ferry/v1/manifest' && req.method === 'GET') {
      requests.manifest.push(Object.fromEntries(url.searchParams.entries()));
      const manifest = opts.manifest ?? [];
      const after = Number(url.searchParams.get('after') ?? '0');
      const batchSize = Math.max(1, Math.ceil(manifest.length / 2)); // force one resume round-trip
      const files = manifest.slice(after, after + batchSize);
      const next = after + files.length;
      res.setHeader('content-type', 'application/json');
      res.setHeader('X-Complete', next >= manifest.length ? '1' : '0');
      res.setHeader('X-Next-Index', String(next));
      res.end(JSON.stringify({ files }));
      return;
    }
    if (url.pathname !== '/wp-json/ferry/v1/files' || req.method !== 'POST') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const params = JSON.parse(body);
      if (params.path !== undefined) {
        // Range mode: raw bytes of one file.
        const data = readFileSync(join(fixtureDir, params.path));
        res.setHeader('content-type', 'application/octet-stream');
        res.end(data.subarray(params.offset, params.offset + params.length));
        return;
      }
      const paths: string[] = params.paths;
      requests.files.push(paths);
      res.setHeader('content-type', 'application/gzip');
      if (opts.partialFirstBatch && firstFilesCall && paths.length > 1) {
        firstFilesCall = false;
        res.end(await buildBatch(paths.slice(0, 1), false, 1));
        return;
      }
      res.end(await buildBatch(paths, true, paths.length));
    });
  });

  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { base, requests, close: () => server.close() };
}

/** Size helper for building manifests from fixtures. */
export function sizeOf(fixtureDir: string, path: string): number {
  return statSync(join(fixtureDir, path)).size;
}

/** MD5 helper for building hash-bearing manifests from fixtures. */
export function hashOf(fixtureDir: string, path: string): string {
  return createHash('md5').update(readFileSync(join(fixtureDir, path))).digest('hex');
}
