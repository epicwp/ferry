# Ferry Plan 2 — Fidelity Slice — Design

**Date:** July 25, 2026
**Base:** `docs/ferry-walking-skeleton.md` §§2.6–2.9, 3.1, 3.5 + roadmap `2026-07-24-ferry-roadmap.md` (Plan 2)
**Ships as:** one branch, one PR, three independently-verifiable task clusters + shared E2E fixture prep.

## 1. Purpose & scope

The clone behaves like production without hauling production's bloat. Three sub-features:

- **(A) DB exclusions + lite/full pull** — revisions, transients, sessions, and Action
  Scheduler history stay behind by default; `--full` pulls everything.
- **(B) License stubs** — EDD, Freemius, and WooCommerce.com clients keep believing they
  are licensed inside the airtight harness, instead of nagging or self-deactivating.
- **(C) Uploads materialization + `ferry fetch-uploads`** — missing uploads are fetched
  from production on first request and written to disk (replacing the bare 302); a CLI
  command bulk-fetches prefixes.

Plus one cross-cutting fix: the `transfer.ts` range-mode write gains a containment guard
(parked item from PR #3; `fetch-uploads` reuses that path, so it gets fixed, not filed).

Out of scope (decided during brainstorm): proactive pull-time font materialization
(obsoleted — the materializing fallback serves fonts same-origin, so the CORS failure the
roadmap item targeted can no longer occur); Freemius full E2E (deferred — needs a
registered Freemius product; stub ships with unit tests against the SDK's real
request/response shapes).

## 2. Principles

- Exclusion policy lives hardcoded in the plugin, selected by name from the CLI. Never SQL
  over the wire (extends the §3.1 posture from files to rows).
- The DB snapshot already carries production's license state. Stubs exist so revalidation
  pings cannot flip that state — they return generic "still valid" shapes, no per-site
  templating.
- The clone never holds the pairing secret. The agent works in the clone; a secret there
  could sign real requests against production. The in-clone fallback uses plain public
  GETs; only the CLI does authenticated transport.
- Version skew fails loud: a plugin that silently ignores `skip` must not produce a clone
  that claims to be lite.

## 3. (A) DB exclusions + lite/full pull

### Plugin: named rules

A new hardcoded rule table (peer of `Excludes`), prefix-aware via `$wpdb->prefix`:

| Rule | Table | Effect |
|---|---|---|
| `revisions` | `{p}posts` | rows `WHERE post_type='revision'` dropped |
| `transients` | `{p}options` | rows matching `\_transient\_%` / `\_site\_transient\_%` (escaped LIKE) dropped |
| `sessions` | `{p}woocommerce_sessions` | schema-only |
| `as_logs` | `{p}actionscheduler_logs` | schema-only |
| `as_completed` | `{p}actionscheduler_actions` | rows with status `complete`/`failed`/`canceled` dropped (pending/in-progress kept) |

Row rules become an extra `AND` clause inside the existing keyset chunk query
(`WHERE pk > ? AND pk <= ? AND <rule> ORDER BY pk`). `X-Last-Key` resume, the `before`
snapshot bound, and the byte budget are unchanged — pagination still walks the PK; the
filter only drops rows from the stream. Schema-only tables emit `DROP TABLE` +
`SHOW CREATE TABLE`, zero rows, `complete=1` on the first batch — plugins that expect the
table don't fatal. All named-rule tables have integer PKs; the OFFSET fallback is never
involved.

Accepted quirk: excluded revisions leave orphaned `{p}postmeta` rows. Harmless for
debugging; not worth a JOIN.

### Contract

`GET /ferry/v1/db` gains `skip=<comma-separated rule names>`.

- Unknown rule name → 400 (`ferry_unknown_skip`). Fail loud beats a silently-bloated clone.
- The response carries `X-Ferry-Skip: <the rule names the plugin recognized and armed>` —
  regardless of whether they matched the table in this request. Its job is proving the
  plugin understood the parameter. The CLI aborts unless the header equals the requested
  set ("update the Ferry Connect plugin") — this catches an older plugin that ignores the
  parameter entirely (WP REST silently drops unknown params, so the header would simply
  be absent).
- No `skip` param → full export, byte-identical to today. `/db/tables` is unchanged.

### CLI

- `ferry pull <site>` defaults to lite: sends all five rule names on every `/db` request;
  the plugin applies whichever match that table.
- `ferry pull <site> --full` sends none. Per-invocation, not sticky.
- Output reports the mode:
  `lite pull: skipped revisions, transients, sessions, AS logs/completed (use --full for everything)`.

## 4. (B) License stubs

### Home

`ferry-stubs.php` ships as a **static PHP asset** in ferry-cli (real .php file, not a
template string), copied into `wp-content/mu-plugins/` next to `ferry-overlay.php` during
`applyOverlay`. The overlay's `pre_http_request` interceptor consults it before blocking:

```php
if (function_exists('ferry_stub_response')) {
    $stub = ferry_stub_response($url, $args);
    if ($stub !== null) { error_log('[ferry-harness] stubbed: ' . $url); return $stub; }
}
// fall through: block with WP_Error as today
```

`ferry_stub_response` returns a WP_Http-shaped response array or null. Housekeeping: the
mu-plugin entry moves from `Excludes::FILES` to a `wp-content/mu-plugins/ferry-` prefix in
`Excludes::PREFIXES`, and `.gitignore` gets the same pattern, so both ferry-generated
files stay out of transfer and out of git.

### Frameworks

- **EDD** — detected by request *shape*, not domain (every EDD store hosts its own API):
  `edd_action` ∈ `check_license` / `activate_license` / `deactivate_license` /
  `get_version` in body or query. Responds `license: "valid"` JSON (success, expires,
  activations_left); `get_version` responds "installed version is current, no package".
- **Freemius** — detected by host `api.freemius.com`. Success-shaped per-endpoint JSON
  (ping, install sync) so the SDK's background sync neither errors nor deactivates.
- **WooCommerce.com** — detected by host `api.woocommerce.com` / `woocommerce.com` helper
  routes. Valid-shaped subscription/auth responses so `wc-helper` pages load clean.

Everything else still blocks + logs exactly as today (that log is Plan 6's stub backlog).

## 5. (C) Uploads materialization + fetch-uploads

### Materializing fallback (replaces the bare 302)

A missing `/wp-content/uploads/*` request routes to a small **standalone** PHP script — a
static asset copied into the clone docroot, gitignored, never present on production, and
independent of WordPress (no WP load → the harness doesn't apply to it, by design).

Behavior, in order:
1. Validate: path must resolve under `wp-content/uploads/`, no traversal, never `*.php`.
   Invalid → 404.
2. Fetch `https://<prod-origin>/wp-content/uploads/<path>` with a plain public GET (no
   secret — see §2).
3. `Content-Length` > 50MB → 302 to production instead of buffering (videos). Fonts and
   images never hit the cap, so same-origin font serving — the thing that fixes CORS — is
   guaranteed.
4. Success → stream to a temp file, rename into `uploads/` (atomic), serve with a
   content-type from extension. From then on nginx/apache serves it directly and
   `file_exists()` works for PHP code.
5. Any failure (non-200, network) → 302 to production: today's behavior is the floor.

Routing per webserver (clone mirrors production's server type):
- **nginx-fpm**: existing `.ddev/nginx/ferry-uploads.conf`, `@ferry_origin` now fastcgi's
  to the script instead of returning 302.
- **apache-fpm**: the htaccess block rewrites missing uploads to the script instead of
  emitting the 302.

### `ferry fetch-uploads <site> [prefix] | --all`

The §2.8 escape hatch, bulk edition (e.g. `ferry fetch-uploads mysite 2026/07/`):

- Plugin: `/manifest` gains `scope=uploads` (+ optional `prefix=`). Walks only
  `wp-content/uploads/<prefix>`, resumable via the existing `Budget`/`X-Next-Index`
  machinery. Default scope (no param) is byte-identical to today.
- `/files` accepts explicitly-requested uploads paths. All other exclusions —
  `wp-config.php`, backups, caches, logs — stay hard-blocked regardless of request.
- Transport reuses `fetchAll()` wholesale: bin-packing, byte-range mode for oversized
  files, hash verification, resume. Destination is the docroot; `uploads/` is already
  gitignored so the production snapshot stays clean.
- `--all` means literally everything under uploads, documented as such.

Clone `CLAUDE.md` and the pull output change wording: missing uploads materialize on
first request from production; `ferry fetch-uploads` bulk-fetches.

## 6. Cross-cutting: transfer containment guard

`fetchOversized()` in `transfer.ts` writes `join(destDir, entry.path)` unchecked. A
malicious or corrupted manifest entry (`../../…`) would escape the clone. Fix: resolve the
destination and require it inside `destDir` before writing (client-side mirror of the
`realpath` prefix check `Routes.php` does server-side). Applies to batch extraction too if
the tar layer doesn't already guarantee it (verify; `tar.x` with `cwd` strips absolute
paths and `..` by default — confirm in a test rather than assume).

## 7. Error handling & degradation

- `/db` with unknown `skip` → 400, CLI aborts with the plugin-update message.
- `X-Ferry-Skip` mismatch → CLI aborts (no silent bloated clone).
- Fallback script: origin down or 404 → 302 to production; the browser sees exactly the
  pre-slice behavior. Materialization is strictly an upgrade path.
- `fetch-uploads` on a path production has deleted → reported in the existing `skipped`
  list, not fatal.
- Stubs match nothing → hard block + log, exactly today's harness.

## 8. Testing

**PHPUnit (plugin):** rule filters via `FakeWpdb` (row rules, schema-only, keyset resume
under filtering, escaped LIKE); `skip` param parsing incl. unknown-name 400 and
`X-Ferry-Skip` echo; manifest `scope=uploads` + `prefix`; `/files` uploads-path acceptance
with other exclusions still blocked; stub matchers and response shapes for all three
frameworks (the stubs file is plain PHP with pure functions — required into the plugin's
suite from the CLI asset path; accepted monorepo pragmatism).

**Vitest (CLI):** `--full`/skip wiring; `X-Ferry-Skip` mismatch abort; overlay copies both
static assets; nginx/htaccess generation now routing to the script; fetch-uploads planning
(prefix → manifest scope → fetchAll); the containment guard (traversal entry rejected).

**E2E (ferry-prod fixture, DDEV).** Fixture prep: seed revisions + transients; install
WooCommerce (real `{p}woocommerce_sessions` + `actionscheduler_*` tables; seed completed
*and* pending AS actions; seed a helper connection token); add a fixture plugin embedding
the genuine `EDD_SL_Plugin_Updater` client with a seeded license option; ensure uploads
holds an image + a `woff2` referenced by a page.

Gates:
1. Lite pull → clone: 0 revisions; sessions + AS-logs tables exist empty; pending AS
   actions kept, completed gone. `--full` re-pull brings revisions back.
2. EDD fixture plugin shows **Valid** in clone wp-admin and its feature stays active; WC
   helper pages load without license errors; harness log shows `stubbed:` lines and zero
   unstubbed outbound calls.
3. Requesting the image and the font via the clone materializes both to disk (second
   request served locally, `file_exists` true); the page renders the font without CORS
   errors in the browser console.
4. `ferry fetch-uploads <site> 2026/` materializes the prefix, hash-verified.

## 9. Success criteria

The roadmap's Plan-2 "done when", fidelity portion: a licensed plugin behaves as on
production inside the airtight clone; a lite clone is visibly leaner than production's DB
while every table a plugin might touch still exists; media and fonts appear on first view
and stay local; and nothing about a full pull changed.
