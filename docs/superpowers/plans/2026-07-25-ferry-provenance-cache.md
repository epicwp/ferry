# Ferry Plan 2 — Provenance & Content-Addressable Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut first-pull transfer to the genuinely unique bytes by reconstructing WP core / wp.org plugins / wp.org themes from official packages via a shared local cache, make re-pulls near-instant via local hash reuse, and surface a modified-core-files report.

**Architecture:** The plugin manifest starts carrying real per-file MD5 hashes and `/info` gains locale + installed plugin/theme version hints. The CLI `resolve()` seam (currently identity) becomes an async classifier that buckets every manifest entry as **reuse** (already on disk with the same hash), **reconstruct** (proven byte-identical to an official wp.org package file, copied from the package cache), or **fetch** (over the bridge). The cache under `$FERRY_HOME/cache/packages/` ingests **only** bytes downloaded from wordpress.org (never customer bytes). The provenance report is built from the same classification evidence. The transfer layer (`transfer.ts`) is untouched.

**Spec:** `docs/superpowers/specs/2026-07-25-ferry-provenance-cache-design.md`. One refinement vs the spec's sketch: `resolve()` returns classification buckets plus per-package `evidence`, and the report is built from that evidence by `report.ts` and composed in `pull.ts` — same data flow, cleaner task boundaries.

**Tech Stack:** ferry-plugin: native PHP (zero dependencies, PHPUnit). ferry-cli: TypeScript ESM on Node ≥20, vitest, undici; **one new dependency: `fflate`** (zip extract/create — wp.org packages are zips, and test fixtures need to build them).

## Global Constraints

- Plugin stays native PHP, zero external dependencies, read-only, **no new endpoints**; REST namespace `/ferry/v1/` unchanged.
- Hash algorithm is **MD5 everywhere** — dictated by `api.wordpress.org/core/checksums/1.0/`.
- The cache ingests **wordpress.org bytes only**. Customer bytes never enter the cache.
- **wp.org is an optimization, never a dependency**: every provenance failure demotes files to fetch-over-the-bridge; a pull never fails because of provenance.
- **Mirror-first**: the clone's bytes always equal production's. Reconstruction only ever substitutes bytes proven identical by hash; a hacked file is reported *and* faithfully present in the clone.
- All per-site state lives in readable files under `$FERRY_HOME` (`FERRY_HOME` env override respected; tests use it).
- Unit/integration tests must never hit real wordpress.org — wp.org endpoints are injectable everywhere.
- Version-skew must stay graceful: `hash: null` manifest entries and missing `/info` hint fields (old plugin) degrade to v0 full-fetch behavior.
- Surgical changes only: match existing code style (plugin: PHP-7-compatible `final class` statics; CLI: small ESM modules, explicit vitest imports).
- Run tests from the component dir: `cd ferry-cli && npx vitest run <file>` / `cd ferry-plugin && composer test` (or `./vendor/bin/phpunit`).

---

### Task 1: Plugin — real MD5 hashes in the manifest

**Files:**
- Modify: `ferry-plugin/src/Manifest.php`
- Test: `ferry-plugin/tests/ManifestTest.php`

**Interfaces:**
- Consumes: existing `Manifest::batch(string $root, int $after, Budget $budget, int $cap = 5000)` and `Excludes`.
- Produces: manifest entries `{path: string, size: int, hash: ?string}` where `hash` is the file's MD5 hex, `null` only when the file is unreadable. The CLI (Tasks 6/8) relies on `hash` being the MD5 of the file's bytes.

**Key design point:** hashing must happen **after** the resume-cursor check, not inside `walk()` — a resumed request (`?after=N`) must never re-read the bytes of files already delivered in earlier batches. The walk itself (sorted `scandir`) stays byte-free.

- [ ] **Step 1: Write the failing tests**

In `ferry-plugin/tests/ManifestTest.php`, update the two existing assertions and add an unreadable-file test:

```php
// in test_walk_is_sorted_and_applies_excludes(), replace the assertNull line:
        $this->assertSame(md5('body{}'), $result['files'][1]['hash']);
        $this->assertSame(md5_file($this->root . '/index.php'), $result['files'][0]['hash']);

// in test_resume_via_after_and_cap(), after the $all assertion, add:
        $this->assertSame(md5('body{}'), $second['files'][0]['hash'], 'resumed batches must carry hashes too');

// new test method:
    public function test_unreadable_file_yields_null_hash(): void
    {
        if (function_exists('posix_geteuid') && posix_geteuid() === 0) {
            $this->markTestSkipped('root reads chmod-0000 files');
        }
        chmod($this->root . '/index.php', 0000);
        $result = Manifest::batch($this->root, 0, new Budget(10.0));
        $this->assertNull($result['files'][0]['hash']);
        chmod($this->root . '/index.php', 0644);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ferry-plugin && ./vendor/bin/phpunit tests/ManifestTest.php`
Expected: FAIL — `hash` is `null`, not the MD5.

- [ ] **Step 3: Implement**

In `ferry-plugin/src/Manifest.php`, replace `batch()` (walk stays unchanged — it keeps yielding `hash => null` as a placeholder that `batch()` fills):

```php
    /**
     * @return array{files: array<int, array{path: string, size: int, hash: ?string}>, next: int, complete: bool}
     */
    public static function batch(string $root, int $after, Budget $budget, int $cap = 5000): array
    {
        $root = rtrim($root, '/');
        $files = [];
        $index = 0;
        $complete = true;
        foreach (self::walk($root, '') as $entry) {
            if ($index++ < $after) {
                continue;
            }
            // Hash after the resume-cursor check: a resumed request must never
            // re-read bytes already delivered in earlier batches. @: an unreadable
            // file is a null hash (CLI fetches it), not a PHP warning in the response.
            $hash = @md5_file($root . '/' . $entry['path']);
            $entry['hash'] = $hash === false ? null : $hash;
            $files[] = $entry;
            if (count($files) >= $cap || $budget->exhausted()) {
                $complete = false;
                break;
            }
        }
        return ['files' => $files, 'next' => $after + count($files), 'complete' => $complete];
    }
```

Also update the `walk()` docblock's return type to `array{path: string, size: int, hash: ?string}`.

- [ ] **Step 4: Run the full plugin suite**

Run: `cd ferry-plugin && ./vendor/bin/phpunit`
Expected: all green (the existing budget test `test_exhausted_budget_still_makes_progress` must still pass — hashing happens inside the budget window, which is the point).

- [ ] **Step 5: Commit**

```bash
git add ferry-plugin/src/Manifest.php ferry-plugin/tests/ManifestTest.php
git commit -m "feat(plugin): real MD5 hashes in the manifest"
```

---

### Task 2: Plugin — locale + plugin/theme version hints in /info, CLI SiteInfo type

**Files:**
- Create: `ferry-plugin/src/Hints.php`
- Modify: `ferry-plugin/src/Routes.php` (the `info()` return array)
- Modify: `ferry-cli/src/profile.ts` (SiteInfo)
- Test: `ferry-plugin/tests/HintsTest.php`

**Interfaces:**
- Produces (wire, added to `GET /ferry/v1/info`):
  - `locale: string` (e.g. `"nl_NL"`)
  - `plugins: [{file: string, version: string}]` — `file` is get_plugins()' key, e.g. `"akismet/akismet.php"`; `version` may be `""`.
  - `themes: [{stylesheet: string, version: string}]`
