# Ferry v0 Pull Skeleton — E2E Gate Runbook & Results

**Date:** July 24, 2026
**Task:** Plan 1, Task 19 (definition of done, base doc §4.7)
**Result:** ✅ **10/10 checks pass** against a real DDEV-hosted WordPress site.

## Environment

- macOS (darwin 24.5.0), Docker running, DDEV v1.24.6, mkcert CA present, Node v24, PHP 8.1 (host) / 8.3 (containers)
- Node trusts the DDEV TLS cert via `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`

## Fixture (production stand-in)

A DDEV WordPress project `ferry-prod` at `~/ferry-e2e/prod`, PHP 8.3 / MariaDB 10.11:
- `wp core install` (admin/admin), permalinks `/%postname%/`, one published post "Hello Ferry"
- one media upload at `wp-content/uploads/2026/07/ferry-logo.png` (never cloned — exercises the 302 fallback)
- a fatal-prone `wp-content/object-cache.php` drop-in (must be neutralized, not fatal)
- the ferry plugin (`ferry-plugin/ferry.php` + `src/`, no vendor/tests) installed and activated; paired via `ddev wp ferry pair`

## Run

```
ferry link https://ferry-prod.ddev.site --code=<pairing code>   # real HMAC key exchange
ferry pull ferry-prod-ddev-site                                  # ~14s: signed transport + DDEV clone
```

## Definition-of-done results (§4.7)

| # | Check | Result |
|---|---|---|
| 1 | Clone site returns HTTP 200 | ✅ |
| 2 | Permalink `/hello-ferry/` returns 200 | ✅ |
| 3 | Runtime URL mapping: `wp option get home` = clone URL (DB stayed byte-identical, no search-replace) | ✅ |
| 4 | Missing upload 302-redirects to production | ✅ `302 → https://ferry-prod.ddev.site/wp-content/uploads/2026/07/ferry-logo.png` |
| 5 | No mail leaves the clone (`wp_mail` → `false`) | ✅ |
| 6 | No outbound HTTP (`wp_remote_get` → `WP_Error`) | ✅ |
| 7 | Drop-in neutralized (`object-cache.php.ferry-disabled` present, no fatal) | ✅ |
| 8 | Admin login works with the generated `ferry-admin` password (real cookie login → dashboard 200) | ✅ |
| 9 | `wp-config.php` generated locally, never crossed the bridge (DDEV creds, ferry banner) | ✅ |
| 10 | PHP parity: clone 8.3 = production 8.3 | ✅ |

## Bugs found and fixed by this gate

The unit suites were green throughout; these two defects were only reachable by a real pull, which is exactly why the gate exists.

1. **`.ddev/` pulled from a DDEV-based production host, clobbering the clone's own DDEV config.**
   The fixture is itself a DDEV project, so it has a `.ddev/` directory. The manifest walked all of ABSPATH and included it; the transfer overwrote the clone's `.ddev/config.yaml` (which `provision` had written with the clone's project name) with the fixture's `name: ferry-prod`, so `ddev import-db` failed on a project-name collision. Fix: exclude `.ddev/` in the plugin's `Excludes` (base doc §5 already lists `.ddev/` as a local artifact that must never travel). A real shared-host WordPress site has no `.ddev/`, but the exclusion is correct defense and unblocks the gate. (`ferry-plugin/src/Excludes.php`)

2. **Uploads 302 fallback 404'd because a regex nginx location out-ranked it.**
   DDEV's site config has `location ~* \.(png|jpg|...)$` that matches an uploaded image and `try_files $uri /index.php` (→ 404 for a missing file). Our snippet, included after it, used a regex location too — and nginx picks the first matching regex location, so the media handler always won. Fix: use a preferential prefix location `location ^~ /wp-content/uploads/`, which suppresses regex-location evaluation when it matches, and redirect with `$request_uri`. (`ferry-cli/src/overlay.ts` `generateNginxFallback`)

Both fixes shipped with updated unit tests (plugin 62/62, CLI 37/37 green).

## Reproduce

Rebuild the fixture and re-run from the commands above; teardown:

```
ddev stop --unlist ferry-prod-ddev-site && rm -rf ~/ferry-sites/ferry-prod-ddev-site
ddev stop --unlist ferry-prod && rm -rf ~/ferry-e2e
```
