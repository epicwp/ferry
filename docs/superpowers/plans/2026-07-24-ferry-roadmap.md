# Ferry — Implementation Roadmap

**Date:** July 24, 2026
**Specs:** `docs/ferry-saas-walking-skeleton-specs.md` (SaaS layer) + `docs/ferry-walking-skeleton.md` (base CLI+plugin design, rev. 2)
**Design:** `design.zip` — Ferry Dashboard, 7 screens, Dutch copy. **All product copy ships in English by default**; the Dutch design copy gets translated when the dashboard is built (Plan 3).

The specs cover multiple subsystems (plugin, pull engine, SaaS server, dashboard, agent, push pipeline). One plan covering all of it would be unbuildable and unreviewable, so the work is decomposed into sequential plans. **Each plan produces working, testable software on its own.** Each plan is written in full detail only when its predecessor ships, so it can build on real code instead of guesses.

## Plan 1 — v0 pull skeleton (detailed plan exists: `2026-07-24-ferry-v0-pull-skeleton.md`)

The base doc's walking skeleton (§4): `ferry link` + `ferry pull` → an airtight DDEV clone at production parity. WordPress plugin (native PHP, zero dependencies, read-only) + Node/TypeScript engine. Everything else stands on this.

**Done when (§4.7):** link + pull run against a real site; the clone opens in the browser with working admin (local user), permalinks, content and images (302 uploads fallback) — on production's PHP/DB versions, without sending a single mail, without a drop-in fatal.

## Plan 2 — clone versioning & agent-readiness (base doc v0.1–v0.2)

- git over the whole WP root: every pull commits on `production`, work on agent branches; `.gitignore` for local artifacts; nested `.git` → `.git.ferry-disabled`
- Core/wp.org-plugin provenance via official checksums + content-addressable cache (first pull ~60s → ~45s; "modified core files" report)
- DB exclusions (revisions, transients, sessions, Action Scheduler) + lite/full mode
- License stubs (EDD, Freemius, WooCommerce.com) in the harness
- Uploads fallback that materializes fetched files; fonts materialized by default (CORS); `ferry fetch-uploads`
- Auto-placed `CLAUDE.md` with the clone's ground rules

**Done when:** a second pull of an unchanged site is seconds; `git diff production` on the clone shows exactly and only the agent's changes; a licensed plugin behaves as on production.

## Plan 3 — SaaS control plane & dashboard shell (design screens 01–05)

- Node/TS server that runs the Plan-1/2 engine per site on our infrastructure (plain DDEV, no VM isolation yet — spec §11); all state in readable files per site (spec §13)
- Accounts, sites, pairing device-flow UI (screen 02–03), initial-sync progress via SSE (screen 04), sites list with status incl. multisite hard-refusal display (screens 01, 05)
- Dashboard is a thin shell over the engine; **all copy in English** (translate the Dutch design copy)

**Done when:** the end-vision flow steps 1–6 (spec §1) work end-to-end: account → site → plugin install → pairing code → connection test → initial sync < 2 min → reachable clone URL.

## Plan 4 — the agent (design screen 06, chat portion)

- Claude Agent SDK session per site against the clone (filesystem + git + wp-cli + shell); ferry commands as custom/MCP tools
- Chat streaming via SSE, session persistence per site; token bill on our account (spec §10)

**Done when:** a user chats with the ferry agent about their cloned site; the agent greps/reads/edits/runs wp-cli in the clone and reports a plan and a fix on its own branch.

## Plan 5 — write-back: journal, push, drift, change cards (design screens 06–07)

- Auth hardening first: nonce check (base doc §4.5 — hard precondition for any write endpoint)
- MySQL row-based binlog in the clone DDEV → typed-operations journal, committed in git next to the code
- Plugin write endpoints: staged upload (base64, WAF-safe), typed DB operations, two-phase commit with atomic rename swap + backup
- Drift: file hash compare-and-swap; read-set check inside a single production transaction (`SELECT … FOR UPDATE` + verify old values + apply + commit); agent-declared preconditions
- Smoke test with automatic rollback; rollback button stays visible
- Change card UX: plain-language summary, expandable diff + DB ops, one "Push to production" button; card inline in chat + standalone in a Changes tab

**Done when:** the acceptance criterion of the base doc (§6): an agent fixes a bug in a WooCommerce site that receives orders during the session; the fix is pushed; provably no order, customer, or concurrent change touched.

## Plan 6 — production isolation & scale (deliberately last)

- Firecracker microVM per site (provider choice still open by design), egress closed at VM level, transparent stub proxy (WireMock/VCR pattern; blocked+logged = stub backlog)
- Re-enable the agent's web tools (WebSearch/WebFetch) once the agent runs inside the VM with proxied egress — kept off in Plan 4 because web content is a prompt-injection vector while the agent holds a host shell (decision 2026-07-26; the product needs web tools eventually)
- DB refresh via block fingerprints (pt-table-checksum pattern) + WP-hook journal as first-line signal; Merkle tree for file change detection; warm standby
- Billing, audit log, monitoring, onboarding (spec §15 — open points, decide then)

## Standing decisions that constrain every plan

- Plugin stays native PHP, zero external dependencies, no command execution, versioned REST namespace (`/ferry/v1/`)
- `wp-config.php` never crosses the bridge; multisite is refused hard with a clear message
- Timeouts are answers, not errors (resumable batches everywhere)
- DB content is never pushed back; writes are typed operations only
- Nothing reaches production without one human click; PAKE, FastCDC, provider choice deliberately deferred (spec §14)
