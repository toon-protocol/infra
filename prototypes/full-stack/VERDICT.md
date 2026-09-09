# VERDICT — full-stack integration: local gateway resolves locally-bought ArNS names

PROTOTYPE — throwaway. Question: *Can the local AR.IO gateway resolve an ArNS
name that was bought on the local Solana validator — so that `buy name → point
ANT at an uploaded data item → fetch the content by name through the gateway`
works fully locally in Docker?*

**YES — proven end-to-end on 2026-09-09, first complete run.** Observed, not
inferred:

1. `turbo-sdk → http://localhost:3000/bundler` upload → data item
   `J4zdIVlQsuwFO8Rbwois_6dfnxz-8Cm1fKp5QMihUW0`, served instantly at
   `/raw/<id>` (optical path, as in gateway-upload).
2. `spawnSolanaANT` + `ario.buyRecord({name:'toon-full-9wqvpf'})` +
   `ant.setRecord({undername:'@', transactionId:<data item id>})` against the
   local validator (as in solana-arns).
3. `GET http://localhost:3000/ar-io/resolver/toon-full-9wqvpf` → 200
   `{"txId":"J4zd…HUW0","ttlSeconds":60,"antId":"Cqsw…HTUv",…}` — the exact
   data-item id.
4. `GET http://toon-full-9wqvpf.ar.localhost:3000/` → 200, body contains the
   unique upload string; headers carry the full ArNS set
   (`x-arns-resolved-id`, `x-arns-ant-id`, `x-arns-ant-program-id` = local ANT
   program id, `x-arns-record: @`, `x-arns-undername-limit: 10`).
5. Undernames too: `ant.setRecord({undername:'www'})` →
   `GET http://www_toon-full-9wqvpf.ar.localhost:3000/` → 200 with
   `x-arns-record: www` (one 404 then success on retry ~3s later — cache).

Core's logs show the real code path: `CompositeArNSResolver → 
OnDemandArNSResolver` ("Resolving name...", then ANT `getRecords` via
`SolanaANTReadable` against `http://solana-validator:8899`). No mainnet Solana
call remains (the gateway-upload prototype's last mainnet touchpoint —
ArNS-cache hydration from mainnet-beta — is now local).

## The env delta: gateway → local-validator ArNS resolution

Everything on top of gateway-upload's proven `gateway-env.conf`
(ar-io-node r83; names as in `docs/envs.md` / `src/config.ts`):

| Var | Value | Why |
|---|---|---|
| `SOLANA_RPC_URL` | `http://solana-validator:8899` | core reads registry + ANTs from the local validator. HTTP JSON-RPC only — `src/system.ts` uses `createSolanaRpc`; **no :8900 websocket needed by the gateway** (only the driver scripts use WS). |
| `ARIO_CORE_PROGRAM_ID` | `8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1` | = validator genesis id = SDK `DEVNET_PROGRAM_IDS.core`. The upstream compose **defaults are the mainnet ids**, so all four must be set. |
| `ARIO_GAR_PROGRAM_ID` | `7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz` | " |
| `ARIO_ARNS_PROGRAM_ID` | `6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp` | " |
| `ARIO_ANT_PROGRAM_ID` | `DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX` | " — also pinned into `SolanaANTReadable` by the on-demand resolver and echoed as `x-arns-ant-program-id`. |
| `ARNS_ROOT_HOST` | `ar.localhost` | enables the ArNS subdomain middleware + envoy's `TVAL_ARNS_ROOT_HOST` vhost. `*.localhost` resolves to loopback here (verified `getent hosts foo.ar.localhost` → `::1`); `curl --resolve`/Host-header works as fallback. |
| `ARNS_RESOLVER_PRIORITY_ORDER` | `on-demand` | default is `on-demand,gateway`; the `gateway` fallback would call `https://__NAME__.turbo-gateway.com` on every local miss. |
| `ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS` | `5` | see boot ordering below (default 120). |
| `ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS` | `30` | default 3600; keeps the base-name list fresh for iterative dev. |
| `ARNS_CACHE_TTL_SECONDS` | `30` | default 86400; lets ANT record edits show up quickly. |

Note: `docs/envs.md` in r83 lists *different* "staging devnet" program ids
(`5iU1…`, etc.) — stale relative to the current staging deploy. The authority
is what's actually loaded on the validator = `DEVNET_PROGRAM_IDS` in
`@ar.io/sdk@4.3.0` = `program-ids/staging.json` (see solana-arns/VERDICT.md).

## Boot ordering (the caching question, answered)

