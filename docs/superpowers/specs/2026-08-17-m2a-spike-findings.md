# M2a spike findings — Fly Machines API (executed 2026-08-17)

Live spike against Robbert's Fly account (org `personal`), 48h org token, throwaway
app `ferry-m2a-spike` (created and destroyed the same hour). All calls below were
executed verbatim and worked unless noted.

## 1. App / volume / machine creation (Machines REST API)

Base `https://api.machines.dev/v1`, header `Authorization: Bearer <org token>`.

- `POST /apps` body `{"app_name":"…","org_slug":"personal"}` → `{"id":"…","created_at":…}`.
- `POST /apps/{app}/volumes` body `{"name":"data","size_gb":3,"region":"ams"}` →
  volume object with `id` (`vol_…`), `encrypted:true` by default.
- `POST /apps/{app}/machines` with `config` exactly as used:

```json
{
  "region": "ams",
  "config": {
    "image": "registry-1.docker.io/library/wordpress:php8.2-apache",
    "guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 1024},
    "mounts": [{"volume": "<vol id>", "path": "/data"}],
    "files": [{"guest_path": "/etc/ferry/spike-test", "raw_value": "<base64>"}],
    "services": [{"protocol": "tcp", "internal_port": 80,
      "ports": [{"port": 80, "handlers": ["http"]}, {"port": 443, "handlers": ["tls", "http"]}]}],
    "restart": {"policy": "always"}
  }
}
```

  Response carries `id` (machine id) and `private_ip`.
- `GET /apps/{app}/machines/{id}/wait?state=started&timeout=60` → `{"ok":true,"state":"started",…}`.
- Teardown: `DELETE /apps/{app}?force=true` → 202; app (incl. machines + volume) gone.

## 2. IP allocation (GraphQL — the one non-Machines-API call)

`POST https://api.fly.io/graphql`, same bearer token:

```graphql
mutation($input: AllocateIPAddressInput!) {
  allocateIpAddress(input: $input) { ipAddress { address type } }
}
```

- `{"input":{"appId":"<app name>","type":"shared_v4"}}` → returns `ipAddress: null`
  BUT works: the app's `sharedIpAddress` field is populated afterwards (shared IPs
  are not dedicated-IP nodes; the null is expected, not an error).
- `{"input":{"appId":"<app name>","type":"v6"}}` → returns the dedicated v6 address.
- Verify query: `query($app:String!){ app(name:$app){ ipAddresses{nodes{address type}} sharedIpAddress } }`.

**FlyApi.allocateIps therefore issues both mutations and treats `ipAddress: null`
on shared_v4 as success (assert no GraphQL `errors` array instead of asserting a
non-null address).**

## 3. Public + private reachability, files, memory

- `https://ferry-m2a-spike.fly.dev/` answered over TLS within seconds of machine
  start (302 — the WordPress installer redirect). Shared v4 + dedicated v6 is
  sufficient for fly.dev TLS routing.
- `files` entry landed: `cat /etc/ferry/spike-test` → contents decoded from
  `raw_value` base64. KB-scale bootstrap files confirmed viable (sited secret).
- Memory on the 1 GB guest with Apache+PHP (wordpress image) running:
  `free -m` → total 962, used 213, available 748. **1 GB leaves ~750 MB for
  MariaDB + sited — the planned `memory_mb: 1024` stands** (MariaDB idles
  ~150–300 MB; bump to 2048 only if a real site shows pressure).
- 6PN from ferry-cp: `http://<machine-id>.vm.ferry-m2a-spike.internal:80/` →
  302 in ~2.1 s on the FIRST request (includes DNS + connect). A provision-time
  health poll with 2 s interval / 120 s deadline is comfortably enough.
- Note: the ferry-cp runtime image has no `curl` (by design, M1); in-process
  undici/fetch reaches 6PN fine (verified via `node -e "fetch(…)"`).

## 4. Registry decision: GHCR public — CONFIRMED

A machine created from `ghcr.io/astral-sh/uv:latest` (public GHCR image, no
credentials passed) pulled and ran (exited per its `sleep` + `restart: no`,
proving pull+exec). **Fly pulls public GHCR images unauthenticated →
`FERRY_SITE_RUNTIME_IMAGE=ghcr.io/epicwp/ferry-site-runtime` stands, matching
the already-committed publish workflow. The GHCR package must be made PUBLIC
after its first publish (Task 15).** registry.fly.io fallback not needed.

## 5. Deltas vs the plan's assumptions

None structural. Two refinements for Task 6/8 implementers:
1. `allocateIpAddress` for `shared_v4` returns `ipAddress: null` on success —
   check for GraphQL `errors`, not for a non-null address.
2. Docker-Hub-style image refs work with the `registry-1.docker.io/library/…`
   prefix AND plain `ghcr.io/…` refs work as-is.
