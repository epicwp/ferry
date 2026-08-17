import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildSited, type SitedDeps } from './app.js';

const exec: SitedDeps['exec'] = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
    });
    if (opts.input !== undefined) { child.stdin?.write(opts.input); child.stdin?.end(); }
  });

const secret = readFileSync(process.env.SITED_SECRET_FILE ?? '/etc/ferry/sited-secret', 'utf8').trim();
const app = buildSited({ secret, docroot: process.env.SITED_DOCROOT ?? '/data/www', exec });
const port = Number(process.env.SITED_PORT ?? 2323);
const host = process.env.SITED_HOST ?? 'fly-local-6pn';
await app.listen({ port, host });
console.log(`sited listening on ${host}:${port}`);
