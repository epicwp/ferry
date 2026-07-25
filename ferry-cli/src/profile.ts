import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SiteInfo {
  wp: string;
  php: { version: string; extensions: string[]; ini: Record<string, string | number> };
  db: { server: 'mysql' | 'mariadb'; version: string; charset: string; collation: string; bytes: number };
  server: 'nginx' | 'apache';
  constants: Record<string, string | number | boolean | null>;
  multisite: boolean;
  prefix: string;
  abspath: string;
  siteurl: string;
}

export interface SiteProfile {
  url: string;
  secret: string;
  slug: string;
  clonePath: string;
  info?: SiteInfo;
}

// All state lives in readable files per site (SaaS spec §13) - the SaaS
// version stores the same structure centrally instead of rewriting anything.
export function ferryHome(): string {
  return process.env.FERRY_HOME ?? join(homedir(), '.ferry');
}

export function profilePath(slug: string): string {
  return join(ferryHome(), 'sites', slug, 'profile.json');
}

export function saveProfile(profile: SiteProfile): void {
  const path = profilePath(profile.slug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(profile, null, 2) + '\n');
}

export function loadProfile(slug: string): SiteProfile {
  const path = profilePath(slug);
  if (!existsSync(path)) {
    throw new Error(`Unknown site "${slug}". Pair it first: ferry link <url> --code=<pairing code>`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SiteProfile;
}

export function slugFromUrl(url: string): string {
  return new URL(url).hostname
    .replace(/^www\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
