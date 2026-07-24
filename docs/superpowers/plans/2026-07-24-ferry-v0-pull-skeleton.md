# Ferry v0 Pull Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ferry link <url> --code=XXXX-XXXX` + `ferry pull <site>` clone a real WordPress site (no SSH) into a local DDEV environment at production parity, airtight, reachable at `https://<slug>.ddev.site`.

**Architecture:** A read-only WordPress plugin (native PHP, zero dependencies, no command execution) exposes signed REST endpoints: `/info`, `/pair`, `/manifest`, `/files`, `/db/tables`, `/db`. A Node/TypeScript CLI does the smart work: HMAC-signed requests with server-clock offset, bin-packed parallel file batches, keyset-paginated DB export with byte budget, DDEV provisioning from `/info`, and an overlay (runtime siteurl mapping, containment harness, drop-in neutralization, uploads 302 fallback). The plugin is deliberately dumb; every collection endpoint is resumable because shared-host timeouts are answers, not errors.

**Tech Stack:** Plugin: PHP ≥7.2, WP REST API, `hash_hmac`, `deflate_add`, `$wpdb`, own ~60-line tar writer. CLI: Node ≥20, TypeScript, undici, p-limit, node-tar, commander, built-in zlib/crypto. Tests: PHPUnit ^9.6, Vitest ^2. Local env: DDEV ≥1.24.

**Reference docs:** `docs/ferry-walking-skeleton.md` (base design, § references like §3.5 point here) and `docs/ferry-saas-walking-skeleton-specs.md` (SaaS layer). Task 1 copies the base doc into the repo.

## Global Constraints

- Plugin: native PHP, **zero runtime dependencies**, source compatible with **PHP 7.2+**; **no `exec()`, no wp-cli in-process, no eval** — read-only, no write endpoints in v0.
- Transport: HTTPS via WP REST `/wp-json/ferry/v1/…`, HMAC-SHA256-signed requests, **~8MB batches, 4 parallel requests**, back off on 429/503; no FTP, no SSH.
- Signature window **60 seconds**; CLI signs with **server time** derived from the `Date` header (clock drift, §4.5). No nonce in v0 (read-only); nonce is a hard precondition before any write endpoint (Plan 5).
- Every collection endpoint is resumable; plugin stops at **~70% of `max_execution_time`** (§3.3).
- DB export: **keyset pagination** (`WHERE pk > ? AND pk <= ?`), **byte budget ~4MB per batch**, **hex literals** for non-numeric values, max-key bound taken at export start (§3.5).
- **`wp-config.php` never crosses the bridge** — excluded from manifest AND refused by `/files` even when explicitly requested (§4.4).
- **Multisite: hard refusal** with a clear message (§2.19).
- Hardcoded exclusion list (§3.1) — a constant in the plugin, not configuration.
- Clone: DDEV at production parity (`php_version`, `database.type/version`, `webserver_type`, wp-config constants). No VM isolation locally (SaaS spec §11).
- Overlay: DB stays byte-identical — runtime `pre_option_siteurl`/`pre_option_home` filters (§2.6); harness blocks outbound HTTP + mail, disables cron (§2.7); drop-ins renamed to `<name>.php.ferry-disabled`; uploads fall back to production via 302 (§2.8).
- CLI state: **readable JSON file per site** at `~/.ferry/sites/<slug>/profile.json` (`FERRY_HOME` overrides root; SaaS spec §13 requires file-based state).
- **All user-facing copy in English** (CLI output, admin notices, error messages).
- Explicitly NOT in v0 (§4.9): git, provenance/cache, Merkle, sessions, configurable excludes, write endpoints, license stubs, read-set, multisite.

**Spec fidelity notes** (deliberate deviations, decided in planning):

1. `/files` streams its body, so resume state cannot go in HTTP headers (headers are sent before the loop knows where it stopped). Resume state travels **in-band** as the final tar entry `.ferry-meta.json` (`{complete, next_index, skipped}`). `/manifest` and `/db` are not streamed and use `X-Complete`/`X-Next-Index`/`X-Last-Key` headers exactly as specced.
2. wp-config constants (§2.5) are captured by scanning `wp-config.php` for `define()` names via `token_get_all` (never executed) and reading live values via `constant()`. Raw `get_defined_constants(true)['user']` at REST time would include every plugin's constants, not just wp-config's.
3. Per-file hashes in file batches: deferred; manifest `hash` is `null` (§4.4 explicitly allows this — the field exists so the shape is right).
4. Skip-compression for already-compressed files (§3.2): deferred to v0.1 — one gzip stream, fixed level 6.
5. Uploads fallback on Apache-parity clones uses a prepended `.htaccess` block (mod_rewrite R=302) since DDEV nginx snippets don't apply to `apache-fpm`.

---

### Task 1: Repository layout + CLI package scaffold

**Files:**
- Create: `.gitignore` (repo root)
- Create: `docs/ferry-walking-skeleton.md` (copy of the base doc)
- Create: `ferry-cli/package.json`
- Create: `ferry-cli/tsconfig.json`
- Create: `ferry-cli/src/main.ts`
- Test: `ferry-cli/tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an installable `ferry-cli` npm package with `npm test` (Vitest) and `npm run ferry` (tsx) working; later tasks add files under `ferry-cli/src/` and `ferry-cli/tests/`.

- [ ] **Step 1: Copy the base design doc into the repo**

```bash
cp ~/Downloads/ferry-walking-skeleton.md docs/ferry-walking-skeleton.md
```

- [ ] **Step 2: Create the root `.gitignore`**

```gitignore
node_modules/
dist/
vendor/
.phpunit.result.cache
.DS_Store
```

- [ ] **Step 3: Create `ferry-cli/package.json`**

```json
{
  "name": "ferry-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "ferry": "./dist/main.js" },
  "scripts": {
    "ferry": "tsx src/main.ts",
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "p-limit": "^6.1.0",
    "tar": "^7.4.3",
    "undici": "^6.21.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 4: Create `ferry-cli/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `ferry-cli/src/main.ts` (placeholder; Task 18 wires commander)**

```ts
#!/usr/bin/env node
console.log('ferry 0.1.0');
```

- [ ] **Step 6: Write the smoke test `ferry-cli/tests/smoke.test.ts`**

```ts
import { expect, it } from 'vitest';

it('test harness runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: Install and run**

Run: `cd ferry-cli && npm install && npm test`
Expected: `1 passed` from Vitest; `package-lock.json` created.

- [ ] **Step 8: Commit**

```bash
git add .gitignore docs/ferry-walking-skeleton.md ferry-cli
git commit -m "chore: scaffold ferry-cli package and vendor base design doc"
```

---

### Task 2: Plugin package scaffold

**Files:**
- Create: `ferry-plugin/composer.json`
- Create: `ferry-plugin/phpunit.xml`
- Create: `ferry-plugin/ferry.php` (header only; full bootstrap in Task 9)
- Create: `ferry-plugin/tests/bootstrap.php`
- Test: `ferry-plugin/tests/SmokeTest.php`

**Interfaces:**
- Consumes: nothing.
- Produces: `vendor/bin/phpunit` runs in `ferry-plugin/`; `tests/bootstrap.php` autoloads `Ferry\*` classes from `src/` and defines `ARRAY_A`/`ARRAY_N` for WP-free unit tests. Later tasks add `ferry-plugin/src/*.php` + `ferry-plugin/tests/*Test.php`.

- [ ] **Step 1: Create `ferry-plugin/composer.json`**

```json
{
  "name": "ferry/plugin",
  "description": "Ferry Connect - read-only transport plugin (dev tooling only; the plugin itself has zero runtime dependencies)",
  "require": { "php": ">=7.2" },
  "require-dev": { "phpunit/phpunit": "^9.6" }
}
```

- [ ] **Step 2: Create `ferry-plugin/phpunit.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit bootstrap="tests/bootstrap.php" colors="true">
  <testsuites>
    <testsuite name="ferry">
      <directory>tests</directory>
    </testsuite>
  </testsuites>
</phpunit>
```

- [ ] **Step 3: Create `ferry-plugin/tests/bootstrap.php`**

```php
<?php
// WP array-output constants, needed by classes unit-tested without WordPress.
if (!defined('ARRAY_A')) { define('ARRAY_A', 'ARRAY_A'); }
if (!defined('ARRAY_N')) { define('ARRAY_N', 'ARRAY_N'); }

spl_autoload_register(function ($class) {
    if (strpos($class, 'Ferry\\') === 0) {
        $path = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, 6)) . '.php';
        if (is_file($path)) {
            require $path;
        }
    }
});
```

- [ ] **Step 4: Create `ferry-plugin/ferry.php` (header + guard only for now)**

```php
<?php
/**
 * Plugin Name: Ferry Connect
 * Description: Read-only transport layer for ferry - manifest, file batches, and database export over signed REST requests. No command execution, no write endpoints.
 * Version: 0.1.0
 * Requires PHP: 7.2
 * Author: Ferry
 */

if (!defined('ABSPATH')) {
    exit;
}
```

- [ ] **Step 5: Write `ferry-plugin/tests/SmokeTest.php`**

```php
<?php
use PHPUnit\Framework\TestCase;

final class SmokeTest extends TestCase
{
    public function test_harness_runs(): void
    {
        $this->assertTrue(PHP_VERSION_ID >= 70200);
    }
}
```

- [ ] **Step 6: Install and run**

Run: `cd ferry-plugin && composer install && vendor/bin/phpunit`
Expected: `OK (1 test, 1 assertion)`.

- [ ] **Step 7: Commit**

```bash
git add ferry-plugin
git commit -m "chore: scaffold ferry-plugin package with phpunit"
```

---

### Task 3: HMAC signing contract (shared vectors, TS + PHP)

Both sides must produce byte-identical canonical strings. The contract: `METHOD\nROUTE\nCANONICAL_QUERY\nBODY\nTIMESTAMP`, where ROUTE is the REST route without `/wp-json` (e.g. `/ferry/v1/manifest`), CANONICAL_QUERY is RFC3986-encoded `key=value` pairs sorted by key and joined with `&`, with `rest_route` and `_locale` stripped (WP adds those under plain permalinks). Signature = hex HMAC-SHA256. Headers: `X-Ferry-Timestamp`, `X-Ferry-Signature`.

**Files:**
- Create: `contracts/hmac-vectors.json`
- Create: `ferry-cli/src/signing.ts`
- Create: `ferry-plugin/src/Auth.php`
- Test: `ferry-cli/tests/signing.test.ts`
- Test: `ferry-plugin/tests/AuthTest.php`

**Interfaces:**
- Consumes: Task 1 + 2 scaffolds.
- Produces:
  - TS: `canonical(method: string, route: string, query: Record<string,string>, body: string, timestamp: number): string` and `sign(secret: string, method, route, query, body, timestamp): string` from `signing.ts`.
  - PHP: `Ferry\Auth::canonical(string $method, string $route, array $query, string $body, int $timestamp): string`, `Auth::sign(string $secret, ...same): string`, `Auth::verify(string $secret, string $method, string $route, array $query, string $body, ?string $timestamp, ?string $signature, int $now): bool`, plus pairing: `Auth::issue_pairing_code(): array{code,expires}`, `Auth::current_pairing_code(): ?array`, `Auth::complete_pairing(string $code): ?string` and constants `Auth::SIGNATURE_WINDOW = 60`, `Auth::CODE_TTL = 600`.

- [ ] **Step 1: Create `contracts/hmac-vectors.json`** (values verified: Node and PHP implementations both reproduce these)

```json
{
  "secret": "ferry-test-secret-0123456789abcdef",
  "vectors": [
    {
      "name": "get-manifest",
      "method": "GET",
      "route": "/ferry/v1/manifest",
      "query": { "after": "0" },
      "body": "",
      "timestamp": 1753351200,
      "expected": "49932caecd43868dbecc742a2c7f0c6035af201a1359137b0c2743ccc8063d9f"
    },
    {
      "name": "post-files",
      "method": "POST",
      "route": "/ferry/v1/files",
      "query": {},
      "body": "{\"paths\":[\"wp-load.php\"]}",
      "timestamp": 1753351260,
      "expected": "3b150e5ba131fd206d9f59207a245886bf64ceb6c9ec962799e72c7e861c64ec"
    },
    {
      "name": "get-db-sorted-query",
      "method": "GET",
      "route": "/ferry/v1/db",
      "query": { "table": "wp_posts", "after": "0", "before": "4210" },
      "body": "",
      "timestamp": 1753351320,
      "expected": "116e6aee9032361b14b1be1ed2590021080fa68b639f167d1eef1449b7039c69"
    },
    {
      "name": "rfc3986-encoding-edge",
      "method": "GET",
      "route": "/ferry/v1/files",
      "query": { "path": "wp-content/themes/x y/f'(1)!.php" },
      "body": "",
      "timestamp": 1753351380,
      "expected": "62a218d9e3bd0362901f92c1c87b372f26f17711dc5a839e2ee518b9a5120e28"
    }
  ]
}
```

- [ ] **Step 2: Write the failing TS test `ferry-cli/tests/signing.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sign } from '../src/signing.js';

const here = dirname(fileURLToPath(import.meta.url));
const { secret, vectors } = JSON.parse(
  readFileSync(join(here, '../../contracts/hmac-vectors.json'), 'utf8'),
);

describe('sign', () => {
  for (const v of vectors) {
    it(`matches vector: ${v.name}`, () => {
      expect(sign(secret, v.method, v.route, v.query, v.body, v.timestamp)).toBe(v.expected);
    });
  }

  it('strips rest_route and _locale from the query', () => {
    const v = vectors[2];
    const polluted = { ...v.query, rest_route: '/ferry/v1/db', _locale: 'user' };
    expect(sign(secret, v.method, v.route, polluted, v.body, v.timestamp)).toBe(v.expected);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/signing.js`.

- [ ] **Step 4: Implement `ferry-cli/src/signing.ts`**

```ts
import { createHmac } from 'node:crypto';

// RFC3986 percent-encoding, byte-identical to PHP's rawurlencode.
const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function canonical(
  method: string,
  route: string,
  query: Record<string, string>,
  body: string,
  timestamp: number,
): string {
  const pairs = Object.keys(query)
    .filter((k) => k !== 'rest_route' && k !== '_locale')
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`);
  return `${method.toUpperCase()}\n${route}\n${pairs.join('&')}\n${body}\n${timestamp}`;
}

export function sign(
  secret: string,
  method: string,
  route: string,
  query: Record<string, string>,
  body: string,
  timestamp: number,
): string {
  return createHmac('sha256', secret)
    .update(canonical(method, route, query, body, timestamp))
    .digest('hex');
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS (5 signing tests + smoke).

- [ ] **Step 6: Write the failing PHP test `ferry-plugin/tests/AuthTest.php`**

```php
<?php
use Ferry\Auth;
use PHPUnit\Framework\TestCase;

final class AuthTest extends TestCase
{
    private static function contract(): array
    {
        return json_decode(
            file_get_contents(__DIR__ . '/../../contracts/hmac-vectors.json'),
            true
        );
    }

    public function test_sign_matches_all_vectors(): void
    {
        $data = self::contract();
        foreach ($data['vectors'] as $v) {
            $this->assertSame(
                $v['expected'],
                Auth::sign($data['secret'], $v['method'], $v['route'], $v['query'], $v['body'], $v['timestamp']),
                $v['name']
            );
        }
    }

    public function test_verify_accepts_fresh_valid_signature(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertTrue(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['timestamp'] + 59
        ));
    }

    public function test_verify_rejects_expired_timestamp(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['timestamp'] + 61
        ));
    }

    public function test_verify_rejects_bad_signature(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            (string) $v['timestamp'], str_repeat('0', 64), $v['timestamp']
        ));
    }

    public function test_verify_rejects_missing_headers(): void
    {
        $data = self::contract();
        $v = $data['vectors'][0];
        $this->assertFalse(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $v['query'], $v['body'],
            null, null, $v['timestamp']
        ));
    }

    public function test_verify_strips_rest_route_pollution(): void
    {
        $data = self::contract();
        $v = $data['vectors'][2];
        $polluted = array_merge($v['query'], ['rest_route' => '/ferry/v1/db']);
        $this->assertTrue(Auth::verify(
            $data['secret'], $v['method'], $v['route'], $polluted, $v['body'],
            (string) $v['timestamp'], $v['expected'], $v['timestamp']
        ));
    }
}
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd ferry-plugin && vendor/bin/phpunit`
Expected: FAIL — class `Ferry\Auth` not found.

- [ ] **Step 8: Implement `ferry-plugin/src/Auth.php`**

The signature helpers are pure (no WordPress calls) so they unit-test standalone; the pairing methods use `get_option`/`update_option` and are exercised in the E2E gate (Task 19).

```php
<?php
namespace Ferry;

