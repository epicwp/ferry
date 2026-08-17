# Ferry M2 — Fly-native clone substrate (design)

**Date:** 2026-08-17
**Status:** Approved in brainstorm (Robbert, 2026-08-17); awaiting written-spec review
**Parent:** `2026-08-17-fly-deployment-design.md` §7 fixed the direction; this document is the full M2 design. M1 is live at https://ferry-cp.fly.dev.

## 1. Context and goal

M1 put the control plane + dashboard on Fly with no clone substrate: adding a
site fails at pull because the engine's clone environment is DDEV, which does
not exist on the Fly machine. M2 makes one demo WordPress site (a fresh
throwaway on Robbert's own hosting) work end-to-end ON FLY: pull → clone
browsable at a real URL → agent chat → typed change → push → rollback.

Execution is split (decision, 2026-08-17): **M2a** delivers the working
substrate with today's security posture; **M2b** deepens isolation (egress
default-deny, license-stub proxy, write-secret out of agent reach) and only
then reconsiders moving the agent into the site machine. This document covers
both at design level; M2a gets the first implementation plan.

## 2. Decisions (resolved with Robbert, 2026-08-17)

| Fork | Decision |
|---|---|
| Execution slicing | One design (this), two plans: M2a working, M2b isolation. |
| Demo site | Fresh throwaway WordPress on Robbert's own hosting (he sets it up in parallel; plugin zip + pairing from the live dashboard). |
| Agent placement (M2a) | Control plane — clone files, git, and the agent SDK subprocess stay on `ferry-cp` exactly as today. Revisited in M2b. |
| Transport CP ↔ site machine | A small HMAC-authenticated HTTP daemon ("sited") inside the site machine, over Fly private networking (6PN). Chosen over Machines-API exec (hard 60s cap, buffered output — unusable for imports) and over hallpass SSH/SFTP (certs expire ≤72h with no documented API to re-mint without flyctl). |
| Site machine shape | ONE container image (Apache+PHP WordPress base + MariaDB + wp-cli + mysqlbinlog + sited under supervisord). Multi-container Machines are org-allowlist-gated and per-container volume mounts are unsupported — avoided. |
| Local dev parity | DDEV stays the default env; `FERRY_CLONE_ENV=ddev|fly` selects the implementation (default `ddev`). The DDEV e2e suites remain the merge gate. |
| Production parity on Fly (Robbert, spec review 2026-08-17) | PHP-version parity via an image tag matrix: CI builds `ferry-site-runtime:php<minor>` per supported PHP minor; `provision()` picks the tag from `info.php_version` — same source DDEV uses (`ddevConfig`, `ferry-cli/src/env/ddev.ts:16-29`). Webserver is Apache-only in M2a (the `.htaccess` path); MariaDB version fixed. Any parity mismatch (unsupported PHP minor → nearest tag, non-Apache production webserver, db version) is surfaced explicitly in the sync result, never silent. Nginx variant + db-version parity follow when a real site needs them. |

## 3. Site-runtime image + provisioning

**Image `ferry-site-runtime`** (new `docker/site-runtime/Dockerfile`):
WordPress Apache+PHP base, MariaDB server, wp-cli, `mysqlbinlog`, Node (for
sited), supervisord as PID 1. **Built as a tag matrix per PHP minor**
(`:php8.1` … `:php8.4`, one Dockerfile with a PHP-version build arg);
`provision()` selects the tag from `info.php_version` so the clone runs the
production PHP version, mirroring DDEV's behavior. An unsupported minor maps
to the nearest tag and is reported in the sync result. Docroot `/data/www`, MySQL datadir
`/data/mysql`, binlog on with the same settings as DDEV's `ferry-binlog.cnf`
(`log-bin`, ROW format, FULL row image, `ferry-cli/src/env/ddev.ts:32-40`).
MariaDB binds loopback only — nothing exposes 3306 on the private
network; sited is the machine's sole 6PN entry point. Built and
pushed once via the repo's pipeline, not per site; the Machines API creates
machines from it. **Registry choice (registry.fly.io cross-app pull vs GHCR
public) is a plan-time verification point.**

**`FlyEnv.provision(clonePath, info, slug)`** via the Machines REST API
(org-scoped token as a Fly secret on ferry-cp):

1. Create app on the SAME 6PN network as ferry-cp (network is set at app
   create and can never change).
2. Allocate public IPs (shared v4 + dedicated v6) — this runs over Fly's
   GraphQL API; **exact mutation is a plan-time spike item**.
3. Create 3 GB volume; create machine (`shared-cpu-1x`/1 GB, autostop off in
   M2a) with the image, the machine `files` field carrying the per-site sited
   secret, and services for 80/443 (public WordPress) — sited's port 2323 is
   NOT a service (6PN-only).