- Produces (CLI): `SiteInfo` gains **optional** `locale?`, `plugins?`, `themes?` (optional so an old plugin's response still parses — Task 6 treats absence as "no hints").
- These are **hints only**; Task 6 never trusts them beyond choosing which packages to try.

- [ ] **Step 1: Write the failing test**

Create `ferry-plugin/tests/HintsTest.php`:

```php
<?php
use Ferry\Hints;
use PHPUnit\Framework\TestCase;

final class HintsTest extends TestCase
{
    public function test_plugins_maps_get_plugins_output(): void
    {
        $raw = [
            'akismet/akismet.php' => ['Name' => 'Akismet', 'Version' => '5.3.7'],
            'hello.php'           => ['Name' => 'Hello Dolly'], // no Version header
        ];
        $this->assertSame([
            ['file' => 'akismet/akismet.php', 'version' => '5.3.7'],
            ['file' => 'hello.php', 'version' => ''],
        ], Hints::plugins($raw));
    }

    public function test_themes_maps_stylesheet_version_pairs(): void
    {
        $this->assertSame(
            [['stylesheet' => 'twentytwentyfive', 'version' => '1.2']],
            Hints::themes(['twentytwentyfive' => '1.2'])
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ferry-plugin && ./vendor/bin/phpunit tests/HintsTest.php`
Expected: FAIL — class `Ferry\Hints` not found.

- [ ] **Step 3: Implement `Hints.php` and wire `Routes::info()`**

Create `ferry-plugin/src/Hints.php`:

```php
<?php
namespace Ferry;

/**
 * §2.14 provenance hints: which wp.org packages the CLI should try.
 * Hints only - the CLI verifies every file by hash; a lying Version
 * header costs bandwidth, never correctness.
 */
final class Hints
{
    /**
     * @param array<string, array<string, mixed>> $plugins get_plugins() output
     * @return array<int, array{file: string, version: string}>
     */
    public static function plugins(array $plugins): array
    {
        $out = [];
        foreach ($plugins as $file => $data) {
            $out[] = [
                'file'    => (string) $file,
                'version' => (string) (isset($data['Version']) ? $data['Version'] : ''),
            ];
        }
        return $out;
    }

    /**
     * @param array<string, string> $themes stylesheet => version
     * @return array<int, array{stylesheet: string, version: string}>
     */
    public static function themes(array $themes): array
    {
        $out = [];
        foreach ($themes as $stylesheet => $version) {
            $out[] = ['stylesheet' => (string) $stylesheet, 'version' => (string) $version];
        }
        return $out;
    }
}
```

In `ferry-plugin/src/Routes.php` `info()`, add three entries to the returned array (after `'siteurl' => ...`):

```php
            'locale'    => get_locale(),
            'plugins'   => Hints::plugins(self::installed_plugins()),
            'themes'    => Hints::themes(self::installed_themes()),
```

and add two private helpers to `Routes` (kept out of `Hints` so `Hints` stays pure/testable):

```php
    /** @return array<string, array<string, mixed>> */
    private static function installed_plugins(): array
    {
        if (!function_exists('get_plugins')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        return get_plugins();
    }

    /** @return array<string, string> stylesheet => version */
    private static function installed_themes(): array
    {
        $out = [];
        foreach (wp_get_themes() as $stylesheet => $theme) {
            $out[$stylesheet] = (string) $theme->get('Version');
        }
        return $out;
    }
```

- [ ] **Step 4: Run plugin suite**

Run: `cd ferry-plugin && ./vendor/bin/phpunit`
Expected: all green (`Routes::info()` itself has no unit test — it needs live WP and is covered by the E2E gate, same as v0).

- [ ] **Step 5: Update `SiteInfo` in `ferry-cli/src/profile.ts`**

Add to the `SiteInfo` interface after `siteurl: string;`:

```ts
  locale?: string;
  plugins?: { file: string; version: string }[];
  themes?: { stylesheet: string; version: string }[];
```

Run: `cd ferry-cli && npx vitest run && npm run build`
Expected: all green, clean build (fields are optional — nothing else changes yet).

- [ ] **Step 6: Commit**

```bash
git add ferry-plugin/src/Hints.php ferry-plugin/src/Routes.php ferry-plugin/tests/HintsTest.php ferry-cli/src/profile.ts
git commit -m "feat(plugin): locale + plugin/theme version hints in /info"
```

---

### Task 3: CLI — wporg.ts (wp.org endpoints) + mock wp.org test helper

**Files:**
- Create: `ferry-cli/src/provenance/wporg.ts`
- Create: `ferry-cli/tests/helpers/mockWporg.ts`
- Modify: `ferry-cli/package.json` (add `fflate`)
- Test: `ferry-cli/tests/wporg.test.ts`

**Interfaces (produced — Tasks 4/6/8 consume exactly these):**

```ts
export interface WporgEndpoints { api: string; downloads: string }
export const WPORG_DEFAULTS: WporgEndpoints; // { api: 'https://api.wordpress.org', downloads: 'https://downloads.wordpress.org' }
export function coreChecksumsUrl(ep: WporgEndpoints, version: string, locale: string): string;
export function coreZipUrl(ep: WporgEndpoints, version: string, locale: string): string;
export function pluginZipUrl(ep: WporgEndpoints, slug: string, version: string): string;
export function themeZipUrl(ep: WporgEndpoints, slug: string, version: string): string;
// null = unavailable (404, network error, timeout, malformed) - NEVER throws:
export function fetchCoreChecksums(ep: WporgEndpoints, version: string, locale: string):
  Promise<{ checksums: Record<string, string>; locale: string } | null>;
export function downloadZip(url: string): Promise<Buffer | null>;
```

Test helper (consumed by Tasks 4 and 8):

```ts
export interface MockWporg { endpoints: WporgEndpoints; requests: string[]; close(): void }
export function zipOf(topDir: string, files: Record<string, string>): Buffer; // wp.org-style zip with one wrapping top dir
export function startMockWporg(opts?: {
  checksums?: Record<string, Record<string, string> | false>; // "<version>-<locale>" → path→md5, false → API's "unknown" answer
  zips?: Record<string, Buffer>;                              // URL pathname → zip bytes
}): Promise<MockWporg>;
```

- [ ] **Step 1: Add the fflate dependency**

```bash
cd ferry-cli && npm install fflate@^0.8.2
```

- [ ] **Step 2: Write the failing tests**

Create `ferry-cli/tests/wporg.test.ts`:

```ts
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  coreZipUrl, downloadZip, fetchCoreChecksums, pluginZipUrl, themeZipUrl,
} from '../src/provenance/wporg.js';
import { startMockWporg, zipOf, type MockWporg } from './helpers/mockWporg.js';

describe('wporg', () => {
  let mock: MockWporg;
  afterEach(() => mock?.close());

  it('builds the documented URL shapes', () => {
    const ep = { api: 'https://api.wordpress.org', downloads: 'https://downloads.wordpress.org' };
    expect(coreZipUrl(ep, '6.8.2', 'en_US')).toBe('https://downloads.wordpress.org/release/wordpress-6.8.2.zip');
    expect(coreZipUrl(ep, '6.8.2', 'nl_NL')).toBe('https://downloads.wordpress.org/release/nl_NL/wordpress-6.8.2-nl_NL.zip');
    expect(pluginZipUrl(ep, 'akismet', '5.3.7')).toBe('https://downloads.wordpress.org/plugin/akismet.5.3.7.zip');
    expect(themeZipUrl(ep, 'twentytwentyfive', '1.2')).toBe('https://downloads.wordpress.org/theme/twentytwentyfive.1.2.zip');
  });

  it('fetches core checksums for the requested locale', async () => {
    mock = await startMockWporg({ checksums: { '6.8.2-nl_NL': { 'wp-includes/a.php': 'abc' } } });
    const result = await fetchCoreChecksums(mock.endpoints, '6.8.2', 'nl_NL');
    expect(result).toEqual({ checksums: { 'wp-includes/a.php': 'abc' }, locale: 'nl_NL' });
  });

  it('falls back to en_US when the locale build has no checksums', async () => {
    mock = await startMockWporg({ checksums: { '6.8.2-en_US': { 'wp-includes/a.php': 'abc' } } });
    const result = await fetchCoreChecksums(mock.endpoints, '6.8.2', 'nl_NL');
    expect(result?.locale).toBe('en_US');
  });

  it('returns null when the API answers checksums:false for every locale', async () => {
    mock = await startMockWporg({ checksums: {} });
    expect(await fetchCoreChecksums(mock.endpoints, '9.9.9', 'nl_NL')).toBeNull();
  });

  it('returns null (never throws) when wp.org is unreachable', async () => {
    const ep = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };
    expect(await fetchCoreChecksums(ep, '6.8.2', 'en_US')).toBeNull();
    expect(await downloadZip('http://127.0.0.1:1/plugin/x.1.0.zip')).toBeNull();
  });

  it('downloads a zip and 404s become null', async () => {
    mock = await startMockWporg({ zips: { '/plugin/akismet.5.3.7.zip': zipOf('akismet', { 'akismet.php': '<?php' }) } });
    const buf = await downloadZip(`${mock.endpoints.downloads}/plugin/akismet.5.3.7.zip`);
    expect(buf).not.toBeNull();
    expect(Object.keys(unzipSync(new Uint8Array(buf!)))).toContain('akismet/akismet.php');
    expect(await downloadZip(`${mock.endpoints.downloads}/plugin/nope.1.0.zip`)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ferry-cli && npx vitest run tests/wporg.test.ts`
Expected: FAIL — module `../src/provenance/wporg.js` not found.

- [ ] **Step 4: Implement helper and module**

Create `ferry-cli/tests/helpers/mockWporg.ts`:

```ts
import { zipSync } from 'fflate';
import { createServer, type Server } from 'node:http';
import type { WporgEndpoints } from '../../src/provenance/wporg.js';

export interface MockWporg { endpoints: WporgEndpoints; requests: string[]; close(): void }

/** wp.org-style zip: all files wrapped in one top-level dir ("wordpress/", "<slug>/"). */
export function zipOf(topDir: string, files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[`${topDir}/${path}`] = new TextEncoder().encode(content);
  }
  return Buffer.from(zipSync(entries));
}

export async function startMockWporg(opts: {
  checksums?: Record<string, Record<string, string> | false>;
  zips?: Record<string, Buffer>;
} = {}): Promise<MockWporg> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/core/checksums/1.0/') {
      const key = `${url.searchParams.get('version')}-${url.searchParams.get('locale')}`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ checksums: opts.checksums?.[key] ?? false }));
      return;
    }
    const zip = opts.zips?.[url.pathname];
    if (zip) {
      res.setHeader('content-type', 'application/zip');
      res.end(zip);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { endpoints: { api: base, downloads: base }, requests, close: () => server.close() };
}
```

Create `ferry-cli/src/provenance/wporg.ts`:

```ts
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
      const res = await request(url, { signal: AbortSignal.timeout(timeoutMs), maxRedirections: 3 });
      const buf = Buffer.from(await res.body.arrayBuffer());
      if (res.statusCode === 200) return buf;
      if (res.statusCode === 404) return null; // definitive: not on wp.org - retrying won't help
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ferry-cli && npx vitest run tests/wporg.test.ts`
Expected: PASS (the unreachable test is fast — ECONNREFUSED, not a timeout).

- [ ] **Step 6: Commit**

```bash
git add ferry-cli/src/provenance/wporg.ts ferry-cli/tests/helpers/mockWporg.ts ferry-cli/tests/wporg.test.ts ferry-cli/package.json ferry-cli/package-lock.json
git commit -m "feat(cli): wp.org checksums/zip client with unavailable-as-value semantics"
```

---

### Task 4: CLI — cache.ts (the package store)

**Files:**
- Create: `ferry-cli/src/provenance/cache.ts`
- Test: `ferry-cli/tests/cache.test.ts`

**Interfaces (produced — Task 6 consumes exactly these):**

```ts
export interface PackageRef { type: 'core' | 'plugin' | 'theme'; slug: string; version: string; locale?: string }
// core uses slug 'core' and carries locale; plugin/theme carry no locale
export interface CachedPackage { ref: PackageRef; filesDir: string; checksums: Record<string, string> }
// checksums keys and filesDir layout are PACKAGE-ROOT-RELATIVE paths ("wp-admin/about.php", "akismet.php")
export function packageDir(cacheDir: string, ref: PackageRef): string;
export function safeRelPath(entryName: string): string | null; // zip-slip guard + top-dir strip; exported for tests
export function ensurePackage(cacheDir: string, ref: PackageRef, ep: WporgEndpoints): Promise<CachedPackage | null>;
// null = package unavailable. Cached hit = zero network. Ingest is atomic (tmp + rename).
export function cleanTmp(cacheDir: string): void; // removes cache/tmp entries older than 24h
```

**Core ingest rule (spec §5/§8):** for core, `checksums.json` is the **full official API list** (the report needs it), but `files/` only holds bytes whose MD5 **matches** that list — a zip byte that disagrees with the API is dropped, so it can never be reconstructed. For plugins/themes there is no API: `checksums.json` is computed from the extracted zip, which *is* the authority.

- [ ] **Step 1: Write the failing tests**

Create `ferry-cli/tests/cache.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanTmp, ensurePackage, packageDir, safeRelPath, type PackageRef } from '../src/provenance/cache.js';
import { startMockWporg, zipOf, type MockWporg } from './helpers/mockWporg.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('cache', () => {
  let cacheDir: string;
  let mock: MockWporg;

  beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'ferry-cache-')); });
  afterEach(() => { mock?.close(); rmSync(cacheDir, { recursive: true, force: true }); });

  it('maps refs to package dirs', () => {
    expect(packageDir('/c', { type: 'core', slug: 'core', version: '6.8.2', locale: 'nl_NL' })).toBe('/c/packages/core/6.8.2-nl_NL');
    expect(packageDir('/c', { type: 'plugin', slug: 'akismet', version: '5.3.7' })).toBe('/c/packages/plugin/akismet/5.3.7');
    expect(packageDir('/c', { type: 'theme', slug: 'x', version: '1.2' })).toBe('/c/packages/theme/x/1.2');
  });

  it('strips the wp.org top dir and rejects zip-slip entries', () => {
    expect(safeRelPath('wordpress/wp-admin/about.php')).toBe('wp-admin/about.php');
    expect(safeRelPath('akismet/akismet.php')).toBe('akismet.php');
    expect(safeRelPath('toplevel.txt')).toBeNull();
    expect(safeRelPath('a/../../etc/passwd')).toBeNull();
    expect(safeRelPath('/abs/path')).toBeNull();
  });

  it('ingests a plugin zip: extracts, computes checksums, atomic rename', async () => {
    mock = await startMockWporg({ zips: { '/plugin/akismet.5.3.7.zip': zipOf('akismet', { 'akismet.php': '<?php // a', 'readme.txt': 'hi' }) } });
    const ref: PackageRef = { type: 'plugin', slug: 'akismet', version: '5.3.7' };
    const pkg = await ensurePackage(cacheDir, ref, mock.endpoints);
    expect(pkg).not.toBeNull();
    expect(pkg!.checksums['akismet.php']).toBe(md5('<?php // a'));
    expect(readFileSync(join(pkg!.filesDir, 'readme.txt'), 'utf8')).toBe('hi');
    expect(existsSync(join(cacheDir, 'tmp'))).toBe(true); // tmp parent may remain; no stray package dirs inside
    // cached hit: no second download
    const before = mock.requests.length;
    const again = await ensurePackage(cacheDir, ref, mock.endpoints);
    expect(again!.checksums).toEqual(pkg!.checksums);
    expect(mock.requests.length).toBe(before);
  });

  it('core ingest keeps the full API list but drops zip bytes that mismatch it', async () => {
    const good = '<?php // good';
    mock = await startMockWporg({
      checksums: { '6.8.2-en_US': { 'wp-includes/a.php': md5(good), 'wp-includes/b.php': md5('official-b'), 'wp-content/themes/x/s.css': md5('x') } },
      zips: { '/release/wordpress-6.8.2.zip': zipOf('wordpress', { 'wp-includes/a.php': good, 'wp-includes/b.php': 'TAMPERED' }) },
    });
    const pkg = await ensurePackage(cacheDir, { type: 'core', slug: 'core', version: '6.8.2', locale: 'en_US' }, mock.endpoints);
    expect(pkg!.checksums['wp-includes/b.php']).toBe(md5('official-b')); // full list kept for the report
    expect(existsSync(join(pkg!.filesDir, 'wp-includes/a.php'))).toBe(true);
    expect(existsSync(join(pkg!.filesDir, 'wp-includes/b.php'))).toBe(false); // unproven bytes never cached
  });

  it('returns null when the zip 404s or the API has no checksums for core', async () => {
    mock = await startMockWporg({});
    expect(await ensurePackage(cacheDir, { type: 'plugin', slug: 'nope', version: '1.0' }, mock.endpoints)).toBeNull();
    expect(await ensurePackage(cacheDir, { type: 'core', slug: 'core', version: '9.9.9', locale: 'en_US' }, mock.endpoints)).toBeNull();
  });

  it('cleanTmp removes only stale tmp dirs', () => {
    const stale = join(cacheDir, 'tmp', 'old');
    const fresh = join(cacheDir, 'tmp', 'new');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const old = (Date.now() - 25 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);
    cleanTmp(cacheDir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ferry-cli && npx vitest run tests/cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cache.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ferry-cli && npx vitest run tests/cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/provenance/cache.ts ferry-cli/tests/cache.test.ts
git commit -m "feat(cli): package cache with atomic wp.org-only ingest"
```

---

### Task 5: CLI — md5 helper + reconstruct.ts (verified CoW copy)

**Files:**
- Create: `ferry-cli/src/provenance/md5.ts`
- Create: `ferry-cli/src/provenance/reconstruct.ts`
- Test: `ferry-cli/tests/reconstruct.test.ts`

**Interfaces (produced — Tasks 6/8 consume exactly these):**

```ts
// md5.ts
export function md5File(path: string): Promise<string | null>; // null on any read error (incl. ENOENT)
// reconstruct.ts
export interface ReconstructItem { path: string; sourceFile: string; md5: string }
// path = manifest path in the clone; sourceFile = absolute path inside the cache
export function reconstruct(items: ReconstructItem[], docroot: string): Promise<{ failed: ReconstructItem[] }>;
// verify-then-CoW-copy; failures are RETURNED (caller demotes to fetch), never thrown
```

- [ ] **Step 1: Write the failing tests**

Create `ferry-cli/tests/reconstruct.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ferry-cli && npx vitest run tests/reconstruct.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `ferry-cli/src/provenance/md5.ts`:

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streaming MD5 of a file; null on any read error (incl. ENOENT). */
export async function md5File(path: string): Promise<string | null> {
  try {
    const hash = createHash('md5');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}
```

Create `ferry-cli/src/provenance/reconstruct.ts`:

```ts
import { constants, promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { md5File } from './md5.js';

export interface ReconstructItem { path: string; sourceFile: string; md5: string }

/**
 * Verify the cache source's MD5, then CoW-copy into the clone (COPYFILE_FICLONE:
 * reflink on APFS, silent full-copy fallback elsewhere). Real copies, never
 * hardlinks - an agent editing the clone must never write through into the
 * shared cache. Failures are returned; the caller demotes them to a bridge fetch.
 */
export async function reconstruct(items: ReconstructItem[], docroot: string): Promise<{ failed: ReconstructItem[] }> {
  const limit = pLimit(8);
  const failed: ReconstructItem[] = [];
  await Promise.all(items.map((item) => limit(async () => {
    if ((await md5File(item.sourceFile)) !== item.md5) {
      failed.push(item);
      return;
    }
    try {
      const dest = join(docroot, item.path);
      await fsp.mkdir(dirname(dest), { recursive: true });
      await fsp.copyFile(item.sourceFile, dest, constants.COPYFILE_FICLONE);
    } catch {
      failed.push(item);
    }
  })));
  return { failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ferry-cli && npx vitest run tests/reconstruct.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/provenance/md5.ts ferry-cli/src/provenance/reconstruct.ts ferry-cli/tests/reconstruct.test.ts
git commit -m "feat(cli): verified CoW reconstruction from the package cache"
```

---

### Task 6: CLI — resolve.ts rewrite (the seam becomes the classifier)

**Files:**
- Rewrite: `ferry-cli/src/resolve.ts`
- Test: `ferry-cli/tests/resolve.test.ts`

**Interfaces:**
- Consumes: `ManifestEntry` (client.ts), `SiteInfo` (profile.ts, Task 2 fields), `ensurePackage`/`PackageRef`/`CachedPackage` (Task 4), `md5File` (Task 5), `ReconstructItem` (Task 5), `WporgEndpoints`/`WPORG_DEFAULTS` (Task 3).
- Produces (Task 7's report and Task 8's pull consume exactly these):

```ts
export type Owner =
  | { type: 'core'; relPath: string }
  | { type: 'plugin' | 'theme'; dir: string; relPath: string }
  | null;
export function ownerOf(path: string): Owner; // exported for tests
export interface PackageEvidence {
  ref: PackageRef;
  checksums: Record<string, string>; // official, package-root-relative
  entries: { relPath: string; hash: string | null }[]; // ALL owned manifest entries, transfer bucket irrelevant
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
export function resolve(entries: ManifestEntry[], info: SiteInfo, deps: ResolveDeps): Promise<ResolvePlan>;
```

**Classification rules (spec §4):** per entry, in order: (1) local file at `docroot/path` has the same MD5 → **reuse**; (2) owning package is cached/ingested, `checksums[relPath] === entry.hash`, and the cache source file exists → **reconstruct**; (3) otherwise → **fetch**. `hash: null` can never reuse or reconstruct. Ownership: non-`wp-content/` → core; `wp-content/plugins/<dir>/<rest>` → plugin `<dir>`; `wp-content/themes/<dir>/<rest>` → theme `<dir>`; everything else (incl. `wp-content/index.php`, single-file plugins like `plugins/hello.php`, mu-plugins, languages) → no owner. Packages are ensured for **every** hinted package owning ≥1 entry — even all-reuse ones — because the report needs their checksums; on a warm cache that costs zero network.

- [ ] **Step 1: Write the failing tests**

Create `ferry-cli/tests/resolve.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManifestEntry } from '../src/client.js';
import type { SiteInfo } from '../src/profile.js';
import { ownerOf, resolve } from '../src/resolve.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const DEAD_WPORG = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };

const entry = (path: string, content: string | null): ManifestEntry =>
  ({ path, size: content?.length ?? 0, hash: content === null ? null : md5(content) });

const info = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.8.2', php: { version: '8.2', extensions: [], ini: {} },
  db: { server: 'mariadb', version: '10.6', charset: 'utf8mb4', collation: '', bytes: 1 },
  server: 'nginx', constants: {}, multisite: false, prefix: 'wp_',
  abspath: '/var/www/html/', siteurl: 'https://x.example', locale: 'en_US',
  plugins: [], themes: [], ...over,
});

/** Seed a ready-made cache package on disk - resolve must use it with zero network. */
function seedPackage(cacheDir: string, rel: string, files: Record<string, string>, checksums?: Record<string, string>): void {
  const dir = join(cacheDir, 'packages', rel);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'files', p)), { recursive: true });
    writeFileSync(join(dir, 'files', p), content);
  }
  mkdirSync(dir, { recursive: true });
  const sums = checksums ?? Object.fromEntries(Object.entries(files).map(([p, c]) => [p, md5(c)]));
  writeFileSync(join(dir, 'checksums.json'), JSON.stringify(sums));
}

describe('ownerOf', () => {
  it('maps paths to their owning package', () => {
    expect(ownerOf('wp-admin/about.php')).toEqual({ type: 'core', relPath: 'wp-admin/about.php' });
    expect(ownerOf('index.php')).toEqual({ type: 'core', relPath: 'index.php' });
    expect(ownerOf('wp-content/plugins/akismet/akismet.php')).toEqual({ type: 'plugin', dir: 'akismet', relPath: 'akismet.php' });
    expect(ownerOf('wp-content/themes/x/style.css')).toEqual({ type: 'theme', dir: 'x', relPath: 'style.css' });
    expect(ownerOf('wp-content/plugins/akismet-pro/a.php')).toEqual({ type: 'plugin', dir: 'akismet-pro', relPath: 'a.php' });
    expect(ownerOf('wp-content/plugins/hello.php')).toBeNull(); // single-file plugin: no package
    expect(ownerOf('wp-content/index.php')).toBeNull();
    expect(ownerOf('wp-content/mu-plugins/x.php')).toBeNull();
  });
});

describe('resolve', () => {
  let docroot: string;
  let cacheDir: string;

  beforeEach(() => {
    docroot = mkdtempSync(join(tmpdir(), 'ferry-docroot-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'ferry-cache-'));
  });
  afterEach(() => {
    rmSync(docroot, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('classifies reuse > reconstruct > fetch, with evidence for the report', async () => {
    seedPackage(cacheDir, 'core/6.8.2-en_US', { 'wp-includes/a.php': 'official-a', 'wp-includes/b.php': 'official-b' });
    mkdirSync(join(docroot, 'wp-includes'), { recursive: true });
    writeFileSync(join(docroot, 'wp-includes/a.php'), 'official-a'); // already local → reuse
    const entries = [
      entry('wp-includes/a.php', 'official-a'),
      entry('wp-includes/b.php', 'official-b'),   // in cache → reconstruct
      entry('wp-includes/hacked.php', 'evil'),    // core-owned, not in checksums → fetch
      entry('wp-content/custom.txt', 'unique'),   // no owner → fetch
      entry('unreadable.php', null),              // null hash → fetch
    ];
    const plan = await resolve(entries, info(), { docroot, cacheDir, wporg: DEAD_WPORG });
    expect(plan.reuse.map((e) => e.path)).toEqual(['wp-includes/a.php']);
    expect(plan.reconstruct.map((r) => r.path)).toEqual(['wp-includes/b.php']);
    expect(plan.reconstruct[0].sourceFile).toBe(join(cacheDir, 'packages/core/6.8.2-en_US/files/wp-includes/b.php'));
    expect(plan.fetch.map((e) => e.path).sort()).toEqual(['unreadable.php', 'wp-content/custom.txt', 'wp-includes/hacked.php']);
    const core = plan.evidence.find((ev) => ev.ref.type === 'core')!;
    expect(core.entries.map((e) => e.relPath).sort()).toEqual(
      ['unreadable.php', 'wp-includes/a.php', 'wp-includes/b.php', 'wp-includes/hacked.php'],
    );
  });

  it('reuses a modified core file yet still carries it in evidence', async () => {
    seedPackage(cacheDir, 'core/6.8.2-en_US', { 'wp-includes/v.php': 'official' });
    mkdirSync(join(docroot, 'wp-includes'), { recursive: true });
    writeFileSync(join(docroot, 'wp-includes/v.php'), 'hacked'); // clone already mirrors the hack
    const plan = await resolve([entry('wp-includes/v.php', 'hacked')], info(), { docroot, cacheDir, wporg: DEAD_WPORG });
    expect(plan.reuse).toHaveLength(1); // transfer decision: nothing to move
    const core = plan.evidence.find((ev) => ev.ref.type === 'core')!;
    expect(core.entries[0]).toEqual({ relPath: 'wp-includes/v.php', hash: md5('hacked') }); // report will flag it
  });

  it('uses cached plugin/theme packages via hints', async () => {
    seedPackage(cacheDir, 'plugin/akismet/5.3.7', { 'akismet.php': 'plugin-code' });
    seedPackage(cacheDir, 'theme/twentytwentyfive/1.2', { 'style.css': 'theme-css' });
    const plan = await resolve(
      [entry('wp-content/plugins/akismet/akismet.php', 'plugin-code'), entry('wp-content/themes/twentytwentyfive/style.css', 'theme-css')],
      info({ plugins: [{ file: 'akismet/akismet.php', version: '5.3.7' }], themes: [{ stylesheet: 'twentytwentyfive', version: '1.2' }] }),
      { docroot, cacheDir, wporg: DEAD_WPORG },
    );
    expect(plan.reconstruct).toHaveLength(2);
    expect(plan.fetch).toEqual([]);
  });

  it('marks hintless dirs and unavailable packages as unverified, files fetch', async () => {
    const plan = await resolve(
      [entry('wp-content/plugins/premium-seo/seo.php', 'secret'), entry('wp-content/plugins/akismet/akismet.php', 'x')],
      info({ plugins: [{ file: 'akismet/akismet.php', version: '5.3.7' }] }), // premium-seo: no hint; akismet: cold cache + dead wp.org
      { docroot, cacheDir, wporg: DEAD_WPORG },
    );
    expect(plan.fetch).toHaveLength(2);
    expect(plan.unverified).toContainEqual({ type: 'plugin', slug: 'premium-seo', version: null, reason: 'no-version-hint' });
    expect(plan.unverified).toContainEqual({ type: 'plugin', slug: 'akismet', version: '5.3.7', reason: 'unavailable' });
    expect(plan.evidence).toEqual([]); // nothing verifiable - core owned no entries here
  });

  it('degrades to all-fetch with no hints and no hashes (old plugin)', async () => {
    const plan = await resolve(
      [entry('index.php', null), entry('wp-load.php', null)],
      info({ locale: undefined, plugins: undefined, themes: undefined }),
      { docroot, cacheDir, wporg: DEAD_WPORG },
    );
    expect(plan.fetch).toHaveLength(2);
    expect(plan.reuse).toEqual([]);
    expect(plan.reconstruct).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ferry-cli && npx vitest run tests/resolve.test.ts`
Expected: FAIL — `resolve` has the old identity signature, `ownerOf` doesn't exist.

- [ ] **Step 3: Rewrite `resolve.ts`**

```ts
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
```

- [ ] **Step 4: Run resolve tests, then the whole CLI suite**

Run: `cd ferry-cli && npx vitest run tests/resolve.test.ts && npx vitest run`
Expected: resolve tests PASS; **`tests/pull.test.ts` now FAILS to compile** (pull.ts still calls the old `resolve(manifest)` signature). That is expected and fixed in Task 8 — do not fix pull.ts in this task. If anything besides pull/smoke breaks, stop and investigate.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/resolve.ts ferry-cli/tests/resolve.test.ts
git commit -m "feat(cli): resolve() becomes the provenance classifier (reuse/reconstruct/fetch)"
```

---

### Task 7: CLI — report.ts (build, write, summarize)

**Files:**
- Create: `ferry-cli/src/provenance/report.ts`
- Test: `ferry-cli/tests/report.test.ts`

**Interfaces:**
- Consumes: `PackageEvidence`, `UnverifiedPackage` (Task 6), `ferryHome` (profile.ts).
- Produces (Task 8 consumes exactly these):

```ts
export interface PackageReport {
  type: 'core' | 'plugin' | 'theme'; slug: string; version: string; locale?: string;
  modified: string[]; missing: string[]; extra: string[];
}
export interface ProvenanceReport { generatedAt: string; verified: PackageReport[]; unverified: UnverifiedPackage[] }
export function buildReport(evidence: PackageEvidence[], unverified: UnverifiedPackage[]): ProvenanceReport;
export function writeReport(slug: string, report: ProvenanceReport): string; // returns the file path
export function summarize(report: ProvenanceReport): string; // one console line
```

**Rules (spec §7):** paths in the report are package-root-relative. For core, only official checksum paths **outside** `wp-content/` are compared (the API list's bundled akismet/`twenty*` entries are ignored — wp-content is judged by its own packages); `extra` = present paths under `wp-admin/` or `wp-includes/` that are in no official list, core only. `modified` = present, hash non-null, ≠ official. `missing` = official, absent from the manifest. Entries with `hash: null` are never judged.

- [ ] **Step 1: Write the failing tests**

Create `ferry-cli/tests/report.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport, summarize, writeReport } from '../src/provenance/report.js';
import type { PackageEvidence } from '../src/resolve.js';

