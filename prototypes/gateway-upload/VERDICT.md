# VERDICT — local AR.IO gateway + Turbo bundler upload/serve round trip

**YES.** Fully in Docker on this machine, with zero mainnet involvement on the
upload/serve/settle path: `@ardrive/turbo-sdk` → `http://localhost:3000/bundler`
(envoy proxy → upload-service) → optical bridge → served instantly by the local
gateway at `http://localhost:3000/<id>` and visible in local GraphQL with tags.
Verified 2026-09-09 against ar-io-node **r83** images (SHA pins as shipped in the
r83 compose files).

## What was proven end-to-end

1. **Upload**: `TurboFactory.authenticated({ privateKey: jwk, token: 'arweave', uploadServiceConfig: { url } })`
   — the custom-endpoint option is **`uploadServiceConfig: { url }`** (and
   `paymentServiceConfig: { url }`; both `TurboServiceConfiguration` in the SDK's
   `types.d.ts`, SDK v1.43.0). `turbo.upload({ data, dataItemOpts: { tags } })`
   returned a signed receipt (`id`, `deadlineHeight: 201`, `winc: "0"`).
2. **`<gateway>/bundler/tx` proxying works**: the driver used
   `http://localhost:3000/bundler` as the SDK base URL (envoy → upload-service:5100)
   — no direct :5100 access needed. `/bundler/info` also proxies.
3. **Instant serve**: `GET :3000/<id>` returned HTTP 200 with the unique payload
   string and correct `content-type` on the **first attempt** (optical bridge →
   `queue-data-item` admin endpoint → dataItemIndexer; bytes served from the
   shared localstack S3 bucket, `ON_DEMAND_RETRIEVAL_ORDER=s3`). `/raw/<id>` works too.
4. **GraphQL**: item visible immediately with all tags; `block: null`,
   `bundledIn: null` (optimistic/pending — correct, nothing is mined).
5. **Fulfillment / settlement is safely neutered**: with
   `OVERDUE_DATA_ITEM_THRESHOLD_MS=0` the pipeline ran plan → prepare → post →
   seed within ~2 min. The bundle tx POST went to the local gateway
   (`ARWEAVE_GATEWAY=http://envoy:3000`) and core logged
   `Dry-run mode: Transaction validated successfully, skipping POST`
   (`ARWEAVE_POST_DRY_RUN=true`); chunk seeding likewise "Finished uploading
   chunks" locally. **Nothing was broadcast anywhere; no AR needed or spent.**
   `verify-bundle` then errors once a minute forever (bundle never confirms —
   there is no chain). Harmless, but noisy.

## The one hack required: fake head block

The README's warning ("gateway GraphQL index must be synced near chain head")
concretely means: the upload service resolves the current block height via the
gateway's GraphQL `blocks(first: 1)` (fallback `GET /block/current`) to compute
receipt `deadlineHeight`. On a chainless gateway both fail → every upload gets
**HTTP 503 "Upload Service is Unavailable. Unable to sign receipt... Failed to
fetch block info"**. Neither service env nor SDK option bypasses it (checked
`arweaveGateway.js` in the shipped image).

Fix (`seed-head-block.sh`): insert one fake row (height 1) into `new_blocks` in
core's `data/sqlite/core.db`. GraphQL then reports height 1, receipts sign with
`deadlineHeight = 201`, everything downstream works. For real infra compose this
becomes a tiny init job (or: keep ArLocal + a future upstream fix; see below).

## ArLocal integration: partial

- **Works as "trusted node"**: envoy/core pointed at `textury/arlocal:v1.1.66`
  (`TRUSTED_NODE_URL=http://arlocal:1984` etc.) — core boots, `/info` proxying,
  tx-anchor fetch (the bundle's `last_tx` came from ArLocal's genesis hash).
- **Fails for chain sync (expected, documented in the research doc)**: core's
  BlockImporter crashes on ArLocal's minimal genesis block —
  `fromB64Url(undefined)` in `saveBlockAndTxs` (`TypeError [ERR_INVALID_ARG_TYPE]:
  The first argument must be of type string or an instance of Buffer... Received
  undefined`), uncaught-exception loop re-importing height 0 forever. ArLocal
  block JSON lacks `nonce`/`hash`/etc. **Do not point the sync pipeline at
  ArLocal.** Mitigation: `START_WRITERS=false` — verified this disables only
  blockImporter + tx/bundle repair + mempool watcher (`src/app.ts`), while the
  `queue-data-item` optical path stays fully functional.
- ArLocal has no `/block/current` either, so it can't substitute for the fake
  head block.

## Exact env deltas from upstream defaults

Gateway (`gateway-env.conf`, vs `docker-compose.yaml` defaults):

