# Ferry on Fly.io — deployment design (M1 + M2 direction)

**Date:** 2026-08-17
**Status:** Approved by Robbert (brainstorm 2026-08-17); M1 ready for writing-plans
**Kickoff:** `2026-08-17-fly-deploy-kickoff.md` (verbatim prompt with the framing decisions)

## 1. Context and goal

Ferry works end-to-end locally (Plans 1–6a merged, latest merge `4712592`). This
workstream puts the current product on Robbert's Fly.io account for controlled
testing on sites he owns — not a public launch — and establishes a repeatable
commit → deploy → feedback loop. Plan 6b (Firecracker isolation) is absorbed
into the M2 direction here, not finished separately first.

Two milestones:

- **M1** — control plane + dashboard live on Fly, account creation works, deploy
  pipeline and observability proven. No clone/sync/agent yet.
- **M2** — one demo-site clone + sync + agent working on Fly. Gets its own
  brainstorm/plan; this document fixes only its direction so M1 builds nothing
  that M2 throws away.

## 2. Decisions (resolved with Robbert, 2026-08-17)

| Fork | Decision |
|---|---|
| Milestone scope | One design doc (this one) covering M1 fully and M2 at decision level; implementation plan + execution for M1 only. M2 gets its own plan afterwards. |
| Deploy mechanism | GitHub Actions on push-to-main (repo `epicwp/ferry`) with a scoped deploy token; manual `fly deploy` stays as fallback. |
| Assistant access | A separate app-scoped token (`fly tokens create app`) for the assistant: `fly logs`, `fly status`, `fly ssh console`. Revocable independently of the CI token. |
| Tenant gating | New `FERRY_MAX_ACCOUNTS` env cap (2 on Fly). The Plan 6a "signup limit" turned out to be a per-IP rate limiter (`ferry-server/src/routes/auth.ts:8-15`), not an account cap, so this is a small new mechanism. |
| M2 clone substrate | Fly-native: one Fly app per site (Machine + volume) created via the Machines REST API. No DDEV/dockerd on Fly. Verified against current Fly docs — see §7. |

## 3. M1 — Fly topology

- One Fly app (name chosen at launch — `fly.dev` namespace is global; suggestion
  `ferry-cp`), region `ams`.
- One Machine, `shared-cpu-1x` / 1 GB (~$6/mo). Single machine + rolling deploy
  means a brief blip per deploy; acceptable for this phase.
- One 3 GB volume mounted at `/data`, `FERRY_HOME=/data/ferry`. This holds
  `server.db` (+ WAL) and the `sites/<slug>/profile.json` secrets, so accounts
  survive redeploys. Clones never land here — in M2 they live on per-site
  machines. Fly's automatic daily snapshots (5-day retention) are adequate
  backup for the test phase.
- Public URL: `https://<app>.fly.dev` with `force_https`. No custom domain in M1.
- `auto_stop_machines` off — a stable target for the feedback loop beats the
  savings.

## 4. M1 — image and config

**Docker image** (multi-stage, `node:24-slim`; no `engines` field exists in the
repo, local dev runs Node 24):

- Build stage: workspace `npm ci`, then `npm --workspace ferry-dashboard run build`.
- Runtime stage needs, at the same relative paths as the repo (all resolved via
  `import.meta.url` from `ferry-server/src/main.ts:70-71`):
  `ferry-server/` (runs from TypeScript source via `tsx` — a devDependency, so
  the runtime install must include dev deps for the server workspace),
  `ferry-cli/src/` (imported by relative path, e.g. `ferry-server/src/main.ts:4`),
  `ferry-plugin/` (plugin zip is built in memory at boot from this dir,
  `ferry-server/src/main.ts:76`, `ferry-server/src/plugin-zip.ts`),
  `ferry-dashboard/dist/` (git-ignored, so built in the build stage).
- Native/platform bits resolved by a Linux-side `npm ci`: `better-sqlite3`
  prebuilt, and the Agent SDK's platform-specific CLI binary
  (`@anthropic-ai/claude-agent-sdk-linux-*` in `optionalDependencies`; the plan
  verifies the lockfile carries the Linux variants).
- Also in the image: `git` (used by the engine and agent context) and the
  `sqlite3` CLI (DB inspection over `fly ssh console`).
- `.dockerignore` is mandatory **before the first build**: the repo-root `.env`
  contains Robbert's live `ANTHROPIC_API_KEY` (loaded at boot by
  `ferry-server/src/env-file.ts`) and must never enter an image; also exclude
  `.git`, `node_modules`, `ferry-dashboard/dist` (rebuilt), docs.

**fly.toml:**

- `internal_port` 4000 (`PORT` stays defaulted).
- `kill_timeout = 20` — above the shutdown hard deadline of 15 s
  (`ferry-server/src/shutdown.ts:5`). Fly sends SIGINT by default; `main.ts`
  handles both SIGINT and SIGTERM (`ferry-server/src/main.ts:91-102`), so no
  `kill_signal` override needed.
- No `release_command` — release VMs cannot see volumes, and the schema is
  managed at startup already.
- `[env]`: `FERRY_HOME=/data/ferry`, `FERRY_HOST=0.0.0.0`,
  `FERRY_SECURE_COOKIES=1`, `FERRY_MAX_ACCOUNTS=2`.
- `[[mounts]]`: volume at `/data`.

**Secrets:** none in M1. `ANTHROPIC_API_KEY` is deliberately NOT set — the
server then disables the agent entirely (`ferry-server/src/main.ts:41,66-68`),
which is the safest posture until M2 gives the agent an isolated substrate.

## 5. M1 — code changes (each with a test)

