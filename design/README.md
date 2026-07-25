# Design

The dashboard design lives in the Claude Design project **Ferry SaaS Dashboard Design** — that project is the single source of truth; no exported copy is kept in this repo.

- Project: https://claude.ai/design/p/1132dc21-be82-4723-9921-8d425583d6cf?file=Ferry+Dashboard.dc.html
- Files there: `Ferry Dashboard.dc.html` (all screens), `support.js`

To work with the current version in a Claude Code session, pull it via the DesignSync tool (authenticates through the claude.ai login; `/design-login` as fallback for sessions without one) and write it into this directory as a disposable cache — never commit the export back.

Decisions that constrain the design are recorded in `docs/ferry-saas-walking-skeleton-specs.md`: §1 (Ferry is a dev environment — no clickable clone domain in the dashboard) and §13 (agent screenshots on the change card are the visual approval evidence).