| Var | Value | Why |
|---|---|---|
| `ADMIN_API_KEY` | `proto-admin-key` | fixed so fulfillment's `AR_IO_ADMIN_KEY` matches |
| `TRUSTED_NODE_URL` | `http://arlocal:1984` | cut mainnet (default `http://envoy:3000`→arweave.net) |
| `TRUSTED_NODE_HOST/PORT` | `arlocal`/`1984` | envoy upstream (default arweave.net:443) |
| `FALLBACK_NODE_HOST/PORT` | `arlocal`/`1984` | envoy fallback (default peers.arweave.xyz:1984) |
| `ENABLE_ARWEAVE_PEER_EDS` | `false` | stop envoy's mainnet peer discovery |
| `ARWEAVE_PEER_DNS_RECORDS` | `arlocal` | (belt & suspenders with EDS off) |
| `ARWEAVE_POST_DRY_RUN` | `true` | POST /tx and /chunk return 200 locally, never broadcast |
| `ANS104_INDEX_FILTER` | `{"always":true}` | per `.env.bundler.example` |
| `ANS104_UNBUNDLE_FILTER` | `{"attributes":{"owner_address":"<bundler addr>"}}` | per `.env.bundler.example` |
| `AWS_ENDPOINT` + creds + `AWS_S3_CONTIGUOUS_DATA_BUCKET=ar.io`, `PREFIX=data` | localstack | core reads data-item bytes from the bundler's S3 bucket |
| `ON_DEMAND_RETRIEVAL_ORDER` | `s3` | default starts with `trusted-gateways` (arweave.net) |
| `RUN_OBSERVER` | `false` | no observer wallet |
| `START_WRITERS` | `false` | **critical**: block importer crashes on ArLocal genesis |

Bundler (`bundler-env.conf`, vs `.env.bundler.example` / `docker-compose.bundler.yaml`):

| Var | Value | Why |
|---|---|---|
| `BUNDLER_ARWEAVE_WALLET` / `BUNDLER_ARWEAVE_ADDRESS` | throwaway JWK / `_AfaQWjz…AldE` | required identity (zero AR is fine — nothing is broadcast) |
| `SKIP_BALANCE_CHECKS` | `true` | upload-service defaults to `false` → allow-all uploads |
| `ADMIN_API_KEY` | `proto-admin-key` | must equal the gateway's (optical bridge auth) |
| everything else | verbatim from `.env.bundler.example` | filters + localstack S3 |

Compose-level (`gateway.override.yaml`): core host port `3004:4000` (host 4000
occupied by a sibling stack here; `CORE_PORT` can't be used because envoy derives
its upstream port from it), plus the `arlocal` service on `ar-io-network`.

## Remaining mainnet touchpoints (allowed for this prototype)

- **ArNS/Solana**: `SOLANA_RPC_URL` unset → core hydrated its ArNS names cache
  from Solana mainnet-beta with the baked-in mainnet `ARIO_*_PROGRAM_ID`s. To cut
  it: point `SOLANA_RPC_URL` at the sibling prototype's local validator and set
  the four `ARIO_*_PROGRAM_ID`s to the localnet ids (that's also where ArNS
  resolution would plug in; not exercised here).
- fulfillment tries `https://payment.ardrive.dev/v1/rates/usd` (fails, harmless;
  no env observed to disable).
- Cosmetic: receipts advertise `dataCaches/fastFinalityIndexes: ["arweave.net"]`.
- `PREFERRED_CHUNK_GET/POST_NODE_URLS` defaults (arweave.xyz) are never contacted
  with dry-run on, but set them to arlocal for hygiene in real infra.

## Implications for the real infra compose

1. The upstream compose pair works nearly as-is; total delta is ~15 env vars,
   one port remap, and the fake-head-block init step (script it as a one-shot
   service depending on core-healthy, or patch upstream to allow a configured
   static height).
2. Local "permanence" is simulated exactly as the research doc predicted:
   optical-bridge-instant serving, bundles dry-run-posted, never finalized.
   `verify-bundle` will log errors forever — accept the noise or disable
   (`VERIFY_BUNDLE_ENABLED=false` exists in the bundler compose).
3. Keep `START_WRITERS=false` and never let the sync pipeline see ArLocal.
   ArLocal is still worth including as the trusted node: it satisfies envoy
   upstreams, tx-anchor lookups, and keeps every default URL resolvable locally.
4. Wire `SOLANA_RPC_URL` + `ARIO_*_PROGRAM_ID` + upload-service's allow-list
   (swap `SKIP_BALANCE_CHECKS=true` for `ALLOW_LISTED_ADDRESSES`/
   `ALLOW_LISTED_SIGNATURE_TYPES` if gating is wanted) once the Solana leg lands.
5. The store's turbo-sdk needs only `uploadServiceConfig.url` exposed via env to
   target `http://<gateway>:3000/bundler` (confirmed working through envoy).
