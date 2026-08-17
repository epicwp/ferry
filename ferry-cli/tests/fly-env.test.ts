import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSited, type SitedDeps } from '../../ferry-sited/src/app.js';
import { FlyEnv, flyConfigFromEnv, type FlyEnvConfig } from '../src/env/fly.js';
import { saveProfile } from '../src/profile.js';

const SECRET = 'fly-test-secret';
const SLUG = 'my-site';

describe('FlyEnv', () => {
  let home: string;
  let www: string;
  let clonePath: string;
  let sited: FastifyInstance;
  let baseUrl: string;
  let execImpl: SitedDeps['exec'];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    www = mkdtempSync(join(tmpdir(), 'sited-www-'));
    clonePath = join(home, 'clones', SLUG);
    mkdirSync(clonePath, { recursive: true });

    execImpl = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const exec: SitedDeps['exec'] = (cmd, args, opts) => execImpl(cmd, args, opts);
    sited = buildSited({ secret: SECRET, docroot: www, exec });
    baseUrl = await sited.listen({ port: 0, host: '127.0.0.1' });

    saveProfile({
      url: 'https://example.test',
      secret: 's',
      slug: SLUG,
      clonePath,
      flySited: { app: 'a', machineId: 'm', volumeId: 'v', secret: SECRET },
    });
  });

  afterEach(async () => {
    await sited.close();
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(www, { recursive: true, force: true });
  });

  function env(overrides: Partial<FlyEnvConfig> = {}): FlyEnv {
    return new FlyEnv({
      token: 't',
      org: 'personal',
      region: 'ams',
      imageRepo: 'ghcr.io/epicwp/ferry-site-runtime',
      sitedBaseFor: () => baseUrl,
      ...overrides,
    });
  }

  describe('FlyEnv.appName', () => {
    it('is deterministic, ≤63 chars, and slug-prefixed', () => {
      const name = FlyEnv.appName('wasgeurtje-nl');
      expect(name).toBe(FlyEnv.appName('wasgeurtje-nl'));
      expect(name.startsWith('ferry-s-wasgeurtje-nl-')).toBe(true);
      expect(name).toBe(name.toLowerCase());
      expect(name.length).toBeLessThanOrEqual(63);
      // a long slug still fits: 8 + 30 + 1 + 6 = 45
      const long = FlyEnv.appName('a'.repeat(80));
      expect(long.length).toBeLessThanOrEqual(63);
    });
  });

  it('url() derives from appName synchronously', () => {
    expect(env().url('wasgeurtje-nl')).toBe(`https://${FlyEnv.appName('wasgeurtje-nl')}.fly.dev`);
  });

  it('showColumns round-trips through sited /sql', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db', '-e', 'SHOW COLUMNS FROM wp_options']);
      return { stdout: 'Field\tType\tNull\tKey\tDefault\tExtra\noption_id\tbigint\tNO\tPRI\t\tauto\n', stderr: '', exitCode: 0 };
    };
    expect(await env().showColumns(clonePath, 'wp_options')).toEqual({ fields: ['option_id'], pkCols: ['option_id'] });
  });

  it('binlogPosition round-trips through sited /sql', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db', '-e', 'SHOW BINLOG STATUS']);
      return { stdout: 'File\tPosition\tBinlog_Do_DB\nferry-bin.000002\t1234\t\n', stderr: '', exitCode: 0 };
    };
    expect(await env().binlogPosition(clonePath)).toEqual({ file: 'ferry-bin.000002', position: 1234 });
  });

  it('importDb streams the dump file body to /db/import', async () => {
    const sql = 'CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n';
    const dumpFile = join(home, 'dump.sql');
    writeFileSync(dumpFile, sql);
    let received: Buffer | undefined;
    execImpl = async (cmd, args, opts) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db']);
      received = opts?.input;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await env().importDb(clonePath, dumpFile);
    expect(received?.toString('utf8')).toBe(sql);
  });

  it("createAdmin drives wp user create via /wp, returns the generated credentials, and tolerates 'already exists'", async () => {
    let captured: string[] = [];
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('wp');
      captured = args;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const { user, password } = await env().createAdmin(clonePath);
    expect(user).toBe('ferry-admin');
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(captured).toEqual([
      `--path=${www}`, '--allow-root',
      'user', 'create', 'ferry-admin', 'ferry-admin@ferry.local',
      '--role=administrator', `--user_pass=${password}`,
    ]);

    execImpl = async () => ({ stdout: '', stderr: 'user ferry-admin already exists', exitCode: 1 });
    await expect(env().createAdmin(clonePath)).resolves.toMatchObject({ user: 'ferry-admin' });
  });

  it('createAdmin throws with the stderr excerpt on a real (non-"already exists") failure', async () => {
    execImpl = async () => ({ stdout: '', stderr: 'Error: something broke', exitCode: 1 });
    await expect(env().createAdmin(clonePath)).rejects.toThrow(/something broke/);
  });

  it('extractBinlog fetches /binlog output', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('mysqlbinlog');
      expect(args).toEqual([
        '--no-defaults', '--base64-output=decode-rows', '-v',
        '--start-position=328', '/data/mysql/ferry-bin.000001',
      ]);
      return { stdout: '# binlog events\n', stderr: '', exitCode: 0 };
    };
    expect(await env().extractBinlog(clonePath, { file: 'ferry-bin.000001', position: 328 })).toBe('# binlog events\n');
  });

  it('deployFiles tars the docroot (excluding .git) and PUTs /files', async () => {
    writeFileSync(join(clonePath, 'index.php'), '<?php // wp');
    mkdirSync(join(clonePath, '.git'), { recursive: true });
    writeFileSync(join(clonePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await env().deployFiles(clonePath);

    expect(existsSync(join(www, 'index.php'))).toBe(true);
    expect(existsSync(join(www, '.git'))).toBe(false);
  });

  it('runWp forwards argv', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('wp');
      expect(args).toEqual([`--path=${www}`, '--allow-root', 'plugin', 'list']);
      return { stdout: 'akismet\n', stderr: '', exitCode: 0 };
    };
    expect(await env().runWp(clonePath, ['plugin', 'list'])).toEqual({ stdout: 'akismet\n', stderr: '', exitCode: 0 });
  });

  it('signed requests fail against a wrong secret (401 surfaces as thrown error)', async () => {
    saveProfile({
      url: 'https://example.test',
      secret: 's',
      slug: SLUG,
      clonePath,
      flySited: { app: 'a', machineId: 'm', volumeId: 'v', secret: 'the-wrong-secret' },
    });
    await expect(env().binlogPosition(clonePath)).rejects.toThrow(/401/);
  });

  it('throws a clear error naming the slug when the profile has no flySited state', async () => {
    const otherSlug = 'no-fly-site';
    const otherClone = join(home, 'clones', otherSlug);
    mkdirSync(otherClone, { recursive: true });
    saveProfile({ url: 'https://x.test', secret: 's', slug: otherSlug, clonePath: otherClone });
    await expect(env().binlogPosition(otherClone)).rejects.toThrow(/no-fly-site/);
  });
});

describe('flyConfigFromEnv', () => {
  it('requires FERRY_FLY_TOKEN and FERRY_SITE_RUNTIME_IMAGE, defaulting org/region', () => {
    expect(() => flyConfigFromEnv({})).toThrow(/FERRY_FLY_TOKEN/);
    expect(() => flyConfigFromEnv({ FERRY_FLY_TOKEN: 't' })).toThrow(/FERRY_SITE_RUNTIME_IMAGE/);
    expect(flyConfigFromEnv({ FERRY_FLY_TOKEN: 't', FERRY_SITE_RUNTIME_IMAGE: 'ghcr.io/x/y' })).toEqual({
      token: 't', org: 'personal', region: 'ams', imageRepo: 'ghcr.io/x/y',
    });
  });

  it('honors FERRY_FLY_ORG and FERRY_FLY_REGION overrides', () => {
    expect(flyConfigFromEnv({
      FERRY_FLY_TOKEN: 't', FERRY_SITE_RUNTIME_IMAGE: 'ghcr.io/x/y',
      FERRY_FLY_ORG: 'epicwp', FERRY_FLY_REGION: 'fra',
    })).toEqual({ token: 't', org: 'epicwp', region: 'fra', imageRepo: 'ghcr.io/x/y' });
  });
});
