# Ferry SaaS — walking skeleton specs

**Date:** July 24, 2026
**Status:** design, locked in after design session (see `docs/2026-07-24-raw-conversatie.md`)
**Builds on:** `ferry-walking-skeleton.md` (rev. 2) — the CLI+plugin base design (pull, airtight clone, asymmetric write-back). This document locks in the SaaS layer on top of it.

Everything in this document was discussed and decided in the design session. Where something was deliberately deferred or remains open, that is stated explicitly in §14 and §15. Details that were not discussed are marked *not specified*.

---

## 1. Proposition & vision

**Proposition (max 20 words):** give coding agents full local access to WordPress sites without SSH: clone safely, debug at production parity, and push fixes back under control.

**Underlying vision:** if every WordPress site could be edited with Claude Code, every problem would be solved at least 10× faster. Editing directly on production is unwise; a staging environment that stays in sync with production is too complex today — there is too much friction there.

**Target audience:** developers and agencies (not site owners — they don't know they need this). Market assessment from the session: **8/10** — cloning already exists (WP Migrate, InstaWP, BlogVault), but agent-native debugging plus safe push-back with drift detection is something nobody does. Timing is perfect; execution and distribution will determine success.

### End-vision flow (user perspective)

1. User creates an account on agent-ferry.com.
2. User creates a site.
3. User installs the ferry plugin on the site.
4. User receives a pairing code and pairs in the dashboard.
5. User tests the connection.
6. Initial sync of the production site within 2 minutes into a DDEV environment on our server:
   - no media;
   - hook for replacing the domain at runtime;
   - same specs as production (PHP/MariaDB versions, wp-config constants);
   - reachable DDEV domain;
   - with database;
   - with version control (git).
7. User opens the site screen and starts a chat with the ferry agent. The agent investigates (like Claude Code), comes back with a plan, makes changes to code and database, checks whether it can push to production without problems, and saves the changes to db and code as a version.
8. On a later session (e.g. 2 days later), ferry pulls only the changes to database and code.

---

## 2. Scope & coverage

- **~90% of standard WordPress sites is feasible and enough to start with.**
- Out of scope, **refuse hard with a clear error message**: multisite, aggressive security plugins/WAFs, extreme host limits, non-standard structures. Edge cases get solved later.
- **Pull confidence of 70/100 accepted** to keep up momentum. Validation route without real test sites (task, later): study the code, support forums, and changelogs of Duplicator, UpdraftPlus, and All-in-One WP Migration — they have already solved these exact problems (timeouts, encoding, WAFs) for years. Their support forums are a free catalog of edge cases per host, and their changelogs show which bugs actually occur.

---

## 3. Stack

| Layer | Choice |
|---|---|
| Plugin (site) | Native PHP, no external dependencies — WP REST API (routes), `deflate_add()` (compression), `hash()` (verification), `hash_hmac()` (auth), `$wpdb` (export), own tar writer (~60 lines) |
| Transport | HTTPS via WP REST API (`/wp-json/ferry/v1/files`), HMAC-signed requests, resumable ~8MB batches. No FTP or SSH. |
| SaaS server | Node/TypeScript — undici or got (HTTP with retries/streams), p-queue/p-limit (parallelism with backoff), tar-stream or node-tar, built-in zlib and crypto |
| Clone environment | DDEV per site, production parity, on our server |
| Version control | git over the entire WP root |
| DB tracking | MySQL row-based binlog in DDEV |
| Uploads/media | not cloned; 302 fallback to production |
| Agent | Claude Agent SDK |
| Isolation | Firecracker microVM per site |

No battle-tested library exists for the download protocol itself (batches, resume headers, HMAC) — that thin orchestration layer is our own code, and it is exactly the part we want to own ourselves.

---

## 4. Pull mechanics

**Approach:**

1. Plugin provides a **manifest with hashes** of all files.
2. Core and wp.org plugins are **reconstructed locally via official checksums** (content-addressable cache) — only the ~3MB of unique files go over the wire.
3. **Exclude uploads and backups.** Media is served directly from production (302 fallback).
4. **Database via keyset pagination with a byte budget.**
5. After that, never a full clone again: **Merkle tree and block fingerprints for deltas.**

**Duration:** first pull ~60s, refresh in seconds.

**Downloading the unique files:** the CLI splits them into packages of ~8MB and requests them via 4–6 parallel requests. The plugin packs them (tar) and stops cleanly before the server time limit; the next request continues where it left off. Every download is verified via a hash.

---

## 5. Version control

- Every clone becomes a **git repo on the server**, over the **entire WP root (docroot), including core**. Reason: the diff must show exactly what needs to go back to production — including a hacked or patched core file.
- Every pull is a **commit on the `production` branch**; the agent works on **its own branch**. The diff between those two shows exactly what needs to go to production. Rollback, history, and conflict detection come for free; agents are already at home in git.
- **`.gitignore`:** locally generated artifacts — `wp-config.php`, `.ddev/`, the uploads directory — must never show up as a pushable change.
- **Nested `.git` directories** are renamed to `.git.ferry-disabled` during the pull — otherwise git treats them as submodules and those files disappear from the diff.
- Confidence: **90/100**. The remaining 10: binary files diff poorly, and the database falls outside it (needs its own versioning, see §6).

---

## 6. Tracking database changes (in the clone)

- **MySQL row-based binlog in DDEV**, not PHP hooks. We control the database in the clone, so binlog can simply be enabled. This captures every change with before/after values, regardless of how it was written — including direct `$wpdb` writes and writes that bypass `$wpdb` entirely (custom tables). CDC tools like Debezium have proven this pattern for years. More reliable than PHP hooks.
- From the binlog, a **journal of typed operations** (old + new) is generated. That journal **commits along in git** next to the code.
- **Push = replay the journal on production; rollback = replay it in reverse.**
- Changes to non-core tables and schema changes are riskier than options/postmeta — **show those explicitly at push time and require confirmation**.

---

## 7. Database refresh between sessions (production side)

- **Production owns that data** — the clone is a snapshot; drift between sessions is not a problem.
- On a new session: refresh via **block fingerprints** — request a cheap checksum per 10k rows, re-fetch only the blocks that differ (seconds). This is Percona's pt-table-checksum pattern, *the* industry standard for MySQL comparison.
- Need current data mid-session? **Inject a single targeted row via the control plane.**
- Binlog CDC on production (theoretically the number 1, like Debezium — exact, realtime, incremental) is not possible: it requires replication privileges you don't have on shared hosting. Within the constraint (PHP plugin, no shell), block fingerprints are the top option — theoretically second, practically first. Plus a WP-hook journal as a cheap first-line signal.

---

## 8. Push mechanics

**Two-phase commit**, like Capistrano/blue-green deploys — the world standard, translated to shared hosting without shell:

1. Diffs go to a staging directory first.
2. Verify hashes.
3. Drift check (file hashes + read set, see §9).
4. Atomic `rename()` swap with backup.
5. Replay the DB journal as typed operations.
6. Finish with a smoke test — if it fails, **automatic rollback**.

---

## 9. Drift detection

**Model:** git three-way — the snapshot commit is the merge base, production-now is "theirs", the agent branch is "ours".

- **Files:** hash-compare only what you overwrite (compare-and-swap, like HTTP If-Match).
- **Database:** read-set check — check only the keys the fix actually read (optimistic concurrency, like Postgres' serializable snapshot isolation). Deliberately ignore all other drift.

**From 75 to ~95 for data:** move the check inside the write transaction on production. The commit call performs a single DB transaction:

1. `SELECT ... FOR UPDATE` on all read-set rows;
2. verify the expected old values (compare-and-swap);
3. apply the typed operations;
4. commit.

Mismatch → rollback, nothing applied. The race window (TOCTOU) disappears entirely — this is how etcd and DynamoDB conditional writes work. In addition, the agent declares its assumptions **explicitly as preconditions** ("this fix assumes option X = Y") — those catch what read-set logging misses.

In plain terms: instead of two separate steps — first look ("has anything changed?"), then write — looking and writing happen in one indivisible step. The plugin briefly locks the rows involved, checks they still hold the values the fix expected, and only then applies the change. If anything is off, nothing happens at all and you get a notification. All or nothing — no gap left.

---

## 10. The agent

- **Claude Agent SDK.** The clone is a filesystem with git, wp-cli, and a shell — exactly the environment Claude Code was trained and optimized for (grep, read, edit, bash).
- The agent loop, sessions, subagents, and permission model come for free; ferry commands attach as MCP tools or custom tools.
- **Costs: we (the company) pay the Claude token bill**, not the end user per session.

---

## 11. Multi-tenant infra & isolation

- **Customer code is untrusted code — Docker alone is too weak.** Firecracker microVM per site (as Fly.io and E2B do): hard isolation, starts in ~1s, pauses when nobody is working — you only pay for active sessions.
- **Egress closed by default at the network level** — which immediately reinforces the containment harness.
- DDEV runs unmodified inside the VM.
- **Provider is NOT chosen:** Firecracker is the technique, Fly.io merely one of the providers — that choice can come later.
- **Local development: plain DDEV without VM isolation.** Isolation is only needed once there are real customers.

---

## 12. Containment harness & license stubs

Defense in layers — the clone must never actually call out (no real mails or payment requests):

1. **PHP filters** inside WordPress for behavior (mails/HTTP/cron blocked, per the base document).
2. **Network egress closed at the VM level** as the guarantee.
3. **Transparent stub proxy at the VM level** (WireMock/VCR pattern) that all outbound traffic must pass through:
   - known license endpoints (EDD, Freemius, WooCommerce.com) get **declarative stub fixtures** answering "license valid", so plugins don't disable themselves;
   - everything else is **blocked and logged** — that log is the backlog of stubs still to be written.

---

## 13. Pairing, dashboard & approval UX

### Pairing

**Device-flow pattern** (like TV apps and `gh auth login`): the plugin shows a short code, the user pastes it into the dashboard, server and plugin exchange keys. The code is short-lived and single-use.

**PAKE deliberately deferred.** Three reasons: the gain is marginal (the code is single-use, short-lived, over HTTPS — PAKE mainly protects against a leaked screenshot in that one minute), an external crypto library undermines the trump card "no dependencies, trivially auditable" that earns the plugin its place on customer sites, and pairing is one isolated seam — cheap to build in later, no rewrite. Building it now = buying delay for risk that doesn't exist yet.

### Dashboard

Thin shell on top of the engine. Agent sessions stream live via SSE; all state in readable files per site.

### Approval UX: the change card

The GitHub PR pattern, translated for non-technical users. One card with layers, from understandable to technical:

```
┌─────────────────────────────────────────────┐
│ ✅ VAT calculation fixed                    │
│                                             │
│ "The wrong VAT on orders was caused by     │
│  an incorrect setting plus a bug in the    │
│  theme. I have fixed both."                │
│                                             │
│ ▸ 2 files changed              (expand)    │
│ ▸ 1 setting: old → new         (expand)    │
│                                             │
│ Drift check: ✅ production unchanged        │
│ After push I test: checkout, order list    │
│                                             │
│         [ Push to production ]              │
└─────────────────────────────────────────────┘
```

- **Top:** a plain-language summary, written by the agent — that is what a site owner reads and decides on. **Expandable below:** the technical diff and DB operations (old → new), for the developer/agency. Plus the drift-check status and what the smoke test will verify. One card serves both audiences without scaring anyone off.
- **One button, "Push to production".** Nothing ever goes to production automatically without that single human click.
- During the push: live progress. Afterwards: the smoke test result and a **rollback button that stays visible** — undoing is one click, not a support ticket.
- The card appears **inline in the chat** (that's where you decide, in the context of the conversation) and also lives as a **standalone object** in a "Changes" tab per site, with status (draft, pushed, rolled back). Same model as GitHub: the discussion happens in the conversation, but the PR has its own page. Important for later: a card can then be shared ("could you approve this?") without making anyone read the whole chat.

---

## 14. Deliberately deferred

- **FastCDC content-defined chunking** (restic/borg pattern) instead of whole-file hashes — deduplicates across all customer sites, makes refreshes of large files cheaper.
- **PAKE** for pairing (see §13).
- **Provider choice for Firecracker hosting** (Fly.io or otherwise).
- **Pull validation via existing migration plugins** (Duplicator, UpdraftPlus, All-in-One WP Migration) — recorded as a task.

## 15. Open points (not yet discussed)

- Pricing toward the end user.
- Audit log and monitoring.
- Onboarding and distribution.

## 16. Confidence scores from the session

| Component | Score | Biggest remaining risk |
|---|---|---|
| Pull mechanics (90% of sites) | 70/100 | WAFs/security plugins, db export encoding — only certain after ten real customer sites |
| Git over the entire WP root | 90/100 | binary files, database falls outside it |
| Drift detection (files) | 90+/100 | — |
| Drift detection (data, with transactional check) | ~95/100 | direct `$wpdb` reads missing from the read set |
| Market relevance | 8/10 | execution and distribution determine success |
