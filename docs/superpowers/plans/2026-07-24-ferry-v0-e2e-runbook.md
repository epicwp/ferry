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

---

# Plan 2 — Git substrate (2026-07-24)

**Result:** ✅ **all checks pass** against the real DDEV `ferry-prod` fixture.

Fixture prep: seeded a bundled plugin repo `wp-content/plugins/demo/.git` (+ `plugin.php`) on `ferry-prod` to exercise nested-`.git` neutralization; cleared the clone for a clean first pull; ran `ferry pull ferry-prod-ddev-site` with the git-substrate CLI (`export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`).

CLI printed: `Committed production snapshot 9d0785e (1 nested repo(s) neutralized)`.

| Check | Result |
|---|---|
| Pull commits to `production` (subject "ferry: production snapshot", HEAD on production) | ✅ |
| Ferry artifacts not tracked; `check-ignore` covers wp-config.php, wp-config-ddev.php, CLAUDE.md, .ddev/, uploads, ferry-overlay.php | ✅ |
| Bundled `demo/.git` → `demo/.git.ferry-disabled` (no stray `.git`); its metadata tracked | ✅ |
| Bundled `demo/plugin.php` IS tracked (not hidden as a submodule) | ✅ |
| `CLAUDE.md` auto-placed in the clone root | ✅ |
| From a `work` branch, `git diff production` shows exactly `index.php` and nothing else | ✅ |
| Clone still serves HTTP 200 (git step didn't disturb the working clone) | ✅ |
| **Re-pull:** second `production` commit (count=2), nested repo re-neutralized idempotently, ferry repo's own `.git` intact (sentinel present), status clean | ✅ |

No bugs found — the git substrate worked end-to-end on the first run, first and second pulls alike.

Teardown (optional): `rm -rf ~/ferry-e2e/prod/wp-content/plugins/demo` to remove the seeded bundled repo.

---

# Plan 2 — Provenance & cache (2026-07-25)

**Result:** ✅ **all four scenarios pass** against the real DDEV `ferry-prod` fixture, hitting real wordpress.org. One fixture defect found (WordPress core on the fixture was genuinely corrupt — the provenance report is what found it) and one product concern logged.

## Environment deltas from Plan 1

- Same fixture `ferry-prod` (`~/ferry-e2e/prod`, WP **7.0.2**, PHP 8.3) and clone `ferry-prod-ddev-site` (`~/ferry-sites/ferry-prod-ddev-site`); the ferry plugin lives at `wp-content/plugins/ferry-connect/`.
- Fixture now also carries **akismet 5.7** (real wp.org plugin — exercises plugin-package provenance), the hintless **`demo`** plugin left by the Plan 2 git-substrate gate, and `hello.php`.
- New CLI state: package cache at `~/.ferry/cache/packages/{core,plugin,theme}/…` and the report at `~/.ferry/sites/<slug>/provenance.json`.
- Deploy step: `cp ferry-plugin/ferry.php` + `rsync -a --delete ferry-plugin/src/` into the fixture's `ferry-connect/`, then `npm run build` in `ferry-cli`.

## Fixture repair (do this before trusting any baseline)

The very first provenance pull reported `⚠ 21 unexpected file(s) in wp-admin//wp-includes/, 25 missing core file(s)`. Investigation showed **the fixture's own WordPress was corrupt**: every file whose ABSPATH-relative path exceeds 90 characters had its name truncated at exactly 90 — `Literata72pt-ExtraBoldItalic.woff` (no `2`), `SourceSerif4Variable-Ita`, `page-link-in-bio-heading-paragraph-links-image` (no `.php`), and 33 more. 90 + `wordpress/` (10) = **100 bytes, the classic ustar `name`-field limit**: `ddev wp core download` extracted `wordpress-7.0.2.tar.gz` with a tar reader that truncates instead of using the `prefix` field. Four groups of long paths collided on the same 90-byte prefix and overwrote each other, which is why 25 files were missing but only 21 stray names remained.

Repair (do **not** use `wp core download --force` — that is what caused it):

```bash
curl -sL https://wordpress.org/wordpress-7.0.2.zip -o wp.zip && unzip -q wp.zip -d stage
rsync -a --delete stage/wordpress/wp-admin/    ~/ferry-e2e/prod/wp-admin/
rsync -a --delete stage/wordpress/wp-includes/ ~/ferry-e2e/prod/wp-includes/
rsync -a --exclude wp-content --exclude wp-admin --exclude wp-includes stage/wordpress/ ~/ferry-e2e/prod/
for t in twentytwentythree twentytwentyfour twentytwentyfive; do
  rsync -a --delete "stage/wordpress/wp-content/themes/$t/" ~/ferry-e2e/prod/wp-content/themes/$t/
done
rsync -a --delete stage/wordpress/wp-content/plugins/akismet/ ~/ferry-e2e/prod/wp-content/plugins/akismet/
```

After the repair the fixture has 3945 core files and a longest relative path of 129 chars, matching the wp.org checksum list exactly. The stale truncated files were pruned from the clone by the next pull without any manual help.

## Scenarios

All runs: `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"; time node ferry-cli/dist/main.js pull ferry-prod-ddev-site`.

| # | Scenario | `Files:` line | Wall / CPU | Result |
|---|---|---|---|---|
| 0 | Pre-repair first pull (exposed the fixture defect) | 3949 reused, 0 reconstructed, 5 fetched | 28.4s | ⚠ found the corrupt core |
| 0b | Re-sync after repair (cache warm, clone stale) | 3918 reused, **39 reconstructed**, 3 fetched | 26.1s | ✅ cache repaired the clone |
| A | Warm clone, clean baseline → `TREE_A` | 3957 reused, 0 reconstructed, 3 fetched | 25.8s / 1.6s user | ✅ |
| B | Cold cache (`rm -rf ~/.ferry/cache`) + deleted clone | **0 reused, 3938 reconstructed, 22 fetched** | 16.2s / 3.1s user | ✅ tree == `TREE_A`, HTTP 200 |
| C | Tamper (modified `version.php` + rogue file) | 3956 reused, 0 reconstructed, 5 fetched | 27.5s | ✅ mirror-first held |
| D | Fixture restored, final clean pull | 3956 reused, **1 reconstructed**, 3 fetched | 25.8s | ✅ tree back to `TREE_A`, HTTP 200 |

`TREE_A` = `1e634a9a264aa7cddd8bffa6ed5f9894369e57d0` (`git rev-parse 'HEAD^{tree}'`).

**Scenario A** — provenance summary `⚠ 3 modified plugin/theme file(s)`; core and akismet verified clean, zero missing, zero extra. Unverified list is exactly what it should be: `demo` (`no-version-hint`) and `ferry-connect` (`unavailable` — it is not a wp.org plugin). The pull is now DB/DDEV-dominated: 25.8s wall against 1.6s of CLI CPU.

**Scenario B** — the whole docroot came back from wp.org + the cache: `0 reused, 3938 reconstructed, 22 fetched`, the 22 being the genuine unique tail (11 `ferry-connect`/`demo` files, `hello.php`, the four `index.php` guards, `object-cache.php`, and the theme files that differ from their standalone zips). Cache ingested `~/.ferry/cache/packages/core/7.0.2-en_US/{checksums.json,files}` (107 MB total). **The tree hash is byte-identical to `TREE_A`** — reconstruction is faithful, not merely equivalent. Clone serves HTTP 200. Notably this cold run was *faster* (16.2s) than the warm one, because a fresh DDEV project is cheaper to create than an existing one is to restart; the extra file work costs only ~4s of CPU.

**Scenario C** — after `printf '\n// ferry-tamper\n' >> wp-includes/version.php` and a rogue `wp-includes/ferry-rogue.php` on production:

```
Provenance: ⚠ 1 modified core file(s), 1 unexpected file(s) in wp-admin//wp-includes/, 3 modified plugin/theme file(s)
```

`provenance.json` lists exactly `modified: ["wp-includes/version.php"]`, `extra: ["wp-includes/ferry-rogue.php"]`, `missing: []`. Both files are present in the clone carrying **production's tampered bytes** (md5 `c74daea55689d6cac9e2a3af6a05a5bd` / `6f6e8069c340ae36530610d5783f4921`, identical to the fixture) — mirror-first holds: Ferry reports the drift, it does not silently "heal" it from wp.org.

**Scenario D** — restoring `version.php` from the official zip and deleting the rogue file returns the summary to the 3 theme files, prunes the rogue file from the clone, and the tree hash returns to `TREE_A`. The restored `version.php` was **reconstructed from the cache**, closing the loop.

## Bugs found

1. **Fixture (environment), not product:** the ustar-100 truncation described above. Worth keeping in mind for any future fixture: `wp core download` can produce a silently corrupt WordPress. The gate's real lesson is positive — the provenance report detected genuine core corruption on a site nobody suspected, which is exactly its job.

2. **Product concern (not fixed here): bundled `twenty*` themes are verified against the wrong artifact.** `report.ts` deliberately excludes `wp-content/` from the core checksum comparison and judges each theme against its standalone zip on `downloads.wordpress.org`. But the theme bundled in a core release is *not* byte-identical to the standalone zip of the same version:

   | File | fixture md5 | core checksums API | standalone theme zip |
   |---|---|---|---|
   | `twentytwentythree/style.css` | `f27c4edd…` | `f27c4edd…` ✅ | differs (`Tested up to: 6.7` vs `7.0`) |
   | `twentytwentythree/readme.txt` | `3d139d48…` | `3d139d48…` ✅ | differs |
   | `twentytwentyfive/style.min.css` | `58336bb3…` | `58336bb3…` ✅ | differs (minifier property order) |

   All three files are **authentic WordPress bytes** — the core checksum list already vouches for them. The consequence is that a stock WordPress install can never reach `core and wp.org packages verified clean`; it always reports 2–3 phantom "modified plugin/theme file(s)". The fix is to prefer the core checksum list for bundled themes when the version matches the core release, but that is a code change and is out of scope for this gate.

No product code was changed by this gate.

## Reproduce / teardown

Same teardown as Plan 1, plus `rm -rf ~/.ferry/cache` to reset the package store.

