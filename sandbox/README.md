# TOON Protocol local dev sandbox

One `docker compose` project that stands up everything TOON Protocol needs
for local development:

| service | what | host port |
|---|---|---|
| `solana-validator` | agave test validator with AR.IO's five Anchor programs + Metaplex Core preloaded at genesis, 2MB NameRegistry account preloaded | 8899 (RPC), 8900 (WS) |
| `anvil` | local EVM chain (chain-id 31337) for the connector leg | 8545 |
| `arlocal` | fake Arweave node (the gateway's "trusted node") | 1984 |
| `envoy` + `core` + `redis` | AR.IO gateway (ar-io-node r83) | 3000 (gateway), 3004 (core direct) |
| `upload-service` + `fulfillment-service` + `upload-service-pg` + `localstack` | Turbo bundler stack | 5100 (upload), 4566 (localstack) |
| `seed-solana`, `seed-gateway-block` | one-shot idempotent init jobs | — |

The proven end-to-end flow (what `make smoke` exercises):
**upload a payload via the local Turbo bundler → buy an ArNS name on the
local validator → point the ANT's `@` record at the data item → fetch
`http://<name>.ar.localhost:3000/` through the local gateway.** No mainnet
is touched anywhere on that path.

Everything here was distilled from three proven throwaway prototypes on the
`prototype/local-ar-io-stack` branch
(`prototypes/{solana-arns,gateway-upload,full-stack}` — their `VERDICT.md`s
hold the detailed findings). The AR.IO service definitions are vendored from
ar-io-node r83's compose files (image tags pinned to the exact SHAs r83
shipped), so no ar-io-node checkout is needed.

## Prerequisites

- Docker with the compose plugin
- Node.js >= 20 with npm (for the smoke test / driver scripts on the host)
- Free host ports: 3000, 3004, 5100, 4566, 1984, 8545, 8899, 8900
- `*.localhost` resolving to loopback (default on modern Linux/macOS
  resolvers; check with `getent hosts foo.ar.localhost`)

## Cold start

```bash
cd sandbox
make setup          # npm ci (host-side script deps; one-time)
make up             # docker compose up -d --build
# first run: pulls images + builds the seeder; stack settles in ~1-2 min
make smoke          # full end-to-end proof (upload -> buy name -> serve by name)
```

`make up` alone brings up everything in the right order — the init jobs are
compose services gated on healthchecks:
`solana-validator` healthy → `seed-solana` (ARIO mint, ATAs,
`ario_arns::initialize`) and `core` healthy → `seed-gateway-block` (fake
head block, see below) → bundler stack.

Teardown:

```bash
make down    # stop, keep state (uploads, bought names in gateway caches, etc.)
make clean   # stop + wipe ALL state; next `make up` is a cold start again
```

## Using the sandbox

- **Upload via Turbo**: point `@ardrive/turbo-sdk` at the gateway proxy —
  `TurboFactory.authenticated({ privateKey, token: 'arweave', uploadServiceConfig: { url: 'http://localhost:3000/bundler' } })`.
  Uploads are served by the gateway instantly (optical path).
- **Fetch by id**: use `http://localhost:3000/raw/<id>`. Plain `/<id>` does
  NOT work locally: with `ARNS_ROOT_HOST` set, the sandbox middleware 302s it
  to an unreachable `https://<base32>.ar.localhost` URL.
