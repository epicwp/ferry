# Plan 4 acceptance runbook — real agent against the ferry-prod fixture

Preconditions: fixture running at ~/ferry-e2e/prod; `ddev delete -Oy ferry-prod-ddev-site`;
`export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`; `export ANTHROPIC_API_KEY=<key>`.
Optional caps for the run: `FERRY_AGENT_MAX_BUDGET_USD=2`.

1. `npm --workspace ferry-server run dev` and `npm --workspace ferry-dashboard run dev`.
2. Sign up at http://localhost:5173, add `https://ferry-prod.ddev.site`, pair
   (`cd ~/ferry-e2e/prod && ddev wp eval 'print(json_encode(\Ferry\Auth::issue_pairing_code()));'`),
   run the initial sync to Ready.
3. Open the site → Agent chat. Ask: "The site title looks wrong on the homepage —
   can you find where it's set and fix a typo in it?" (or any small, real defect you
   plant in the fixture theme first).
4. PASS criteria — all of:
   - tool rows stream live (grep/read/ddev wp visible while it works); prose streams token-wise
   - the agent states a plan before editing
   - `git -C $FERRY_HOME/clones/ferry-prod-ddev-site log agent/work` shows its commit(s);
     `git diff production` shows exactly the fix
   - the agent verified inside the clone (`ddev wp` or an HTTP check) and said so
   - a turn_end event with cost lands in agent_events (check the DB or the SSE stream)
   - `git push` attempts (if any) were denied and the agent recovered
5. Restart the ferry-server dev process mid-session; send a follow-up message —
   the session resumes with context intact.
6. Press "New session" — thread clears; a fresh question starts clean.
7. Cost-semantics check: in the same session, send a second message after the first turn
   completes, then compare the two `turn_end` events' `totalCostUsd` in `agent_events` (DB
   or SSE stream). If the second value includes the first (i.e. it's cumulative rather than
   per-turn), record that in the PR description — the design doc's SUM-over-events cost rule
   must become MAX-per-session before anything bills on it.

Record the observed total cost for the session in the PR description.
