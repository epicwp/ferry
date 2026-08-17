import * as fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { x as tarExtract, type ReadEntry } from 'tar';
import { makeVerify } from './verify.js';
export { sitedCanonical } from './verify.js';

export interface SitedDeps {
  secret: string;
  docroot: string;
  exec: (cmd: string, args: string[], opts?: { input?: Buffer; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const TABLE_RE = /^[A-Za-z0-9_]+$/;

// Origin: ferry-cli/src/env/ddev.ts parseShowColumns — sited ships alone into the site image, so the logic is copied.
function parseShowColumns(stdout: string): { fields: string[]; pkCols: string[] } {
  const lines = stdout.trim().split('\n').slice(1).filter((l) => l.length > 0);
  const fields: string[] = [];
  const pkCols: string[] = [];
  for (const line of lines) {
    const [field, , , key] = line.split('\t');
    fields.push(field);
    if (key === 'PRI') pkCols.push(field);
  }
  return { fields, pkCols };
}

/** Extracts a gzipped tar `buffer` into `dest`, rejecting (throwing on) any entry
 *  whose path is absolute or contains a `..` segment, or that is a symlink/hardlink
 *  (the docroot never legitimately contains one; don't rely on tar's own defanging). */
async function extractTar(buffer: Buffer, dest: string): Promise<void> {
  const stream = tarExtract({
    cwd: dest,
    filter: (entryPath, entry) => {
      if (entryPath.startsWith('/') || entryPath.split('/').includes('..')) {
        throw new Error(`unsafe tar entry: ${entryPath}`);
      }
      const type = (entry as ReadEntry).type;
      if (type === 'SymbolicLink' || type === 'Link') {
        throw new Error(`unsafe tar entry: ${entryPath} (${type})`);
      }
      return true;
    },
  });
  const done = new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('close', resolve);
  });
  for await (const chunk of Readable.from(buffer)) {
    stream.write(chunk as Buffer);
  }
  stream.end();
  await done;
}

export function buildSited(deps: SitedDeps): FastifyInstance {
  const app = Fastify({ bodyLimit: 1024 * 1024 * 1024 }); // dumps/tars run to hundreds of MB
  // Every body arrives as raw bytes; routes parse JSON themselves after verification.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  const verify = makeVerify(deps.secret);

  app.get('/health', async () => ({ ok: true }));

  app.post('/sql', { preHandler: verify }, async (request, reply) => {
    const body = JSON.parse((request.body as Buffer).toString('utf8') || '{}') as { kind?: string; table?: string };
    if (body.kind === 'binlog-status') {
      const { stdout, exitCode, stderr } = await deps.exec('mysql', ['db', '-e', 'SHOW BINLOG STATUS']);
      if (exitCode !== 0) return reply.code(500).send({ error: stderr.slice(0, 500) });
      const row = stdout.trim().split('\n')[1]?.split('\t');
      if (!row || row.length < 2 || row[0] === '' || !Number.isFinite(Number(row[1]))) return reply.code(500).send({ error: 'unexpected SHOW BINLOG STATUS output' });
      return { file: row[0], position: Number(row[1]) };
    }
    if (body.kind === 'show-columns') {
      if (!body.table || !TABLE_RE.test(body.table)) return reply.code(400).send({ error: 'invalid table' });
      const { stdout, exitCode, stderr } = await deps.exec('mysql', ['db', '-e', `SHOW COLUMNS FROM ${body.table}`]);
      if (exitCode !== 0) return reply.code(500).send({ error: stderr.slice(0, 500) });
      return parseShowColumns(stdout);
    }
    return reply.code(400).send({ error: 'unknown kind' });
  });

  app.post('/wp', { preHandler: verify }, async (request) => {
    const body = JSON.parse((request.body as Buffer).toString('utf8') || '{}') as { argv?: string[] };
    const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
    return deps.exec('wp', [`--path=${deps.docroot}`, '--allow-root', ...argv], { timeoutMs: 120_000 });
  });

  app.post('/db/import', { preHandler: verify }, async (request, reply) => {
    const sql = request.body as Buffer;
    const { exitCode, stderr } = await deps.exec('mysql', ['db'], { input: sql, timeoutMs: 600_000 });
    if (exitCode !== 0) return reply.code(500).send({ error: stderr.slice(0, 500) });
    return reply.code(204).send();
  });

  app.put('/files', { preHandler: verify }, async (request, reply) => {
    const tarball = request.body as Buffer;
    const next = `${deps.docroot}.new`;
    const old = `${deps.docroot}.old`;
    await fsp.rm(next, { recursive: true, force: true });
    await fsp.mkdir(next, { recursive: true });
    try {
      await extractTar(tarball, next);
    } catch (err) {
      await fsp.rm(next, { recursive: true, force: true });
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'bad archive' });
    }
    await fsp.rm(old, { recursive: true, force: true });
    await fsp.rename(deps.docroot, old).catch(() => {}); // first deploy: docroot may not exist yet
    await fsp.rename(next, deps.docroot);
    await fsp.rm(old, { recursive: true, force: true });
    return reply.code(204).send();
  });

  return app;
}