final class Auth
{
    const CODE_TTL = 600;          // pairing code lifetime, seconds (device flow, SaaS spec §13)
    const SIGNATURE_WINDOW = 60;   // max clock skew for signed requests, seconds (§4.5)
    const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // no 0/O, 1/I/L, U

    // ---- pairing (WordPress-dependent) ----

    /** @return array{code: string, expires: int} */
    public static function issue_pairing_code(): array
    {
        $code = '';
        for ($i = 0; $i < 8; $i++) {
            $code .= self::CODE_ALPHABET[random_int(0, strlen(self::CODE_ALPHABET) - 1)];
        }
        $code = substr($code, 0, 4) . '-' . substr($code, 4);
        $pairing = ['code' => $code, 'expires' => time() + self::CODE_TTL];
        update_option('ferry_pairing', $pairing, false);
        return $pairing;
    }

    /** @return array{code: string, expires: int}|null null when already paired or expired */
    public static function current_pairing_code()
    {
        if (get_option('ferry_secret')) {
            return null;
        }
        $pairing = get_option('ferry_pairing');
        if (!is_array($pairing) || !isset($pairing['code'], $pairing['expires']) || $pairing['expires'] < time()) {
            return null;
        }
        return $pairing;
    }

    /** Single-use exchange: valid code -> fresh secret, code invalidated. Null on failure. */
    public static function complete_pairing(string $code)
    {
        $pairing = get_option('ferry_pairing');
        if (!is_array($pairing) || !isset($pairing['code'], $pairing['expires']) || $pairing['expires'] < time()) {
            return null;
        }
        if (!hash_equals($pairing['code'], strtoupper(trim($code)))) {
            return null;
        }
        $secret = bin2hex(random_bytes(32));
        update_option('ferry_secret', $secret, false);
        delete_option('ferry_pairing');
        return $secret;
    }

    // ---- signatures (pure, mirror of ferry-cli/src/signing.ts) ----

    public static function canonical(string $method, string $route, array $query, string $body, int $timestamp): string
    {
        unset($query['rest_route'], $query['_locale']);
        ksort($query);
        $pairs = [];
        foreach ($query as $k => $v) {
            $pairs[] = rawurlencode((string) $k) . '=' . rawurlencode((string) $v);
        }
        return strtoupper($method) . "\n" . $route . "\n" . implode('&', $pairs) . "\n" . $body . "\n" . $timestamp;
    }

    public static function sign(string $secret, string $method, string $route, array $query, string $body, int $timestamp): string
    {
        return hash_hmac('sha256', self::canonical($method, $route, $query, $body, $timestamp), $secret);
    }

    public static function verify(string $secret, string $method, string $route, array $query, string $body, $timestamp, $signature, int $now): bool
    {
        if (!is_string($timestamp) || !is_string($signature) || $timestamp === '' || $signature === '') {
            return false;
        }
        if (abs($now - (int) $timestamp) > self::SIGNATURE_WINDOW) {
            return false;
        }
        $expected = self::sign($secret, $method, $route, $query, $body, (int) $timestamp);
        return hash_equals($expected, strtolower($signature));
    }
}
```

- [ ] **Step 9: Run to verify it passes**

Run: `cd ferry-plugin && vendor/bin/phpunit`
Expected: `OK (7 tests, ...)`.

- [ ] **Step 10: Commit**

```bash
git add contracts ferry-cli/src/signing.ts ferry-cli/tests/signing.test.ts ferry-plugin/src/Auth.php ferry-plugin/tests/AuthTest.php
git commit -m "feat: HMAC signing contract with shared cross-language test vectors"
```

---

### Task 4: Plugin exclusion list

**Files:**
- Create: `ferry-plugin/src/Excludes.php`
- Test: `ferry-plugin/tests/ExcludesTest.php`

**Interfaces:**
- Consumes: Task 2 bootstrap.
- Produces: `Ferry\Excludes::excluded(string $relpath): bool` — used by `Manifest` (Task 6) and the `/files` handler (Task 9). Paths are relative to the WP root, forward slashes, no leading slash; directory paths carry a trailing slash.

- [ ] **Step 1: Write the failing test `ferry-plugin/tests/ExcludesTest.php`**

```php
<?php
use Ferry\Excludes;
use PHPUnit\Framework\TestCase;

final class ExcludesTest extends TestCase
{
    /** @dataProvider excludedPaths */
    public function test_excluded(string $path): void
    {
        $this->assertTrue(Excludes::excluded($path), $path);
    }

    /** @dataProvider includedPaths */
    public function test_included(string $path): void
    {
        $this->assertFalse(Excludes::excluded($path), $path);
    }

    public function excludedPaths(): array
    {
        return [
            ['wp-content/uploads/2026/07/photo.jpg'],
            ['wp-content/uploads/'],
            ['wp-content/cache/page.html'],
            ['wp-content/cache/wp-rocket/site/index.html'],
            ['wp-content/updraft/backup.zip'],
            ['wp-content/ai1wm-backups/site.wpress'],
            ['wp-content/backups/db.sql'],
            ['wp-content/backups-dup-pro/archive.zip'],   // §3.1 "backups*/"
            ['wp-content/wp-rocket-config/site.php'],
            ['wp-content/ewww/image.jpg.bak'],
            ['wp-content/upgrade/plugin.tmp'],
            ['wp-content/upgrade-temp-backup/plugins/x/x.php'],
            ['wp-config.php'],                             // §4.4: never over the bridge
            ['wp-content/debug.log'],
            ['error_log'],
            ['wp-admin/error_log'],                        // error_log appears in many directories
        ];
    }

