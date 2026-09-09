PROTOTYPE — throwaway; answers: can local gateway+Turbo upload/serve work in Docker?

# gateway-upload prototype

Runs the AR.IO gateway (ar-io-node r83) + Turbo upload-service bundler sidecar +
ArLocal fully locally in Docker, uploads a data item via `@ardrive/turbo-sdk`,
and fetches it back through the local gateway. **Answer: YES — see `VERDICT.md`.**

Wallets here (`throwaway-*.json`) are freshly generated throwaways with zero AR.
Env files are named `*.conf` (not `*.env`) only because this workspace denies
writing `*.env` files; docker compose `--env-file` doesn't care.

## Layout

- `ar-io-node/` — shallow clone of https://github.com/ar-io/ar-io-node at tag `r83` (unmodified)
- `gateway.override.yaml` — remaps core host port 4000→3004 (4000 taken by a sibling stack) and adds `textury/arlocal:v1.1.66`
- `gateway-env.conf` — gateway env deltas (see VERDICT for the full list)
- `bundler-env.conf` — bundler env (per `.env.bundler.example` + `SKIP_BALANCE_CHECKS=true`)
- `seed-head-block.sh` — REQUIRED post-boot hack: fakes a head block in core's SQLite so the upload service can sign receipts
- `upload-roundtrip.mjs` — driver: upload via turbo-sdk → fetch via gateway → GraphQL
- `throwaway-bundler-wallet.json` — bundler identity (`_AfaQWjzW9cnVIDMtb-ufTxSrgWLsvdWe0zxFm_AldE`)
- `throwaway-uploader-wallet.json` — uploader identity (`HKO0xRhh2AB2QA_GffBE3sToWSkwVWkjPl4EeiIA9uc`)

## Run

```bash
cd prototypes/gateway-upload
npm install   # arweave + @ardrive/turbo-sdk

# 1. gateway stack (envoy :3000, core :3004, arlocal :1984, observer :5050)
docker compose -p proto-gateway-upload --env-file gateway-env.conf \
  -f ar-io-node/docker-compose.yaml -f gateway.override.yaml up -d

# 2. once core is healthy (~15s), seed the fake head block (idempotent)
./seed-head-block.sh

# 3. bundler stack (upload-service :5100, fulfillment, postgres, localstack)
docker compose -p proto-gateway-upload --env-file bundler-env.conf \
  -f ar-io-node/docker-compose.bundler.yaml up -d

# 4. round trip
node upload-roundtrip.mjs
```

Teardown (leaves files):

```bash
docker compose -p proto-gateway-upload --env-file bundler-env.conf -f ar-io-node/docker-compose.bundler.yaml down
docker compose -p proto-gateway-upload --env-file gateway-env.conf -f ar-io-node/docker-compose.yaml -f gateway.override.yaml down
```

## Known noise (harmless)

- `observer` crash-loops (no observer wallet configured; `RUN_OBSERVER=false` doesn't stop the container, only its work — it exits and restarts). Ignore.
- fulfillment logs `SQS ... NonExistentQueue` for ~20s at boot while localstack's init creates the queues; self-recovers.
- fulfillment `Failed to fetch USD/AR rate` from `https://payment.ardrive.dev/v1/rates/usd` (external, unreachable/irrelevant) — retried, harmless.
- fulfillment `Error verifying bundle!` once a minute forever — the bundle can never confirm because there is no chain. Harmless.
