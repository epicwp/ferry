import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ferryHome } from '../profile.js';
import type { PackageEvidence, UnverifiedPackage } from '../resolve.js';

export interface PackageReport {
  type: 'core' | 'plugin' | 'theme';
  slug: string;
  version: string;
  locale?: string;
  modified: string[];
  missing: string[];
  extra: string[];
}

export interface ProvenanceReport {
  generatedAt: string;
  verified: PackageReport[];
  unverified: UnverifiedPackage[];
}

// §7: judge each package against its official checksums. Core is compared only
// outside wp-content/ (the API list bundles akismet/twenty* - wp-content is
// judged by its own packages); extra is core-only and restricted to wp-admin//
// wp-includes/, the classic malware drop location. null hashes are never judged.
// Bundled packages (themes/plugins shipped with core) match against core checksums
// to account for bytes differences between core release and standalone zips.
export function buildReport(evidence: PackageEvidence[], unverified: UnverifiedPackage[]): ProvenanceReport {
  const verified: PackageReport[] = [];

  // Extract core checksums for bundled package verification (bundled themes/plugins
  // ship with the core release and may have different bytes than their standalone zips)
  const coreSums = evidence.find((ev) => ev.ref.type === 'core')?.checksums ?? {};

  for (const ev of evidence) {
    const isCore = ev.ref.type === 'core';
    const official = Object.keys(ev.checksums).filter((p) => !isCore || !p.startsWith('wp-content/'));
    const officialSet = new Set(official);
    const present = new Map(ev.entries.map((e) => [e.relPath, e.hash]));
    const modified = official.filter((p) => {
      const hash = present.get(p);
      if (hash === undefined || hash === null || hash === ev.checksums[p]) {
        return false;
      }
      // For non-core packages, exclude files matching core-bundled checksums.
      // A file matching the core release's official checksum is authentic core-bundled bytes,
      // even when the standalone package zip differs.
      if (!isCore) {
        const fullPath = `wp-content/${ev.ref.type}s/${ev.ref.slug}/${p}`;
        if (coreSums[fullPath] === hash) {
          return false;
        }
      }
      return true;
    });
    const missing = official.filter((p) => !present.has(p));
    const extra = isCore
      ? ev.entries
          .filter((e) => e.hash !== null && (e.relPath.startsWith('wp-admin/') || e.relPath.startsWith('wp-includes/')) && !officialSet.has(e.relPath))
          .map((e) => e.relPath)
      : [];
    verified.push({ type: ev.ref.type, slug: ev.ref.slug, version: ev.ref.version, locale: ev.ref.locale, modified, missing, extra });
  }
  return { generatedAt: new Date().toISOString(), verified, unverified };
}

export function writeReport(slug: string, report: ProvenanceReport): string {
  const path = join(ferryHome(), 'sites', slug, 'provenance.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

export function summarize(report: ProvenanceReport): string {
  const core = report.verified.find((p) => p.type === 'core');
  const pkgModified = report.verified.filter((p) => p.type !== 'core').reduce((n, p) => n + p.modified.length, 0);
  const parts: string[] = [];
  if (core && core.modified.length > 0) parts.push(`${core.modified.length} modified core file(s)`);
  if (core && core.extra.length > 0) parts.push(`${core.extra.length} unexpected file(s) in wp-admin/ or wp-includes/`);
  if (core && core.missing.length > 0) parts.push(`${core.missing.length} missing core file(s)`);
  if (pkgModified > 0) parts.push(`${pkgModified} modified plugin/theme file(s)`);
  return parts.length === 0 ? 'core and wp.org packages verified clean' : `⚠ ${parts.join(', ')}`;
}
