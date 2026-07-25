# Plan 3a E2E runbook — control plane against ferry-prod

## Preconditions
- The paired fixture runs: `cd ~/ferry-e2e/prod && ddev start` (never restore it with
  `ddev wp core download` — use the official zip).
- mkcert CA trusted for Node: `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`
- Docker/DDEV running; workspace installed (`npm install` at the repo root).

## Run
    export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
    npm --workspace ferry-server run e2e

Pass = exit 0, `✔ E2E passed in <s>s` with s < 120, phases printed
`info → manifest → resolve → files → git → db → import → done`, clone server-verified.
The script provisions everything under a fresh temp FERRY_HOME and prints it.

## Teardown
    ddev delete -Oy ferry-prod-ddev-site   # the clone project created by the run
    rm -rf <printed FERRY_HOME>

## Troubleshooting
- `fetch failed ... self-signed certificate` → NODE_EXTRA_CA_CERTS not exported in this shell.
- `pair: 400` → pairing code expired (10 min TTL); the script issues a fresh one per run,
  so this usually means the fixture plugin is deactivated.
- Sync hangs in `import` → DDEV cold start; check `ddev list` and Docker resources.
- Env vars: `FERRY_E2E_PROD` (fixture dir), `FERRY_E2E_URL` (fixture URL), `PORT` unused here
  (the script binds an ephemeral port).
