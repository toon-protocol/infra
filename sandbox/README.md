# TOON Protocol local dev sandbox

One `docker compose` project that stands up everything TOON Protocol needs
for local development:

| service | what | host port |
|---|---|---|
| `solana-validator` | agave test validator with AR.IO's five Anchor programs + Metaplex Core + the TOON `payment_channel` program preloaded at genesis, 2MB NameRegistry account preloaded | 8899 (RPC), 8900 (WS) |
| `anvil` | local EVM chain (chain-id 31337) with the connector's settlement contracts auto-deployed (MockERC20 USDC, TokenNetworkRegistry, TokenNetwork) | 8545 |
| `arlocal` | fake Arweave node (the gateway's "trusted node") | 1984 |
| `envoy` + `core` + `redis` | AR.IO gateway (ar-io-node r83) | 3000 (gateway), 3004 (core direct) |
| `upload-service` + `fulfillment-service` + `upload-service-pg` + `localstack` | Turbo bundler stack | 5100 (upload), 4566 (localstack) |
| `relay-connector` | TOON ILP connector — the HUB (`g.toon.relay`, forwards `g.toon.store` / `g.toon.gastation` over peerings) | 3200 (client edge) |
| `store-connector` | TOON connector terminating `g.toon.store` | 3210 (client edge) |
| `gas-connector` | TOON connector terminating `g.toon.gastation` | 3220 (client edge) |
| `relay` | TOON Nostr relay (paid writes via connector only; write port 3100 unpublished) | 7100 (free NIP-01 reads) |
| `store` | paid Arweave blob store, kind:5094/5095 (paid handler 3300 unpublished) | 3300 → container 3400 (free /health) |
| `gas-station` | pays Solana gas, kind:5096 (paid handler 3300 unpublished) | 3400 (free /describe + /health) |
| `turbo-tls` | TLS shim aliasing `upload.ardrive.io` onto the local Turbo bundler (see "TOON layer") | — |
| `seed-solana`, `seed-gateway-block`, `seed-toon-solana`, `seed-toon-evm` | one-shot idempotent init jobs | — |

The proven end-to-end flows (what `make smoke` exercises):
1. **AR.IO**: upload a payload via the local Turbo bundler → buy an ArNS name
   on the local validator → point the ANT's `@` record at the data item →
   fetch `http://<name>.ar.localhost:3000/` through the local gateway.
2. **TOON payment layer**: a real client (`@toon-protocol/client`) opens a
   payment channel on anvil against the hub, then a PAID Nostr write to
   `g.toon.relay`, a PAID kind:5094 blob to `g.toon.store` and a PAID
   kind:5096 gas quote to `g.toon.gastation` all enter at the HUB's edge
   (:3200); the store and gas packets route over real, collateralised
   peerings to the other two connectors, the blob lands in the LOCAL Turbo
   bundler and is served back by the local gateway, and the connectors' own
   claim books prove both the client edge and the peerings were paid.

No mainnet is touched anywhere on either path.

Everything here was distilled from three proven throwaway prototypes on the
`prototype/local-ar-io-stack` branch
(`prototypes/{solana-arns,gateway-upload,full-stack}` — their `VERDICT.md`s
hold the detailed findings). The AR.IO service definitions are vendored from
ar-io-node r83's compose files (image tags pinned to the exact SHAs r83
shipped), so no ar-io-node checkout is needed.

## Prerequisites

