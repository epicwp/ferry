# Ferry Plan 2 — Provenance & Content-Addressable Cache — Design

**Date:** July 25, 2026
**Status:** design, approved in brainstorming
**Builds on:** the shipped v0 pull skeleton (PR #1) and the git-substrate slice (PR #2), both on `main`
**Roadmap:** `docs/superpowers/plans/2026-07-24-ferry-roadmap.md` — this is the provenance/speed slice of Plan 2. Base doc: `docs/ferry-walking-skeleton.md` §2.14 (reconstruct instead of transfer) and §4.3 (the `resolve()` seam).

## 1. Purpose & scope

Make re-pulls feel instant and cut first-pull transfer to the genuinely unique bytes. Of a typical ~60MB WP install, ~45MB is core and ~12MB wp.org plugins/themes — identical everywhere. Only ~3MB is unique to the site. This slice reconstructs the identical part locally from official wordpress.org packages, backed by a package cache shared across all sites, and surfaces a "modified core files" report as a by-product.

Unlike the git slice, this touches **both sides**: the plugin manifest starts carrying real per-file hashes (currently `hash: null`), and the CLI `resolve()` seam (currently identity) becomes the hash-diff.

**In scope:**
- Plugin: MD5 per file in the manifest; `locale`, installed `plugins`, and `themes` added to `/info` as reconstruction hints.
- CLI: `resolve()` rewritten to classify every manifest entry as **reuse** (already on disk with the same hash), **reconstruct** (official package bytes from the cache), or **fetch** (over the bridge).
- A package cache under `$FERRY_HOME/cache/`, populated exclusively from wordpress.org downloads, shared across sites.
- A provenance report per pull: modified / missing / unexpected-extra core files, modified files in wp.org plugins/themes, and the list of unverifiable (premium/custom) packages.

**Decided in brainstorming:**
- **Files only.** The DB re-pull is untouched; DB exclusions/lite-mode are a separate Plan-2 slice, block-fingerprint refresh is Plan 6.
- **wp.org-only cache trust.** Customer bytes never enter the cache — a customer file that claims a known hash is skipped-and-reconstructed from official bytes, never ingested. This kills cache-poisoning (MD5 chosen-prefix collisions are practical) and cross-customer redistribution of licensed code before the cache lands on shared SaaS infrastructure in Plan 3. Premium plugins always travel over the bridge; they are the unique tail anyway.
- **Themes included.** Same mechanism as plugins, one more zip URL pattern; default themes ship with every install.
- **Version hints come from the plugin** (`/info`), not from CLI-side inference.
- **Full report** (modified + missing + extra + per-package), not just modified core.

**Deferred:**
- Cross-site dedup of premium plugin bytes (would need per-customer namespacing; negates the benefit).
- Cache eviction/GC — the cache grows by used package versions (~1–2GB after ten sites); disk is cheap, revisit when it isn't.
- Merkle-tree change detection (§2.15) and DB fingerprints (§2.16) — later plans.

## 2. Principles

- **Mirror-first is untouched.** Provenance changes where bytes come *from*, never what they *are*. A hacked core file is flagged in the report **and** faithfully present in the clone — it is exactly what an agent may need to investigate. Reconstruction only ever substitutes bytes proven identical by hash.
- **wp.org is an optimization, never a dependency.** Every provenance failure demotes files toward the bucket that always works: fetch over the bridge. A pull may be slower than hoped; it never fails because of provenance.
- **Hints are not trusted.** Version headers from `/info` only steer which packages to try. Reconstruction requires a byte-for-byte MD5 match against official checksums; a lying header costs bandwidth, never correctness.
- **MD5 because the ecosystem dictates it.** `api.wordpress.org/core/checksums/1.0/` returns MD5 (same source `wp core verify-checksums` uses). MD5 is safe here *because* of the wp.org-only trust rule: the cache never ingests attacker-controllable bytes, so collision attacks have nothing to poison.

## 3. Plugin-side changes (stays read-only, no new endpoints)

**`Manifest.php`** — fill the hash field: `'hash' => md5_file($abspath)`, `null` when unreadable. The walk now reads every file's bytes; the existing time budget (§3.3) absorbs the cost — batches get smaller and the deterministic index cursor (`?after=N`) is unaffected. **The interaction with resumable transfer is zero**; slow hosts just take more manifest round-trips.

**`Routes::info()`** — three new hint fields:

```
locale:  get_locale()                            // e.g. "nl_NL" — core checksums are per-locale build
plugins: get_plugins() →  [ { file: "akismet/akismet.php", version: "5.3.7" } ]
themes:  wp_get_themes() → [ { stylesheet: "twentytwentyfive", version: "1.2" } ]
```

(`get_plugins()` needs `require_once ABSPATH . 'wp-admin/includes/plugin.php'` in a REST context.) The wp.org slug is derived CLI-side from the plugin directory / theme stylesheet name — a hint like everything else here.

**Version skew is graceful both ways:** old plugin + new CLI → `hash: null` → everything fetches (v0 behavior). New plugin + old CLI → extra fields ignored.

## 4. CLI: the pull flow at the seam

`pull.ts` changes exactly at the seam (§4.3's promise: provenance is one function replaced, the transfer layer untouched):

```ts
const manifest = await fetchManifest(client);
const plan = await resolve(manifest, info, { docroot, cacheDir });  // seam: now async, returns a plan
await Promise.all([
  fetchAll(client, plan.fetch, docroot),       // transfer layer: untouched
  reconstruct(plan.reconstruct, docroot),      // local CoW copies from the cache
]);
writeReport(plan.report, slug);                // JSON next to profile.json + console summary
```

`resolve()` classifies every manifest entry, checked in order:

1. **reuse** — the file already exists in `docroot` with the same MD5. Hashing the local ~60MB tree costs ~0.3s and is robust against any local drift (no reliance on stored state). This is what makes re-pulls instant, and it applies to *all* files — including premium plugins.
2. **reconstruct** — the entry's hash equals the official checksum for that path in the package that owns it → CoW-copy from the cache.
3. **fetch** — everything else: the unique tail, hash-null entries, files of unavailable packages.

**Path→package ownership:** non-`wp-content` paths (`wp-admin/**`, `wp-includes/**`, root files) belong to core; `wp-content/plugins/<dir>/**` to plugin `<dir>`; `wp-content/themes/<dir>/**` to theme `<dir>`; everything else (`mu-plugins`, `languages`, other `wp-content`) is never package-matched — only reuse or fetch. Core's official checksum list also covers bundled `wp-content` items (akismet, `twenty*` themes); those entries are ignored so wp-content is judged strictly by its own packages and nothing is judged twice.

Downstream is untouched: `commitProduction` still receives the full manifest path list; reused, reconstructed, and fetched files are all on disk before the `production` commit, so the snapshot stays complete.

## 5. The package cache

`$FERRY_HOME/cache/` — shared across all sites, honors the existing `FERRY_HOME` override (tests point it at a scratch dir).

```
$FERRY_HOME/cache/
  packages/
    core/6.8.2-nl_NL/
      files/            ← extracted zip
      checksums.json    ← path → md5  (core: from api.wordpress.org; plugins/themes: computed at ingest)
    plugin/akismet/5.3.7/
      files/ … checksums.json
    theme/twentytwentyfive/1.2/
      files/ … checksums.json
  tmp/                  ← in-flight ingests; cleaned opportunistically at pull start
```

A **package store**, not a git-style object CAS: with wp.org-only ingestion every cached byte belongs to a known package, so matches are always (package, path, hash) triples and bare-hash object storage buys nothing but machinery. The store is human-browsable, deletion is `rm -rf` of a package dir, and disk duplication across versions is accepted (~1–2GB after ten sites).

One operation: `ensurePackage(type, id, version, locale?)` → returns the cached dir, or ingests: download zip → extract into `cache/tmp/<unique>/` → write `checksums.json` → `rename()` into place. The rename makes ingestion **atomic per package**; if a concurrent pull won the race, the existing dir wins and the temp dir is discarded. `packages/` never holds a partial package.

## 6. CLI components

New module `ferry-cli/src/provenance/`, plus the rewritten seam:

- **`wporg.ts`** — the only file that talks to wordpress.org. Core checksums (`api.wordpress.org/core/checksums/1.0/?version=X&locale=Y`; empty/404 → retry `en_US`), zip downloads (`downloads.wordpress.org/release/wordpress-<ver>.zip` or the locale build; `…/plugin/<slug>.<ver>.zip`; `…/theme/<slug>.<ver>.zip`). Short timeouts, one retry; every failure returns "unavailable" as a value — nothing here throws a pull-killing error.
- **`cache.ts`** — the package store (§5).
- **`reconstruct.ts`** — `fs.copyFile(COPYFILE_FICLONE)`: copy-on-write clone on APFS, silent fallback to a real copy elsewhere. Real copies, never hardlinks — an agent editing a clone file must never write through into the shared cache. Each file's MD5 is verified in-stream during the copy; a mismatch (cache corruption) demotes the file to fetch with a warning.
- **`report.ts`** — builds the report from the classification pass (no extra I/O), writes `~/.ferry/sites/<slug>/provenance.json`, prints the summary.
- **`resolve.ts`** — the seam, rewritten in place: collect candidate packages from the `/info` hints → `ensurePackage` each → classify every entry (§4) → build the report. Still one function returning a plain plan object.

## 7. The provenance report

Built from data the classification already computed:

```
per package (core, each wp.org plugin/theme):
  modified[]   — on site, hash ≠ official checksum
  missing[]    — in the official list, absent from the manifest
  extra[]      — core only: files under wp-admin/ or wp-includes/ in no official list
                 (classic malware drop location — the highest-signal finding)
unverified[]   — packages with no wp.org match (premium/custom): listed, not judged
```

Written to `~/.ferry/sites/<slug>/provenance.json` (readable files per site, SaaS spec §13 — Plan 3 reads the same file). Console: one clean line when nothing is flagged, otherwise e.g. `⚠ 3 modified core files, 1 unexpected file in wp-includes/ — full report: <path>`. The report describes *production*, so it stays out of the clone's git repo.

## 8. Error handling & degradation

| Failure | Behavior |
|---|---|
| wp.org unreachable / timeout / non-200 | affected packages unavailable → files reuse-or-fetch; pull proceeds at v0 speed; costs seconds, not minutes |
| zip 404 (premium dir name colliding with a wp.org slug; version removed from wp.org) | package unavailable → files fetch; listed in `unverified[]` |
| API checksum ≠ zip's actual bytes for a path | that path is never reconstructed → fetch (reconstruct only on proven match) |
| `hash: null` entry | fetch |
| cache corruption | caught by in-copy MD5 verify → fetch + warning |
| interrupted ingest | garbage in `cache/tmp/` only, cleaned at next pull start; atomic rename protects `packages/` |
| locale build without checksums | `en_US` list; translated files mismatch → fetch (small) |

## 9. Testing

1. **Unit** — classification against fixture manifests/checksums: null hashes, locale fallback, ownership boundaries (`plugins/x/` vs `plugins/x-pro/`), core-list wp-content entries ignored, report bucketing. Plugin: PHPUnit for manifest hash values and the new `/info` fields against the existing WP stubs.
2. **Integration** — `cache.ts`/`wporg.ts` against a local HTTP server with fixture zips/checksums: ingest atomicity, concurrent-race behavior, 404/timeout degradation, reconstruct CoW + in-copy verify.
3. **E2E gate** — real DDEV `ferry-prod` fixture (`export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`), real wp.org:
   - **Cold-cache pull** → tree byte-identical to a full v0-style pull (empty `git diff` between the two production commits); only unique files crossed the bridge.
   - **Tamper test** → modify one core file + drop one rogue file in `wp-includes/` on ferry-prod → report flags exactly those two; the clone contains both **as production has them** (mirror-first).
   - **Warm re-pull, unchanged site** → file phase in single-digit seconds, zero reconstruction, near-zero transfer.

## 10. Success criteria

- Unchanged re-pull's file phase ≤ a few seconds.
- First-pull bridge transfer reduced to roughly the unique tail on a stock-ish site (base doc §4.8: ~60–90s → ~45–70s total).
- Report correctly flags modified / missing / extra core files and modified wp.org package files; premium packages listed as unverified.
- With wp.org fully offline, a pull still completes correctly at v0 speed.
