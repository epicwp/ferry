import { unzipSync } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  coreZipUrl, downloadZip, fetchCoreChecksums, pluginZipUrl, themeZipUrl, type WporgEndpoints,
} from './wporg.js';

export interface PackageRef { type: 'core' | 'plugin' | 'theme'; slug: string; version: string; locale?: string }
export interface CachedPackage { ref: PackageRef; filesDir: string; checksums: Record<string, string> }

export function packageDir(cacheDir: string, ref: PackageRef): string {
  return ref.type === 'core'
    ? join(cacheDir, 'packages', 'core', `${ref.version}-${ref.locale ?? 'en_US'}`)
    : join(cacheDir, 'packages', ref.type, ref.slug, ref.version);
}

/** Zip-slip guard + strip the single wp.org wrapping dir ("wordpress/", "<slug>/"). */
export function safeRelPath(entryName: string): string | null {
  const norm = entryName.replace(/\\/g, '/');
  if (norm.startsWith('/') || norm.split('/').some((seg) => seg === '..')) return null;
  const slash = norm.indexOf('/');
  if (slash < 0) return null; // top-level stray file - not part of the package tree
  const rel = norm.slice(slash + 1);
  return rel === '' ? null : rel;
}

function load(dir: string, ref: PackageRef): CachedPackage {
  return {
    ref,
    filesDir: join(dir, 'files'),
    checksums: JSON.parse(readFileSync(join(dir, 'checksums.json'), 'utf8')) as Record<string, string>,
  };
}

/**
 * Cached hit = zero network. Ingest: download zip → extract to cache/tmp →
 * checksums.json (core: full official API list; plugins/themes: computed from
 * the zip) → atomic rename. Core files/ only holds bytes whose MD5 matches the
 * API list - unproven bytes are never cached. null = unavailable, never throws.
 */
export async function ensurePackage(cacheDir: string, ref: PackageRef, ep: WporgEndpoints): Promise<CachedPackage | null> {
  const dir = packageDir(cacheDir, ref);
  if (existsSync(join(dir, 'checksums.json'))) {
    return load(dir, ref);
  }

  let official: Record<string, string> | null = null;
  let zipUrl: string;
  if (ref.type === 'core') {
    const result = await fetchCoreChecksums(ep, ref.version, ref.locale ?? 'en_US');
    if (result === null) return null;
    official = result.checksums;
    zipUrl = coreZipUrl(ep, ref.version, result.locale);
  } else {
    zipUrl = ref.type === 'plugin' ? pluginZipUrl(ep, ref.slug, ref.version) : themeZipUrl(ep, ref.slug, ref.version);
  }

  let zip = await downloadZip(zipUrl);
  if (zip === null && ref.type === 'core' && (ref.locale ?? 'en_US') !== 'en_US') {
    // locale zip missing: en_US bytes still prove most files against the locale list
    zip = await downloadZip(coreZipUrl(ep, ref.version, 'en_US'));
  }
  if (zip === null) return null;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zip));
  } catch {
    return null; // corrupt download - unavailable, the pull degrades to fetch
  }

  const tmp = join(cacheDir, 'tmp', randomUUID());
  const computed: Record<string, string> = {};
  mkdirSync(join(tmp, 'files'), { recursive: true });
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    const rel = safeRelPath(name);
    if (rel === null) continue;
    const md5 = createHash('md5').update(bytes).digest('hex');
    if (official !== null && official[rel] !== md5) continue; // core: only proven bytes enter the cache
    const dest = join(tmp, 'files', rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    computed[rel] = md5;
  }
  writeFileSync(join(tmp, 'checksums.json'), JSON.stringify(official ?? computed, null, 2) + '\n');

  mkdirSync(dirname(dir), { recursive: true });
  try {
    renameSync(tmp, dir); // atomic: packages/ never holds a partial package
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(join(dir, 'checksums.json'))) return null; // lost a race AND the winner vanished - give up
  }
  return load(dir, ref);
}

/** Opportunistic cleanup of interrupted ingests; >24h so a concurrent pull's live tmp survives. */
export function cleanTmp(cacheDir: string): void {
  const tmp = join(cacheDir, 'tmp');
  if (!existsSync(tmp)) return;
  for (const name of readdirSync(tmp)) {
    const p = join(tmp, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > 24 * 3600 * 1000) {
        rmSync(p, { recursive: true, force: true });
      }
    } catch {
      // a concurrent pull may have renamed/removed it - fine
    }
  }
}