- **Buy ArNS names**: `@ar.io/sdk` with `DEVNET_PROGRAM_IDS` overrides
  against `http://localhost:8899` / `ws://localhost:8900` (exactly the
  store's devnet path; see `scripts/smoke-test.mjs` for a complete example).
  The buyer is `keys/admin.json`, funded with 10M local ARIO by the seeder.
- **Resolve names**: `http://<name>.ar.localhost:3000/` in any browser, or
  `http://localhost:3000/ar-io/resolver/<name>`. A freshly bought name
  resolves within ~5s (the sandbox shrinks the gateway's name-list
  miss-refresh interval; the first request may 404 once).
- **GraphQL**: `http://localhost:3000/graphql` (uploads appear immediately,
  `block: null` — optimistic/pending, correct since nothing is mined).
- **EVM**: plain anvil at `http://localhost:8545` (chain-id 31337, 10 funded
  accounts). See "EVM leg" below for deploying the connector contracts.

## What the init jobs do (and why they exist)

- **`seed-solana`** — airdrops SOL, creates a local "ARIO" SPL mint +
  treasury/buyer ATAs, mints 10M ARIO to the buyer, then runs
  `ario_arns::initialize` + `ario_core::initialize`. The initialize
  instructions are gated to the *programs' upgrade authority*, which is why
  the validator loads the AR.IO programs with `--upgradeable-program <id>
  <so> <admin>` (never `--bpf-program`) and why `keys/admin.json` is
  committed. Idempotent: exits 0 if the ArnsConfig PDA already exists.
- **`seed-gateway-block`** — inserts one fake block (height 1) into core's
  SQLite. The Turbo upload service resolves the current block height via the
  gateway's GraphQL to sign receipts; on a chainless gateway every upload
  would 503. Idempotent (replaces the same row). The bundler services only
  start after this completes.

## Committed keys and artifacts

**Everything under `keys/` is a valueless throwaway** generated for this
sandbox — zero real funds, zero mainnet standing. Committed on purpose so the
sandbox works from a fresh clone:

- `keys/admin.json` — Solana keypair `5ncaUQEykDpzYaWHAxQ16M3Kq49hxzo6xXUWkVXC3TXX`:
  upgrade authority of the preloaded AR.IO programs, protocol authority, and
  the default ArNS buyer.
- `keys/treasury.json` — treasury ATA owner.
- `keys/uploader-wallet.json` / `keys/bundler-wallet.json` — Arweave JWKs
  with zero AR (nothing is ever broadcast; the gateway runs
  `ARWEAVE_POST_DRY_RUN=true`). The bundler JWK is also embedded in
  `conf/bundler.conf` and its address in the gateway's
  `ANS104_UNBUNDLE_FILTER`.

`artifacts/` (program `.so` dumps + the 2MB NameRegistry genesis account) is
committed for convenience but fully regenerable: `./scripts/fetch-artifacts.sh`
re-dumps the five AR.IO programs from devnet and mpl_core from mainnet-beta
using the pinned validator image (no Solana toolchain needed), and
`node scripts/gen-genesis.mjs` rebuilds the genesis account (and keys, if
missing — regenerating keys requires updating the admin pubkey in
`docker-compose.yml`). The program ids are the staging/devnet ids
(= `@ar.io/sdk` `DEVNET_PROGRAM_IDS`) — they cannot be changed, the binaries
carry `declare_id!` for them. Refresh the dumps only together with an
`@ar.io/sdk` / `@ar.io/solana-contracts` upgrade.

## TOON payment-channel program (not preloaded)

The validator has a **documented, commented-out stanza** for loading the
connector's `payment_channel.so` under its fixed id
`HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR`. It is not wired in because no
prebuilt BPF artifact exists in the connector checkout — building one needs
the connector's pinned toolchain (`make solana-build` there, producing
`connector/target/deploy/payment_channel.so`). Once built, uncomment the
stanza + mount in `docker-compose.yml` (instructions inline there).

## EVM leg

The sandbox provides the *chain* only. Deploying the connector's contracts
(MockERC20 USDC, TokenNetworkRegistry, …) requires the connector repo's
Foundry project; the connector's own `docker-compose.yml` is the proven
reference (anvil + `forge script script/DeployLocal.s.sol` in one container,
with a "healthy = deployed" healthcheck). To get a contracts-deployed chain
here, either run the connector's compose instead of this `anvil` service, or
mount `connector/packages/contracts` and adopt its entrypoint (pointer in
the commented block on the `anvil` service).

## Restarting the validator

The validator runs `--reset`: chain state lives only for the container's
lifetime and a *restart* wipes it (bought names disappear from the chain;
the gateway's caches expire within ~30s). A plain `docker compose up -d`
after that re-runs `seed-solana`, which detects the missing ArnsConfig and
reseeds. Gateway/bundler state (`./data/`) survives restarts and is only
removed by `make clean`.

## Known noise (harmless)

- envoy periodically logs DNS failures for the `observer` cluster — the
  observer service is deliberately not run (it has no wallet and would
  crash-loop); `/ar-io/observer/*` routes 503.
- core logs `Error during parallel resolution ... unregistered_arns` — the
  default not-found probe name, which doesn't exist locally.
- fulfillment logs SQS `NonExistentQueue` for ~20s at boot while localstack
  creates the queues, and occasional `Failed to fetch USD/AR rate` from an
  unreachable external service. Both self-recover/are irrelevant.

## Troubleshooting

- **Upload 503 "Unable to sign receipt"**: `seed-gateway-block` didn't run —
  `docker compose ps -a` should show it `Exited (0)`; re-run with
  `docker compose up -d seed-gateway-block`.
- **Name never resolves**: check `seed-solana` logs
  (`docker compose logs seed-solana`) — if the validator restarted after
  seeding, run `docker compose up -d` to reseed, then re-buy (chain state
  was wiped).
- **`*.ar.localhost` doesn't resolve**: use
  `curl -H 'Host: <name>.ar.localhost' http://localhost:3000/` (note: Node's
  `fetch()` silently drops a user-set Host header; curl is fine).