1. **Listen host** — `app.listen({ port, host: '127.0.0.1' })` at
   `ferry-server/src/main.ts:84` becomes env-conditioned:
   `FERRY_HOST` (default `127.0.0.1`; Fly sets `0.0.0.0`).
2. **Secure cookie** — `COOKIE_OPTS` at `ferry-server/src/routes/auth.ts:7`
   gains `secure` when `FERRY_SECURE_COOKIES=1`. Local http dev keeps working
   (flag unset). This closes the Plan 6a deferral "whichever plan first deploys
   behind TLS".
3. **Account cap** — signup returns 403 with a clear message once existing
   accounts ≥ `FERRY_MAX_ACCOUNTS`. Unset = unlimited, so local dev and the
   e2e suites are unaffected. Sits next to the existing per-IP rate limiter.
4. **Health endpoint** — unauthenticated `GET /api/health` returning 200 with a
   trivial body (includes a cheap DB touch), used by deploy verification.

No other server changes. The M1 boundary is explicit: signup, login, dashboard,
and `/api/plugin.zip` download work; adding a site and pulling it does not (no
substrate on Fly yet) and is allowed to fail honestly until M2.

## 6. M1 — deploy pipeline, observability, feedback loop

**Pipeline:** `.github/workflows/deploy.yml` on push to `main`:
`actions/checkout` → `superfly/flyctl-actions/setup-flyctl` →
`flyctl deploy --remote-only`, with `FLY_API_TOKEN` (from
`fly tokens create deploy`, app-scoped) as a GitHub secret and a `concurrency`
group so deploys never overlap. No test jobs in the workflow — the existing
pre-merge gate discipline (cli/server vitest, plugin phpunit, three typechecks,
dashboard e2e) remains the quality gate; the deploy stays fast. Manual
`fly deploy` remains as fallback.

**Rollback:** `git revert` + push = automatic redeploy of the previous state;
the volume (accounts) is untouched.

**Observability:** app logs already go to stdout via `console.*` → `fly logs`.
The assistant gets its own app-scoped token, stored locally in a git-ignored
file (never in the image or repo), and uses `fly logs`, `fly status`, and
`fly ssh console` (e.g. `sqlite3 /data/ferry/server.db`) directly.

**The loop:** Robbert tests in the browser → finding → fix on a branch → gates
green → merge → auto-deploy → assistant verifies `/api/health` + logs and only
then reports "deployed".

## 7. M2 direction (decision level — details in the M2 brainstorm)

Verified against current Fly docs (research 2026-08-17): Fly Machines are
Firecracker microVMs; multi-container Machines (Fly's "Pilot" init) let one
Machine run nginx/php-fpm + MariaDB like a compose stack; the Machines REST API
(`api.machines.dev`, or `_api.internal:4280` from inside the org network) can
create apps, machines, and volumes programmatically; Fly Network Policies give
per-app default-deny egress; running dockerd/DDEV inside a Machine is possible
but explicitly not the documented pattern, and `*.ddev.site` URLs would not be
publicly reachable.

Direction:

- **One Fly app per site**, created by the control plane via the Machines API
  (org-scoped token as a Fly secret): one Machine (WordPress + MariaDB as a
  multi-container Machine) + one volume. Clone URL = `https://<site-app>.fly.dev`
  (TLS for free). Wildcard custom domain + `fly-replay` routing is a later
  refinement, not M2 scope.
- **`DdevEnv` gets a Fly counterpart** behind the same interface
  (`ferry-cli/src/env/ddev.ts`): provision (create app/machine/volume),
  db import, wp-cli via machine exec, binlog read-out, clone URL, verify.
- **Plan 6b is absorbed**: per-site Firecracker isolation comes free with the
  Machine; egress default-deny via Network Policies. Remaining 6b concerns
  become M2 design questions: the license-endpoint stub proxy, moving the
  write secret out of agent reach (today `profile.json` under `$HOME` is
  readable from the agent's shell), and **where the agent runs** — control
  plane vs inside the site machine (the latter is the real 6b promise).
- Open M2 questions, recorded not answered: agent placement, file sync between
  agent workdir and site machine, remote binlog tailing, per-site cost
  (~$7–13/mo always-on; much less with autostop).

## 8. Security posture (until M2 isolation lands)

- Signup capped at 2 accounts; no public launch.
- No `ANTHROPIC_API_KEY` on Fly in M1 → no agent process exists there → no
  agent host-shell risk on the control plane.
- Agent web tools (WebSearch/WebFetch) stay disabled regardless
  (`ferry-server/src/agent/sdk-runner.ts:153`).
- Testing only against sites Robbert controls.

## 9. M1 success criteria

1. `https://<app>.fly.dev` serves the dashboard; Robbert signs up, logs in, and
   his account survives a redeploy (volume-backed DB proven).
2. Third signup attempt is rejected (403) with `FERRY_MAX_ACCOUNTS=2`.
3. A push to `main` deploys automatically; `/api/health` returns 200 after.
4. `Set-Cookie` on Fly carries `Secure`; local http dev still logs in.
5. The assistant, with its own token, reads logs, status, and queries
   `server.db` over ssh without Robbert's involvement.
6. `/api/plugin.zip` downloads a valid zip behind login.
7. A deploy shows a clean drain in the logs (no hard-deadline kill).
8. All suites and typechecks stay green (plugin 216 / cli 146 / server 209 /
   dashboard e2e 18 at time of writing).

## 10. Out of scope for M1

Clone/sync/agent on Fly (M2); custom domains; multi-machine/HA; LiteFS;
public signup; any Plan 6b work beyond what §7 absorbs; billing/limits beyond
the account cap.
