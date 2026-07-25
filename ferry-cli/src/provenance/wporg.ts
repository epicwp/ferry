import { request } from 'undici';

export interface WporgEndpoints { api: string; downloads: string }

export const WPORG_DEFAULTS: WporgEndpoints = {
  api: 'https://api.wordpress.org',
  downloads: 'https://downloads.wordpress.org',
};

export function coreChecksumsUrl(ep: WporgEndpoints, version: string, locale: string): string {
  return `${ep.api}/core/checksums/1.0/?version=${encodeURIComponent(version)}&locale=${encodeURIComponent(locale)}`;
}

export function coreZipUrl(ep: WporgEndpoints, version: string, locale: string): string {
  return locale === 'en_US'
    ? `${ep.downloads}/release/wordpress-${version}.zip`
    : `${ep.downloads}/release/${locale}/wordpress-${version}-${locale}.zip`;
}

export function pluginZipUrl(ep: WporgEndpoints, slug: string, version: string): string {
  return `${ep.downloads}/plugin/${slug}.${version}.zip`;
}

export function themeZipUrl(ep: WporgEndpoints, slug: string, version: string): string {
  return `${ep.downloads}/theme/${slug}.${version}.zip`;
}

const ATTEMPTS = 2; // §8: wp.org failures cost seconds, not minutes - one retry, then unavailable

async function fetchBuffer(url: string, timeoutMs: number): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await request(url, { signal: controller.signal });
        const buf = Buffer.from(await res.body.arrayBuffer());
        if (res.statusCode === 200) return buf;
        if (res.statusCode === 404) return null; // definitive: not on wp.org - retrying won't help
        // other status codes: retry
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // network error / timeout: retry once
    }
  }
  return null;
}

/** Official core path→md5 list. Falls back to en_US when the locale build has none. Never throws. */
export async function fetchCoreChecksums(
  ep: WporgEndpoints,
  version: string,
  locale: string,
): Promise<{ checksums: Record<string, string>; locale: string } | null> {
  for (const loc of locale === 'en_US' ? ['en_US'] : [locale, 'en_US']) {
    const buf = await fetchBuffer(coreChecksumsUrl(ep, version, loc), 15_000);
    if (buf === null) continue;
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      if (parsed && typeof parsed.checksums === 'object' && parsed.checksums !== null) {
        return { checksums: parsed.checksums as Record<string, string>, locale: loc };
      }
    } catch {
      // malformed answer: try the next locale
    }
  }
  return null;
}

/** Zip bytes, or null when unavailable. Never throws. */
export async function downloadZip(url: string): Promise<Buffer | null> {
  return fetchBuffer(url, 120_000);
}
