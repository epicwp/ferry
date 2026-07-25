# Ferry Plan 3 — SaaS control plane & dashboard shell (design)

**Date:** July 25, 2026
**Status:** approved in design session
**Builds on:** `docs/ferry-saas-walking-skeleton-specs.md` (SaaS specs, incl. the 2026-07-25 §1 decision), `docs/ferry-walking-skeleton.md` (base design rev. 2), the Plan 1/2 engine on `main` (PRs #1–#4), and `docs/superpowers/plans/2026-07-24-ferry-roadmap.md` (Plan 3 scope: design screens 1–5 + auth).

Plan 3 turns the local CLI engine into a hosted flow: a Node/TS control plane that runs the Plan-1/2 engine per site on our infrastructure (plain DDEV, no VM isolation yet — spec §11), plus a dashboard shell for the end-vision flow steps 1–6 (spec §1): account → site → plugin install → pairing code → connection test → initial sync < 2 min → verified clone.

---

## 1. Decisions made in this session

1. **"Reachable clone URL" means server-verified reachability.** Per the §1 decision (clone is agent-only; `*.ddev.site` resolves to 127.0.0.1) the done-criterion is reinterpreted: after a successful pull, the control plane itself performs an HTTP check on the clone URL and only then marks the sync complete. The dashboard shows the URL as copyable text with a "verified" check — never as a customer-facing link. No ingress is built (deferred, spec §14).
2. **The server imports the engine as a library.** `ferry-server` calls `pull()` directly in-process. The engine gains one seam: an optional progress callback on `pull()`. No child-process/JSON-output mode; the VM boundary in Plan 6 will reshape that anyway.
3. **Development runs entirely on the Mac.** Server, dashboard, and clones run locally; the existing `ferry-prod` DDEV fixture plays production. Matches spec §11 (local development: plain DDEV, no VM isolation). Real hosting comes later.
4. **Stack: Fastify + React/Vite + SQLite.** One Fastify server for API + SSE that also serves the built dashboard; React SPA built with Vite; accounts/sessions in one SQLite file; all engine state stays in the existing readable files per site (spec §13). Auth: email + password.
5. **One design doc, two implementation plans.** Plan 3a: control plane API, fully testable without a browser. Plan 3b: dashboard shell on top. Each with its own E2E gate.

---

## 2. Architecture

### 2.1 Packages

A root `package.json` with npm workspaces is added. Layout:

```
ferry/
  ferry-plugin/       (existing, PHP — untouched except being zipped for download)
  ferry-cli/          (existing engine; gains the progress callback)
  ferry-server/       (new — Fastify, TypeScript, ESM, same conventions as ferry-cli)
  ferry-dashboard/    (new — React + Vite + TypeScript)
```

- `ferry-server` depends on `ferry-cli` via the workspace and imports `link()`, `pull()`, `FerryClient`, and the profile helpers directly. Pulls run in the server process. A crash in a pull is caught and recorded as a failed sync; it does not take the server down (acceptable single-machine risk, decision 2).
- `ferry-dashboard` in development runs on the Vite dev server with a proxy to the API; otherwise Fastify serves `ferry-dashboard/dist` statically.

### 2.2 Storage — two kinds, strictly separated

**SQLite** (`~/.ferry/server.db`, via `better-sqlite3`) holds only what the engine does not own:

```sql
users    (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL, created_at TEXT NOT NULL)
sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
          expires_at TEXT NOT NULL)
sites    (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
          name TEXT NOT NULL, url TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL,          -- new | paired | syncing | ready | error | refused_multisite
          last_error TEXT, last_sync_at TEXT, verified_at TEXT,
          created_at TEXT NOT NULL)
```

**Files per site** (existing `~/.ferry/sites/<slug>/`) remain the source of truth for everything the engine produces: `profile.json` (url, secret, clonePath, site info), db dumps, provenance reports. The server reads them; it never duplicates them into SQLite. The site `secret` lives only in `profile.json` — never in SQLite, never in an API response.

Pairing codes are stored nowhere on our side: the plugin shows the code, the user pastes it, the server exchanges it immediately via `link()`. SQLite records only the outcome (site status).

Site identity: `slug` comes from the existing `slugFromUrl()`. The slug is unique per server, so two accounts cannot add the same site in the walking skeleton — accepted and documented.

Passwords are hashed with `scrypt` from `node:crypto` (no extra dependency). Sessions are opaque random tokens in an `httpOnly`, `SameSite=Lax` cookie. CSRF protection beyond `SameSite=Lax` + JSON-only bodies is deliberately out of scope for the walking skeleton.

### 2.3 API surface

```
POST /api/auth/signup        {email, password}        → session cookie
POST /api/auth/login         {email, password}        → session cookie
POST /api/auth/logout
GET  /api/me                                          → {email}

GET  /api/sites                                       → list incl. status, last_sync_at
POST /api/sites              {name, url}              → site (status: new)
GET  /api/sites/:id                                   → site detail
POST /api/sites/:id/pair     {code}                   → paired | error (incl. multisite refusal)
POST /api/sites/:id/test                              → {wp, php, db, server} | error
POST /api/sites/:id/sync                              → 202 (sync started)
GET  /api/sites/:id/sync/events                       → SSE stream

GET  /api/plugin.zip                                  → ferry-connect plugin zip
```

All `/api/sites/*` routes require a valid session and check site ownership. Clone admin credentials (`PullResult.adminUser/adminPassword`) are never exposed through the API or UI — they are for the agent and stay in the site files.

The plugin zip is built once at server start from the `ferry-plugin/` source directory and served from memory/disk — good enough for development, replaced by a released artifact later.

---

## 3. Flows

### 3.1 Pairing (screens 2–3, device-flow pattern per spec §13)

1. User creates a site (name + URL) → status `new`.
2. Screen 2 shows install instructions + the plugin zip download.
3. User activates the plugin on their site; the plugin shows a short-lived pairing code (existing behavior).
4. User pastes the code in screen 3 → `POST /api/sites/:id/pair` → server calls the existing `link()` (exchanges code at `/ferry/v1/pair`, writes `profile.json` with the secret, clone path under the server's control).
5. Success → status `paired`. Plugin answers `ferry_multisite` → status `refused_multisite` with the hard-refusal message (spec §2.19). Wrong/expired code → inline error, user can retry; site stays `new`.

### 3.2 Connection test (flow step 5)

One button → `POST /api/sites/:id/test` → signed `/ferry/v1/info` call → "Connected — WordPress 6.8, PHP 8.1, MariaDB 10.6". A 403 from a security plugin surfaces here with the recognizable message from spec §3.4 ("got 403 — is a security plugin running?").

### 3.3 Initial sync with live progress (screen 4)

**Engine seam — the only engine change.** `PullOpts` gains an optional callback; behavior without it is byte-for-byte unchanged:

```ts
export type PullPhase =
  | 'info' | 'manifest' | 'resolve' | 'files' | 'git' | 'db' | 'import' | 'done';

export interface PullProgress {
  phase: PullPhase;
  detail?: string;     // free-form, e.g. "wp_posts"
  current?: number;    // e.g. files fetched so far / tables dumped
  total?: number;
}

export interface PullOpts { full?: boolean; onProgress?: (e: PullProgress) => void }
```

Phases follow the real §4.6 flow order. DDEV provisioning stays hidden behind the transport (by design) and surfaces inside `import` (which awaits `envReady`). `files` and `db` carry counters (x of y files/tables); the transfer and db layers get an optional callback parameter threaded through to feed them.

**Server side.**

- `POST /api/sites/:id/sync` → 202, status `syncing`, pull starts in-process. One sync per site at a time (a second request while one runs → 409); different sites may sync concurrently — no global cap in Plan 3 (dev machine; revisit with real hosting).
- The server keeps the latest sync state per site in memory: `{status, phase, current, total, detail, error?}`.
- **SSE protocol:** every message on `/api/sites/:id/sync/events` is the *full current state* as JSON — no deltas. On connect the server immediately sends the current state, then a message per update. A page refresh mid-sync therefore shows the right position instantly, and the browser's automatic `EventSource` reconnect needs no replay bookkeeping.

**Clone verification (decision 1).** After `pull()` resolves, the server performs an HTTP GET on the clone URL (the mkcert root CA is trusted in dev via `NODE_EXTRA_CA_CERTS`) and requires HTTP 200 with a non-empty HTML body. Only then: status `ready`, `verified_at` set, final SSE message. Screens 4/5 show "Clone verified ✓" plus the URL as copyable text.

---

## 4. Dashboard shell (Plan 3b — screens 1–5 + 17, all copy in English)

Thin React shell over the API. The dashboard design lives in the Claude Design project **Ferry SaaS Dashboard Design** (see `design/README.md`; pull the current version via DesignSync as a disposable cache, never commit the export). It is the reference for look & feel; its Dutch copy is translated to English. The four already-specified design adjustments apply — in Plan 3's screens concretely: no clickable clone domain; URL as text + verified status.

| Screen | Content |
|---|---|
| 17 Auth | Sign up / log in, email + password |
| 1 Empty list | "Add your first site" CTA |
| 2 New site | Name + URL form → install instructions + plugin zip download |
| 3 Pairing | Code input, inline errors (wrong/expired code, multisite refusal) |
| 4 Sync progress | Live phases via SSE → "Clone verified ✓" + URL as copyable text. No clone admin credentials in the UI. |
| 5 Sites list | Status chip per site (`new`, `paired`, `syncing`, `ready`, `error`, `multisite refused`) + last sync time |

---

## 5. Error handling

- **Pull fails** → status `error`, message persisted (`last_error`) and shown, retry button re-runs the sync.
- **SSE drops** → `EventSource` auto-reconnects; the connect-time state snapshot restores the view.
- **Server restarts mid-sync** → progress lived in memory, so at startup every site in status `syncing` is honestly set to `error` ("interrupted by restart — retry").
- **Multisite** → refused hard at pair time with the clear message; status `refused_multisite` visible in the list.
- **Security-plugin 403 / wrong code / auth errors** → each their own recognizable inline message.

## 6. Testing & gates

- **Engine seam (in Plan 3a):** ferry-cli unit tests assert the progress events fire in the documented order with plausible counters (existing stub infrastructure), and that `pull()` without a callback is unchanged.
- **Server:** vitest; API tests via Fastify's `inject`, sync/SSE state machine tested against a stubbed engine.
- **Plan 3a E2E gate (no browser):** scripted run against the real `ferry-prod` DDEV fixture: signup → create site → pair (code read from the fixture) → connection test → sync while following SSE → clone verified, **end-to-end under 2 minutes**.
- **Plan 3b E2E gate:** Playwright happy path (sign up → add site → pair → watch progress → `ready` in the list) plus a manual comparison of the five screens against the design.
- **Process:** subagent-driven development per task (fresh implementer + independent reviewer), whole-branch review at the end — same as Plans 1/2.

## 7. Out of scope for Plan 3

Agent/chat (Plan 4); write-back, push, change cards (Plan 5); VM isolation, ingress/public clone domains, warm standby, billing (Plan 6 / deferred per spec §14); email verification and password reset; sharing a site between accounts; rate limiting; deployment of the control plane itself.
