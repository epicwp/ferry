import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import * as tar from 'tar';
import { buildSited, sitedCanonical, type SitedDeps } from '../src/app.js';
import { SECRET } from './helpers.js';

const noopExec: SitedDeps['exec'] = async () => ({ stdout: '', stderr: '', exitCode: 0 });

/** Signs and injects a raw-byte-body request, as sited's clients would for /db/import and /files. */
function injectRaw(app: FastifyInstance, method: string, path: string, body: Buffer) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', SECRET).update(sitedCanonical(method, path, {}, bodyHash, ts, nonce)).digest('hex');
  const headers = {
    'x-ferry-timestamp': String(ts),
    'x-ferry-nonce': nonce,
    'x-ferry-signature': sig,
    'content-type': 'application/octet-stream',
  };
  return app.inject({ method: method as InjectOptions['method'], url: path, headers, payload: body });
}

/** Builds a real gzipped tar containing `files` (relative path -> content), rooted so entries are relative. */
async function buildTarGz(files: Record<string, string>): Promise<Buffer> {
  const src = mkdtempSync(join(tmpdir(), 'sited-files-src-'));
  for (const rel of Object.keys(files)) writeFileSync(join(src, rel), files[rel]);
  const outFile = join(tmpdir(), `sited-fixture-${randomBytes(4).toString('hex')}.tar.gz`);
  await tar.create({ gzip: true, cwd: src, file: outFile, portable: true }, Object.keys(files));
  const buf = await readFile(outFile);
  rmSync(src, { recursive: true, force: true });
  rmSync(outFile, { force: true });
  return buf;
}

/** Builds a tar.gz whose single entry escapes its extraction root via a literal '..' path segment. */
async function buildDotDotTarGz(): Promise<Buffer> {
  const root = mkdtempSync(join(tmpdir(), 'sited-evil-src-'));
  const inner = join(root, 'inner');
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(root, 'evil.txt'), 'pwned');
  const outFile = join(tmpdir(), `sited-evil-dotdot-${randomBytes(4).toString('hex')}.tar.gz`);
  await tar.create({ gzip: true, cwd: inner, file: outFile, preservePaths: true, portable: true }, ['../evil.txt']);
  const buf = await readFile(outFile);
  rmSync(root, { recursive: true, force: true });
  rmSync(outFile, { force: true });
  return buf;
}

/** Builds a tar.gz whose single entry uses an absolute path. */
async function buildAbsoluteTarGz(): Promise<Buffer> {
  const root = mkdtempSync(join(tmpdir(), 'sited-evil-abs-'));
  const absFile = join(root, 'abs.txt');
  writeFileSync(absFile, 'pwned-abs');
  const outFile = join(tmpdir(), `sited-evil-abs-${randomBytes(4).toString('hex')}.tar.gz`);
  await tar.create({ gzip: true, cwd: root, file: outFile, preservePaths: true, portable: true }, [absFile]);
  const buf = await readFile(outFile);
  rmSync(root, { recursive: true, force: true });
  rmSync(outFile, { force: true });
  return buf;
}

describe('PUT /files', () => {
  let docroot: string | undefined;

  afterEach(() => {
    if (!docroot) return;
    for (const suffix of ['', '.new', '.old']) rmSync(`${docroot}${suffix}`, { recursive: true, force: true });
    docroot = undefined;
  });

  it('replaces the docroot atomically from a tar.gz and removes files absent from the tar', async () => {
    docroot = mkdtempSync(join(tmpdir(), 'sited-docroot-'));
    writeFileSync(join(docroot, 'old.txt'), 'stale');
    const tarball = await buildTarGz({ 'index.php': '<?php echo "hi";' });
    const app = buildSited({ secret: SECRET, docroot, exec: noopExec });
    const res = await injectRaw(app, 'PUT', '/files', tarball);
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(docroot, 'index.php'))).toBe(true);
    expect(existsSync(join(docroot, 'old.txt'))).toBe(false);
  });

  it('rejects .. and absolute entries with 400 and leaves the docroot untouched', async () => {
    docroot = mkdtempSync(join(tmpdir(), 'sited-docroot-'));
    writeFileSync(join(docroot, 'keep.txt'), 'still here');
    const app = buildSited({ secret: SECRET, docroot, exec: noopExec });

    const dotDotRes = await injectRaw(app, 'PUT', '/files', await buildDotDotTarGz());
    expect(dotDotRes.statusCode).toBe(400);
    expect(existsSync(join(docroot, 'keep.txt'))).toBe(true);
    expect(existsSync(`${docroot}.new`)).toBe(false);

    const absRes = await injectRaw(app, 'PUT', '/files', await buildAbsoluteTarGz());
    expect(absRes.statusCode).toBe(400);
    expect(existsSync(join(docroot, 'keep.txt'))).toBe(true);
    expect(existsSync(`${docroot}.new`)).toBe(false);
  });
});
