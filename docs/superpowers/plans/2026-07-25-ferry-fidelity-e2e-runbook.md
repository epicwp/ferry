# Ferry Fidelity Slice — E2E Gate Runbook & Results (Task 9)

**Date:** July 25, 2026
**Branch:** `feat/fidelity-slice`
**Result:** ✅ **all four gates pass.** Gate 2 initially found a real product defect (WooCommerce's stock "Extensions" admin page fataled under the generic license stub); fixed in `ferry-cli/assets/ferry-stubs.php` and re-verified end-to-end below. Gates 1, 3, 4 passed clean with no code changes needed.

## Environment

- macOS (darwin 24.5.0), DDEV v1.24.6 (upgrade to v1.25.3 available, not applied), mkcert CA trusted via `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`.
- Production fixture: DDEV project `ferry-prod` at `~/ferry-e2e/prod` (nginx-fpm, PHP 8.3.21, MariaDB 10.11.11, WP 7.0.2 — the core-corruption repair from the provenance gate is still in effect). Plugin lives at `wp-content/plugins/ferry-connect/`.
- Clone: DDEV project `ferry-prod-ddev-site` at `~/ferry-sites/ferry-prod-ddev-site` (also nginx-fpm — **this gate does not exercise the apache-fpm `.htaccess` fallback routing at all; that path is a known, uncovered gap**, tracked as a to-do for a future apache-fpm fixture).
- **Deploy step (not in the brief's literal steps, but required):** the fixture's `ferry-connect` plugin was stale (pre-dated Tasks 1–8 of this slice). Redeployed with `cp ferry-plugin/ferry.php` + `rsync -a --delete ferry-plugin/src/` into `~/ferry-e2e/prod/wp-content/plugins/ferry-connect/`. The plugin has no vendor/composer autoloading in production (a hand-rolled `spl_autoload_register` in `ferry.php`), so no build step was needed. `php -l` on every deployed file: clean.
- `cd ferry-cli && npx tsc` — clean build, `dist/main.js` and `dist/fetch-uploads.js` present.

## Fixture-seeding (Step 2)

Exact commands from the brief, run in `~/ferry-e2e/prod`:

```bash
ddev wp plugin install woocommerce --activate                 # WooCommerce 10.9.4
ddev wp eval 'as_schedule_single_action(time() + 86400, "ferry_e2e_pending"); as_enqueue_async_action("ferry_e2e_done");'
ddev wp action-scheduler run
ddev wp post update 1 --post_content="ferry rev seed 1"
ddev wp post update 1 --post_content="ferry rev seed 2"
ddev wp transient set ferry_e2e_transient hello 3600
ddev wp db query "INSERT INTO wp_woocommerce_sessions (session_key, session_value, session_expiry) VALUES ('ferry_e2e', 'a:0:{}', UNIX_TIMESTAMP()+86400)"
ddev wp option update woocommerce_helper_data '{"auth":{"access_token":"ferry-e2e","access_token_secret":"x","site_id":1,"user_id":1,"updated":0}}' --format=json
cp -r e2e/fixtures/ferry-demo-licensed wp-content/plugins/
mkdir -p wp-content/mu-plugins && cp e2e/fixtures/e2e-fake-edd-store.php wp-content/mu-plugins/
ddev wp plugin activate ferry-demo-licensed
printf 'wOF2fake-font-bytes' > wp-content/uploads/2026/e2e-font.woff2
```

**Deviation:** `ddev wp action-scheduler run` errors on `ferry_e2e_done` — *"will not be executed as no callbacks are registered"* — since `as_enqueue_async_action()` schedules a hook nothing listens on. The action ends up `status=failed`, not `complete`. This still satisfies the fixture's intent (`DbExcludes::plan()`'s `as_completed` rule drops rows `WHERE status NOT IN ('complete','failed','canceled')`, so `failed` is dropped exactly like `complete` would be) — confirmed below in Gate 1.

Pre-pull verification (adjusted — see "wp-cli + WooCommerce admin_init" deviation below):

```bash
ddev wp eval "require_once WP_PLUGIN_DIR.'/woocommerce/includes/admin/wc-admin-functions.php'; do_action('admin_init');"
ddev wp option get ferry_demo_license_status   # → valid
```

Production seed state confirmed before pulling: 2 revisions on post 1, transient set, 1 `wp_woocommerce_sessions` row, `ferry_e2e_pending` pending / `ferry_e2e_done` failed.

### Deviation: vendored EDD client source repo

The brief named `easydigitaldownloads/edd-sample-plugin` as the source for `EDD_SL_Plugin_Updater.php`. That repo doesn't exist (the `easydigitaldownloads` GitHub org has no public repos at all via the API). The real, canonical vendoring source — a repo dedicated to exactly this one file, maintained by WebDevStudios (a well-known WP agency) — is `WebDevStudios/EDD_SL_Plugin_Updater`. Fetched from its default branch: genuine, unmodified `EDD_SL_Plugin_Updater` class v1.9.4, 711 lines, `php -l` clean. This satisfies the brief's actual intent ("real client code runs," "do not modify it") even though the exact repo name was wrong.

### Deviation: `wp-cli` + WooCommerce break `do_action('admin_init')`

Both `ddev wp eval "do_action('admin_init');"` calls in the brief (production pre-check and Gate 2) hit a **pre-existing WooCommerce/WP-CLI incompatibility, unrelated to Ferry**: WooCommerce's `wc-admin-functions.php` (defines `wc_get_page_screen_id()`) is only `require`d when `is_admin()` is true; WP-CLI never sets `is_admin()` true (no `WP_ADMIN` constant, no admin bootstrap), so any `admin_init` callback that touches that function — here, WooCommerce's own `OrderAttributionController` — fatals. Because WordPress fires `admin_init` callbacks in registration order, the fixture plugin's own callback (which sets `ferry_demo_license_status`) runs and persists *before* WooCommerce's callback fatals later in the same chain — so the option is set correctly even though the bare command exits 1 with a stack trace. To get a clean, evidence-worthy run, every `do_action('admin_init')` invocation in this runbook pre-loads the missing file:

```bash
ddev wp eval "require_once WP_PLUGIN_DIR.'/woocommerce/includes/admin/wc-admin-functions.php'; do_action('admin_init');"
```

This is a WP-CLI/WooCommerce environment quirk, not a Ferry defect — it doesn't affect real browser requests to `wp-admin/`, which set `is_admin()` correctly from the start (confirmed in Gate 2 below).

## Gate 1 — lite pull

```bash
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
cd ferry-cli && node dist/main.js pull ferry-prod-ddev-site
```

Observed:
```
✔ Clone ready: https://ferry-prod-ddev-site.ddev.site
  Admin: https://ferry-prod-ddev-site.ddev.site/wp-admin/ - ferry-admin / UbwUsf6yx-3V
  Lite DB pull: skipped revisions, transients, sessions, as_logs, as_completed (use --full for everything)
  Committed production snapshot d379f95 (1 nested repo(s) neutralized)
  Files: 3953 reused, 6194 reconstructed, 11 fetched
  Provenance: core and wp.org packages verified clean
```
(full commit: `d379f95335bfd72e8e288086bd8cf0e9fec2b3e8`)

In the clone (`~/ferry-sites/ferry-prod-ddev-site`):

| Check | Command | Observed |
|---|---|---|
| Revisions dropped | `wp db query "SELECT COUNT(*)… post_type='revision'"` | `0` |
| Transient dropped | `wp transient get ferry_e2e_transient` | `Transient with key "ferry_e2e_transient" is not set.` |
| WC sessions table exists, empty | `wp db query "SELECT COUNT(*) FROM wp_woocommerce_sessions"` | `0` (table present) |
| AS logs table exists, empty | `wp db query "SELECT COUNT(*) FROM wp_actionscheduler_logs"` | `0` (table present) |
| AS actions filtered | `wp db query "SELECT status, hook … LIKE 'ferry_e2e%'"` | only `pending  ferry_e2e_pending`; `ferry_e2e_done` absent |

**Gate 1: PASS**, exactly as specified.

## Gate 2 — license stubs

```bash
ddev wp eval "require_once WP_PLUGIN_DIR.'/woocommerce/includes/admin/wc-admin-functions.php'; do_action('admin_init');"
ddev wp option get ferry_demo_license_status
```
Observed: exit 0, `valid`. The eval command's own stderr (see the "wp-cli + WooCommerce" deviation above for why `ddev logs -s web` doesn't capture this — WP-CLI's SAPI logs to its own stderr, not the fpm log stream `ddev logs` aggregates) contains:
```
[ferry-harness] stubbed: https://ferry-prod-ddev-site.ddev.site/
```
— confirming the EDD `check_license` call was intercepted and answered locally, never left the clone.

**Browser check** (authenticated curl session as `ferry-admin`, mirroring a real browser hit to `/wp-admin/`):
```
GET /wp-admin/ → 200
  "Ferry Demo Licensed: license VALID - premium feature active."
  notice notice-success
```
✅ green notice confirmed.

**WooCommerce → Extensions** (`GET /wp-admin/admin.php?page=wc-addons`) — first run, **before the fix**:
```
HTTP 200 (headers already flushed before the fatal)
<b>Fatal error</b>: Uncaught TypeError: array_map(): Argument #2 ($array) must be of type array, stdClass given
  in .../wp-content/plugins/woocommerce/includes/admin/class-wc-admin-addons.php:200
Stack trace:
#0 class-wc-admin-addons.php(200): array_map()
#1 class-wc-admin-addons.php(404)…: WC_Admin_Menus->addons_page()
...
```
❌ **fataled.** Root cause and fix are in "Bug found & fixed" below. The fix was applied in `ferry-cli/assets/ferry-stubs.php`, re-delivered to the clone via a fresh `node dist/main.js pull ferry-prod-ddev-site` (commit `3521414`), and re-verified end-to-end:

```
GET /wp-admin/admin.php?page=wc-addons  → 302 → /wp-admin/admin.php?page=wc-admin&path=%2Fextensions → 200
  <title>Extensions ‹ WooCommerce ‹ Ferry Fixture</title>
  0 occurrences of "fatal error" / "critical error" in the response body
```
`ddev logs -s web` (a real php-fpm request this time, unlike the wp-cli eval calls above) shows the new stub case firing:
```
NOTICE: PHP message: [ferry-harness] stubbed: https://woocommerce.com/wp-json/wccom-extensions/1.0/categories?locale=en_US
NOTICE: PHP message: [ferry-harness] stubbed: https://woocommerce.com/wp-json/helper/1.0/product-usage-notice-rules
```
✅ **fixed, re-verified — no fatal, no other endpoint on the page needed a shape change.**

**Negative control** (brief's Step 4, extra item) — re-run against the fixed stub, after the fresh pull:
```bash
mv wp-content/mu-plugins/ferry-stubs.php wp-content/mu-plugins/ferry-stubs.php.disabled
ddev wp eval "require_once …/wc-admin-functions.php; do_action('admin_init');"   # exit 0
ddev wp option get ferry_demo_license_status                                     # → invalid
mv wp-content/mu-plugins/ferry-stubs.php.disabled wp-content/mu-plugins/ferry-stubs.php
ddev wp eval "require_once …/wc-admin-functions.php; do_action('admin_init');"   # exit 0
ddev wp option get ferry_demo_license_status                                     # → valid
```
`ferry-harness` log lines confirmed the mechanism: `blocked outbound HTTP: https://ferry-prod-ddev-site.ddev.site/` while the stub was disabled, `stubbed: https://ferry-prod-ddev-site.ddev.site/` after restoring it.

**Gate 2: PASS — valid/invalid flip, negative control, green admin notice, and WooCommerce Extensions (post-fix) all confirmed.**

## Gate 3 — uploads materialization

Sibling-networking workaround (DDEV-only; `ferry-prod.ddev.site` resolves to loopback from inside a sibling project's container otherwise). Added to the **clone's** `.ddev/docker-compose.ferry-e2e.yaml`:

```yaml
services:
  web:
    external_links:
      - "ddev-router:ferry-prod.ddev.site"
```

`ddev restart` in the clone. Observed: restart succeeded; DDEV logged `Using nginx snippets: .../ferry-uploads.conf`. Extra verification item (nginx accepts the named-location `rewrite … last` config at all — `ddev start`/`restart` would otherwise fail):
```bash
ddev exec nginx -t
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful
```
Sibling resolution confirmed from inside the web container: `getent hosts ferry-prod.ddev.site` → a real docker-network IP (not `127.0.0.1`); `curl` to `https://ferry-prod.ddev.site/` from inside the container → `200`.

Core checks:

| Request | Result |
|---|---|
| `GET /wp-content/uploads/2026/07/ferry-logo.png` (existing image, first hit) | `200`, `content-type: image/png`; materialized on disk (`2480` bytes) |
| `GET /wp-content/uploads/2026/e2e-font.woff2` | `200`, `content-type: font/woff2`, same-origin |
| `GET /wp-content/uploads/2026/nope.jpg` (miss floor) | `302` → `https://ferry-prod.ddev.site/wp-content/uploads/2026/nope.jpg` |
| `GET /wp-content/uploads/..%2Fwp-config.php` (traversal) | `404` |

Extra verification item — confirm the **second** request for a materialized file is served without the fallback script: renamed `ferry-uploads-fallback.php` away, re-requested both already-materialized files:
```
GET .../ferry-logo.png    → 200, etag/last-modified/accept-ranges: bytes present (static nginx response, not the PHP script)
GET .../e2e-font.woff2    → 200, etag/last-modified/accept-ranges: bytes present
```
Control (same conditions, a **not-yet-materialized** thumbnail): `404` (fallback script absent → nothing can materialize it), proving the two 200s above really didn't depend on the script. Restored the script; the thumbnail materializes normally.

**Testing-methodology note (not a product bug):** immediately after restoring the fallback script, one retry still 404'd. Root cause: DDEV's Mutagen host↔container file sync has a short lag, and the restoring `mv` was done from the host, racing the very next `curl`. Running `ddev mutagen sync` (flush) before retrying resolved it cleanly (`200`, `image/png`). This is an artifact of doing file swaps from the host side for the test, not of the fallback script itself.

**Gate 3: PASS**, all checks including every carried-over extra verification item.

## Gate 4 — fetch-uploads + full pull

```bash
node dist/main.js fetch-uploads ferry-prod-ddev-site 2026/
```
Observed: `✔ Materialized 3 file(s) (0.0 MB)`. Confirmed on disk: `2026/07/ferry-logo.png`, `2026/07/ferry-logo-150x63.png`, `2026/e2e-font.woff2`.

```bash
node dist/main.js pull ferry-prod-ddev-site --full
```
Observed:
```
✔ Clone ready: https://ferry-prod-ddev-site.ddev.site
  Full DB pull: no exclusions
  Committed production snapshot cdf3010 (1 nested repo(s) neutralized)
  Files: 10155 reused, 0 reconstructed, 3 fetched
  Provenance: core and wp.org packages verified clean
```
(full commit: `cdf301064582048d685401f801465103c51964e3`)

```bash
ddev wp db query "SELECT COUNT(*) AS c FROM wp_posts WHERE post_type='revision'"   # → 2
curl -kso /dev/null -w '%{http_code}\n' https://ferry-prod-ddev-site.ddev.site/    # → 200
```

**Gate 4: PASS.**

## Bug found & fixed: WooCommerce's stock "Extensions" page fataled under the generic WC.com stub

Found during Gate 2, diagnosed, and — once confirmed as a genuine code defect rather than an environment issue — fixed and re-verified in the same E2E pass (commit `8c651fb`).

**Where:** `ferry-cli/assets/ferry-stubs.php`, `ferry_stub_woocommerce()`, before the fix:
```php
function ferry_stub_woocommerce($url)
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (substr($path, -14) === '/subscriptions') {
        return ferry_stub_http_200('[]');
    }
    return ferry_stub_http_200(new stdClass());   // ← the default branch
}
```

**What breaks:** WooCommerce's built-in **WooCommerce → Extensions** admin page (`admin.php?page=wc-addons` — present on every WooCommerce install, not something the demo fixture invented) calls `WC_Admin_Addons::get_sections()`, which does:
```php
$raw_sections = wp_safe_remote_get('https://woocommerce.com/wp-json/wccom-extensions/1.0/categories?locale=…', …);
$addon_sections = json_decode(wp_remote_retrieve_body($raw_sections));   // no `true` assoc flag
```
and later:
```php
$allowed_sections = array_map(fn($section_object) => $section_object->slug, $sections);
```
`GET https://woocommerce.com/wp-json/wccom-extensions/1.0/categories` doesn't match the `/subscriptions` special case, so the stub falls through to the default `{}` (empty-object) shape. `json_decode('{}')` yields a `stdClass`, not an array, and `array_map()`'s second argument must be an array — **uncaught `TypeError`**, caught by WordPress's fatal-error handler, rendering as a "critical error" page (still HTTP 200, since headers were already flushed).

**Reproduction:** any DDEV clone with WooCommerce active; visit **WooCommerce → Extensions** in wp-admin. Was 100% reproducible, confirmed via authenticated `curl` with the full stack trace.

**Root cause, one level up:** the stub's default fallback assumes every non-`/subscriptions` WooCommerce.com endpoint is content with an empty *object* response. That was wrong for at least this one real, common endpoint, which needs an empty *array* (`[]`) to be handled gracefully by WooCommerce's own code (`array_map` over zero categories is a legitimate, well-formed "no data" case). No existing test (`ferry-plugin/tests/`, `ferry-cli/tests/`) covered `ferry_stub_woocommerce()` at all — this path was untested before this gate.

**Fix applied** (`ferry-cli/assets/ferry-stubs.php`, commit `8c651fb`):
```php
function ferry_stub_woocommerce($url)
{
    $path = (string) parse_url($url, PHP_URL_PATH);
    if (substr($path, -14) === '/subscriptions') {
        return ferry_stub_http_200('[]');
    }
    // WC_Admin_Addons::get_sections() array_maps over this response - must be a
    // list, not the generic {} shape, or WooCommerce's own Extensions page fatals.
    if (strpos($path, '/wccom-extensions/') !== false && substr($path, -11) === '/categories') {
        return ferry_stub_http_200('[]');
    }
    return ferry_stub_http_200(new stdClass());
}
```
Special-cases the `wccom-extensions/.../categories` path to `'[]'`, same pattern as `/subscriptions`; every other WC.com path (confirmed on this page: `.../helper/1.0/product-usage-notice-rules`) keeps the `{}` default and rendered fine. Covered by a new `StubsTest::test_woocommerce_extensions_categories_is_a_list()` (`ferry-plugin/tests/StubsTest.php`) asserting the categories path returns `'[]'` and an unrelated `wccom-extensions` path still returns `'{}'`. Iterating "load the page, extend the stub for the next endpoint that fatals" per the fix instructions took exactly one round — no further endpoint on the Extensions page needed a shape change (confirmed by the clean re-verification above, following the page's own redirect through to the React marketplace shell with zero fatal/critical-error occurrences).

**Test evidence:** `php -l ferry-cli/assets/ferry-stubs.php` → clean. `cd ferry-plugin && vendor/bin/phpunit` → **91 tests, 191 assertions, OK** (one new `StubsTest` case added). `cd ferry-cli && npx vitest run` → **18 files, 91 tests, all passed** (unaffected — the CLI test asserting the copied stub only checks for the `ferry_stub_response` function name substring). `npx tsc --noEmit` → clean (no `.ts` files touched).

## Reproduce / teardown

Same as prior runbooks: `ddev stop --unlist ferry-prod-ddev-site && rm -rf ~/ferry-sites/ferry-prod-ddev-site`, `ddev stop --unlist ferry-prod && rm -rf ~/ferry-e2e`. Additionally for this gate: `rm -f ~/ferry-sites/ferry-prod-ddev-site/.ddev/docker-compose.ferry-e2e.yaml` if reusing the clone directory without the sibling-networking workaround.

## Known gap

**Apache-fpm `.htaccess` uploads-fallback routing (`generateHtaccessFallback()`) is not exercised by this or any prior E2E gate.** Both fixture DDEV projects use nginx-fpm (the DDEV default); nobody has run a real apache-fpm fixture against this slice. The htaccess block is unit-tested (string generation) but never proven against a real Apache `mod_rewrite` engine.