- The base-name list (`ArNSNamesCache`) hydrates **once at core boot**
  (`getArNSRecords` = full `getProgramAccounts` scan) and re-hydrates on a
  cache **miss** at most every `ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS`
  (default **120**). A name bought *after* gateway start is therefore NOT a
  restart problem — it's a bounded delay: first request 404s
  ("Base name not found in ArNS names cache") and triggers re-hydration; with
  the interval at 5s the name resolved on the second attempt (~3s later).
  With defaults you'd wait up to ~2 min. **No gateway restart, no
  buy-before-boot requirement.** Locally the registry is tiny, so a
  re-scan-per-miss is free; on mainnet this knob would be expensive — keep the
  override local-only.
- Required strict ordering that remains:
  1. validator healthy → `seed.mjs` (`ario_arns::initialize`) — must precede
     any buy; core does NOT need it before boot (hydration of an
     uninitialized/empty registry succeeds with 0 names).
  2. core healthy → `seed-head-block.sh` → bundler stack → uploads (unchanged
     from gateway-upload; only receipt signing needs it).
  3. buy/setRecord any time; resolution follows within the miss-refresh
     interval.
- The compose override adds `core depends_on solana-validator: healthy` so
  boot-time hydration targets a live RPC. Probably soft (hydration failure is
  retried on miss) but untested without it.

## Integration gotchas found (beyond the two siblings' findings)

1. **Sandbox redirect breaks `/​<id>` fetches once `ARNS_ROOT_HOST` is set.**
   Any `GET /<43-char-id>` on a non-matching host 302s to
   `https://<base32(id)>.ar.localhost/<id>` (protocol defaults to https, port
   dropped) — unreachable locally. Failure signature: driver `fetch failed …
   ECONNREFUSED 127.0.0.1:443`. Use `/raw/<id>` (bypasses the sandbox
   middleware), or set `SANDBOX_PROTOCOL=http` (still loses `:3000`, so
   `/raw` is the practical local answer).
2. **Node `fetch()` silently drops a user-set `Host:` header** (forbidden
   header). Hit the real vhost URL (`http://<name>.ar.localhost:3000/`)
   instead; `curl -H 'Host: …'` is fine.
3. **Compose multi-file paths**: relative volume paths resolve against the
   FIRST `-f` file's directory. Run with `--project-directory .` so the
   override's `../solana-arns` mounts work AND `./data` lands in this dir
   instead of colliding with the sibling's gateway data (stale core.db there
   would carry a poisoned/foreign state).
4. `ARNS_CACHE_TYPE` defaults to `redis` in the compose — works as-is (redis
   ships in the gateway stack); no extra wiring.
5. `ario_gar` still never initialized; resolution doesn't touch it
   (`RUN_OBSERVER=false`). Unchanged unknown from solana-arns.

## Implications / recommendations for the real infra compose

1. **Topology proven**: upstream gateway compose + bundler compose + one
   validator service + arlocal on the shared `ar-io-network`, single project.
   Total gateway delta vs upstream defaults is gateway-upload's ~15 vars plus
   the 9-var block above.
2. **Init containers/jobs**, in order: (a) validator-seeder (node + seed.mjs,
   after validator healthy, idempotency guard = "ArnsConfig exists");
   (b) head-block seeder (after core healthy — tiny sqlite insert; script or
   upstream patch); (c) nothing else — name purchases are runtime operations,
   not boot steps.
3. **Set the ArNS cache knobs by environment**: the three cache overrides
   (miss-refresh 5–15s, hit-refresh, TTL) are what make local dev feel
   instant; don't ship them to anything pointed at mainnet.
4. `ARNS_ROOT_HOST=ar.localhost` gives browser-usable URLs
   (`http://<name>.ar.localhost:3000/`) with zero DNS setup on modern
   systems. Document `/raw/<id>` (not `/<id>`) for by-id fetches, or set
   `SANDBOX_PROTOCOL=http` and accept sandbox-subdomain URLs without port
   only behind a :80/:443 proxy.
5. The store's flow maps 1:1: turbo-sdk `uploadServiceConfig.url` →
   `http://<gateway>:3000/bundler`; ArNS buy via its existing devnet override
   path pointed at the local RPC; then the content URL is
   `http://<name>.<ARNS_ROOT_HOST>:3000/` immediately (≤ miss-refresh
   interval) after `setRecord`.

## Not covered

- `ARNS_CACHE_TYPE=node` (ran with the compose-default redis).
- Behavior with the *default* 120s miss-refresh (inferred bounded-delay, not
  timed end-to-end).
- Manifests (multi-path content behind an ArNS name), `APEX_ARNS_NAME`,
  primary names, `syncAttributes`-driven TTL propagation into resolution.
- Observer/epoch machinery against the local validator (`ario_gar`
  uninitialized; observer disabled).