- Docker with the compose plugin
- Node.js >= 20 with npm (for the smoke test / driver scripts on the host)
- The **connector sibling checkout** at `../../connector` — the `anvil`
  service bind-mounts its Foundry project (`packages/contracts`) and deploys
  the settlement contracts in-container on every start (the connector repo's
  own proven pattern; submodules self-heal if the clone wasn't `--recursive`)
- Free host ports: 3000, 3004, 5100, 4566, 1984, 8545, 8899, 8900, 3200,
  3210, 3220, 3300, 3400, 7100
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
- **EVM**: anvil at `http://localhost:8545` (chain-id 31337, 10 funded
  accounts) with the connector's settlement contracts auto-deployed at their
  deterministic addresses (MockERC20 USDC `0x5FbD…0aa3`, TokenNetworkRegistry
  `0xe7f1…0512`, TokenNetwork `0xCafa…052c`).
- **TOON payments**: hand a paid ILP packet to the hub at
  `http://localhost:3200` — see "TOON layer" below and
  `scripts/smoke-toon.mjs` for a complete client example.

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

## TOON layer

The payment layer + the three TOON apps, wired into the same compose project.

### Topology and port map

```
smoke test / any client (host)
   │ POST /ilp (paid)                       ┌──────────────────────────────┐
   ▼                                        │  ws://localhost:7100 (free)  │
relay-connector :3200  ── g.toon.relay ──▶ relay:3100/write ──▶ relay reads┘
   │        (hub)      ── g.toon.relay.ephemeral ─▶ relay:3100/write-ephemeral
   ├─ g.toon.store ──[peering relay-store]──▶ store-connector :3210
   │                                            └─▶ store:3300/store (kind:5094/5095)
   └─ g.toon.gastation ──[peering relay-gas]──▶ gas-connector :3220
                                                └─▶ gas-station:3300/gas (kind:5096)
```

- Connector client edges: hub **3200**, store **3210**, gas **3220** (all
  `GET /ilp` self-describing; the operator surface rides the same port).
- The apps' PAID handler ports (relay 3100, store 3300, gas-station 3300)
  are **unpublished** — the only route to them is a paid packet through a
  connector, and the relay leans on exactly that (it skips schnorr
  verification for paid ephemeral kinds).
- Free surfaces: relay reads **:7100** (NIP-01 WS), store health **:3300**
  (container 3400), gas-station **:3400** (`/describe` + `/health`).

### Peering mechanism

Static config-file peering — the connector repo's own CI-proven mechanism
(`connector/local/two-hop` and `local/mixed-chain`, ADR 0028/0042/0060/0061):
the hub holds `[[peers]]` rows with `endpoint` + `fee`, a forwarded
`[[routes]]` row per prefix, and a `[[peer_channels]]` + `[[pay_channels]]`
pair per peering (one on-chain channel in two roles — cover-forward claims
are signed BEFORE each forwarded PREPARE leaves); the accepting connectors
set `peer_expose = "http"` and hold the mirror `[[peer_channels]]` row. The
runtime alternative (`POST /peers`, ADR 0058) exists but the config-file
route is what the connector's own local topologies commit and rehearse.

Fee arithmetic (enforced by nothing — kept true by these committed files):
the hub collects `price`, retains `fee = 100`, forwards the rest; the payees
terminate at exactly the forwarded amount (store `{base=1000, per_kib=10}`
behind hub `{base=1100, per_kib=10}`; gas `1000` behind `1100`).

The peering channels are REAL channels on anvil's TokenNetwork: opened and
collateralised (100 USDC each) by the `seed-toon-evm` init job from the
hub's settlement key, at ids that are `keccak(p1, p2, epoch=0)` (ADR 0059) —
precomputed, committed in `conf/connector-*.toml`, and re-asserted against
the chain on every seed run.

### Keys and provisioning

Everything under `keys/toon/` is a **valueless committed throwaway** (like
`keys/` itself): per-connector `signer.key` (random ILP identity),
`settlement.key` / `settlement-solana.key` (derived from anvil's public test
mnemonic at fixed indices 24-26 / 34-36, because their addresses appear in
committed configs), operator credentials, the connector repo's own
deterministic mock-USDC mint keypairs, and the two app keypairs whose public
halves are embedded in `conf/*.conf`. `scripts/gen-toon-keys.sh` documents
and regenerates the lot. The connector image runs as uid 10001 and mounts
key dirs read-only (world-readable files suffice — nothing here is written
by root); its `/app/state` claim journals are **named volumes** so they
inherit the image's uid-10001 ownership and die with `make clean` (a stale
claim journal against a wiped chain satisfies payment assertions vacuously).

