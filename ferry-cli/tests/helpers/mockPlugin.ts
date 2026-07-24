import { createServer, type Server } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';

export interface MockPlugin {
  base: string;
  close(): void;
}

/**
 * In-memory stand-in for the plugin's REST surface, serving files from a
 * fixture directory. Ignores signatures (client auth is covered by the
 * client tests); implements the wire contract of Task 9.
 */
export async function startMockPlugin(
  fixtureDir: string,
  opts: { partialFirstBatch?: boolean } = {},
): Promise<MockPlugin> {
  let firstFilesCall = true;

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
  return { base, close: () => server.close() };
}

/** Size helper for building manifests from fixtures. */
export function sizeOf(fixtureDir: string, path: string): number {
  return statSync(join(fixtureDir, path)).size;
}
