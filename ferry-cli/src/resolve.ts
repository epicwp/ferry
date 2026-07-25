import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { ManifestEntry } from './client.js';
import type { SiteInfo } from './profile.js';
import { ensurePackage, type CachedPackage, type PackageRef } from './provenance/cache.js';
import { md5File } from './provenance/md5.js';
import type { ReconstructItem } from './provenance/reconstruct.js';
import { WPORG_DEFAULTS, type WporgEndpoints } from './provenance/wporg.js';

// Seam (§4.3), grown into §2.14 provenance: classify every manifest entry as
// reuse (already local, same hash), reconstruct (proven identical to an official
// wp.org package file in the cache), or fetch (over the bridge). The transfer
// layer still just receives lists of entries.

export type Owner =
  | { type: 'core'; relPath: string }
  | { type: 'plugin' | 'theme'; dir: string; relPath: string }
  | null;

export function ownerOf(path: string): Owner {
  if (!path.startsWith('wp-content/')) {
    return { type: 'core', relPath: path };
  }
  for (const [type, prefix] of [['plugin', 'wp-content/plugins/'], ['theme', 'wp-content/themes/']] as const) {
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        return { type, dir: rest.slice(0, slash), relPath: rest.slice(slash + 1) };
      }
    }
  }
  return null; // mu-plugins, languages, wp-content root files, single-file plugins
}

export interface PackageEvidence {
  ref: PackageRef;
  checksums: Record<string, string>;
  entries: { relPath: string; hash: string | null }[];
}

export interface UnverifiedPackage {
  type: 'core' | 'plugin' | 'theme';
  slug: string;
  version: string | null;
  reason: 'no-version-hint' | 'unavailable';
}

export interface ResolvePlan {
  fetch: ManifestEntry[];
  reuse: ManifestEntry[];
  reconstruct: ReconstructItem[];
  evidence: PackageEvidence[];
  unverified: UnverifiedPackage[];
}

export interface ResolveDeps { docroot: string; cacheDir: string; wporg?: WporgEndpoints }

/** Hinted packages keyed by owner key ('core' | 'plugin:<dir>' | 'theme:<dir>'). Hints only - hashes decide. */
function hintedPackages(info: SiteInfo): Map<string, PackageRef> {
  const map = new Map<string, PackageRef>();
  map.set('core', { type: 'core', slug: 'core', version: info.wp, locale: info.locale ?? 'en_US' });
  for (const p of info.plugins ?? []) {
    const slash = p.file.indexOf('/');
    if (slash > 0 && p.version !== '') {
      const dir = p.file.slice(0, slash);
      map.set(`plugin:${dir}`, { type: 'plugin', slug: dir, version: p.version });
    }
  }
  for (const t of info.themes ?? []) {
    if (t.stylesheet !== '' && t.version !== '') {
      map.set(`theme:${t.stylesheet}`, { type: 'theme', slug: t.stylesheet, version: t.version });
    }
  }
  return map;
}

export async function resolve(entries: ManifestEntry[], info: SiteInfo, deps: ResolveDeps): Promise<ResolvePlan> {
  const wporg = deps.wporg ?? WPORG_DEFAULTS;
  const hints = hintedPackages(info);

  // Group entries by owning package; note dirs we have no hint for.
  const owned = new Map<string, { ref: PackageRef; entries: { entry: ManifestEntry; relPath: string }[] }>();
  const hintless = new Map<string, UnverifiedPackage>();
  const owners: Owner[] = [];
  for (const entry of entries) {
    const owner = ownerOf(entry.path);
    owners.push(owner);
    if (!owner) continue;
    const key = owner.type === 'core' ? 'core' : `${owner.type}:${owner.dir}`;
    const ref = hints.get(key);
    if (ref) {
      const group = owned.get(key) ?? { ref, entries: [] };
      group.entries.push({ entry, relPath: owner.relPath });
      owned.set(key, group);
    } else if (owner.type !== 'core') {
      hintless.set(key, { type: owner.type, slug: owner.dir, version: null, reason: 'no-version-hint' });
    }
  }

  // Ensure every owning package - the report needs checksums even for all-reuse
  // packages. Warm cache = zero network; unavailable = value, not error.
  const unverified: UnverifiedPackage[] = [...hintless.values()];
  const packages = new Map<string, CachedPackage | null>();
  const ensureLimit = pLimit(4);
  await Promise.all([...owned.entries()].map(([key, group]) => ensureLimit(async () => {
    const pkg = await ensurePackage(deps.cacheDir, group.ref, wporg);
    packages.set(key, pkg);
    if (pkg === null) {
      unverified.push({ type: group.ref.type, slug: group.ref.slug, version: group.ref.version, reason: 'unavailable' });
    }
  })));

  // Local-reuse hashes (the re-pull fast path), bounded concurrency.
  const hashLimit = pLimit(16);
  const localHashes = await Promise.all(entries.map((entry) => hashLimit(() =>
    entry.hash === null ? Promise.resolve(null) : md5File(join(deps.docroot, entry.path)),
  )));

  const fetch: ManifestEntry[] = [];
  const reuse: ManifestEntry[] = [];
  const reconstruct: ReconstructItem[] = [];
  entries.forEach((entry, i) => {
    if (entry.hash !== null && localHashes[i] === entry.hash) {
      reuse.push(entry);
      return;
    }
    const owner = owners[i];
    if (entry.hash !== null && owner) {
      const key = owner.type === 'core' ? 'core' : `${owner.type}:${owner.dir}`;
      const pkg = packages.get(key);
      if (pkg && pkg.checksums[owner.relPath] === entry.hash) {
        const sourceFile = join(pkg.filesDir, owner.relPath);
        if (existsSync(sourceFile)) {
          reconstruct.push({ path: entry.path, sourceFile, md5: entry.hash });
          return;
        }
      }
    }
    fetch.push(entry);
  });

  const evidence: PackageEvidence[] = [];
  for (const [key, group] of owned) {
    const pkg = packages.get(key);
    if (pkg) {
      evidence.push({
        ref: group.ref,
        checksums: pkg.checksums,
        entries: group.entries.map(({ entry, relPath }) => ({ relPath, hash: entry.hash })),
      });
    }
  }
  return { fetch, reuse, reconstruct, evidence, unverified };
}