Init jobs, in order: `seed-toon-solana` (creates the deterministic mock USDC
mint `H8HSre…A77H`, airdrops SOL + mints USDC to every settlement key and
the gas station's fee payer) and `seed-toon-evm` (funds ETH + USDC, opens +
collateralises the two peering channels). Both gate the connectors, whose
startup is fail-closed on BOTH settlement backends — the Solana backend
submits a real ATA-create and simulates an `InitializeChannel` against the
genesis-loaded `payment_channel` program, so three healthy connectors are
themselves the "payment_channel.so deployed and working" proof.

### payment_channel.so

`artifacts/payment_channel.so` is committed (like the AR.IO dumps), built
from the connector repo with its pinned toolchain (platform-tools v1.52 via
`make solana-build` there, Solana CLI v3.1.12). `scripts/build-payment-channel.sh`
regenerates it. The validator loads it at genesis with plain `--bpf-program`
under the bare id `HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR` (no init
gate — same id the connector's own local tooling shares).

### Store upload path (the turbo-tls shim)

The store has **no env override for the Turbo upload-service URL** — its
turbo-sdk client always aims at the production `https://upload.ardrive.io`
(the only knobs are the Solana signing key / network / RPC gateway; verified
against `store/src/entrypoint-store.ts` + `turbo-funding.ts`). To keep
uploads fully local without patching the store repo, the `turbo-tls` service
carries `upload.ardrive.io` as a compose network **alias**, terminates TLS
with a committed throwaway certificate (`conf/turbo-tls/`), and proxies to
the local `upload-service:5100`; the store trusts the shim CA via
`NODE_EXTRA_CA_CERTS`. Paid Turbo top-ups stay off
(`STORE_TURBO_MAX_ARIO_PER_UPLOAD` unset), so the store serves the free tier
(data items ≤ 107,520 bytes) — enough for the smoke proof, and the local
bundler skips balance checks anyway.

### Driving the TOON layer by hand

```js
import { ToonClient } from '@toon-protocol/client';
const client = await ToonClient.create({
  connector: 'http://localhost:3200',                       // the hub
  mnemonic: 'test test test test test test test test test test test junk',
  chain: 'evm', rpcUrl: 'http://localhost:8545',
  channelStore: '.toon-client/channels.json',
});
await client.channel.open({ deposit: 10_000_000n });        // 10 USDC
await client.send('g.toon.relay', { body: JSON.stringify({ event }) });
// forwarded routes need sealTo = the TERMINATING connector's edge:
await client.send('g.toon.store', { body }, { sealTo: 'http://localhost:3210' });
```

See `scripts/smoke-toon.mjs` for the full flow (jobs via `sendJob`, claim
assertions over the operator surface with the committed bearer tokens).

### TOON layer: known gaps

- **Store upload URL override** (above): wired via the turbo-tls shim; the
  clean fix is an upstream store env var for `uploadServiceConfig.url`.
- **kind:5098 (EVM gas) unconfigured**: it needs an ERC-2771 forwarder
  contract that `DeployLocal.s.sol` does not deploy locally; the gas station
  deliberately leaves the kind unregistered when its env is absent. The
  smoke proves kind:5096 (Solana) instead, quote phase included.
- **kind:5095 `op=buy` (brokered ArNS) unconfigured**: `ARNS_DVM_SOLANA_SECRET_KEY`
  is unset, and the store's ArNS SDK has no RPC override pointed at the
  local validator; direct ArNS buys against the local validator are already
  proven by the AR.IO smoke.
- **Solana-settled peerings**: the two peerings settle on anvil (EVM), like
  the connector repo's two-hop topology. Opening a Solana channel needs a
  running node's operator surface (`POST /channels`,
  `connector/local/open-solana-channel.py`) and is left out; the Solana
  settlement *backends* are live on all three connectors regardless.

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
