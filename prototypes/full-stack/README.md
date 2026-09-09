PROTOTYPE — throwaway; answers: can the local gateway resolve locally-bought ArNS names end-to-end?

# full-stack prototype

**Answer: YES.** See `VERDICT.md`. Combines the two proven sibling prototypes
(`../solana-arns`, `../gateway-upload`) into one Docker stack and proves:
`buy name on local validator → point ANT '@' at a locally-uploaded data item →
fetch http://<name>.ar.localhost:3000/ through the local gateway`.

This dir holds only the deltas; it reuses the siblings read-only:

- `../gateway-upload/ar-io-node/` — the r83 compose files (gateway + bundler)
- `../solana-arns/artifacts/`, `../solana-arns/genesis/` — program .so dumps +
  2MB NameRegistry genesis account (mounted read-only into the validator)

| file | role |
|---|---|
| `full-stack.override.yaml` | adds solana-validator (verbatim from solana-arns) + arlocal to the gateway compose, remaps core 4000→3004 |
| `gateway-env.conf` | gateway-upload's proven env + the NEW Solana/ArNS wiring (see the marked block) |
| `bundler-env.conf` | copy of gateway-upload's (unchanged) |
| `seed.mjs` | copy of solana-arns's validator seeder (ARIO mint, ATAs, arns/core initialize) |
| `seed-head-block.sh` | copy of gateway-upload's fake-head-block hack (container renamed) |
| `flow.mjs` | THE integration driver: upload → buy → setRecord → resolve |
| `undername-test.mjs` | bonus: `www_<name>` undername resolution |
| `keys/` | copies of solana-arns's throwaway admin/treasury keypairs |
| `throwaway-uploader-wallet.json` | copy of gateway-upload's uploader JWK |

Env files are `*.conf` because this workspace denies writing `*.env`.

## Run from cold

```bash
cd prototypes/full-stack
npm install

# 1. gateway + validator + arlocal (envoy :3000, core :3004, RPC :8899/:8900).
#    --project-directory MUST be this dir: it makes the override's
#    ../solana-arns mounts resolve correctly and isolates ./data here.
docker compose -p proto-full-stack --project-directory . \
  --env-file gateway-env.conf \
  -f ../gateway-upload/ar-io-node/docker-compose.yaml \
  -f full-stack.override.yaml up -d

# 2. seed validator state (validator is healthy before core starts, but this
#    can run any time after `up`): ARIO mint + ATAs + arns/core initialize
node seed.mjs

# 3. once core is healthy (~20s), fake head block (idempotent; needed only by
#    the Turbo upload service's receipt signing)
./seed-head-block.sh

# 4. bundler stack (upload-service :5100, fulfillment, postgres, localstack :4566)
docker compose -p proto-full-stack --project-directory . \
  --env-file bundler-env.conf \
  -f ../gateway-upload/ar-io-node/docker-compose.bundler.yaml up -d

# 5. the whole flow (give upload-service ~20s after step 4)
node flow.mjs            # or: node flow.mjs my-name
```

Expected tail: `FULL STACK OK: http://<name>.ar.localhost:3000/ serves the
uploaded payload (unique string matched)`.

Teardown (leaves files):

```bash
docker compose -p proto-full-stack --project-directory . --env-file bundler-env.conf -f ../gateway-upload/ar-io-node/docker-compose.bundler.yaml down
docker compose -p proto-full-stack --project-directory . --env-file gateway-env.conf -f ../gateway-upload/ar-io-node/docker-compose.yaml -f full-stack.override.yaml down
```

## Known noise (all inherited from gateway-upload, all harmless)

- `observer` crash-loops (no wallet); ignore.
- fulfillment: SQS NonExistentQueue for ~20s at boot; USD/AR rate fetch
  failures; `Error verifying bundle!` once a minute forever (no chain).
- core: `Error during parallel resolution` for `unregistered_arns` (the
  default ARNS_NOT_FOUND_ARNS_NAME, which doesn't exist locally).
