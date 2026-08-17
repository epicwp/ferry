import Fastify, { type FastifyInstance } from 'fastify';
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
      return { file: row?.[0], position: Number(row?.[1]) };
    }
    if (body.kind === 'show-columns') {
      if (!body.table || !TABLE_RE.test(body.table)) return reply.code(400).send({ error: 'invalid table' });
      const { stdout, exitCode, stderr } = await deps.exec('mysql', ['db', '-e', `SHOW COLUMNS FROM ${body.table}`]);
      if (exitCode !== 0) return reply.code(500).send({ error: stderr.slice(0, 500) });
      return parseShowColumns(stdout);
    }
    return reply.code(400).send({ error: 'unknown kind' });
  });

  return app;
}
