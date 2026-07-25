import { zipSync } from 'fflate';
import { createServer, type Server } from 'node:http';
import type { WporgEndpoints } from '../../src/provenance/wporg.js';

export interface MockWporg { endpoints: WporgEndpoints; requests: string[]; close(): void }

/** wp.org-style zip: all files wrapped in one top-level dir ("wordpress/", "<slug>/"). */
export function zipOf(topDir: string, files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[`${topDir}/${path}`] = new TextEncoder().encode(content);
  }
  return Buffer.from(zipSync(entries));
}

export async function startMockWporg(opts: {
  checksums?: Record<string, Record<string, string> | false>;
  zips?: Record<string, Buffer>;
} = {}): Promise<MockWporg> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/core/checksums/1.0/') {
      const key = `${url.searchParams.get('version')}-${url.searchParams.get('locale')}`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ checksums: opts.checksums?.[key] ?? false }));
      return;
    }
    const zip = opts.zips?.[url.pathname];
    if (zip) {
      res.setHeader('content-type', 'application/zip');
      res.end(zip);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { endpoints: { api: base, downloads: base }, requests, close: () => server.close() };
}
