import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { request } from 'undici';
import * as tar from 'tar';
import { loadProfile, type SiteInfo } from '../profile.js';
import type { CloneEnv, TableColumns } from './ddev.js';
import { FlyApi } from './fly-api.js';

// Origin: ferry-sited/src/verify.ts sitedCanonical — copied so the cli client signs
// identically; sited ships dependency-free into the site image, so this can't be a shared import.
function sitedCanonical(
  method: string,
  path: string,
  query: Record<string, string>,
  bodySha256Hex: string,
  timestamp: number,
  nonce: string,
): string {
  const pairs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`);
  return `${method.toUpperCase()}\n${path}\n${pairs.join('&')}\n${bodySha256Hex}\n${timestamp}\n${nonce}`;
}

function signedHeaders(
  secret: string,
  method: string,
  path: string,
  query: Record<string, string>,
  bodyHash: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const sig = createHmac('sha256', secret).update(sitedCanonical(method, path, query, bodyHash, ts, nonce)).digest('hex');
  return { 'x-ferry-timestamp': String(ts), 'x-ferry-nonce': nonce, 'x-ferry-signature': sig };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Tars `clonePath` (gzip), excluding `.git`, into an in-memory buffer for PUT /files.
 *  tar entries under a `['.']` pack root carry a `./` prefix, so the exclusion strips it
 *  before comparing - matching on the bare `.git`/`.git/...` prefix used to leave it in. */
async function packTar(clonePath: string): Promise<Buffer> {
  const stream = tar.c(
    {
      gzip: true,
      cwd: clonePath,
      filter: (p) => {
        const rel = p.replace(/^\.\//, '');
        return rel !== '.git' && !rel.startsWith('.git/');
      },
    },
    ['.'],
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

type HttpResponse = { statusCode: number; body: { text(): Promise<string> } };

async function ensureOk(res: HttpResponse, method: string, path: string): Promise<void> {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`sited ${method} ${path} → ${res.statusCode}: ${text.slice(0, 300)}`);
  }
}

async function readJson(res: HttpResponse, method: string, path: string): Promise<unknown> {
  await ensureOk(res, method, path);
  const text = await res.body.text();
  return text ? JSON.parse(text) : undefined;
}

export interface FlyEnvConfig {
  token: string;
  org: string;
  region: string;
  imageRepo: string;
  sitedPort?: number; // default 2323
  sitedBaseFor?: (app: string, machineId: string) => string; // test seam
  api?: FlyApi; // test seam (Task 8)
}

export function flyConfigFromEnv(env: NodeJS.ProcessEnv): FlyEnvConfig {
  const token = env.FERRY_FLY_TOKEN;
  if (!token) throw new Error('FERRY_FLY_TOKEN is required');
  const imageRepo = env.FERRY_SITE_RUNTIME_IMAGE;
  if (!imageRepo) throw new Error('FERRY_SITE_RUNTIME_IMAGE is required');
  return {
    token,
    org: env.FERRY_FLY_ORG ?? 'personal',
    region: env.FERRY_FLY_REGION ?? 'ams',
    imageRepo,
  };
}

export class FlyEnv implements CloneEnv {
  constructor(private readonly cfg: FlyEnvConfig) {}

  static appName(slug: string): string {
    const hash6 = createHash('sha256').update(`ferry-site:${slug}`).digest('hex').slice(0, 6);
    return `ferry-s-${slug.slice(0, 30)}-${hash6}`.toLowerCase();
  }

  url(name: string): string {
    return `https://${FlyEnv.appName(name)}.fly.dev`;
  }

  async provision(): Promise<void> {
    throw new Error('provision arrives in Task 8');
  }

  async destroy(): Promise<void> {
    throw new Error('destroy arrives in Task 8');
  }

  async showColumns(clonePath: string, table: string): Promise<TableColumns> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    return (await postJson(baseUrl, secret, '/sql', { kind: 'show-columns', table })) as TableColumns;
  }

  async binlogPosition(clonePath: string): Promise<{ file: string; position: number }> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    return (await postJson(baseUrl, secret, '/sql', { kind: 'binlog-status' })) as { file: string; position: number };
  }

  async extractBinlog(clonePath: string, pos: { file: string; position: number }): Promise<string> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    const data = (await get(baseUrl, secret, '/binlog', { file: pos.file, position: String(pos.position) })) as { stdout: string };
    return data.stdout;
  }

  async importDb(clonePath: string, dumpFile: string): Promise<void> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    const bodyHash = await hashFile(dumpFile);
    const headers = signedHeaders(secret, 'POST', '/db/import', {}, bodyHash);
    headers['content-type'] = 'application/octet-stream';
    const res = await request(`${baseUrl}/db/import`, { method: 'POST', headers, body: createReadStream(dumpFile) });
    await ensureOk(res, 'POST', '/db/import');
  }

  /** §4.6: a working admin requires a local user - the customer's production credentials never travel. */
  async createAdmin(clonePath: string): Promise<{ user: string; password: string }> {
    const password = randomBytes(9).toString('base64url');
    const { stdout, stderr, exitCode } = await this.runWp(clonePath, [
      'user', 'create', 'ferry-admin', 'ferry-admin@ferry.local',
      '--role=administrator', `--user_pass=${password}`,
    ]);
    if (exitCode !== 0 && !/already exists/i.test(stderr) && !/already exists/i.test(stdout)) {
      throw new Error(`wp user create failed: ${stderr.slice(0, 500)}`);
    }
    return { user: 'ferry-admin', password };
  }

  async deployFiles(clonePath: string): Promise<void> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    const tarball = await packTar(clonePath);
    const bodyHash = createHash('sha256').update(tarball).digest('hex');
    const headers = signedHeaders(secret, 'PUT', '/files', {}, bodyHash);
    headers['content-type'] = 'application/gzip';
    const res = await request(`${baseUrl}/files`, { method: 'PUT', headers, body: tarball });
    await ensureOk(res, 'PUT', '/files');
  }

  /** The agent's wp tool (Task 9) - not part of CloneEnv. */
  async runWp(clonePath: string, argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    return (await postJson(baseUrl, secret, '/wp', { argv })) as { stdout: string; stderr: string; exitCode: number };
  }

  private sitedFor(clonePath: string): { baseUrl: string; secret: string } {
    const slug = basename(clonePath);
    const profile = loadProfile(slug);
    if (!profile.flySited) {
      throw new Error(`site "${slug}" has no Fly machine — pull/provision first`);
    }
    const { app, machineId, secret } = profile.flySited;
    const baseUrl = this.cfg.sitedBaseFor
      ? this.cfg.sitedBaseFor(app, machineId)
      : `http://${machineId}.vm.${app}.internal:${this.cfg.sitedPort ?? 2323}`;
    return { baseUrl, secret };
  }
}

async function postJson(baseUrl: string, secret: string, path: string, payload: unknown): Promise<unknown> {
  const body = Buffer.from(JSON.stringify(payload));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const headers = signedHeaders(secret, 'POST', path, {}, bodyHash);
  headers['content-type'] = 'application/json';
  const res = await request(`${baseUrl}${path}`, { method: 'POST', headers, body });
  return readJson(res, 'POST', path);
}

async function get(baseUrl: string, secret: string, path: string, query: Record<string, string>): Promise<unknown> {
  const bodyHash = createHash('sha256').update('').digest('hex');
  const headers = signedHeaders(secret, 'GET', path, query, bodyHash);
  const qs = new URLSearchParams(query).toString();
  const res = await request(`${baseUrl}${path}?${qs}`, { method: 'GET', headers });
  return readJson(res, 'GET', path);
}