const coreEvidence = (over: Partial<PackageEvidence> = {}): PackageEvidence => ({
  ref: { type: 'core', slug: 'core', version: '6.8.2', locale: 'en_US' },
  checksums: {
    'wp-includes/clean.php': 'aaa',
    'wp-includes/hacked.php': 'bbb',
    'wp-admin/deleted.php': 'ccc',
    'wp-content/themes/twentytwentyfive/style.css': 'ddd', // API bundles wp-content - must be ignored
  },
  entries: [
    { relPath: 'wp-includes/clean.php', hash: 'aaa' },
    { relPath: 'wp-includes/hacked.php', hash: 'EVIL' },
    { relPath: 'wp-includes/rogue.php', hash: 'fff' },      // extra: not in any official list
    { relPath: 'license-note.txt', hash: 'eee' },           // root extra: NOT reported (legit custom root files)
    { relPath: 'wp-includes/unreadable.php', hash: null },  // never judged
  ],
  ...over,
});

describe('report', () => {
  it('buckets modified, missing, and extra for core; ignores wp-content and null hashes', () => {
    const report = buildReport([coreEvidence()], []);
    const core = report.verified[0];
    expect(core.modified).toEqual(['wp-includes/hacked.php']);
    expect(core.missing).toEqual(['wp-admin/deleted.php']);
    expect(core.extra).toEqual(['wp-includes/rogue.php']);
  });

  it('plugin packages get modified+missing but never extra', () => {
    const report = buildReport([{
      ref: { type: 'plugin', slug: 'akismet', version: '5.3.7' },
      checksums: { 'akismet.php': 'aaa', 'removed.php': 'bbb' },
      entries: [{ relPath: 'akismet.php', hash: 'PATCHED' }, { relPath: 'custom-note.txt', hash: 'ccc' }],
    }], []);
    expect(report.verified[0].modified).toEqual(['akismet.php']);
    expect(report.verified[0].missing).toEqual(['removed.php']);
    expect(report.verified[0].extra).toEqual([]);
  });

  it('summarize: clean line when nothing flagged, warning with counts otherwise', () => {
    const clean = buildReport([{
      ref: { type: 'core', slug: 'core', version: '6.8.2', locale: 'en_US' },
      checksums: { 'wp-includes/a.php': 'aaa' },
      entries: [{ relPath: 'wp-includes/a.php', hash: 'aaa' }],
    }], []);
    expect(summarize(clean)).toBe('core and wp.org packages verified clean');
    const dirty = summarize(buildReport([coreEvidence()], []));
    expect(dirty).toContain('1 modified core file');
    expect(dirty).toContain('1 unexpected file');
    expect(dirty).toContain('1 missing core file');
  });

  it('writeReport writes JSON under FERRY_HOME/sites/<slug>/', () => {
    const home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    try {
      const report = buildReport([], [{ type: 'plugin', slug: 'premium-seo', version: null, reason: 'no-version-hint' }]);
      const path = writeReport('mysite', report);
      expect(path).toBe(join(home, 'sites/mysite/provenance.json'));
      expect(JSON.parse(readFileSync(path, 'utf8')).unverified[0].slug).toBe('premium-seo');
    } finally {
      delete process.env.FERRY_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ferry-cli && npx vitest run tests/report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `report.ts`**

```ts
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
export function buildReport(evidence: PackageEvidence[], unverified: UnverifiedPackage[]): ProvenanceReport {
  const verified: PackageReport[] = [];
  for (const ev of evidence) {
    const isCore = ev.ref.type === 'core';
    const official = Object.keys(ev.checksums).filter((p) => !isCore || !p.startsWith('wp-content/'));
    const officialSet = new Set(official);
    const present = new Map(ev.entries.map((e) => [e.relPath, e.hash]));
    const modified = official.filter((p) => {
      const hash = present.get(p);
      return hash !== undefined && hash !== null && hash !== ev.checksums[p];
    });
    const missing = official.filter((p) => !present.has(p));
    const extra = isCore
      ? ev.entries
          .filter((e) => (e.relPath.startsWith('wp-admin/') || e.relPath.startsWith('wp-includes/')) && !officialSet.has(e.relPath))
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
  if (core && core.extra.length > 0) parts.push(`${core.extra.length} unexpected file(s) in wp-admin//wp-includes/`);
  if (core && core.missing.length > 0) parts.push(`${core.missing.length} missing core file(s)`);
  if (pkgModified > 0) parts.push(`${pkgModified} modified plugin/theme file(s)`);
  return parts.length === 0 ? 'core and wp.org packages verified clean' : `⚠ ${parts.join(', ')}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ferry-cli && npx vitest run tests/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/provenance/report.ts ferry-cli/tests/report.test.ts
git commit -m "feat(cli): provenance report - modified/missing/extra + unverified packages"
```

---

### Task 8: CLI — wire pull.ts + main.ts; mockPlugin upgrades; pull tests

**Files:**
- Modify: `ferry-cli/src/pull.ts`
- Modify: `ferry-cli/src/main.ts`
- Modify: `ferry-cli/tests/helpers/mockPlugin.ts`
- Modify: `ferry-cli/tests/pull.test.ts`
- Modify (if needed): `ferry-cli/tests/smoke.test.ts` — same treatment as pull.test if it invokes `pull()`

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces:

```ts
export interface PullDeps { env?: CloneEnv; wporg?: WporgEndpoints; cacheDir?: string }
export interface PullResult {
  // existing fields unchanged, plus:
  provenance: { reportPath: string; summary: string; reused: number; reconstructed: number; fetched: number };
}
export async function pull(slug: string, deps: PullDeps = {}): Promise<PullResult>;
```

- Test-helper contract: `MockPlugin` gains `requests: { files: string[][] }` (paths of every `/files` batch POST — how tests assert what crossed the bridge); the `manifest` option's `hash` widens to `string | null`; new export `hashOf(fixtureDir, path): string` (MD5 helper).

- [ ] **Step 1: Upgrade the mock plugin helper**

In `ferry-cli/tests/helpers/mockPlugin.ts`:
1. Widen the option type: `manifest?: { path: string; size: number; hash: string | null }[]`.
2. Add to the interface and returned object: `requests: { files: string[][] }` — in the `/files` handler's `end` callback, before answering batch mode, record `requests.files.push(paths)` (do **not** record range mode).
3. Add the helper next to `sizeOf`:

```ts
import { createHash } from 'node:crypto';
/** MD5 helper for building hash-bearing manifests from fixtures. */
export function hashOf(fixtureDir: string, path: string): string {
  return createHash('md5').update(readFileSync(join(fixtureDir, path))).digest('hex');
}
```

Concretely: declare `const requests = { files: [] as string[][] };` near `let firstFilesCall`, add `requests.files.push(paths);` immediately after `const paths: string[] = params.paths;`, and return `{ base, requests, close: ... }`.

- [ ] **Step 2: Write the failing pull tests**

In `ferry-cli/tests/pull.test.ts`:

1. Add imports: `hashOf` from the helper; `createHash` from `node:crypto`; `startMockWporg`, `zipOf`, and type `MockWporg` from `./helpers/mockWporg.js`.
2. Add `const DEAD_WPORG = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };` and pass `wporg: DEAD_WPORG` in the existing test's `pull('fixture', { env, wporg: DEAD_WPORG })` call — the existing test becomes the wp.org-offline degradation proof (identical v0 behavior, all fetched). Extend its assertions:

```ts
    expect(result.provenance.fetched).toBe(5);
    expect(result.provenance.reused).toBe(0);
    expect(result.provenance.reconstructed).toBe(0);
    expect(existsSync(join(home, 'sites/fixture/provenance.json'))).toBe(true);
```

3. Add the provenance scenario:

```ts
  it('reconstructs wp.org-matched files, fetches unique ones, reports tampering, and re-pull reuses', async () => {
    // fixture: one core file matching official checksums, one tampered core file, one unique file
    mkdirSync(join(fixture, 'wp-includes'), { recursive: true });
    writeFileSync(join(fixture, 'wp-includes/functions.php'), '<?php // official-functions');
    writeFileSync(join(fixture, 'wp-includes/version.php'), '<?php // TAMPERED');
    const officialVersion = '<?php // official-version';
    const wporg = await startMockWporg({
      checksums: { '6.5-en_US': {
        'wp-includes/functions.php': createHash('md5').update('<?php // official-functions').digest('hex'),
        'wp-includes/version.php': createHash('md5').update(officialVersion).digest('hex'),
      } },
      zips: { '/release/wordpress-6.5.zip': zipOf('wordpress', {
        'wp-includes/functions.php': '<?php // official-functions',
        'wp-includes/version.php': officialVersion,
      }) },
    });
    try {
      const paths = ['index.php', 'wp-includes/functions.php', 'wp-includes/version.php'];
      const manifest = paths.map((p) => ({ path: p, size: sizeOf(fixture, p), hash: hashOf(fixture, p) }));
      mock = await startMockPlugin(fixture, {
        info: siteInfo({ locale: 'en_US' }),
        manifest,
        dbTables: [{
          name: 'wp_options', rows: 1, bytes: 10, pk: 'option_id', maxpk: 1,
          batches: [{ sql: 'INSERT INTO `wp_options` VALUES (1);\n', lastKey: 1, complete: true }],
        }],
      });
      pair(mock.base);
      const result = await pull('fixture', { env: new FakeEnv(), wporg: wporg.endpoints });

      // functions.php was reconstructed from wp.org - never crossed the bridge
      const bridged = mock.requests.files.flat();
      expect(bridged).not.toContain('wp-includes/functions.php');
      expect(bridged).toContain('index.php');                 // unique (not in checksums)
      expect(bridged).toContain('wp-includes/version.php');   // tampered → mirror production's bytes
      expect(result.provenance.reconstructed).toBe(1);
      expect(readFileSync(join(clonePath, 'wp-includes/version.php'), 'utf8')).toBe('<?php // TAMPERED');

      // the report flags the tampering
      const report = JSON.parse(readFileSync(result.provenance.reportPath, 'utf8'));
      const core = report.verified.find((p: { type: string }) => p.type === 'core');
      expect(core.modified).toEqual(['wp-includes/version.php']);
      expect(result.provenance.summary).toContain('1 modified core file');

      // warm re-pull of the unchanged site: everything reuses, nothing crosses the bridge
      const before = mock.requests.files.length;
      const again = await pull('fixture', { env: new FakeEnv(), wporg: wporg.endpoints });
      expect(again.provenance.reused).toBe(3);
      expect(again.provenance.fetched).toBe(0);
      expect(mock.requests.files.length).toBe(before);
    } finally {
      wporg.close();
    }
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ferry-cli && npx vitest run tests/pull.test.ts`
Expected: FAIL — `pull()` doesn't accept `wporg`, `PullResult` has no `provenance`, and `resolve` is called with the old signature.

- [ ] **Step 4: Wire `pull.ts`**

Update `ferry-cli/src/pull.ts`. New imports: `cleanTmp` from `./provenance/cache.js`, `reconstruct` from `./provenance/reconstruct.js`, `buildReport, summarize, writeReport` from `./provenance/report.js`, `type WporgEndpoints` from `./provenance/wporg.js`. Interface changes:

```ts
export interface PullDeps { env?: CloneEnv; wporg?: WporgEndpoints; cacheDir?: string }

export interface PullResult {
  url: string;
  adminUser: string;
  adminPassword: string;
  skipped: string[];
  commit: string;
  neutralizedRepos: number;
  provenance: { reportPath: string; summary: string; reused: number; reconstructed: number; fetched: number };
}
```

Replace the manifest/resolve/fetch section of `pull()` (between `envReady.catch` and `finalizeClone`) with:

```ts
  const cacheDir = deps.cacheDir ?? join(ferryHome(), 'cache');
  cleanTmp(cacheDir);
  const manifest = await fetchManifest(client);
  const plan = await resolve(manifest, info, { docroot, cacheDir, wporg: deps.wporg });
  const report = buildReport(plan.evidence, plan.unverified);
  const reportPath = writeReport(slug, report);
  const [fetched, rec] = await Promise.all([
    fetchAll(client, plan.fetch, docroot),
    reconstruct(plan.reconstruct, docroot),
  ]);
  const skipped = [...fetched.skipped];
  if (rec.failed.length > 0) {
    // cache let us down (corruption): demote to the bucket that always works
    const byPath = new Map(manifest.map((e) => [e.path, e]));
    const retry = rec.failed.map((f) => byPath.get(f.path)).filter((e): e is ManifestEntry => e !== undefined);
    skipped.push(...(await fetchAll(client, retry, docroot)).skipped);
  }
```

and change the signature to `pull(slug: string, deps: PullDeps = {})`, `commitProduction`'s path argument to `manifest.map((e) => e.path)`, and the return to include:

```ts
    provenance: {
      reportPath,
      summary: summarize(report),
      reused: plan.reuse.length,
      reconstructed: plan.reconstruct.length,
      fetched: plan.fetch.length,
    },
```

- [ ] **Step 5: Wire `main.ts`**

In the `pull` command's action, after the "Committed production snapshot" line, add:

```ts
    console.log(`  Files: ${result.provenance.reused} reused, ${result.provenance.reconstructed} reconstructed, ${result.provenance.fetched} fetched`);
    console.log(`  Provenance: ${result.provenance.summary}`);
    console.log(`    Report: ${result.provenance.reportPath}`);
```

- [ ] **Step 6: Run the full CLI suite and build**

Run: `cd ferry-cli && npx vitest run && npm run build`
Expected: **all green** (including smoke.test.ts — if it calls `pull()` without wporg deps it would hit real wp.org: give it the same `wporg: DEAD_WPORG` treatment). Type-check clean.

- [ ] **Step 7: Commit**

```bash
git add ferry-cli/src/pull.ts ferry-cli/src/main.ts ferry-cli/tests/helpers/mockPlugin.ts ferry-cli/tests/pull.test.ts ferry-cli/tests/smoke.test.ts
git commit -m "feat(cli): provenance-aware pull - reuse/reconstruct/fetch + report output"
```

---

### Task 9: E2E gate on the real DDEV fixture + runbook update

**Files:**
- Modify: `docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md` (append a "Plan 2 — Provenance & cache" section with results)

**Preconditions:** Docker + DDEV running; fixture `ferry-prod` at `~/ferry-e2e/prod` (rebuild per the runbook's Fixture section if missing — then `ferry link` again); the clone from previous E2E at `~/ferry-sites/ferry-prod-ddev-site` (if missing, the first pull below simply exercises the cold path with an empty docroot). This E2E intentionally hits **real wordpress.org**.

- [ ] **Step 1: Deploy the updated plugin to the fixture and build the CLI**

```bash
ls ~/ferry-e2e/prod/wp-content/plugins/   # find the ferry plugin dir name (e.g. "ferry")
cp ferry-plugin/ferry.php ~/ferry-e2e/prod/wp-content/plugins/<ferry-dir>/ferry.php
rsync -a --delete ferry-plugin/src/ ~/ferry-e2e/prod/wp-content/plugins/<ferry-dir>/src/
cd ferry-cli && npm run build && cd ..
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

- [ ] **Step 2: Scenario A — warm clone, first provenance pull (reuse path + baseline tree)**

```bash
time node ferry-cli/dist/main.js pull ferry-prod-ddev-site
git -C ~/ferry-sites/ferry-prod-ddev-site rev-parse 'HEAD^{tree}'   # record TREE_A
cat ~/.ferry/sites/ferry-prod-ddev-site/provenance.json
```

Expected: `Files:` line shows reused ≈ all, fetched ≈ 0; file phase runs in single-digit seconds; summary says `core and wp.org packages verified clean` (plus possibly unverified premium items); the pull's total time is now DB-dominated.

- [ ] **Step 3: Scenario B — cold cache + deleted clone (reconstruct path + byte-identity)**

```bash
rm -rf ~/ferry-sites/ferry-prod-ddev-site ~/.ferry/cache
time node ferry-cli/dist/main.js pull ferry-prod-ddev-site
ls ~/.ferry/cache/packages/core/            # core package ingested
git -C ~/ferry-sites/ferry-prod-ddev-site rev-parse 'HEAD^{tree}'   # must equal TREE_A
curl -sk -o /dev/null -w '%{http_code}' https://ferry-prod-ddev-site.ddev.site/
```

Expected: `reconstructed` covers the core/wp.org files, `fetched` is the small unique tail; tree hash **equals TREE_A** (reconstruction is byte-faithful); site serves 200. If DDEV balks at the recreated project dir, run the runbook teardown for the clone and `ferry link` + pull fresh.

- [ ] **Step 4: Scenario C — tamper test (mirror-first + report)**

```bash
printf '\n// ferry-tamper\n' >> ~/ferry-e2e/prod/wp-includes/version.php
printf '<?php // rogue\n'    >  ~/ferry-e2e/prod/wp-includes/ferry-rogue.php
node ferry-cli/dist/main.js pull ferry-prod-ddev-site
cat ~/.ferry/sites/ferry-prod-ddev-site/provenance.json
grep ferry-tamper ~/ferry-sites/ferry-prod-ddev-site/wp-includes/version.php
cat ~/ferry-sites/ferry-prod-ddev-site/wp-includes/ferry-rogue.php
```

Expected: summary line shows `⚠ 1 modified core file(s), 1 unexpected file(s) in wp-admin//wp-includes/`; report JSON lists exactly `wp-includes/version.php` under `modified` and `wp-includes/ferry-rogue.php` under `extra`; **both files are present in the clone with production's (tampered) bytes** — mirror-first holds.

- [ ] **Step 5: Restore the fixture and confirm a clean final pull**

```bash
cd ~/ferry-e2e/prod && ddev wp core download --force --version="$(ddev wp core version)" && rm wp-includes/ferry-rogue.php && cd -
node ferry-cli/dist/main.js pull ferry-prod-ddev-site
```

Expected: clean summary again; reused ≈ all.

- [ ] **Step 6: Append results to the runbook and commit**

Append a `# Plan 2 — Provenance & cache (2026-07-25)` section to `docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md` following the existing format: environment deltas, the four scenarios with a result table (timings included), and any bugs found+fixed.

```bash
git add docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md
git commit -m "docs: E2E runbook results for the provenance/cache slice"
```

---

## Execution notes

- Tasks 1–2 (plugin) and 3–5 (CLI leaf modules) are independent of each other; 6 depends on 2–5; 7 depends on 6; 8 depends on all prior; 9 is the gate.
- Task 6 knowingly leaves `pull.ts` uncompilable against the new `resolve()` — Task 8 fixes it. Run targeted vitest files in 6–7, the full suite in 8.
- After Task 9 passes, finish per process: full-suite runs (`ferry-plugin` PHPUnit + `ferry-cli` vitest + `npm run build`), whole-branch review, then PR against `main`.