4. Wait for machine `started`, then poll sited `/health`.

**App naming / URL:** `CloneEnv.url()` is synchronous and called before
provisioning finishes (`ferry-cli/src/pull.ts:59` vs `:60`), so the app name
must be deterministic from the slug: `ferry-s-<slug>-<6 hex of a keyed hash>`
(global fly.dev namespace, collision-resistant). Clone URL =
`https://<app>.fly.dev`.

**Cost:** ~$7–13/mo per always-on demo site (machine + volume); teardown on
site delete is a FlyEnv responsibility (destroy machine, volume, app).

## 4. sited — the in-machine daemon

Small Fastify service inside the site machine, listening on
`fly-local-6pn:2323` only (never a public Fly service). Auth: HMAC-SHA256
signed requests with timestamp + nonce, reusing the canonical-string pattern
of `ferry-cli/src/signing.ts` (same philosophy as the plugin transport — the
codebase's proven model). The per-site secret is generated by the control
plane at provision and injected via the machine `files` field.

Endpoints (all signed):

| Endpoint | Purpose |
|---|---|
| `PUT /files` | Apply a tar.gz stream to the docroot + a delete list (file sync CP → machine) |
| `POST /db/import` | Stream a SQL dump into MariaDB (replaces `ddev import-db`) |
| `POST /wp` | Run wp-cli with an argv array, bounded runtime (replaces `ddev wp`) |
| `POST /sql` | Whitelisted statements only: `SHOW BINLOG STATUS`, `SHOW COLUMNS FROM <table>` |
| `GET /binlog?file=…&position=…` | `mysqlbinlog --base64-output=decode-rows -v` output from a position (replaces `ddev exec -s db mysqlbinlog`) |
| `GET /health` | Readiness (also used by provision's wait loop) |

sited lives in the monorepo as a new workspace (`ferry-sited`), so the
signing code and tests are shared. It is deliberately dumb: no state beyond
the secret, no knowledge of Ferry sites.

## 5. FlyEnv + CloneEnv interface changes

`FlyEnv implements CloneEnv` (`ferry-cli/src/env/ddev.ts:42-49`) by calling
sited over 6PN (`http://<machine-id>.vm.<app>.internal:2323`). Two interface
changes, both implemented by BOTH envs:

1. **`showColumns(clonePath, table)`** — closes the interface leak at
   `ferry-cli/src/journal.ts:219`, which today shells `ddev mysql` directly,
   bypassing `CloneEnv` (currently untested code). DdevEnv wraps that
   command; FlyEnv calls `POST /sql`.
2. **`deployFiles(clonePath)`** — DdevEnv: no-op (files are served in
   place); FlyEnv: stream changed files (git-diff-derived set; full docroot
   on first deploy) to `PUT /files`. Called after the pull's production
   commit and after every completed agent turn, so the clone URL always
   shows what the agent did.

**Env selection:** new factory `ferry-cli/src/env/index.ts`, driven by
`FERRY_CLONE_ENV` (`ddev` default | `fly`), parsed in
`ferry-server/src/env-config.ts` like the M1 flags. The four hard-wire
points route through it: `pull.ts:42` (seam exists), `engine.ts:41` + `:49`
(fix: `realEngine` must actually pass `PullDeps.env` — today it drops the
seam), `sdk-runner.ts:128`, and `journal.ts:219` (via change 1). Fly-mode
config (org token, network name) comes from env/secrets on ferry-cp.

## 6. Flows

- **Pull/sync:** phase order unchanged (`info → … → import → done`). The
  env-touching steps (`provision`, `importDb`, `binlogPosition`,
  `createAdmin`, `url`) run against sited; everything else (manifest, file
  materialization into the CP clone dir, git commit, db dump download to
  `FERRY_HOME/sites/<slug>/db-dump`) is unchanged. After the production
  commit: `deployFiles` pushes the docroot to the machine.
  `verifyClone` works as-is against the fly.dev URL (200 + `<html`); its
  mkcert/`NODE_EXTRA_CA_CERTS` hint text becomes env-neutral.
- **Agent turn:** unchanged mechanics (SDK subprocess, cwd = CP clone dir,
  `agent/work` branch); on turn end, `deployFiles` syncs edits to the
  machine.
- **Push/rollback/journal:** push and rollback are untouched (profile +
  HTTP to production + local git, `ferry-cli/src/push.ts` — no env contact).
  `journalCandidates` works through the env seam it already has, now fully
  (binlog + columns via sited).

## 7. Agent on Fly (M2a posture change)

- `ANTHROPIC_API_KEY` becomes a Fly secret on ferry-cp — the agent goes
  live on the control-plane machine. This is the deliberate M2a posture:
  the agent holds a shell on ferry-cp (which also holds site secrets under
  `FERRY_HOME`); acceptable ONLY while testing against Robbert's own demo
  site. M2b moves the write secret out of reach.
- Ground rules become env-dependent (`ferry-server/src/agent/ground-rules.ts:10,20,24`
  and the clone `CLAUDE.md`, `ferry-cli/src/git.ts:113-116`): the fly
  variant drops `ddev wp`, points verification at the clone URL, and offers
  a new in-process MCP tool **`wp`** (argv array → FlyEnv → sited) next to
  the existing ferry tools.
- `DOCKER_HOST` leaves the agent env allowlist
  (`ferry-server/src/agent/sdk-runner.ts:41`) in fly mode.
- Web tools stay disabled; `FERRY_MAX_ACCOUNTS=2` stays.

## 8. Dashboard

Three DDEV-specific surfaces become env-agnostic: `site.tsx:114` (hardcodes
`<slug>.ddev.site` — must render the API's real `cloneUrl`), `sync.tsx`'s
"Import & DDEV up" phase label, and the `sites.tsx` "isolated DDEV
environment" copy. The e2e "clone URL is never an anchor" assertions extend
to the fly.dev clone URL.

## 9. Testing

- The DDEV e2e suites stay THE merge gate (local parity is a requirement,
  not an accident). All existing suites must stay green.
- sited: unit tests in its workspace (signing shared with existing tests).
- FlyEnv: unit tests against a fake sited server (the `FakeEnv implements
  CloneEnv` pattern already exists — `ferry-cli/tests/pull.test.ts:15-38`).
- `journalCandidates` gains its first tests (it has none today) via the new
  `showColumns` seam.
- Live acceptance: a runbook against Robbert's demo site, executed together
  — pull, browse clone, agent edit visible on the clone URL, journal, push,
  rollback. That runbook is M2a's proof, mirroring the M1 §9 pattern.

## 10. M2b scope (fixed here, own plan later)

- Egress default-deny on site apps via Fly Network Policies (allow: 6PN to
  ferry-cp, DNS, plus the stub-proxy below); note policies do not affect
  Fly-Proxy-routed traffic — the public 80/443 path stays open by design.
- Transparent license-stub proxy (WireMock/VCR pattern) for EDD/Freemius/
  WC.com endpoints; block + log the rest (feeds on the existing
  `[ferry-harness] stubbed:` backlog).
- Write secret out of agent reach: `profile.json` secrets move where the
  agent subprocess cannot read them (outside the forwarded `$HOME`/
  `FERRY_HOME` scope, or an in-process store) — design detail for the M2b
  plan.
- Reconsider agent-in-site-machine with M2a's experience in hand.

## 11. M2a success criteria

1. Robbert pairs the demo site from the live dashboard (plugin zip →
   pairing code) and a sync completes on Fly: status `ready`, clone URL
   `https://ferry-s-….fly.dev` verified and browsable, showing the demo
   site at production parity — including the production PHP minor
   (verifiable via `wp` through sited or a phpinfo check).
2. Agent chat on the live dashboard edits the clone; the edit is visible on
   the clone URL after the turn.
3. A DB change on the demo production site appears via the journal path
   (typed ops from the binlog through sited).
4. A typed change pushes to the demo production site behind one click, and
   rollback restores it — from the live dashboard.
5. `FERRY_CLONE_ENV` unset locally: everything works exactly as before
   (DDEV suites green: plugin 216, cli 146+, server 226+, dashboard e2e 18).
6. Deleting the site tears down the Fly app/machine/volume.
7. No secrets in git; the sited secret and the org-scoped Fly token exist
   only as Fly secrets / machine files.

## 12. Plan-time verification points (spike items for M2a's plan)

- IP allocation for API-created apps (GraphQL mutation shape).
- Image pull path: registry.fly.io cross-app pulls with an org token vs a
  public GHCR image.
- Machine `files` size bound for the sited secret/config (KB-scale — fine,
  verify).
- First-boot 6PN reachability timing (retry loop around sited health).
- MariaDB memory fit in 1 GB alongside PHP (or bump to 2 GB).
- Which PHP minors to prebuild (check what the demo site + WP core support
  today; likely 8.1–8.4) and the CI cost of the matrix build.

## 13. Out of scope

Wildcard custom domains + fly-replay routing; autostop for site machines;
multi-container Machines; more than one site; public signup; billing;
LiteFS/HA; moving the agent (M2b decides); DDEV deprecation (local dev keeps
DDEV indefinitely).