    public function includedPaths(): array
    {
        return [
            ['wp-load.php'],
            ['index.php'],
            ['wp-content/themes/storefront/style.css'],
            ['wp-content/plugins/woocommerce/woocommerce.php'],
            ['wp-content/cachetest.php'],                  // prefix match must respect the slash
            ['wp-content/mu-plugins/loader.php'],
        ];
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter ExcludesTest`
Expected: FAIL — class `Ferry\Excludes` not found.

- [ ] **Step 3: Implement `ferry-plugin/src/Excludes.php`**

```php
<?php
namespace Ferry;

/**
 * §3.1: exclusions are survival, not optimization. Hardcoded by design -
 * a constant in the plugin, extended per release, never configuration in v0.
 */
final class Excludes
{
    const PREFIXES = [
        'wp-content/uploads/',            // §2.8: media falls back to production
        'wp-content/cache/',              // also covers cache/wp-rocket/
        'wp-content/updraft/',
        'wp-content/ai1wm-backups/',
        'wp-content/backups',             // "backups*/": any wp-content/backups... directory
        'wp-content/wp-rocket-config/',
        'wp-content/ewww/',
        'wp-content/upgrade/',
        'wp-content/upgrade-temp-backup/',
    ];

    const FILES = [
        'wp-config.php',                  // §4.4: never over the bridge, even on explicit request
        'wp-content/debug.log',           // retrievable via control plane later, not pulled
    ];

    const BASENAMES = ['error_log'];

    public static function excluded(string $relpath): bool
    {
        $relpath = ltrim(str_replace('\\', '/', $relpath), '/');
        if (in_array($relpath, self::FILES, true)) {
            return true;
        }
        if (in_array(basename($relpath), self::BASENAMES, true)) {
            return true;
        }
        foreach (self::PREFIXES as $prefix) {
            if (strpos($relpath, $prefix) === 0) {
                return true;
            }
        }
        return false;
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter ExcludesTest`
Expected: PASS (22 data-provider cases).

- [ ] **Step 5: Commit**

```bash
git add ferry-plugin/src/Excludes.php ferry-plugin/tests/ExcludesTest.php
git commit -m "feat: hardcoded exclusion list for pull survival"
```

---

### Task 5: Tar writer (plugin)

**Files:**
- Create: `ferry-plugin/src/Tar.php`
- Test: `ferry-plugin/tests/TarTest.php`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `Ferry\Tar` — `__construct(callable $write)` (sink receives raw tar bytes; the `/files` handler wraps it in `deflate_add`), `add_file(string $name, string $contents, int $mtime = 0, int $mode = 0644): void`, `add_stream(string $name, resource $fh, int $size, int $mtime = 0, int $mode = 0644): void`, `finish(): void`. Throws `RuntimeException` on paths unsplittable into ustar name+prefix and on short reads.

- [ ] **Step 1: Write the failing test `ferry-plugin/tests/TarTest.php`**

```php
<?php
use Ferry\Tar;
use PHPUnit\Framework\TestCase;

final class TarTest extends TestCase
{
    /** @return array{0: string, 1: \PharData} collected bytes + reopened archive */
    private function extract(callable $build): array
    {
        $out = '';
        $tar = new Tar(function (string $bytes) use (&$out) {
            $out .= $bytes;
        });
        $build($tar);
        $tar->finish();
        $file = tempnam(sys_get_temp_dir(), 'ferry') . '.tar';
        file_put_contents($file, $out);
        return [$out, new \PharData($file)];
    }

    public function test_single_file_roundtrip(): void
    {
        [$out, $phar] = $this->extract(function (Tar $tar) {
            $tar->add_file('dir/hello.txt', "hello world\n", 1753351200);
        });
        $this->assertSame(0, strlen($out) % 512, 'archive must be 512-byte aligned');
        $this->assertSame("hello world\n", file_get_contents($phar['dir/hello.txt']->getPathname()));
    }

    public function test_block_aligned_content_gets_no_extra_padding(): void
    {
        [, $phar] = $this->extract(function (Tar $tar) {
            $tar->add_file('exact.bin', str_repeat('x', 512));
            $tar->add_file('after.txt', 'still readable');
        });
        $this->assertSame(512, strlen(file_get_contents($phar['exact.bin']->getPathname())));
        $this->assertSame('still readable', file_get_contents($phar['after.txt']->getPathname()));
    }

    public function test_long_path_uses_ustar_prefix(): void
    {
        $name = str_repeat('directory/', 12) . 'file.txt'; // 128 chars, needs prefix split
        [, $phar] = $this->extract(function (Tar $tar) use ($name) {
            $tar->add_file($name, 'deep');
        });
        $this->assertSame('deep', file_get_contents($phar[$name]->getPathname()));
    }

    public function test_unsplittable_path_throws(): void
    {
        $this->expectException(\RuntimeException::class);
        $tar = new Tar(function () {});
        $tar->add_file(str_repeat('a', 160) . '/b.txt', 'x');
    }

    public function test_add_stream_roundtrip(): void
    {
        $src = tempnam(sys_get_temp_dir(), 'ferry');
        file_put_contents($src, str_repeat('AB', 650)); // 1300 bytes, crosses block boundary
        [, $phar] = $this->extract(function (Tar $tar) use ($src) {
            $fh = fopen($src, 'rb');
            $tar->add_stream('stream.bin', $fh, 1300);
            fclose($fh);
        });
        $this->assertSame(str_repeat('AB', 650), file_get_contents($phar['stream.bin']->getPathname()));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter TarTest`
Expected: FAIL — class `Ferry\Tar` not found.

- [ ] **Step 3: Implement `ferry-plugin/src/Tar.php`**

```php
<?php
namespace Ferry;

/**
 * Minimal ustar writer (§3.2): 512-byte headers, padded blocks, zero extensions.
 * ZipArchive needs a temp file and PharData is blocked on many hosts; this is
 * the ~60 lines that make streaming from shared hosting possible.
 */
final class Tar
{
    /** @var callable */
    private $write;

    public function __construct(callable $write)
    {
        $this->write = $write;
    }

    public function add_file(string $name, string $contents, int $mtime = 0, int $mode = 0644): void
    {
        ($this->write)($this->header($name, strlen($contents), $mtime, $mode));
        ($this->write)($contents);
        $this->pad(strlen($contents));
    }

    /** @param resource $fh */
    public function add_stream(string $name, $fh, int $size, int $mtime = 0, int $mode = 0644): void
    {
        ($this->write)($this->header($name, $size, $mtime, $mode));
        $sent = 0;
        while ($sent < $size && !feof($fh)) {
            $chunk = fread($fh, 512 * 1024);
            if ($chunk === false || $chunk === '') {
                break;
            }
            ($this->write)($chunk);
            $sent += strlen($chunk);
        }
        if ($sent !== $size) {
            throw new \RuntimeException("short read for $name: $sent of $size bytes");
        }
        $this->pad($size);
    }

    public function finish(): void
    {
        ($this->write)(str_repeat("\0", 1024)); // two zero blocks = end of archive
    }

    private function pad(int $size): void
    {
        $pad = (512 - ($size % 512)) % 512;
        if ($pad > 0) {
            ($this->write)(str_repeat("\0", $pad));
        }
    }

    private function header(string $name, int $size, int $mtime, int $mode): string
    {
        $prefix = '';
        if (strlen($name) > 100) {
            $pos = strrpos(substr($name, 0, 155), '/');
            if ($pos === false || strlen($name) - $pos - 1 > 100) {
                throw new \RuntimeException("path does not fit ustar name/prefix fields: $name");
            }
            $prefix = substr($name, 0, $pos);
            $name = substr($name, $pos + 1);
        }
        $h  = str_pad($name, 100, "\0");
        $h .= sprintf("%07o\0", $mode);
        $h .= sprintf("%07o\0", 0);           // uid
        $h .= sprintf("%07o\0", 0);           // gid
        $h .= sprintf("%011o\0", $size);
        $h .= sprintf("%011o\0", $mtime);
        $h .= '        ';                     // chksum placeholder: 8 spaces
        $h .= '0';                            // typeflag: regular file
        $h .= str_repeat("\0", 100);          // linkname
        $h .= "ustar\0" . '00';               // magic + version
        $h .= str_repeat("\0", 32);           // uname
        $h .= str_repeat("\0", 32);           // gname
        $h .= sprintf("%07o\0", 0);           // devmajor
        $h .= sprintf("%07o\0", 0);           // devminor
        $h .= str_pad($prefix, 155, "\0");
        $h  = str_pad($h, 512, "\0");
        $sum = 0;
        for ($i = 0; $i < 512; $i++) {
            $sum += ord($h[$i]);
        }
        return substr_replace($h, sprintf("%06o\0 ", $sum), 148, 8);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter TarTest`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ferry-plugin/src/Tar.php ferry-plugin/tests/TarTest.php
git commit -m "feat: minimal streaming ustar writer"
```

---

### Task 6: Time budget + resumable manifest walker (plugin)

**Files:**
- Create: `ferry-plugin/src/Budget.php`
- Create: `ferry-plugin/src/Manifest.php`
- Test: `ferry-plugin/tests/BudgetTest.php`
- Test: `ferry-plugin/tests/ManifestTest.php`

**Interfaces:**
- Consumes: `Ferry\Excludes::excluded()` (Task 4).
- Produces:
  - `Ferry\Budget` — `__construct(?float $limit_seconds = null)` (null = 70% of `max_execution_time`, treating 0/unlimited as 30s), `exhausted(): bool`.
  - `Ferry\Manifest::batch(string $root, int $after, Budget $budget, int $cap = 5000): array` returning `['files' => [['path','size','hash' => null], ...], 'next' => int, 'complete' => bool]`. Deterministic sorted walk; a request that fills the cap reports `complete => false` and the follow-up call returns the remainder (possibly empty).

- [ ] **Step 1: Write the failing tests**

`ferry-plugin/tests/BudgetTest.php`:

```php
<?php
use Ferry\Budget;
use PHPUnit\Framework\TestCase;

final class BudgetTest extends TestCase
{
    public function test_zero_budget_is_immediately_exhausted(): void
    {
        $this->assertTrue((new Budget(0.0))->exhausted());
    }

    public function test_generous_budget_is_not_exhausted(): void
    {
        $this->assertFalse((new Budget(10.0))->exhausted());
    }
}
```

`ferry-plugin/tests/ManifestTest.php`:

```php
<?php
use Ferry\Budget;
use Ferry\Manifest;
use PHPUnit\Framework\TestCase;

final class ManifestTest extends TestCase
{
    /** @var string */
    private $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/ferry-manifest-' . uniqid();
        mkdir($this->root . '/wp-content/themes/t', 0777, true);
        mkdir($this->root . '/wp-content/uploads/2026', 0777, true);
        file_put_contents($this->root . '/index.php', '<?php // 14 bytes');
        file_put_contents($this->root . '/wp-config.php', '<?php // secret');
        file_put_contents($this->root . '/wp-content/themes/t/style.css', 'body{}');
        file_put_contents($this->root . '/wp-content/uploads/2026/skip.jpg', 'jpegbytes');
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
    }

    public function test_walk_is_sorted_and_applies_excludes(): void
    {
        $result = Manifest::batch($this->root, 0, new Budget(10.0));
        $paths = array_column($result['files'], 'path');
        $this->assertSame(['index.php', 'wp-content/themes/t/style.css'], $paths);
        $this->assertSame(6, $result['files'][1]['size']);
        $this->assertNull($result['files'][1]['hash']);
        $this->assertTrue($result['complete']);
        $this->assertSame(2, $result['next']);
    }

    public function test_resume_via_after_and_cap(): void
    {
        $first = Manifest::batch($this->root, 0, new Budget(10.0), 1);
        $this->assertFalse($first['complete']);
        $this->assertSame(1, $first['next']);
        $second = Manifest::batch($this->root, $first['next'], new Budget(10.0), 1);
        $all = array_merge(
            array_column($first['files'], 'path'),
            array_column($second['files'], 'path')
        );
        $this->assertSame(['index.php', 'wp-content/themes/t/style.css'], $all);
        $third = Manifest::batch($this->root, $second['next'], new Budget(10.0), 1);
        $this->assertSame([], $third['files']);
        $this->assertTrue($third['complete']);
    }

    public function test_exhausted_budget_still_makes_progress(): void
    {
        $result = Manifest::batch($this->root, 0, new Budget(0.0));
        $this->assertCount(1, $result['files'], 'must emit at least one entry per request');
        $this->assertFalse($result['complete']);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter 'BudgetTest|ManifestTest'`
Expected: FAIL — classes not found.

- [ ] **Step 3: Implement `ferry-plugin/src/Budget.php`**

```php
<?php
namespace Ferry;

/** §3.3: stop cleanly at ~70% of max_execution_time - timeouts are answers, not errors. */
final class Budget
{
    /** @var float */
    private $deadline;

    public function __construct(?float $limit_seconds = null)
    {
        if ($limit_seconds === null) {
            $max = (int) ini_get('max_execution_time');
            $limit_seconds = ($max > 0 ? $max : 30) * 0.7;
        }
        $this->deadline = microtime(true) + $limit_seconds;
    }

    public function exhausted(): bool
    {
        return microtime(true) >= $this->deadline;
    }
}
```

- [ ] **Step 4: Implement `ferry-plugin/src/Manifest.php`**

```php
<?php
namespace Ferry;

/**
 * Resumable file listing (§3.3 applied to §4.4's /manifest). The walk is
 * deterministic (sorted scandir), so "skip the first N entries" is a stable
 * resume cursor even across requests.
 */
final class Manifest
{
    /**
     * @return array{files: array<int, array{path: string, size: int, hash: null}>, next: int, complete: bool}
     */
    public static function batch(string $root, int $after, Budget $budget, int $cap = 5000): array
    {
        $files = [];
        $index = 0;
        $complete = true;
        foreach (self::walk(rtrim($root, '/'), '') as $entry) {
            if ($index++ < $after) {
                continue;
            }
            $files[] = $entry;
            if (count($files) >= $cap || $budget->exhausted()) {
                $complete = false;
                break;
            }
        }
        return ['files' => $files, 'next' => $after + count($files), 'complete' => $complete];
    }

    /** @return \Generator<array{path: string, size: int, hash: null}> */
    private static function walk(string $root, string $rel): \Generator
    {
        $abs = $rel === '' ? $root : $root . '/' . $rel;
        $names = scandir($abs, SCANDIR_SORT_ASCENDING);
        if ($names === false) {
            return;
        }
        foreach ($names as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $relpath = $rel === '' ? $name : $rel . '/' . $name;
            $abspath = $root . '/' . $relpath;
            if (is_link($abspath)) {
                continue;
            }
            if (is_dir($abspath)) {
                if (!Excludes::excluded($relpath . '/')) {
                    yield from self::walk($root, $relpath);
                }
            } elseif (is_file($abspath) && !Excludes::excluded($relpath)) {
                yield ['path' => $relpath, 'size' => (int) filesize($abspath), 'hash' => null];
            }
        }
    }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter 'BudgetTest|ManifestTest'`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add ferry-plugin/src/Budget.php ferry-plugin/src/Manifest.php ferry-plugin/tests/BudgetTest.php ferry-plugin/tests/ManifestTest.php
git commit -m "feat: time budget and resumable manifest walker"
```

---

### Task 7: DB value encoding (plugin, pure)

**Files:**
- Create: `ferry-plugin/src/Db.php` (encoding half; export loop added in Task 8)
- Test: `ferry-plugin/tests/DbLiteralTest.php`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `Ferry\Db::literal($value, bool $numeric): string` and `Ferry\Db::numeric_map(array $show_columns_rows): array<string,bool>` (input: `SHOW COLUMNS` rows as `ARRAY_A`, keys `Field`/`Type`). Hex literals kill the entire encoding-bug category (§3.5) — but hex into a numeric column corrupts it (`0x31` = 49), so numeric columns emit bare numbers, decided by **column type**, never by value shape (a `VARCHAR` `'0123'` must stay a string).

- [ ] **Step 1: Write the failing test `ferry-plugin/tests/DbLiteralTest.php`**

```php
<?php
use Ferry\Db;
use PHPUnit\Framework\TestCase;

final class DbLiteralTest extends TestCase
{
    public function test_null_is_null(): void
    {
        $this->assertSame('NULL', Db::literal(null, false));
        $this->assertSame('NULL', Db::literal(null, true));
    }

    public function test_numeric_column_values_stay_bare(): void
    {
        $this->assertSame('42', Db::literal('42', true));
        $this->assertSame('-3.5', Db::literal('-3.5', true));
        $this->assertSame('0', Db::literal('0', true));
    }

    public function test_string_values_become_hex(): void
    {
        // h=68 é=c3a9 l=6c l=6c o=6f space=20 rocket=f09f9a80
        $this->assertSame('0x68c3a96c6c6f20f09f9a80', Db::literal("h\xc3\xa9llo \xf0\x9f\x9a\x80", false));
    }

    public function test_leading_zero_varchar_is_not_treated_as_number(): void
    {
        $this->assertSame('0x30313233', Db::literal('0123', false));
    }

    public function test_empty_string(): void
    {
        $this->assertSame("''", Db::literal('', false));
    }

    public function test_unexpected_value_in_numeric_column_falls_back_to_hex(): void
    {
        $this->assertSame('0x6e6f7065', Db::literal('nope', true));
    }

    public function test_numeric_map_from_show_columns(): void
    {
        $rows = [
            ['Field' => 'ID', 'Type' => 'bigint(20) unsigned'],
            ['Field' => 'post_content', 'Type' => 'longtext'],
            ['Field' => 'price', 'Type' => 'decimal(10,2)'],
            ['Field' => 'ratio', 'Type' => 'double'],
            ['Field' => 'blob_data', 'Type' => 'varbinary(255)'],
        ];
        $this->assertSame(
            ['ID' => true, 'post_content' => false, 'price' => true, 'ratio' => true, 'blob_data' => false],
            Db::numeric_map($rows)
        );
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter DbLiteralTest`
Expected: FAIL — class `Ferry\Db` not found.

- [ ] **Step 3: Implement the encoding half of `ferry-plugin/src/Db.php`**

```php
<?php
namespace Ferry;

/**
 * Database export (§3.5): keyset pagination, byte budget, hex literals.
 * The literal encoder is pure and column-type-driven: hexing a numeric
 * column would corrupt it (0x31 = 49 in numeric context), and trusting
 * value shape would corrupt leading-zero varchars. Type decides, not value.
 */
final class Db
{
    /** @param array<int, array{Field: string, Type: string}> $show_columns_rows
     *  @return array<string, bool> */
    public static function numeric_map(array $show_columns_rows): array
    {
        $map = [];
        foreach ($show_columns_rows as $col) {
            $map[$col['Field']] = (bool) preg_match('/int|decimal|float|double/i', $col['Type']);
        }
        return $map;
    }

    /** @param string|null $value wpdb returns all values as strings or null */
    public static function literal($value, bool $numeric): string
    {
        if ($value === null) {
            return 'NULL';
        }
        $value = (string) $value;
        if ($numeric && preg_match('/\A-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?\z/', $value)) {
            return $value;
        }
        if ($value === '') {
            return "''";
        }
        return '0x' . bin2hex($value);
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter DbLiteralTest`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ferry-plugin/src/Db.php ferry-plugin/tests/DbLiteralTest.php
git commit -m "feat: column-type-driven hex literal encoding for db export"
```

---

### Task 8: DB export loop (plugin, tested against a scripted fake wpdb)

**Files:**
- Modify: `ferry-plugin/src/Db.php` (add tables/export/keyset methods)
- Create: `ferry-plugin/tests/helpers/FakeWpdb.php`
- Test: `ferry-plugin/tests/DbExportTest.php`

**Interfaces:**
- Consumes: `Db::literal`, `Db::numeric_map` (Task 7), `Ferry\Budget` (Task 6).
- Produces (used by Routes in Task 9 and the CLI in Task 15):
  - `Db::tables($wpdb): array` — list of `['name','rows','bytes','pk' => ?string, 'maxpk' => ?int]`; `maxpk` is the export-start snapshot bound (§3.5: fix the max key up front so new rows can't seep in mid-export).
  - `Db::single_pk($wpdb, string $table): ?string` — single-column integer PK or null (→ OFFSET fallback).
  - `Db::export($wpdb, string $table, ?string $pk, int $after, ?int $before, Budget $budget, int $chunk_rows = 50, int $byte_budget = 4194304): array` returning `['sql' => string, 'last_key' => int, 'complete' => bool]`. First batch (`after === 0`) prepends `DROP TABLE IF EXISTS` + `SHOW CREATE TABLE`. Rows are fetched in sub-chunks of `$chunk_rows` (memory guard: `_elementor_data`-style rows are routinely MBs; overshoot is bounded by one sub-chunk).

- [ ] **Step 1: Create the scripted fake `ferry-plugin/tests/helpers/FakeWpdb.php`**

```php
<?php
/**
 * Minimal scripted wpdb double. Results are returned in FIFO order for
 * get_results/get_row/get_var/get_col alike; tests script the exact call
 * sequence Db makes. Executed SQL is recorded for assertions.
 */
final class FakeWpdb
{
    /** @var array<int, mixed> */
    private $script;
    /** @var string[] */
    public $queries = [];

    public function __construct(array $script)
    {
        $this->script = $script;
    }

    public function prepare($query, ...$args)
    {
        foreach ($args as $arg) {
            $query = preg_replace_callback('/%[dsi]/', function ($m) use ($arg) {
                if ($m[0] === '%d') { return (string) (int) $arg; }
                if ($m[0] === '%i') { return '`' . $arg . '`'; }
                return "'" . $arg . "'";
            }, $query, 1);
        }
        return $query;
    }

    public function get_results($query, $output = ARRAY_A)
    {
        $this->queries[] = $query;
        return array_shift($this->script) ?: [];
    }

    public function get_row($query, $output = ARRAY_A)
    {
        $this->queries[] = $query;
        return array_shift($this->script);
    }

    public function get_var($query)
    {
        $this->queries[] = $query;
        return array_shift($this->script);
    }

    public function get_col($query)
    {
        $this->queries[] = $query;
        return array_shift($this->script) ?: [];
    }
}
```

- [ ] **Step 2: Write the failing test `ferry-plugin/tests/DbExportTest.php`**

```php
<?php
use Ferry\Budget;
use Ferry\Db;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/helpers/FakeWpdb.php';

final class DbExportTest extends TestCase
{
    private const COLUMNS = [
        ['Field' => 'ID', 'Type' => 'bigint(20) unsigned'],
        ['Field' => 'title', 'Type' => 'text'],
    ];
    private const CREATE = ['wp_posts', "CREATE TABLE `wp_posts` (\n  `ID` bigint(20)\n)"];

    public function test_keyset_export_runs_to_completion(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,                                                        // SHOW COLUMNS
            self::CREATE,                                                         // SHOW CREATE TABLE
            [['ID' => '1', 'title' => 'Hello'], ['ID' => '2', 'title' => 'World']], // chunk 1 (full)
            [['ID' => '3', 'title' => 'Bye']],                                    // chunk 2 (short -> done)
        ]);
        $r = Db::export($wpdb, 'wp_posts', 'ID', 0, 3, new Budget(10.0), 2);
        $this->assertStringContainsString('DROP TABLE IF EXISTS `wp_posts`;', $r['sql']);
        $this->assertStringContainsString('CREATE TABLE `wp_posts`', $r['sql']);
        $this->assertStringContainsString("INSERT INTO `wp_posts` VALUES\n(1,0x48656c6c6f),\n(2,0x576f726c64);", $r['sql']);
        $this->assertStringContainsString('(3,0x427965);', $r['sql']);
        $this->assertSame(3, $r['last_key']);
        $this->assertTrue($r['complete']);
        $this->assertStringContainsString('WHERE `ID` > 0 AND `ID` <= 3', $wpdb->queries[2]);
    }

    public function test_byte_budget_stops_batch_early(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,
            self::CREATE,
            [['ID' => '1', 'title' => 'Hello'], ['ID' => '2', 'title' => 'World']],
        ]);
        // budget of 100 bytes: the schema prefix (~80) fits, schema + first chunk does not
        $r = Db::export($wpdb, 'wp_posts', 'ID', 0, null, new Budget(10.0), 2, 100);
        $this->assertFalse($r['complete']);
        $this->assertSame(2, $r['last_key'], 'resume cursor points at last emitted row');
    }

    public function test_resumed_batch_has_no_schema_prefix(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,
            [],           // empty chunk -> immediately complete
        ]);
        $r = Db::export($wpdb, 'wp_posts', 'ID', 5, null, new Budget(10.0), 2);
        $this->assertStringNotContainsString('DROP TABLE', $r['sql']);
        $this->assertTrue($r['complete']);
        $this->assertSame(5, $r['last_key']);
    }

    public function test_offset_fallback_without_usable_pk(): void
    {
        $wpdb = new FakeWpdb([
            self::COLUMNS,
            self::CREATE,
            [['ID' => '9', 'title' => 'a'], ['ID' => '8', 'title' => 'b']],
            [['ID' => '7', 'title' => 'c']],
        ]);
        $r = Db::export($wpdb, 'wp_posts', null, 0, null, new Budget(10.0), 2);
        $this->assertSame(3, $r['last_key'], 'offset cursor advances by row count');
        $this->assertTrue($r['complete']);
        $this->assertStringContainsString('OFFSET 0', $wpdb->queries[2]);
        $this->assertStringContainsString('OFFSET 2', $wpdb->queries[3]);
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter DbExportTest`
Expected: FAIL — `Db::export` not defined.

- [ ] **Step 4: Add tables/export to `ferry-plugin/src/Db.php`** (append inside the class, after `literal`)

```php
    const CHUNK_ROWS = 50;                  // memory guard: rows can be MBs each (§3.5)
    const BYTE_BUDGET = 4194304;            // ~4MB output per batch (§3.5)

    /** @param \wpdb|\FakeWpdb $wpdb */
    public static function tables($wpdb): array
    {
        $tables = [];
        foreach ($wpdb->get_results('SHOW TABLE STATUS', ARRAY_A) as $t) {
            $name = $t['Name'];
            $pk = self::single_pk($wpdb, $name);
            $tables[] = [
                'name'  => $name,
                'rows'  => (int) $t['Rows'],   // approximate for InnoDB; informational only
                'bytes' => (int) $t['Data_length'] + (int) $t['Index_length'],
                'pk'    => $pk,
                'maxpk' => $pk !== null ? (int) $wpdb->get_var("SELECT MAX(`$pk`) FROM `$name`") : null,
            ];
        }
        return $tables;
    }

    /** Single-column integer primary key, or null (-> OFFSET fallback, §3.5). */
    public static function single_pk($wpdb, string $table)
    {
        $keys = $wpdb->get_results($wpdb->prepare('SHOW KEYS FROM %i WHERE Key_name = %s', $table, 'PRIMARY'), ARRAY_A);
        if (!is_array($keys) || count($keys) !== 1) {
            return null;
        }
        $col = $keys[0]['Column_name'];
        $type = $wpdb->get_row($wpdb->prepare('SHOW COLUMNS FROM %i LIKE %s', $table, $col), ARRAY_A);
        return (is_array($type) && stripos($type['Type'], 'int') !== false) ? $col : null;
    }

    /**
     * @return array{sql: string, last_key: int, complete: bool}
     */
    public static function export($wpdb, string $table, $pk, int $after, $before, Budget $budget, int $chunk_rows = self::CHUNK_ROWS, int $byte_budget = self::BYTE_BUDGET): array
    {
        $numeric = self::numeric_map($wpdb->get_results("SHOW COLUMNS FROM `$table`", ARRAY_A));
        $out = '';
        if ($after === 0) {
            $create = $wpdb->get_row("SHOW CREATE TABLE `$table`", ARRAY_N);
            $out .= "DROP TABLE IF EXISTS `$table`;\n" . $create[1] . ";\n";
        }
        $last = $after;
        $complete = false;
        while (strlen($out) < $byte_budget && !$budget->exhausted()) {
            $rows = self::fetch_chunk($wpdb, $table, $pk, $last, $before, $chunk_rows);
            if ($rows === []) {
                $complete = true;
                break;
            }
            $tuples = [];
            foreach ($rows as $row) {
                $vals = [];
                foreach ($row as $col => $value) {
                    $vals[] = self::literal($value, isset($numeric[$col]) ? $numeric[$col] : false);
                }
                $tuples[] = '(' . implode(',', $vals) . ')';
            }
            $out .= "INSERT INTO `$table` VALUES\n" . implode(",\n", $tuples) . ";\n";
            $last_row = $rows[count($rows) - 1];
            $last = $pk !== null ? (int) $last_row[$pk] : $last + count($rows);
            if (count($rows) < $chunk_rows) {
                $complete = true;
                break;
            }
        }
        return ['sql' => $out, 'last_key' => $last, 'complete' => $complete];
    }

    private static function fetch_chunk($wpdb, string $table, $pk, int $after, $before, int $chunk_rows): array
    {
        if ($pk !== null) {
            $sql = "SELECT * FROM `$table` WHERE `$pk` > %d" . ($before !== null ? " AND `$pk` <= %d" : '') . " ORDER BY `$pk` LIMIT %d";
            $args = $before !== null ? [$after, $before, $chunk_rows] : [$after, $chunk_rows];
            return $wpdb->get_results($wpdb->prepare($sql, ...$args), ARRAY_A);
        }
        return $wpdb->get_results($wpdb->prepare("SELECT * FROM `$table` LIMIT %d OFFSET %d", $chunk_rows, $after), ARRAY_A);
    }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ferry-plugin && vendor/bin/phpunit`
Expected: PASS — full plugin suite green (Auth, Excludes, Tar, Budget, Manifest, DbLiteral, DbExport).

- [ ] **Step 6: Commit**

```bash
git add ferry-plugin/src/Db.php ferry-plugin/tests/helpers/FakeWpdb.php ferry-plugin/tests/DbExportTest.php
git commit -m "feat: keyset db export with byte budget and offset fallback"
```

---

### Task 9: Plugin bootstrap, wp-config constant capture, and REST routes

**Files:**
- Modify: `ferry-plugin/ferry.php` (full bootstrap)
- Create: `ferry-plugin/src/Config.php`
- Create: `ferry-plugin/src/Routes.php`
- Test: `ferry-plugin/tests/ConfigTest.php`

**Interfaces:**
- Consumes: `Auth` (Task 3), `Excludes` (4), `Tar` (5), `Budget`/`Manifest` (6), `Db` (7/8).
- Produces:
  - `Ferry\Config::names_from_source(string $php): string[]` (pure, tested) and `Config::constants(): array` (denylist-filtered name ⇒ live value map; needs WP).
  - `Ferry\Routes::register(): void` and REST endpoints `/wp-json/ferry/v1/{pair,info,manifest,files,db/tables,db}` — the exact wire contract the CLI (Tasks 11–15) consumes:
    - `POST /pair` `{code}` → `{secret, siteurl}`; 409 `ferry_multisite`; 403 `ferry_bad_code`.
    - `GET /info` → §4.4 payload shape.
    - `GET /manifest?after=N` → `{files:[{path,size,hash}]}` + `X-Complete`/`X-Next-Index`.
    - `POST /files` `{paths:[...]}` → tar.gz stream ending with entry `.ferry-meta.json` = `{complete, next_index, skipped}`; or `{path, offset, length}` → raw bytes (oversized-file range mode, §3.4).
    - `GET /db/tables` → `{tables:[{name,rows,bytes,pk,maxpk}]}`.
    - `GET /db?table=T&after=N[&before=M]` → gzipped SQL + `X-Complete`/`X-Last-Key`.

- [ ] **Step 1: Write the failing test `ferry-plugin/tests/ConfigTest.php`**

```php
<?php
use Ferry\Config;
use PHPUnit\Framework\TestCase;

final class ConfigTest extends TestCase
{
    public function test_extracts_define_names_without_executing(): void
    {
        $src = <<<'PHP'
<?php
define( 'DB_NAME', 'prod_db' );
define('WP_DEBUG', false);
define("WP_MEMORY_LIMIT", '256M');
define('DYNAMIC_ONE', getenv('SOME_VAR'));
if (!defined('WP_CACHE')) define('WP_CACHE', true);
$noise = 'define'; // string literal, not a call
// define('COMMENTED_OUT', 1); -- tokenizer sees a comment, not a call
PHP;
        $this->assertSame(
            ['DB_NAME', 'WP_DEBUG', 'WP_MEMORY_LIMIT', 'DYNAMIC_ONE', 'WP_CACHE'],
            Config::names_from_source($src)
        );
    }

    public function test_denylist_contains_exactly_salts_and_db_credentials(): void
    {
        $this->assertSame([
            'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
            'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
            'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST',
        ], Config::DENYLIST);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter ConfigTest`
Expected: FAIL — class `Ferry\Config` not found.

- [ ] **Step 3: Implement `ferry-plugin/src/Config.php`**

```php
<?php
namespace Ferry;

/**
 * §2.5: /info carries ALL user-defined wp-config constants minus the denylist.
 * Names are read from wp-config.php via the tokenizer (never executed);
 * values are read from the live runtime via constant(), so computed defines
 * (getenv etc.) report what production actually runs with.
 */
final class Config
{
    const DENYLIST = [
        'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
        'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
        'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST',
    ];

    /** @return string[] define()d constant names, in source order, deduplicated */
    public static function names_from_source(string $php): array
    {
        $names = [];
        $tokens = token_get_all($php);
        $count = count($tokens);
        for ($i = 0; $i < $count; $i++) {
            $t = $tokens[$i];
            if (!is_array($t) || $t[0] !== T_STRING || strtolower($t[1]) !== 'define') {
                continue;
            }
            for ($j = $i + 1; $j < min($i + 4, $count); $j++) {
                $n = $tokens[$j];
                if (is_array($n) && $n[0] === T_CONSTANT_ENCAPSED_STRING) {
                    $names[] = trim($n[1], "\"'");
                    break;
                }
            }
        }
        return array_values(array_unique($names));
    }

    /** @return array<string, scalar|null> */
    public static function constants(): array
    {
        // WP also supports wp-config.php one level above ABSPATH.
        $candidates = [ABSPATH . 'wp-config.php', dirname(ABSPATH) . '/wp-config.php'];
        $out = [];
        foreach ($candidates as $path) {
            if (!is_readable($path)) {
                continue;
            }
            foreach (self::names_from_source((string) file_get_contents($path)) as $name) {
                if (in_array($name, self::DENYLIST, true) || !defined($name)) {
                    continue;
                }
                $value = constant($name);
                if (is_scalar($value) || $value === null) {
                    $out[$name] = $value;
                }
            }
            break;
        }
        return $out;
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-plugin && vendor/bin/phpunit --filter ConfigTest`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `ferry-plugin/src/Routes.php`** (WP glue — verified in the Task 19 E2E gate)

```php
<?php
namespace Ferry;

final class Routes
{
    public static function register(): void
    {
        register_rest_route('ferry/v1', '/pair', [
            'methods'             => 'POST',
            'permission_callback' => '__return_true', // guarded by the single-use, short-lived code itself
            'callback'            => [self::class, 'pair'],
        ]);
        $signed = [
            ['GET',  '/info',      'info'],
            ['GET',  '/manifest',  'manifest'],
            ['POST', '/files',     'files'],
            ['GET',  '/db/tables', 'db_tables'],
            ['GET',  '/db',        'db_export'],
        ];
        foreach ($signed as $r) {
            register_rest_route('ferry/v1', $r[1], [
                'methods'             => $r[0],
                'permission_callback' => [self::class, 'authorize'],
                'callback'            => [self::class, $r[2]],
            ]);
        }
    }

    /** @return true|\WP_Error */
    public static function authorize(\WP_REST_Request $request)
    {
        $secret = get_option('ferry_secret');
        if (!$secret) {
            return new \WP_Error('ferry_unpaired', 'This site is not paired yet. Activate the plugin and pair with the code it shows.', ['status' => 403]);
        }
        $ok = Auth::verify(
            $secret,
            $request->get_method(),
            $request->get_route(),
            $request->get_query_params(),
            $request->get_body(),
            $request->get_header('X-Ferry-Timestamp'),
            $request->get_header('X-Ferry-Signature'),
            time()
        );
        return $ok ? true : new \WP_Error('ferry_bad_signature', 'Invalid or expired request signature.', ['status' => 401]);
    }

    public static function pair(\WP_REST_Request $request)
    {
        if (is_multisite()) {
            return new \WP_Error('ferry_multisite', 'Multisite is not supported. Ferry refuses multisite installs by design.', ['status' => 409]);
        }
        $secret = Auth::complete_pairing((string) $request->get_param('code'));
        if ($secret === null) {
            return new \WP_Error('ferry_bad_code', 'Invalid or expired pairing code.', ['status' => 403]);
        }
        return ['secret' => $secret, 'siteurl' => get_option('siteurl')];
    }

    public static function info()
    {
        global $wpdb, $wp_version;
        return [
            'wp'  => $wp_version,
            'php' => [
                'version'    => PHP_VERSION,
                'extensions' => get_loaded_extensions(),
                'ini'        => [
                    'memory_limit'        => (string) ini_get('memory_limit'),
                    'max_execution_time'  => (int) ini_get('max_execution_time'),
                    'post_max_size'       => (string) ini_get('post_max_size'),
                    'upload_max_filesize' => (string) ini_get('upload_max_filesize'),
                    'max_input_vars'      => (int) ini_get('max_input_vars'),
                ],
            ],
            'db' => [
                'server'    => (stripos($wpdb->db_server_info(), 'mariadb') !== false) ? 'mariadb' : 'mysql',
                'version'   => $wpdb->db_version(),
                'charset'   => $wpdb->charset,
                'collation' => $wpdb->collate,
                'bytes'     => (int) $wpdb->get_var($wpdb->prepare(
                    'SELECT SUM(data_length + index_length) FROM information_schema.TABLES WHERE table_schema = %s',
                    DB_NAME
                )),
            ],
            'server'    => (stripos(isset($_SERVER['SERVER_SOFTWARE']) ? $_SERVER['SERVER_SOFTWARE'] : '', 'nginx') !== false) ? 'nginx' : 'apache',
            'constants' => Config::constants(),
            'multisite' => is_multisite(),
            'prefix'    => $wpdb->prefix,
            'abspath'   => ABSPATH,
            'siteurl'   => get_option('siteurl'),
        ];
    }

    public static function manifest(\WP_REST_Request $request)
    {
        $after = max(0, (int) $request->get_param('after'));
        $result = Manifest::batch(untrailingslashit(ABSPATH), $after, new Budget());
        $response = new \WP_REST_Response(['files' => $result['files']]);
        $response->header('X-Complete', $result['complete'] ? '1' : '0');
        $response->header('X-Next-Index', (string) $result['next']);
        return $response;
    }

    /** Streams tar.gz; resume state travels in-band as the final .ferry-meta.json entry. */
    public static function files(\WP_REST_Request $request)
    {
        $params = $request->get_json_params();
        if (isset($params['path'], $params['offset'], $params['length'])) {
            self::send_range((string) $params['path'], (int) $params['offset'], (int) $params['length']);
        }
        $paths = (isset($params['paths']) && is_array($params['paths'])) ? $params['paths'] : [];
        $root = realpath(untrailingslashit(ABSPATH));
        $budget = new Budget();
        while (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: application/gzip');
        $deflate = deflate_init(ZLIB_ENCODING_GZIP);
        $write = function (string $bytes) use ($deflate) {
            echo deflate_add($deflate, $bytes, ZLIB_NO_FLUSH);
        };
        $tar = new Tar($write);
        $done = 0;
        $skipped = [];
        foreach ($paths as $relpath) {
            if ($budget->exhausted()) {
                break;
            }
            $relpath = (string) $relpath;
            $abs = realpath($root . '/' . $relpath);
            if ($abs === false || strpos($abs, $root . DIRECTORY_SEPARATOR) !== 0
                || Excludes::excluded($relpath) || !is_file($abs)) {
                $skipped[] = $relpath;
                $done++;
                continue;
            }
            $fh = fopen($abs, 'rb');
            if ($fh === false) {
                $skipped[] = $relpath;
                $done++;
                continue;
            }
            $tar->add_stream($relpath, $fh, (int) filesize($abs), (int) filemtime($abs));
            fclose($fh);
            $done++;
        }
        $tar->add_file('.ferry-meta.json', (string) json_encode([
            'complete'   => $done >= count($paths),
            'next_index' => $done,
            'skipped'    => $skipped,
        ]));
        $tar->finish();
        echo deflate_add($deflate, '', ZLIB_FINISH);
        exit;
    }

    /** §3.4: byte-range mode for single files larger than a batch. Raw bytes, no tar. */
    private static function send_range(string $relpath, int $offset, int $length): void
    {
        $root = realpath(untrailingslashit(ABSPATH));
        $abs = realpath($root . '/' . $relpath);
        if ($abs === false || strpos($abs, $root . DIRECTORY_SEPARATOR) !== 0
            || Excludes::excluded($relpath) || !is_file($abs)) {
            status_header(404);
            exit;
        }
        while (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: application/octet-stream');
        $fh = fopen($abs, 'rb');
        fseek($fh, $offset);
        $remaining = $length;
        while ($remaining > 0 && !feof($fh)) {
            $chunk = fread($fh, min(512 * 1024, $remaining));
            if ($chunk === false || $chunk === '') {
                break;
            }
            echo $chunk;
            $remaining -= strlen($chunk);
        }
        fclose($fh);
        exit;
    }

    public static function db_tables()
    {
        global $wpdb;
        return ['tables' => Db::tables($wpdb)];
    }

    public static function db_export(\WP_REST_Request $request)
    {
        global $wpdb;
        $table = (string) $request->get_param('table');
        if (!in_array($table, $wpdb->get_col('SHOW TABLES'), true)) {
            return new \WP_Error('ferry_unknown_table', 'Unknown table.', ['status' => 404]);
        }
        $after = max(0, (int) $request->get_param('after'));
        $before = $request->get_param('before') !== null ? (int) $request->get_param('before') : null;
        $result = Db::export($wpdb, $table, Db::single_pk($wpdb, $table), $after, $before, new Budget());
        while (ob_get_level()) { ob_end_clean(); }
        header('Content-Type: application/gzip');
        header('X-Complete: ' . ($result['complete'] ? '1' : '0'));
        header('X-Last-Key: ' . $result['last_key']);
        echo gzencode($result['sql'], 6);
        exit;
    }
}
```

- [ ] **Step 6: Complete `ferry-plugin/ferry.php`** (replace the file)

```php
<?php
/**
 * Plugin Name: Ferry Connect
 * Description: Read-only transport layer for ferry - manifest, file batches, and database export over signed REST requests. No command execution, no write endpoints.
 * Version: 0.1.0
 * Requires PHP: 7.2
 * Author: Ferry
 */

if (!defined('ABSPATH')) {
    exit;
}

spl_autoload_register(function ($class) {
    if (strpos($class, 'Ferry\\') === 0) {
        $path = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, 6)) . '.php';
        if (is_file($path)) {
            require $path;
        }
    }
});

register_activation_hook(__FILE__, function () {
    if (!get_option('ferry_secret')) {
        Ferry\Auth::issue_pairing_code();
    }
});

add_action('rest_api_init', ['Ferry\\Routes', 'register']);

add_action('admin_notices', function () {
    if (!current_user_can('manage_options')) {
        return;
    }
    $pairing = Ferry\Auth::current_pairing_code();
    if ($pairing === null) {
        return;
    }
    printf(
        '<div class="notice notice-info"><p><strong>Ferry pairing code:</strong> <code>%s</code> &mdash; expires in %d min. Paste it into your ferry client: <code>ferry link %s --code=%s</code></p></div>',
        esc_html($pairing['code']),
        max(1, (int) ceil(($pairing['expires'] - time()) / 60)),
        esc_html(get_option('siteurl')),
        esc_html($pairing['code'])
    );
});

if (defined('WP_CLI') && WP_CLI) {
    WP_CLI::add_command('ferry pair', function () {
        $pairing = Ferry\Auth::issue_pairing_code();
        WP_CLI::line('Pairing code: ' . $pairing['code'] . ' (expires in 10:00)');
    });
}
```

- [ ] **Step 7: Lint and run the full plugin suite**

Run: `cd ferry-plugin && for f in ferry.php src/*.php; do php -l "$f" || exit 1; done && vendor/bin/phpunit`
Expected: `No syntax errors detected` for every file; full suite PASS.

- [ ] **Step 8: Commit**

```bash
git add ferry-plugin/ferry.php ferry-plugin/src/Config.php ferry-plugin/src/Routes.php ferry-plugin/tests/ConfigTest.php
git commit -m "feat: plugin bootstrap, wp-config constant capture, and signed REST routes"
```

---

### Task 10: CLI site profile store

**Files:**
- Create: `ferry-cli/src/profile.ts`
- Test: `ferry-cli/tests/profile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by link/pull, Tasks 12/18):
  - `interface SiteInfo { wp: string; php: { version: string; extensions: string[]; ini: Record<string, string | number> }; db: { server: 'mysql' | 'mariadb'; version: string; charset: string; collation: string; bytes: number }; server: 'nginx' | 'apache'; constants: Record<string, string | number | boolean | null>; multisite: boolean; prefix: string; abspath: string; siteurl: string }`
  - `interface SiteProfile { url: string; secret: string; slug: string; clonePath: string; info?: SiteInfo }`
  - `ferryHome(): string` (`$FERRY_HOME` or `~/.ferry`), `profilePath(slug: string): string`, `saveProfile(p: SiteProfile): void`, `loadProfile(slug: string): SiteProfile` (throws with an actionable English message when missing), `slugFromUrl(url: string): string`.

- [ ] **Step 1: Write the failing test `ferry-cli/tests/profile.test.ts`**

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProfile, profilePath, saveProfile, slugFromUrl } from '../src/profile.js';

describe('profile store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-'));
    process.env.FERRY_HOME = home;
  });

  afterEach(() => {
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('derives a filesystem-safe slug from the site url', () => {
    expect(slugFromUrl('https://www.wasgeurtje.nl')).toBe('wasgeurtje-nl');
    expect(slugFromUrl('https://blog.studiokraft.nl/')).toBe('blog-studiokraft-nl');
  });

  it('round-trips a profile as readable json', () => {
    const profile = {
      url: 'https://wasgeurtje.nl',
      secret: 'abc123',
      slug: 'wasgeurtje-nl',
      clonePath: join(home, 'clone'),
    };
    saveProfile(profile);
    expect(profilePath('wasgeurtje-nl')).toBe(join(home, 'sites', 'wasgeurtje-nl', 'profile.json'));
    expect(loadProfile('wasgeurtje-nl')).toEqual(profile);
  });

  it('fails with an actionable message for unknown sites', () => {
    expect(() => loadProfile('nope')).toThrowError(/ferry link/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/profile.js`.

- [ ] **Step 3: Implement `ferry-cli/src/profile.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/profile.ts ferry-cli/tests/profile.test.ts
git commit -m "feat: file-based site profile store"
```

---

### Task 11: Signed HTTP client with clock offset and retries

**Files:**
- Create: `ferry-cli/src/client.ts`
- Test: `ferry-cli/tests/client.test.ts`

**Interfaces:**
- Consumes: `sign`/`canonical` from `signing.ts` (Task 3).
- Produces (used by all transfer tasks):
  - `interface ManifestEntry { path: string; size: number; hash: string | null }`
  - `class FerryClient { constructor(baseUrl: string, secret: string); syncClock(): Promise<void>; getJson(route: string, query?: Record<string,string>): Promise<{ data: any; headers: Record<string, string | string[] | undefined> }>; getBuffer(route: string, query?: Record<string,string>): Promise<{ buffer: Buffer; headers: ... }>; postStream(route: string, body: unknown): Promise<{ stream: NodeJS.ReadableStream; headers: ...; statusCode: number }> }`
  - Behavior: signs every request with server-derived time (§4.5); retries 429/502/503/504 and network errors up to 5 attempts with exponential backoff, honoring `Retry-After`; throws an English error including status + body snippet on non-200.

- [ ] **Step 1: Write the failing test `ferry-cli/tests/client.test.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FerryClient } from '../src/client.js';
import { sign } from '../src/signing.js';

const SECRET = 'test-secret';
let server: Server;

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(() => server?.close());

describe('FerryClient', () => {
  it('signs requests with server-derived time and a valid signature', async () => {
    const skewMs = 120_000; // server clock 2 minutes ahead - beyond the 60s window without syncClock
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      const serverNow = Math.floor((Date.now() + skewMs) / 1000);
      res.setHeader('Date', new Date(Date.now() + skewMs).toUTCString());
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      const ts = req.headers['x-ferry-timestamp'] as string;
      const query = Object.fromEntries(url.searchParams);
      const expected = sign(SECRET, 'GET', '/ferry/v1/info', query, '', Number(ts));
      const fresh = Math.abs(serverNow - Number(ts)) <= 60;
      const valid = expected === req.headers['x-ferry-signature'] && fresh;
      res.statusCode = valid ? 200 : 401;
      res.end(JSON.stringify({ valid }));
    });
    const client = new FerryClient(base, SECRET);
    await client.syncClock();
    const { data } = await client.getJson('/ferry/v1/info');
    expect(data.valid).toBe(true);
  });

  it('retries retryable statuses with backoff', async () => {
    let calls = 0;
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      calls++;
      if (calls === 1) {
        res.statusCode = 503;
        res.setHeader('Retry-After', '0');
        res.end('busy');
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    const client = new FerryClient(base, SECRET);
    const { data } = await client.getJson('/ferry/v1/info');
    expect(data.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('throws an actionable error on a non-retryable failure', async () => {
    const base = await listen((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/wp-json/') {
        res.end('{}');
        return;
      }
      res.statusCode = 403;
      res.end('{"code":"ferry_unpaired"}');
    });
    const client = new FerryClient(base, SECRET);
    await expect(client.getJson('/ferry/v1/info')).rejects.toThrowError(/403.*ferry_unpaired/s);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/client.js`.

- [ ] **Step 3: Implement `ferry-cli/src/client.ts`**

```ts
import type { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { request, type Dispatcher } from 'undici';
import { sign } from './signing.js';

export interface ManifestEntry {
  path: string;
  size: number;
  hash: string | null;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

export class FerryClient {
  private clockOffsetMs = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  /** §4.5: shared hosts drift minutes off; derive server time from the Date header. */
  async syncClock(): Promise<void> {
    const res = await request(new URL('/wp-json/', this.baseUrl));
    await res.body.text();
    const date = res.headers['date'];
    if (typeof date === 'string' && !Number.isNaN(Date.parse(date))) {
      this.clockOffsetMs = Date.parse(date) - Date.now();
    }
  }

  async getJson(
    route: string,
    query: Record<string, string> = {},
  ): Promise<{ data: any; headers: IncomingHttpHeaders }> {
    const res = await this.send('GET', route, query, '');
    const text = await res.body.text();
    if (res.statusCode !== 200) {
      throw new Error(`GET ${route} failed (${res.statusCode}): ${text.slice(0, 300)}`);
    }
    return { data: JSON.parse(text), headers: res.headers as IncomingHttpHeaders };
  }

  async getBuffer(
    route: string,
    query: Record<string, string> = {},
  ): Promise<{ buffer: Buffer; headers: IncomingHttpHeaders }> {
    const res = await this.send('GET', route, query, '');
    const buffer = Buffer.from(await res.body.arrayBuffer());
    if (res.statusCode !== 200) {
      throw new Error(`GET ${route} failed (${res.statusCode}): ${buffer.toString('utf8', 0, 300)}`);
    }
    return { buffer, headers: res.headers as IncomingHttpHeaders };
  }

  async postStream(
    route: string,
    body: unknown,
  ): Promise<{ stream: Readable; headers: IncomingHttpHeaders; statusCode: number }> {
    const raw = JSON.stringify(body);
    const res = await this.send('POST', route, {}, raw);
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      throw new Error(`POST ${route} failed (${res.statusCode}): ${text.slice(0, 300)}`);
    }
    return {
      stream: res.body as unknown as Readable,
      headers: res.headers as IncomingHttpHeaders,
      statusCode: res.statusCode,
    };
  }

  private async send(
    method: 'GET' | 'POST',
    route: string,
    query: Record<string, string>,
    body: string,
  ): Promise<Dispatcher.ResponseData> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const timestamp = Math.floor((Date.now() + this.clockOffsetMs) / 1000);
      const url = new URL(`/wp-json${route}`, this.baseUrl);
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
      try {
        const res = await request(url, {
          method,
          body: body === '' ? undefined : body,
          headers: {
            ...(body === '' ? {} : { 'content-type': 'application/json' }),
            'x-ferry-timestamp': String(timestamp),
            'x-ferry-signature': sign(this.secret, method, route, query, body, timestamp),
          },
        });
        if (RETRYABLE.has(res.statusCode) && attempt < MAX_ATTEMPTS) {
          await res.body.text();
          const retryAfter = Number(res.headers['retry-after']);
          const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
          await sleep(delay);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_ATTEMPTS) {
          break;
        }
        await sleep(500 * 2 ** attempt);
      }
    }
    throw new Error(
      `${method} ${route}: request failed after ${MAX_ATTEMPTS} attempts. ` +
        `If a security plugin (e.g. Wordfence) runs on the site, allowlist the /wp-json/ferry/v1 namespace. ` +
        `Last error: ${String(lastError)}`,
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS (client tests + previous suites).

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/client.ts ferry-cli/tests/client.test.ts
git commit -m "feat: signed http client with server-clock offset and backoff"
```

---

### Task 12: `ferry link` — pairing

**Files:**
- Create: `ferry-cli/src/link.ts`
- Test: `ferry-cli/tests/link.test.ts`

**Interfaces:**
- Consumes: `saveProfile`, `slugFromUrl`, `ferryHome` (Task 10); plugin `POST /pair` contract (Task 9).
- Produces: `link(url: string, code: string, dir?: string): Promise<SiteProfile>` — exchanges the code, persists the profile, default `clonePath` = `~/ferry-sites/<slug>`. Multisite 409 and bad-code 403 map to clear English errors.

- [ ] **Step 1: Write the failing test `ferry-cli/tests/link.test.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link } from '../src/link.js';
import { loadProfile } from '../src/profile.js';

let server: Server;
let home: string;

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferry-'));
  process.env.FERRY_HOME = home;
});

afterEach(() => {
  server?.close();
  delete process.env.FERRY_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('link', () => {
  it('exchanges the code and stores a profile', async () => {
    const base = await listen((req, res) => {
      expect(req.url).toBe('/wp-json/ferry/v1/pair');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        expect(JSON.parse(body)).toEqual({ code: '7K2P-9QXM' });
        res.end(JSON.stringify({ secret: 's3cret', siteurl: base }));
      });
    });
    const profile = await link(base, '7K2P-9QXM');
    expect(profile.secret).toBe('s3cret');
    expect(loadProfile(profile.slug).secret).toBe('s3cret');
  });

  it('maps the multisite refusal to a clear error', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 'ferry_multisite', message: 'Multisite is not supported.' }));
    });
    await expect(link(base, 'XXXX-XXXX')).rejects.toThrowError(/[Mm]ultisite/);
  });

  it('maps a bad code to a clear error', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 403;
      res.end(JSON.stringify({ code: 'ferry_bad_code', message: 'Invalid or expired pairing code.' }));
    });
    await expect(link(base, 'WRON-GCOD')).rejects.toThrowError(/Invalid or expired pairing code/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/link.js`.

- [ ] **Step 3: Implement `ferry-cli/src/link.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { saveProfile, slugFromUrl, type SiteProfile } from './profile.js';

export async function link(url: string, code: string, dir?: string): Promise<SiteProfile> {
  const res = await request(new URL('/wp-json/ferry/v1/pair', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = (await res.body.json()) as { secret?: string; code?: string; message?: string };
  if (res.statusCode !== 200 || !data.secret) {
    if (data.code === 'ferry_multisite') {
      throw new Error('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.');
    }
    throw new Error(data.message ?? `Pairing failed (${res.statusCode}).`);
  }
  const slug = slugFromUrl(url);
  const profile: SiteProfile = {
    url,
    secret: data.secret,
    slug,
    clonePath: dir ?? join(homedir(), 'ferry-sites', slug),
  };
  saveProfile(profile);
  return profile;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/link.ts ferry-cli/tests/link.test.ts
git commit -m "feat: ferry link pairing command logic"
```

---

### Task 13: Resolve seam + batch bin-packing

**Files:**
- Create: `ferry-cli/src/resolve.ts`
- Create: `ferry-cli/src/transfer.ts` (bin-packing half; fetching added in Task 14)
- Test: `ferry-cli/tests/binpack.test.ts`

**Interfaces:**
- Consumes: `ManifestEntry` (Task 11).
- Produces:
  - `resolve(entries: ManifestEntry[]): ManifestEntry[]` — the §4.3 seam. v0 = identity; later provenance replaces this one function instead of the transfer layer.
  - `binPack(entries: ManifestEntry[], maxBytes = 8 * 1024 * 1024): { batches: ManifestEntry[][]; oversized: ManifestEntry[] }` — greedy, order-preserving; entries larger than `maxBytes` go to `oversized` (fetched via byte ranges).

- [ ] **Step 1: Write the failing test `ferry-cli/tests/binpack.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { binPack } from '../src/transfer.js';
import { resolve } from '../src/resolve.js';

const entry = (path: string, size: number) => ({ path, size, hash: null });

describe('resolve (v0 seam)', () => {
  it('returns the manifest unchanged', () => {
    const entries = [entry('a.php', 10)];
    expect(resolve(entries)).toEqual(entries);
  });
});

describe('binPack', () => {
  it('packs greedily in order and splits oversized files', () => {
    const entries = [entry('a', 60), entry('b', 50), entry('c', 30), entry('d', 250)];
    const { batches, oversized } = binPack(entries, 100);
    expect(batches).toEqual([[entry('a', 60)], [entry('b', 50), entry('c', 30)]]);
    expect(oversized).toEqual([entry('d', 250)]);
  });

  it('handles an empty manifest', () => {
    expect(binPack([], 100)).toEqual({ batches: [], oversized: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `ferry-cli/src/resolve.ts`**

```ts
import type { ManifestEntry } from './client.js';

// Seam (§4.3): v0 fetches everything the manifest lists. Later, provenance
// (§2.14) replaces this single function with a hash-diff against official
// checksums - without touching the transfer layer.
export function resolve(entries: ManifestEntry[]): ManifestEntry[] {
  return entries;
}
```

- [ ] **Step 4: Implement the bin-packing half of `ferry-cli/src/transfer.ts`**

```ts
import type { ManifestEntry } from './client.js';

export const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024; // §3.2: ~8MB batches

export function binPack(
  entries: ManifestEntry[],
  maxBytes = DEFAULT_BATCH_BYTES,
): { batches: ManifestEntry[][]; oversized: ManifestEntry[] } {
  const batches: ManifestEntry[][] = [];
  const oversized: ManifestEntry[] = [];
  let current: ManifestEntry[] = [];
  let bytes = 0;
  for (const e of entries) {
    if (e.size > maxBytes) {
      oversized.push(e);
      continue;
    }
    if (bytes + e.size > maxBytes && current.length > 0) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(e);
    bytes += e.size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return { batches, oversized };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ferry-cli/src/resolve.ts ferry-cli/src/transfer.ts ferry-cli/tests/binpack.test.ts
git commit -m "feat: resolve seam and order-preserving batch bin-packing"
```

---

### Task 14: Parallel resumable file transfer

**Files:**
- Modify: `ferry-cli/src/transfer.ts` (add extraction + fetching)
- Create: `ferry-cli/tests/helpers/mockPlugin.ts`
- Test: `ferry-cli/tests/transfer.test.ts`

**Interfaces:**
- Consumes: `FerryClient.postStream` (Task 11), `binPack` (Task 13), plugin `/files` contract (Task 9: tar.gz with trailing `.ferry-meta.json`; range mode for oversized).
- Produces:
  - `interface BatchMeta { complete: boolean; next_index: number; skipped: string[] }`
  - `extractBatch(buffer: Buffer, destDir: string): Promise<BatchMeta>` — reads the meta entry in-stream, extracts everything else; never writes `.ferry-meta.json` to disk (no cross-batch races).
  - `fetchAll(client: FerryClient, entries: ManifestEntry[], destDir: string, opts?: { maxBytes?: number; concurrency?: number }): Promise<{ skipped: string[] }>` — 4 parallel batches by default; re-requests the unsent remainder when a batch comes back partial; oversized files assembled from 4MB ranges.
  - Test helper: `startMockPlugin(fixtureDir: string, opts?: { partialFirstBatch?: boolean }): Promise<{ base: string; close(): void }>` — reused by Tasks 15 and 18.

- [ ] **Step 1: Create `ferry-cli/tests/helpers/mockPlugin.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';

export interface MockPlugin {
  base: string;
  close(): void;
}

/**
 * In-memory stand-in for the plugin's REST surface, serving files from a
 * fixture directory. Ignores signatures (client auth is covered by the
 * client tests); implements the wire contract of Task 9.
 */
export async function startMockPlugin(
  fixtureDir: string,
  opts: { partialFirstBatch?: boolean } = {},
): Promise<MockPlugin> {
  let firstFilesCall = true;

  async function buildBatch(paths: string[], complete: boolean, nextIndex: number): Promise<Buffer> {
    const staging = mkdtempSync(join(tmpdir(), 'ferry-mock-'));
    for (const p of paths) {
      const dest = join(staging, p);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(fixtureDir, p), dest);
    }
    writeFileSync(
      join(staging, '.ferry-meta.json'),
      JSON.stringify({ complete, next_index: nextIndex, skipped: [] }),
    );
    const chunks: Buffer[] = [];
    const stream = tar.create({ gzip: true, cwd: staging }, [...paths, '.ferry-meta.json']);
    for await (const c of stream) {
      chunks.push(c as Buffer);
    }
    rmSync(staging, { recursive: true, force: true });
    return Buffer.concat(chunks);
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname !== '/wp-json/ferry/v1/files' || req.method !== 'POST') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const params = JSON.parse(body);
      if (params.path !== undefined) {
        // Range mode: raw bytes of one file.
        const data = readFileSync(join(fixtureDir, params.path));
        res.setHeader('content-type', 'application/octet-stream');
        res.end(data.subarray(params.offset, params.offset + params.length));
        return;
      }
      const paths: string[] = params.paths;
      res.setHeader('content-type', 'application/gzip');
      if (opts.partialFirstBatch && firstFilesCall && paths.length > 1) {
        firstFilesCall = false;
        res.end(await buildBatch(paths.slice(0, 1), false, 1));
        return;
      }
      res.end(await buildBatch(paths, true, paths.length));
    });
  });

  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { base, close: () => server.close() };
}

/** Size helper for building manifests from fixtures. */
export function sizeOf(fixtureDir: string, path: string): number {
  return statSync(join(fixtureDir, path)).size;
}
```

- [ ] **Step 2: Write the failing test `ferry-cli/tests/transfer.test.ts`**

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FerryClient } from '../src/client.js';
import { fetchAll } from '../src/transfer.js';
import { startMockPlugin, sizeOf, type MockPlugin } from './helpers/mockPlugin.js';

describe('fetchAll', () => {
  let fixture: string;
  let dest: string;
  let mock: MockPlugin;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'ferry-fixture-'));
    dest = mkdtempSync(join(tmpdir(), 'ferry-dest-'));
    mkdirSync(join(fixture, 'sub'), { recursive: true });
    writeFileSync(join(fixture, 'a.txt'), 'contents of a');
    writeFileSync(join(fixture, 'sub/b.txt'), 'contents of b, nested');
    writeFileSync(join(fixture, 'big.bin'), Buffer.alloc(300, 7));
  });

  afterEach(() => {
    mock?.close();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('fetches batches, resumes partial responses, and ranges oversized files', async () => {
    mock = await startMockPlugin(fixture, { partialFirstBatch: true });
    const client = new FerryClient(mock.base, 'irrelevant');
    const entries = [
      { path: 'a.txt', size: sizeOf(fixture, 'a.txt'), hash: null },
      { path: 'sub/b.txt', size: sizeOf(fixture, 'sub/b.txt'), hash: null },
      { path: 'big.bin', size: 300, hash: null },
    ];
    await fetchAll(client, entries, dest, { maxBytes: 100, concurrency: 2 });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('contents of a');
    expect(readFileSync(join(dest, 'sub/b.txt'), 'utf8')).toBe('contents of b, nested');
    expect(readFileSync(join(dest, 'big.bin'))).toEqual(Buffer.alloc(300, 7));
    expect(existsSync(join(dest, '.ferry-meta.json'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — `fetchAll` is not exported.

- [ ] **Step 4: Add extraction + fetching to `ferry-cli/src/transfer.ts`** (append; keep `binPack` from Task 13)

```ts
import { createWriteStream, promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import pLimit from 'p-limit';
import * as tar from 'tar';
import { FerryClient } from './client.js';

export const META_ENTRY = '.ferry-meta.json';
const RANGE_CHUNK = 4 * 1024 * 1024;

export interface BatchMeta {
  complete: boolean;
  next_index: number;
  skipped: string[];
}

/** Extracts a batch; the trailing meta entry is read in-stream, never written to disk. */
export async function extractBatch(buffer: Buffer, destDir: string): Promise<BatchMeta> {
  let metaRaw = '';
  const parser = tar.t({
    onReadEntry: (entry) => {
      if (entry.path === META_ENTRY) {
        entry.on('data', (c: Buffer) => (metaRaw += c.toString('utf8')));
      } else {
        entry.resume();
      }
    },
  });
  await pipeline(Readable.from(buffer), createGunzip(), parser as unknown as NodeJS.WritableStream);
  await pipeline(
    Readable.from(buffer),
    createGunzip(),
    tar.x({ cwd: destDir, filter: (p) => p !== META_ENTRY }),
  );
  if (metaRaw === '') {
    throw new Error('file batch response is missing its .ferry-meta.json trailer');
  }
  return JSON.parse(metaRaw) as BatchMeta;
}

async function fetchBatch(client: FerryClient, paths: string[], destDir: string): Promise<string[]> {
  let remaining = paths;
  const skipped: string[] = [];
  while (remaining.length > 0) {
    const { stream } = await client.postStream('/ferry/v1/files', { paths: remaining });
    const chunks: Buffer[] = [];
    for await (const c of stream) {
      chunks.push(c as Buffer);
    }
    const meta = await extractBatch(Buffer.concat(chunks), destDir);
    skipped.push(...meta.skipped);
    if (meta.complete) {
      break;
    }
    if (meta.next_index <= 0) {
      throw new Error('server made no progress on a file batch - aborting to avoid an infinite loop');
    }
    remaining = remaining.slice(meta.next_index);
  }
  return skipped;
}

/** §3.4: files larger than one batch come in raw 4MB ranges. */
async function fetchOversized(client: FerryClient, entry: { path: string; size: number }, destDir: string): Promise<void> {
  const dest = join(destDir, entry.path);
  await fsp.mkdir(dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  for (let offset = 0; offset < entry.size; offset += RANGE_CHUNK) {
    const { stream } = await client.postStream('/ferry/v1/files', {
      path: entry.path,
      offset,
      length: Math.min(RANGE_CHUNK, entry.size - offset),
    });
    for await (const chunk of stream) {
      if (!out.write(chunk)) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
}

export async function fetchAll(
  client: FerryClient,
  entries: import('./client.js').ManifestEntry[],
  destDir: string,
  opts: { maxBytes?: number; concurrency?: number } = {},
): Promise<{ skipped: string[] }> {
  const { batches, oversized } = binPack(entries, opts.maxBytes ?? DEFAULT_BATCH_BYTES);
  const limit = pLimit(opts.concurrency ?? 4); // §3.4: more collides with per-account PHP process caps
  const skippedLists = await Promise.all(
    batches.map((b) => limit(() => fetchBatch(client, b.map((e) => e.path), destDir))),
  );
  await Promise.all(oversized.map((e) => limit(() => fetchOversized(client, e, destDir))));
  return { skipped: skippedLists.flat() };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ferry-cli/src/transfer.ts ferry-cli/tests/transfer.test.ts ferry-cli/tests/helpers/mockPlugin.ts
git commit -m "feat: parallel resumable file transfer with in-band batch metadata"
```

---

### Task 15: Database pull

**Files:**
- Create: `ferry-cli/src/db.ts`
- Modify: `ferry-cli/tests/helpers/mockPlugin.ts` (add db endpoints)
- Test: `ferry-cli/tests/db.test.ts`

**Interfaces:**
- Consumes: `FerryClient.getJson`/`getBuffer` (Task 11), plugin `/db/tables` + `/db` contract (Tasks 8/9).
- Produces: `pullDatabase(client: FerryClient, dumpDir: string): Promise<string>` — per-table `.sql` files plus a combined `dump.sql` prefixed with `SET NAMES utf8mb4;` and `SET FOREIGN_KEY_CHECKS=0;`; returns the combined path. Passes `before=<maxpk>` for keyset tables (snapshot bound) and loops `after=<X-Last-Key>` until `X-Complete: 1`, with a no-progress guard.
- Test helper: `mockPlugin.ts` gains a `dbFixture` option: `{ tables: [{ name, rows, bytes, pk, maxpk, batches: [{ sql, lastKey, complete }] }] }`, serving `/db/tables` and `/db` (gzipped, with headers).

- [ ] **Step 1: Extend `ferry-cli/tests/helpers/mockPlugin.ts`**

Add to the options interface and handler. Insert into `startMockPlugin`'s signature:

```ts
export interface DbBatchFixture { sql: string; lastKey: number; complete: boolean; }
export interface DbTableFixture {
  name: string; rows: number; bytes: number;
  pk: string | null; maxpk: number | null;
  batches: DbBatchFixture[];
}
```

and extend `opts`:

```ts
opts: { partialFirstBatch?: boolean; dbTables?: DbTableFixture[] } = {},
```

Inside the request handler, before the `/files` check, add:

```ts
    if (url.pathname === '/wp-json/ferry/v1/db/tables' && req.method === 'GET') {
      const tables = (opts.dbTables ?? []).map(({ batches, ...t }) => t);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tables }));
      return;
    }
    if (url.pathname === '/wp-json/ferry/v1/db' && req.method === 'GET') {
      const table = (opts.dbTables ?? []).find((t) => t.name === url.searchParams.get('table'));
      if (!table) {
        res.statusCode = 404;
        res.end('{"code":"ferry_unknown_table"}');
        return;
      }
      if (table.pk !== null && url.searchParams.get('before') !== String(table.maxpk)) {
        res.statusCode = 500;
        res.end('missing or wrong before= snapshot bound');
        return;
      }
      const after = Number(url.searchParams.get('after'));
      const batch = table.batches.find((b, i) => (i === 0 ? after === 0 : after === table.batches[i - 1].lastKey));
      if (!batch) {
        res.statusCode = 500;
        res.end(`no scripted batch for after=${after}`);
        return;
      }
      res.setHeader('content-type', 'application/gzip');
      res.setHeader('X-Complete', batch.complete ? '1' : '0');
      res.setHeader('X-Last-Key', String(batch.lastKey));
      res.end(gzipSync(Buffer.from(batch.sql)));
      return;
    }
```

Add the import at the top of the helper: `import { gzipSync } from 'node:zlib';`

- [ ] **Step 2: Write the failing test `ferry-cli/tests/db.test.ts`**

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FerryClient } from '../src/client.js';
import { pullDatabase } from '../src/db.js';
import { startMockPlugin, type MockPlugin } from './helpers/mockPlugin.js';

describe('pullDatabase', () => {
  let dumpDir: string;
  let fixture: string;
  let mock: MockPlugin;

  beforeEach(() => {
    dumpDir = mkdtempSync(join(tmpdir(), 'ferry-dump-'));
    fixture = mkdtempSync(join(tmpdir(), 'ferry-nofiles-'));
  });

  afterEach(() => {
    mock?.close();
    rmSync(dumpDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('pulls all tables with resume and snapshot bounds, then combines', async () => {
    mock = await startMockPlugin(fixture, {
      dbTables: [
        {
          name: 'wp_posts', rows: 3, bytes: 1000, pk: 'ID', maxpk: 3,
          batches: [
            { sql: 'INSERT INTO `wp_posts` VALUES (1),(2);\n', lastKey: 2, complete: false },
            { sql: 'INSERT INTO `wp_posts` VALUES (3);\n', lastKey: 3, complete: true },
          ],
        },
        {
          name: 'wp_nopk', rows: 1, bytes: 100, pk: null, maxpk: null,
          batches: [{ sql: 'INSERT INTO `wp_nopk` VALUES (0x61);\n', lastKey: 1, complete: true }],
        },
      ],
    });
    const client = new FerryClient(mock.base, 'irrelevant');
    const combined = await pullDatabase(client, dumpDir);
    expect(readFileSync(join(dumpDir, 'wp_posts.sql'), 'utf8'))
      .toBe('INSERT INTO `wp_posts` VALUES (1),(2);\nINSERT INTO `wp_posts` VALUES (3);\n');
    const dump = readFileSync(combined, 'utf8');
    expect(dump.startsWith('SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n')).toBe(true);
    expect(dump).toContain('wp_posts');
    expect(dump).toContain('wp_nopk');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/db.js`.

- [ ] **Step 4: Implement `ferry-cli/src/db.ts`**

```ts
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FerryClient } from './client.js';

export interface TableInfo {
  name: string;
  rows: number;
  bytes: number;
  pk: string | null;
  maxpk: number | null;
}

export async function pullDatabase(client: FerryClient, dumpDir: string): Promise<string> {
  await fsp.mkdir(dumpDir, { recursive: true });
  const { data } = await client.getJson('/ferry/v1/db/tables');
  const tables = data.tables as TableInfo[];
  const parts: string[] = [];
  for (const table of tables) {
    const file = join(dumpDir, `${table.name}.sql`);
    await fsp.writeFile(file, '');
    let after = 0;
    for (;;) {
      const query: Record<string, string> = { table: table.name, after: String(after) };
      if (table.maxpk !== null) {
        query.before = String(table.maxpk); // §3.5: snapshot bound fixed at export start
      }
      const { buffer, headers } = await client.getBuffer('/ferry/v1/db', query);
      await fsp.appendFile(file, gunzipSync(buffer));
      if (headers['x-complete'] === '1') {
        break;
      }
      const last = Number(headers['x-last-key']);
      if (!Number.isFinite(last) || last <= after) {
        throw new Error(`database export of ${table.name} made no progress - aborting`);
      }
      after = last;
    }
    parts.push(file);
  }
  const combined = join(dumpDir, 'dump.sql');
  await fsp.writeFile(combined, 'SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n');
  for (const part of parts) {
    await fsp.appendFile(combined, await fsp.readFile(part));
  }
  return combined;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ferry-cli/src/db.ts ferry-cli/tests/db.test.ts ferry-cli/tests/helpers/mockPlugin.ts
git commit -m "feat: resumable keyset database pull with snapshot bounds"
```

---

### Task 16: DDEV environment adapter

**Files:**
- Create: `ferry-cli/src/env/ddev.ts`
- Test: `ferry-cli/tests/ddev.test.ts`

**Interfaces:**
- Consumes: `SiteInfo` (Task 10).
- Produces (the §4.3 `env` seam — Task 18 injects a fake for orchestration tests):
  - `majorMinor(version: string): string`
  - `ddevConfig(info: SiteInfo, name: string): string` — pure YAML generation (parity: `php_version`, `database.type/version`, `webserver_type`; `disable_settings_management: true` because ferry generates wp-config itself).
  - `interface CloneEnv { provision(clonePath: string, info: SiteInfo, name: string): Promise<void>; importDb(clonePath: string, dumpFile: string): Promise<void>; createAdmin(clonePath: string): Promise<{ user: string; password: string }>; url(name: string): string }`
  - `class DdevEnv implements CloneEnv` — shells out to `ddev` (`start -y`, `import-db --file=…`, `wp user create ferry-admin … --user_pass=…`); `url(name)` = `https://<name>.ddev.site`.

- [ ] **Step 1: Write the failing test `ferry-cli/tests/ddev.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { ddevConfig, majorMinor } from '../src/env/ddev.js';
import type { SiteInfo } from '../src/profile.js';

const info = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.5',
  php: { version: '8.2.15', extensions: ['gd'], ini: { memory_limit: '256M' } },
  db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: 'utf8mb4_unicode_520_ci', bytes: 52428800 },
  server: 'nginx',
  constants: {},
  multisite: false,
  prefix: 'wp_',
  abspath: '/home/u/public_html/',
  siteurl: 'https://wasgeurtje.nl',
  ...over,
});

describe('majorMinor', () => {
  it('truncates to major.minor', () => {
    expect(majorMinor('8.2.15')).toBe('8.2');
    expect(majorMinor('10.6.16')).toBe('10.6');
  });
});

describe('ddevConfig', () => {
  it('renders production parity into ddev yaml', () => {
    const yaml = ddevConfig(info(), 'wasgeurtje-nl');
    expect(yaml).toContain('name: wasgeurtje-nl');
    expect(yaml).toContain('type: wordpress');
    expect(yaml).toContain('php_version: "8.2"');
    expect(yaml).toContain('webserver_type: nginx-fpm');
    expect(yaml).toContain('type: mariadb');
    expect(yaml).toContain('version: "10.6"');
    expect(yaml).toContain('disable_settings_management: true');
  });

  it('maps apache to apache-fpm', () => {
    expect(ddevConfig(info({ server: 'apache' }), 'x')).toContain('webserver_type: apache-fpm');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/env/ddev.js`.

- [ ] **Step 3: Implement `ferry-cli/src/env/ddev.ts`**

```ts
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SiteInfo } from '../profile.js';

const run = promisify(execFile);

export function majorMinor(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : version;
}

/** §2.5: parity is the core of usability - PHP, DB flavor+version, webserver. */
export function ddevConfig(info: SiteInfo, name: string): string {
  return [
    `name: ${name}`,
    'type: wordpress',
    'docroot: ""',
    `php_version: "${majorMinor(info.php.version)}"`,
    `webserver_type: ${info.server === 'apache' ? 'apache-fpm' : 'nginx-fpm'}`,
    'database:',
    `  type: ${info.db.server}`,
    `  version: "${majorMinor(info.db.version)}"`,
    'disable_settings_management: true', // ferry generates wp-config itself (§4.4)
    '',
  ].join('\n');
}

export interface CloneEnv {
  provision(clonePath: string, info: SiteInfo, name: string): Promise<void>;
  importDb(clonePath: string, dumpFile: string): Promise<void>;
  createAdmin(clonePath: string): Promise<{ user: string; password: string }>;
  url(name: string): string;
}

export class DdevEnv implements CloneEnv {
  async provision(clonePath: string, info: SiteInfo, name: string): Promise<void> {
    await fsp.mkdir(join(clonePath, '.ddev'), { recursive: true });
    await fsp.writeFile(join(clonePath, '.ddev', 'config.yaml'), ddevConfig(info, name));
    await run('ddev', ['start', '-y'], { cwd: clonePath });
  }

  async importDb(clonePath: string, dumpFile: string): Promise<void> {
    await run('ddev', ['import-db', `--file=${dumpFile}`], { cwd: clonePath });
  }

  /** §4.6: a working admin requires a local user - customer passwords never come along. */
  async createAdmin(clonePath: string): Promise<{ user: string; password: string }> {
    const password = randomBytes(9).toString('base64url');
    await run(
      'ddev',
      ['wp', 'user', 'create', 'ferry-admin', 'ferry-admin@ferry.local',
        '--role=administrator', `--user_pass=${password}`],
      { cwd: clonePath },
    );
    return { user: 'ferry-admin', password };
  }

  url(name: string): string {
    return `https://${name}.ddev.site`;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/env/ddev.ts ferry-cli/tests/ddev.test.ts
git commit -m "feat: ddev environment adapter with production parity config"
```

---

### Task 17: Overlay — wp-config, harness mu-plugin, uploads fallback, drop-ins

**Files:**
- Create: `ferry-cli/src/overlay.ts`
- Test: `ferry-cli/tests/overlay.test.ts`

**Interfaces:**
- Consumes: `SiteInfo` (Task 10).
- Produces (used by pull, Task 18 — note the two-phase split):
  - `phpScalar(v: unknown): string | null`
  - `generateWpConfig(info: SiteInfo, localUrl: string): string` — DDEV credentials (`db`/`db`/`db`@`db`), production prefix, carried constants (skips DB/path/URL constants and absolute-path string values), forced `WP_CACHE false` + `DISABLE_WP_CRON true`, `FERRY_LOCAL_URL`, fresh local salts.
  - `generateMuPlugin(): string` — runtime siteurl/home mapping + harness (PHP 7.0-safe syntax: it runs on the *clone's production PHP version*).
  - `generateNginxFallback(prodOrigin: string): string` / `generateHtaccessFallback(prodOrigin: string): string` — uploads 302 fallback per webserver flavor.
  - `applyOverlay(docroot: string, info: SiteInfo, localUrl: string): Promise<void>` — **pre-provision phase**: writes wp-config, mu-plugin, `.ddev/nginx/ferry-uploads.conf` (so `ddev start` picks it up).
  - `neutralizeDropIns(docroot: string): string[]` and `finalizeClone(docroot: string, info: SiteInfo): Promise<string[]>` — **post-transfer phase**: drop-in renames + (apache only) prepend the `.htaccess` fallback block to the *pulled* `.htaccess`; both idempotent. Returns renamed drop-ins.

- [ ] **Step 1: Write the failing test `ferry-cli/tests/overlay.test.ts`**

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyOverlay, finalizeClone, generateMuPlugin, generateNginxFallback,
  generateWpConfig, neutralizeDropIns, phpScalar,
} from '../src/overlay.js';
import type { SiteInfo } from '../src/profile.js';

const info = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.5',
  php: { version: '8.2.15', extensions: [], ini: {} },
  db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: '', bytes: 0 },
  server: 'nginx',
  constants: {
    WP_DEBUG: true,
    WP_ENVIRONMENT_TYPE: 'production',
    WP_MEMORY_LIMIT: '256M',
    WP_CONTENT_DIR: '/home/u/public_html/wp-content',  // path constant: must not carry
    SOME_PLUGIN_PATH: '/home/u/private/keys',           // absolute path value: must not carry
    WP_CACHE: true,                                     // forced false locally
  },
  multisite: false,
  prefix: 'wpx_',
  abspath: '/home/u/public_html/',
  siteurl: 'https://wasgeurtje.nl',
  ...over,
});

describe('phpScalar', () => {
  it('encodes scalars as php literals', () => {
    expect(phpScalar(true)).toBe('true');
    expect(phpScalar(42)).toBe('42');
    expect(phpScalar(null)).toBe('null');
    expect(phpScalar("it's")).toBe("'it\\'s'");
    expect(phpScalar({})).toBeNull();
  });
});

describe('generateWpConfig', () => {
  const config = generateWpConfig(info(), 'https://wasgeurtje-nl.ddev.site');

  it('uses ddev credentials and the production prefix', () => {
    expect(config).toContain("define('DB_NAME', 'db');");
    expect(config).toContain("define('DB_HOST', 'db');");
    expect(config).toContain("$table_prefix = 'wpx_';");
  });

  it('carries production constants but skips path-like and overridden ones', () => {
    expect(config).toContain("define('WP_DEBUG', true);");
    expect(config).toContain("define('WP_ENVIRONMENT_TYPE', 'production');");
    expect(config).toContain("define('WP_MEMORY_LIMIT', '256M');");
    expect(config).not.toContain('WP_CONTENT_DIR');
    expect(config).not.toContain('SOME_PLUGIN_PATH');
    expect(config).toContain("define('WP_CACHE', false);");
    expect(config).toContain("define('DISABLE_WP_CRON', true);");
    expect(config).toContain("define('FERRY_LOCAL_URL', 'https://wasgeurtje-nl.ddev.site');");
  });

  it('generates all eight local salts and boots wp', () => {
    for (const key of ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
      'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']) {
      expect(config).toContain(`define('${key}',`);
    }
    expect(config).toContain("require_once ABSPATH . 'wp-settings.php';");
  });
});

describe('generateMuPlugin', () => {
  it('maps urls at runtime and seals the harness', () => {
    const mu = generateMuPlugin();
    expect(mu).toContain("add_filter('pre_option_siteurl'");
    expect(mu).toContain("add_filter('pre_option_home'");
    expect(mu).toContain("add_filter('pre_wp_mail', '__return_false')");
    expect(mu).toContain("add_filter('pre_http_request'");
    expect(mu).not.toContain('fn ('); // must stay old-PHP-safe: runs on production's PHP version
    expect(mu).not.toContain('fn(');
  });
});

describe('generateNginxFallback', () => {
  it('302s missing uploads to production', () => {
    const conf = generateNginxFallback('https://wasgeurtje.nl');
    expect(conf).toContain('location ~ ^/wp-content/uploads/');
    expect(conf).toContain('return 302 https://wasgeurtje.nl/wp-content/uploads/$ferrypath;');
  });
});

describe('filesystem phases', () => {
  let docroot: string;

  beforeEach(() => {
    docroot = mkdtempSync(join(tmpdir(), 'ferry-docroot-'));
    mkdirSync(join(docroot, 'wp-content'), { recursive: true });
  });

  afterEach(() => rmSync(docroot, { recursive: true, force: true }));

  it('applyOverlay writes config, mu-plugin, and nginx snippet before provision', async () => {
    await applyOverlay(docroot, info(), 'https://x.ddev.site');
    expect(existsSync(join(docroot, 'wp-config.php'))).toBe(true);
    expect(existsSync(join(docroot, 'wp-content/mu-plugins/ferry-overlay.php'))).toBe(true);
    expect(existsSync(join(docroot, '.ddev/nginx/ferry-uploads.conf'))).toBe(true);
  });

  it('neutralizeDropIns renames known drop-ins idempotently', () => {
    writeFileSync(join(docroot, 'wp-content/object-cache.php'), '<?php // redis');
    writeFileSync(join(docroot, 'wp-content/advanced-cache.php'), '<?php // rocket');
    const renamed = neutralizeDropIns(docroot);
    expect(renamed.sort()).toEqual(['advanced-cache.php', 'object-cache.php']);
    expect(existsSync(join(docroot, 'wp-content/object-cache.php'))).toBe(false);
    expect(existsSync(join(docroot, 'wp-content/object-cache.php.ferry-disabled'))).toBe(true);
    expect(neutralizeDropIns(docroot)).toEqual([]); // second run: nothing left to do
  });

  it('finalizeClone prepends the htaccess fallback on apache and preserves pulled rules', async () => {
    writeFileSync(join(docroot, '.htaccess'), '# BEGIN WordPress\n');
    await finalizeClone(docroot, info({ server: 'apache' }));
    const htaccess = readFileSync(join(docroot, '.htaccess'), 'utf8');
    expect(htaccess).toContain('# BEGIN ferry-uploads-fallback');
    expect(htaccess.indexOf('ferry-uploads-fallback')).toBeLessThan(htaccess.indexOf('BEGIN WordPress'));
    await finalizeClone(docroot, info({ server: 'apache' })); // idempotent
    const again = readFileSync(join(docroot, '.htaccess'), 'utf8');
    expect(again.match(/# BEGIN ferry-uploads-fallback/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/overlay.js`.

- [ ] **Step 3: Implement `ferry-cli/src/overlay.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { SiteInfo } from './profile.js';

// Constants that must not carry over: DB credentials are DDEV's, cache/cron
// are forced off by the harness, and path/URL constants point into production.
const SKIP_CONSTANTS = new Set([
  'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST', 'DB_CHARSET', 'DB_COLLATE',
  'WP_CACHE', 'DISABLE_WP_CRON', 'ABSPATH', 'FERRY_LOCAL_URL',
  'WP_HOME', 'WP_SITEURL', 'WP_CONTENT_DIR', 'WP_CONTENT_URL',
  'WP_PLUGIN_DIR', 'WP_PLUGIN_URL', 'WPMU_PLUGIN_DIR', 'WP_TEMP_DIR',
]);

const SALT_KEYS = [
  'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
  'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
];

const DROP_INS = ['object-cache.php', 'advanced-cache.php', 'db.php', 'sunrise.php'];

export function phpScalar(v: unknown): string | null {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return null;
}

/** §2.5 + §4.4: wp-config is regenerated locally; production's never crosses the bridge. */
export function generateWpConfig(info: SiteInfo, localUrl: string): string {
  const lines = [
    '<?php',
    '/* Generated by ferry - local clone configuration. Local artifact, never pushed. */',
    "define('DB_NAME', 'db');",
    "define('DB_USER', 'db');",
    "define('DB_PASSWORD', 'db');",
    "define('DB_HOST', 'db');",
    "define('DB_CHARSET', 'utf8mb4');",
    "define('DB_COLLATE', '');",
    '',
    `$table_prefix = ${phpScalar(info.prefix)};`,
    '',
    '/* Production wp-config constants, carried for parity (base doc §2.5). */',
  ];
  for (const [name, value] of Object.entries(info.constants ?? {})) {
    if (SKIP_CONSTANTS.has(name)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (typeof value === 'string' && value.startsWith('/')) continue; // production filesystem path
    const scalar = phpScalar(value);
    if (scalar === null) continue;
    lines.push(`define('${name}', ${scalar});`);
  }
  lines.push(
    '',
    '/* Ferry local overrides. */',
    "define('WP_CACHE', false);",
    "define('DISABLE_WP_CRON', true);",
    `define('FERRY_LOCAL_URL', ${phpScalar(localUrl)});`,
    '',
  );
  for (const key of SALT_KEYS) {
    lines.push(`define('${key}', ${phpScalar(randomBytes(32).toString('base64'))});`);
  }
  lines.push(
    '',
    "if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }",
    "require_once ABSPATH . 'wp-settings.php';",
    '',
  );
  return lines.join('\n');
}

/**
 * §2.6 runtime URL mapping + §2.7 containment harness. Classic closures only:
 * this file runs on the clone's PHP, which mirrors production (can be 7.0-era).
 */
export function generateMuPlugin(): string {
  return `<?php
/* Ferry local overlay - generated. Runtime URL mapping + containment harness. */
add_filter('pre_option_siteurl', function () { return FERRY_LOCAL_URL; });
add_filter('pre_option_home', function () { return FERRY_LOCAL_URL; });
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function ($pre, $args, $url) {
    error_log('[ferry-harness] blocked outbound HTTP: ' . $url);
    return new WP_Error('ferry_blocked', 'ferry harness: outbound HTTP is blocked in the clone (' . $url . ')');
}, 1, 3);
`;
}

/** §2.8: solve uploads on the HTTP level - local if present, 302 to production if not. */
export function generateNginxFallback(prodOrigin: string): string {
  return `location ~ ^/wp-content/uploads/(?<ferrypath>.*)$ {
    try_files $uri @ferry_origin;
}
location @ferry_origin {
    return 302 ${prodOrigin}/wp-content/uploads/$ferrypath;
}
`;
}

export function generateHtaccessFallback(prodOrigin: string): string {
  return `# BEGIN ferry-uploads-fallback
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^wp-content/uploads/(.*)$ ${prodOrigin}/wp-content/uploads/$1 [R=302,L]
</IfModule>
# END ferry-uploads-fallback
`;
}

/** Phase 1 (before ddev start): config files DDEV must see at boot. */
export async function applyOverlay(docroot: string, info: SiteInfo, localUrl: string): Promise<void> {
  await fsp.writeFile(join(docroot, 'wp-config.php'), generateWpConfig(info, localUrl));
  await fsp.mkdir(join(docroot, 'wp-content', 'mu-plugins'), { recursive: true });
  await fsp.writeFile(join(docroot, 'wp-content', 'mu-plugins', 'ferry-overlay.php'), generateMuPlugin());
  await fsp.mkdir(join(docroot, '.ddev', 'nginx'), { recursive: true });
  await fsp.writeFile(
    join(docroot, '.ddev', 'nginx', 'ferry-uploads.conf'),
    generateNginxFallback(new URL(info.siteurl).origin),
  );
}

/** §2.6: drop-ins fatal locally (no Redis, wrong paths) - the classic white-screen cause. */
export function neutralizeDropIns(docroot: string): string[] {
  const renamed: string[] = [];
  for (const dropIn of DROP_INS) {
    const path = join(docroot, 'wp-content', dropIn);
    const disabled = `${path}.ferry-disabled`;
    if (existsSync(path) && !existsSync(disabled)) {
      renameSync(path, disabled);
      renamed.push(dropIn);
    }
  }
  return renamed;
}

/** Phase 2 (after file transfer): work on files that arrive with the pull. */
export async function finalizeClone(docroot: string, info: SiteInfo): Promise<string[]> {
  const renamed = neutralizeDropIns(docroot);
  if (info.server === 'apache') {
    const htaccessPath = join(docroot, '.htaccess');
    const existing = existsSync(htaccessPath) ? await fsp.readFile(htaccessPath, 'utf8') : '';
    if (!existing.includes('# BEGIN ferry-uploads-fallback')) {
      await fsp.writeFile(
        htaccessPath,
        generateHtaccessFallback(new URL(info.siteurl).origin) + existing,
      );
    }
  }
  return renamed;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/overlay.ts ferry-cli/tests/overlay.test.ts
git commit -m "feat: clone overlay - wp-config, harness mu-plugin, uploads fallback, drop-ins"
```

---

### Task 18: Pull orchestration + CLI entry

**Files:**
- Create: `ferry-cli/src/pull.ts`
- Modify: `ferry-cli/src/main.ts` (replace placeholder)
- Modify: `ferry-cli/tests/helpers/mockPlugin.ts` (add info + manifest endpoints)
- Test: `ferry-cli/tests/pull.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 10–17.
- Produces:
  - `pull(slug: string, deps?: { env?: CloneEnv }): Promise<{ url: string; adminUser: string; adminPassword: string; skipped: string[] }>` — the §4.6 flow: info → multisite refusal → overlay (phase 1) → `env.provision` **started, not awaited** (DDEV boot hides behind the transport) → resumable manifest → `fetchAll` → `finalizeClone` → `pullDatabase` → `await` provision → `importDb` → `createAdmin`.
  - `ferry link <url> --code=<code> [--dir <path>]` and `ferry pull <site>` commands with English output.
- Mock helper gains: `info?: Partial<SiteInfo>` option serving `GET /wp-json/ferry/v1/info`, and a manifest endpoint that lists the fixture dir in two resumable batches.

- [ ] **Step 1: Extend `ferry-cli/tests/helpers/mockPlugin.ts`**

Extend opts: `{ partialFirstBatch?: boolean; dbTables?: DbTableFixture[]; info?: object; manifest?: { path: string; size: number; hash: null }[] }`.

Inside the handler, before the `/files` check, add:

```ts
    if (url.pathname === '/wp-json/ferry/v1/info' && req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(opts.info ?? {}));
      return;
    }
    if (url.pathname === '/wp-json/ferry/v1/manifest' && req.method === 'GET') {
      const manifest = opts.manifest ?? [];
      const after = Number(url.searchParams.get('after') ?? '0');
      const batchSize = Math.max(1, Math.ceil(manifest.length / 2)); // force one resume round-trip
      const files = manifest.slice(after, after + batchSize);
      const next = after + files.length;
      res.setHeader('content-type', 'application/json');
      res.setHeader('X-Complete', next >= manifest.length ? '1' : '0');
      res.setHeader('X-Next-Index', String(next));
      res.end(JSON.stringify({ files }));
      return;
    }
```

- [ ] **Step 2: Write the failing test `ferry-cli/tests/pull.test.ts`**

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloneEnv } from '../src/env/ddev.js';
import { saveProfile, type SiteInfo } from '../src/profile.js';
import { pull } from '../src/pull.js';
import { startMockPlugin, sizeOf, type MockPlugin } from './helpers/mockPlugin.js';

class FakeEnv implements CloneEnv {
  calls: string[] = [];
  wpConfigPresentAtImport = false;
  async provision(): Promise<void> {
    this.calls.push('provision');
  }
  async importDb(clonePath: string): Promise<void> {
    this.calls.push('importDb');
    this.wpConfigPresentAtImport = existsSync(join(clonePath, 'wp-config.php'));
  }
  async createAdmin(): Promise<{ user: string; password: string }> {
    this.calls.push('createAdmin');
    return { user: 'ferry-admin', password: 'pw123' };
  }
  url(name: string): string {
    return `https://${name}.ddev.site`;
  }
}

const siteInfo = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.5',
  php: { version: '8.2.15', extensions: [], ini: {} },
  db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: '', bytes: 1000 },
  server: 'nginx',
  constants: { WP_DEBUG: false },
  multisite: false,
  prefix: 'wp_',
  abspath: '/var/www/html/',
  siteurl: 'https://fixture.example',
  ...over,
});

describe('pull', () => {
  let home: string;
  let fixture: string;
  let clonePath: string;
  let mock: MockPlugin;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    fixture = mkdtempSync(join(tmpdir(), 'ferry-site-'));
    clonePath = join(home, 'clone');
    mkdirSync(join(fixture, 'wp-content'), { recursive: true });
    writeFileSync(join(fixture, 'index.php'), '<?php // wp');
    writeFileSync(join(fixture, 'wp-load.php'), '<?php // load');
    writeFileSync(join(fixture, 'wp-content/object-cache.php'), '<?php // redis');
  });

  afterEach(() => {
    mock?.close();
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  function pair(base: string): void {
    saveProfile({ url: base, secret: 's', slug: 'fixture', clonePath });
  }

  it('runs the full §4.6 flow', async () => {
    const manifest = ['index.php', 'wp-load.php', 'wp-content/object-cache.php']
      .map((p) => ({ path: p, size: sizeOf(fixture, p), hash: null }));
    mock = await startMockPlugin(fixture, {
      info: siteInfo(),
      manifest,
      dbTables: [{
        name: 'wp_options', rows: 1, bytes: 10, pk: 'option_id', maxpk: 1,
        batches: [{ sql: 'INSERT INTO `wp_options` VALUES (1);\n', lastKey: 1, complete: true }],
      }],
    });
    pair(mock.base);
    const env = new FakeEnv();
    const result = await pull('fixture', { env });

    expect(result.url).toBe('https://fixture.ddev.site');
    expect(result.adminPassword).toBe('pw123');
    expect(env.calls).toEqual(['provision', 'importDb', 'createAdmin']);
    expect(env.wpConfigPresentAtImport).toBe(true);
    expect(readFileSync(join(clonePath, 'index.php'), 'utf8')).toBe('<?php // wp');
    expect(existsSync(join(clonePath, 'wp-content/object-cache.php.ferry-disabled'))).toBe(true);
    expect(existsSync(join(clonePath, 'wp-content/mu-plugins/ferry-overlay.php'))).toBe(true);
    const dump = readFileSync(join(home, 'sites/fixture/db-dump/dump.sql'), 'utf8');
    expect(dump).toContain('wp_options');
    const profile = JSON.parse(readFileSync(join(home, 'sites/fixture/profile.json'), 'utf8'));
    expect(profile.info.wp).toBe('6.5');
  });

  it('refuses multisite before transferring anything', async () => {
    mock = await startMockPlugin(fixture, { info: siteInfo({ multisite: true }) });
    pair(mock.base);
    const env = new FakeEnv();
    await expect(pull('fixture', { env })).rejects.toThrowError(/[Mm]ultisite/);
    expect(env.calls).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ferry-cli && npm test`
Expected: FAIL — cannot find module `../src/pull.js`.

- [ ] **Step 4: Implement `ferry-cli/src/pull.ts`**

```ts
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { FerryClient, type ManifestEntry } from './client.js';
import { pullDatabase } from './db.js';
import { DdevEnv, type CloneEnv } from './env/ddev.js';
import { applyOverlay, finalizeClone } from './overlay.js';
import { ferryHome, loadProfile, saveProfile, type SiteInfo } from './profile.js';
import { resolve } from './resolve.js';
import { fetchAll } from './transfer.js';

export interface PullResult {
  url: string;
  adminUser: string;
  adminPassword: string;
  skipped: string[];
}

/** The §4.6 flow. DDEV provisioning starts early and is awaited late ("join"). */
export async function pull(slug: string, deps: { env?: CloneEnv } = {}): Promise<PullResult> {
  const env = deps.env ?? new DdevEnv();
  const profile = loadProfile(slug);
  const client = new FerryClient(profile.url, profile.secret);
  await client.syncClock();

  const { data: info } = (await client.getJson('/ferry/v1/info')) as { data: SiteInfo };
  if (info.multisite) {
    throw new Error('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.');
  }
  profile.info = info;
  saveProfile(profile);

  const docroot = profile.clonePath;
  await fsp.mkdir(docroot, { recursive: true });
  await applyOverlay(docroot, info, env.url(slug));       // phase 1: files DDEV needs at boot
  const envReady = env.provision(docroot, info, slug);    // boots while the transport runs
  envReady.catch(() => {});                               // surfaced at the await below

  const manifest = await fetchManifest(client);
  const entries = resolve(manifest);
  const { skipped } = await fetchAll(client, entries, docroot);
  await finalizeClone(docroot, info);                     // phase 2: drop-ins arrived with the pull

  const dump = await pullDatabase(client, join(ferryHome(), 'sites', slug, 'db-dump'));

  await envReady;                                         // join (§4.6)
  await env.importDb(docroot, dump);
  const admin = await env.createAdmin(docroot);
  return { url: env.url(slug), adminUser: admin.user, adminPassword: admin.password, skipped };
}

async function fetchManifest(client: FerryClient): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  let after = 0;
  for (;;) {
    const { data, headers } = await client.getJson('/ferry/v1/manifest', { after: String(after) });
    entries.push(...(data.files as ManifestEntry[]));
    if (headers['x-complete'] === '1') {
      return entries;
    }
    const next = Number(headers['x-next-index']);
    if (!Number.isFinite(next) || next <= after) {
      throw new Error('manifest made no progress - aborting');
    }
    after = next;
  }
}
```

- [ ] **Step 5: Replace `ferry-cli/src/main.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { link } from './link.js';
import { pull } from './pull.js';

const program = new Command();

program
  .name('ferry')
  .description('Give coding agents safe local access to WordPress sites - clone, debug at production parity, push back under control.');

program
  .command('link <url>')
  .description('Pair with a WordPress site running the Ferry Connect plugin')
  .requiredOption('--code <code>', 'pairing code shown by the plugin')
  .option('--dir <path>', 'directory for the local clone')
  .action(async (url: string, opts: { code: string; dir?: string }) => {
    const profile = await link(url, opts.code, opts.dir);
    console.log(`✔ Paired with ${profile.url}`);
    console.log(`  Clone directory: ${profile.clonePath}`);
    console.log(`  Next: ferry pull ${profile.slug}`);
  });

program
  .command('pull <site>')
  .description('Clone the site into a local DDEV environment at production parity')
  .action(async (site: string) => {
    const result = await pull(site);
    console.log(`✔ Clone ready: ${result.url}`);
    console.log(`  Admin: ${result.url}/wp-admin/ - ${result.adminUser} / ${result.adminPassword}`);
    console.log('  Media is not cloned - missing uploads fall back to production (302).');
    if (result.skipped.length > 0) {
      console.log(`  Skipped ${result.skipped.length} unreadable file(s): ${result.skipped.slice(0, 5).join(', ')}${result.skipped.length > 5 ? ', ...' : ''}`);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 6: Run the full CLI suite + typecheck + build**

Run: `cd ferry-cli && npm test && npm run build`
Expected: all suites PASS; `tsc` emits `dist/` without errors.

- [ ] **Step 7: Commit**

```bash
git add ferry-cli/src/pull.ts ferry-cli/src/main.ts ferry-cli/tests/pull.test.ts ferry-cli/tests/helpers/mockPlugin.ts
git commit -m "feat: pull orchestration and ferry cli entry"
```

---

### Task 19: End-to-end gate on a real site (definition of done, §4.7)

No new production code — this is the milestone gate. It runs the real plugin inside a DDEV "production" fixture and pulls it with the real CLI into a second DDEV project. Record results in the runbook file.

**Files:**
- Create: `docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md` (results log; commands below)

**Interfaces:**
- Consumes: everything.
- Produces: a checked-off definition-of-done log; any failure here becomes a bug-fix commit against the responsible task's module.

- [ ] **Step 1: Build the production fixture**

```bash
mkdir -p ~/ferry-e2e/prod && cd ~/ferry-e2e/prod
ddev config --project-type=wordpress --project-name=ferry-prod
ddev start
ddev wp core download
ddev wp core install --url=https://ferry-prod.ddev.site --title="Ferry Fixture" \
  --admin_user=admin --admin_password=admin --admin_email=admin@example.com
ddev wp rewrite structure '/%postname%/'
ddev wp post create --post_title="Hello Ferry" --post_status=publish
# an upload that will NOT be cloned (tests the 302 fallback):
curl -sL https://raw.githubusercontent.com/WordPress/WordPress/master/wp-admin/images/wordpress-logo.png -o /tmp/logo.png
ddev wp media import /tmp/logo.png
# a drop-in that would fatal locally without neutralization:
echo '<?php // fake redis drop-in' > wp-content/object-cache.php
```

Expected: `https://ferry-prod.ddev.site` serves the fixture site.

- [ ] **Step 2: Install and pair the plugin**

```bash
cp -R /Users/robbertvermeulen/Projects/ferry/ferry-plugin ~/ferry-e2e/prod/wp-content/plugins/ferry-connect
cd ~/ferry-e2e/prod && ddev wp plugin activate ferry-connect
ddev wp ferry pair
```

Expected: `Pairing code: XXXX-XXXX (expires in 10:00)`.

- [ ] **Step 3: Link and pull with the real CLI**

DDEV's TLS certificates come from mkcert; Node does not read the system trust store, so export the CA first:

```bash
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
cd /Users/robbertvermeulen/Projects/ferry/ferry-cli
npm run ferry -- link https://ferry-prod.ddev.site --code=XXXX-XXXX
time npm run ferry -- pull ferry-prod-ddev-site
```

Expected: `✔ Clone ready: https://ferry-prod-ddev-site.ddev.site` with admin credentials printed; total time within the §4.8 envelope (~60–90s for a small site: expect well under that here).

- [ ] **Step 4: Verify the definition of done (§4.7) — record each result in the runbook**

```bash
CLONE=https://ferry-prod-ddev-site.ddev.site
CLONE_DIR=~/ferry-sites/ferry-prod-ddev-site

# 1. Site opens:
curl -sI "$CLONE/" | head -1                          # expect: HTTP/2 200
# 2. Permalinks work:
curl -sI "$CLONE/hello-ferry/" | head -1              # expect: HTTP/2 200
# 3. Runtime URL mapping (DB stayed byte-identical):
cd "$CLONE_DIR" && ddev wp option get home            # expect: https://ferry-prod-ddev-site.ddev.site
# 4. Uploads 302 fallback (image visible via production):
curl -sI "$CLONE/wp-content/uploads/$(cd ~/ferry-e2e/prod && ddev wp post list --post_type=attachment --field=ID | head -1 | xargs -I{} ddev wp eval 'echo get_post_meta({}, "_wp_attached_file", true);')" | grep -E '^(HTTP|location)'
#    expect: HTTP/2 302 + location: https://ferry-prod.ddev.site/wp-content/uploads/...
# 5. No mail leaves the clone:
ddev wp eval 'var_dump(wp_mail("test@example.com","ferry","test"));'   # expect: bool(false)
# 6. No HTTP leaves the clone:
ddev wp eval 'var_dump(is_wp_error(wp_remote_get("https://example.com")));'  # expect: bool(true)
# 7. Drop-in neutralized, no fatal:
ls wp-content/object-cache.php.ferry-disabled          # expect: file exists
# 8. Admin login works with the printed local credentials:
open "$CLONE/wp-admin/"                                # log in as ferry-admin / <printed password>
# 9. wp-config.php never crossed the bridge:
grep -c "Generated by ferry" wp-config.php             # expect: 1 (ours, not production's)
# 10. PHP/DB parity:
ddev wp eval 'echo PHP_VERSION;'                       # expect: same major.minor as fixture
```

- [ ] **Step 5: Record results and commit the runbook**

Write pass/fail per check into `docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md`. Every check must pass before the milestone is done; failures become fix commits against the responsible module.

```bash
git add docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md
git commit -m "test: v0 pull skeleton end-to-end gate results"
```

---

## Post-plan notes for the executor

- **Wordfence-class security plugins** rate-limit parallel requests on unknown REST namespaces (§3.4). The client's failure message already points at allowlisting `/wp-json/ferry/v1`. Real-host validation beyond the DDEV fixture is Plan-2+ work.
- **The `.ferry-meta.json` in-band trailer** is this plan's only wire-format invention; if it proves awkward, the alternative is chunked-encoding HTTP trailers — do not silently change the contract, update Task 9 + Task 14 + this doc together.
- Do not add features beyond this plan (no git, no cache, no hashes-in-manifest): those are Plan 2 and get their own detailed plan once this gate is green.
