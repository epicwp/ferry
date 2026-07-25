import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { md5File } from '../src/provenance/md5.js';
import { reconstruct } from '../src/provenance/reconstruct.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('reconstruct', () => {
  let cache: string;
  let docroot: string;

  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), 'ferry-cachefiles-'));
    docroot = mkdtempSync(join(tmpdir(), 'ferry-docroot-'));
  });
  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
    rmSync(docroot, { recursive: true, force: true });
  });

  it('md5File hashes a file and returns null for a missing one', async () => {
    writeFileSync(join(cache, 'a.txt'), 'hello');
    expect(await md5File(join(cache, 'a.txt'))).toBe(md5('hello'));
    expect(await md5File(join(cache, 'nope.txt'))).toBeNull();
  });

  it('copies verified files into the clone, creating parent dirs', async () => {
    writeFileSync(join(cache, 'about.php'), '<?php // about');
    const { failed } = await reconstruct(
      [{ path: 'wp-admin/about.php', sourceFile: join(cache, 'about.php'), md5: md5('<?php // about') }],
      docroot,
    );
    expect(failed).toEqual([]);
    expect(readFileSync(join(docroot, 'wp-admin/about.php'), 'utf8')).toBe('<?php // about');
  });

  it('overwrites an existing clone file (re-pull over a locally modified file)', async () => {
    writeFileSync(join(cache, 'v.php'), 'official');
    mkdirSync(join(docroot, 'wp-includes'), { recursive: true });
    writeFileSync(join(docroot, 'wp-includes/v.php'), 'local-edit');
    const { failed } = await reconstruct(
      [{ path: 'wp-includes/v.php', sourceFile: join(cache, 'v.php'), md5: md5('official') }],
      docroot,
    );
    expect(failed).toEqual([]);
    expect(readFileSync(join(docroot, 'wp-includes/v.php'), 'utf8')).toBe('official');
  });

  it('demotes corrupt or missing cache sources to failed, never writes them', async () => {
    writeFileSync(join(cache, 'bad.php'), 'rotted');
    const items = [
      { path: 'wp-includes/bad.php', sourceFile: join(cache, 'bad.php'), md5: md5('pristine') },
      { path: 'wp-includes/gone.php', sourceFile: join(cache, 'gone.php'), md5: md5('x') },
    ];
    const { failed } = await reconstruct(items, docroot);
    expect(failed).toHaveLength(2);
    expect(await md5File(join(docroot, 'wp-includes/bad.php'))).toBeNull();
  });
});
