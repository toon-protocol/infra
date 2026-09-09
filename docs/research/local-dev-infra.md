# Local development infrastructure for TOON Protocol

Research notes toward a single compose-based local development environment for TOON
Protocol: local chains for the ecosystems the project touches (Arweave, Solana, EVM,
Mina), deployment of the project's own on-chain code onto them, and local AR.IO
infrastructure (gateway, ArNS, uploads). Findings are drawn from primary sources
only — the sibling repos on this machine (chiefly
`/home/allidoizcode/Work/TOON-Protocol/connector` and `.../store`) and the official
repositories/docs/registries of each upstream project, cited inline. Researched
2026-09-09. This file lives in `docs/research/` — a new directory; the repo had no
prior research-notes convention (`docs/` previously held only `agents/`).

**The two findings that reshape the design:**

1. **AR.IO migrated its entire contract stack (ARIO token, ArNS registry, ANTs) from
   AO to Solana (~June 2026).** The AO-process repos are archived; the contracts are
   now five Anchor programs, the SDK is "Solana-native", and fully-local ArNS is a
   *first-class supported path* via a local Solana validator with the programs
   preloaded. AO components (cu/mu/su, ao-localnet, HyperBEAM) are **not needed** for
   ArNS at all. ([ar-io-network-process, archived with a CAUTION banner pointing to
   the Solana repo](https://github.com/ar-io/ar-io-network-process);
   [ar-io-solana-contracts](https://github.com/ar-io/ar-io-solana-contracts);
   [docs.ar.io/learn/arns](https://docs.ar.io/learn/arns))
2. **The connector repo has no Mina artifacts.** Mina was dropped as a settlement
   chain (ADR 0002) and every remaining Mina artifact — zkApp, tooling, faucet leg —
   was deleted by ADR 0065 ("Mina leaves the repository", #1205)
   (`connector/docs/adr/0065-mina-leaves-the-repository.md`,
   `connector/docs/adr/0002-drop-mina-from-the-rust-connector.md`). There is nothing
   to deploy to a local Mina network today; a Mina service is optional forward
   provisioning only.

---

## What the project actually needs locally (from the sibling repos)

- **`connector`** (Rust Interledger connector) settles on **EVM** and **Solana**.
  Its own `docker-compose.yml` already stands up both local chains with the
  contracts/program auto-deployed, and `local/` proves the shipped image against
  them (`connector/docker-compose.yml`, `connector/local/README.md`). Its Arweave
  involvement is read-side only: a devnet probe fetches uploaded bytes back from
  public gateways, ar.io first
  (`connector/crates/connector-bin/tests/devnet_store_leg_probe.rs`).
- **`store`** (`ghcr.io/toon-protocol/store:release`) is the Arweave-facing app: it
  uploads blobs via **Turbo** (`@ardrive/turbo-sdk`), and brokers **ArNS** name
  buys / ANT spawns via **`@ar.io/sdk` ^4.0.3 + `@ar.io/solana-contracts` 1.0.1** —
  Solana instructions (`ario_ant::initialize`, MPL Core assets), live on Solana
  devnet since 2026-07-17 (`store/package.json`, `store/README.md`,
  `store/src/arns-buy-handler.ts`, `store/src/arns-ant-prepare.ts`). It already
  supports devnet program-id overrides via the SDK's `DEVNET_PROGRAM_IDS`.
- **`gas-station`** co-signs/broadcasts the Solana transactions of the ANT-spawn
  flow and takes `SOLANA_RPC_URL` / `SOLANA_NETWORK` env, so it can point at a
  local validator (`gas-station/README.md`, config table).

So the local environment's center of gravity is: **one EVM chain + one Solana
validator carrying both TOON's payment-channel program and AR.IO's five programs +
an AR.IO gateway + a local Turbo bundler**, with Arweave-the-chain itself being the
one layer that cannot be faithfully local (details below).

---

## Arweave (local chain)

**Verdict: there is no maintained local Arweave node.** The practical local
endpoint is the archived-but-frozen ArLocal simulator, used app-level only.

- **ArLocal** (`textury/arlocal`) — "run a local Arweave gateway-like server". The
  GitHub repo was **archived 2025-05-15** (read-only; last push 2024-07-26)
  ([github.com/textury/arlocal](https://github.com/textury/arlocal)); npm latest is
  **1.1.66, published 2024-03-21**, with no deprecation notice but no release in
  ~2.5 years ([registry.npmjs.org/arlocal](https://registry.npmjs.org/arlocal)).
  - Image: **`textury/arlocal:v1.1.66`** on Docker Hub (tags up to v1.1.66, pushed
    2024-03-21) ([hub.docker.com/r/textury/arlocal](https://hub.docker.com/r/textury/arlocal)).
  - Port **1984**. Key endpoints: `GET /mint/<address>/<balance>` (fund a wallet),
    `GET /mine[/{blocks}]` (confirm pending txs instantly), arweave-js-compatible
    `POST /tx`, GraphQL (repo README).
  - Limitations: simulates the gateway HTTP surface — no real mining, consensus, or
    chunk-level data protocol; upstream is missing pending-tx fetching and raw tx
    downloads, which is why permaweb/ao-localnet builds the
    `MichaelBuhler/arlocal` fork instead
    ([permaweb/ao-localnet compose/README](https://github.com/permaweb/ao-localnet)).
  - It is still what the ecosystem uses: AR.IO's own arns-service integration tests
    pin `textury/arlocal:v1.1.35`
    ([ar-io/arns-service docker-compose.yaml](https://raw.githubusercontent.com/ar-io/arns-service/main/docker-compose.yaml)).
- **Official Erlang node** ([ArweaveTeam/arweave](https://github.com/ArweaveTeam/arweave),
  active, pushed 2026-09-07) now has an internal **localnet mode**
  (`bin/start-localnet`, `apps/arweave/src/ar_localnet.erl`: single node, mining
  disabled, mine-on-demand via `mine_one_block/0`), but it is internal dev tooling:
  no Dockerfile, no published image, no end-user docs (the testing docs URL 404s),
  built from source via the `_build/localnet` profile. The repo's `testnet/` dir is
  for ArweaveTeam's own testnet hosts and refuses to run elsewhere. Not a turnkey
  option.

**Recommendation:** run `textury/arlocal:v1.1.66` on 1984 for app-level Arweave dev
(arweave-js flows, fake gateway), and accept that it is frozen. Do not plan on the
AR.IO gateway indexing it (see AR.IO section). There is no connector/store on-chain
artifact to deploy to Arweave — the project writes *data* (via Turbo), not
contracts.

## Solana (local chain)

**Recommended: `solana-test-validator`, with the TOON payment-channel program loaded
at genesis — the connector repo already does exactly this and the pattern is
proven.**

- **Image status:** there is no current official Docker image. `solana-labs/solana`
  was archived 2025-01-22 ([repo](https://github.com/solana-labs/solana));
  `anzaxyz/agave` on Docker Hub is marked "[SUNSETTING]: no updates" (last updated
  2026-05-12) ([hub.docker.com/r/anzaxyz/agave](https://hub.docker.com/r/anzaxyz/agave));
  Anza's supported install is the release script
  ([docs.anza.xyz/cli/install](https://docs.anza.xyz/cli/install)). The connector
  uses the community image **`ghcr.io/beeman/solana-test-validator:latest`**
  (agave 4.0.3 observed, ports 8899/8900, needs `seccomp=unconfined` because Agave
  v2+ uses io_uring) (`connector/docker-compose.yml`,
  [github.com/beeman/solana-test-validator](https://github.com/beeman/solana-test-validator)).
  **Caveat:** that image's nightly build last succeeded 2026-07-06 — `latest` is
  frozen ~2 months as of this research. A risk to track; fallback is a small own
  Dockerfile over Anza release binaries.
- **Deploying the connector's program:** `packages/solana-program` builds
  `payment_channel.so` via `make solana-build` → `tools/solana/build-sbf.sh`
  (pinned **platform-tools v1.52**; `solana-program = "=2.1.0"`,
  `spl-token = "=6.0.0"`; Cargo.lock deliberately holds back deps the frozen SBF
  cargo 1.79.0 can't parse) (`connector/Makefile`,
  `connector/tools/solana/build-sbf.sh`, `connector/packages/solana-program/Cargo.toml`,
  `connector/Cargo.toml` header). The validator entrypoint loads the `.so` **into
  genesis** with `--bpf-program` under the bare, committed id
  `HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR` — no deploy step, no keypair, no
  fee payer, and the id is committable precisely because it's a bare genesis id
  (`connector/infra/solana/entrypoint.sh`). The deterministic mock USDC mint
  (`H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H`) is seeded by
  `make solana-mint-usdc` / `infra/solana/create-usdc-mint.sh`
  (`connector/local/solo/connector.toml` comments).
- **The same validator should also carry the AR.IO programs** (see AR.IO section):
  five Anchor programs + Metaplex Core, all preloadable the same `--bpf-program`
  way (AR.IO's own localnet script does exactly that, on Surfpool). That gives one
  Solana service serving both TOON settlement and ArNS.

## EVM (local chain)

**Recommended: Anvil in the official Foundry image — again, already the connector's
proven pattern.**

- **Image:** `ghcr.io/foundry-rs/foundry` is official (forge, cast, anvil, chisel
  inside); docs instruct pulling it directly
  ([getfoundry.sh installation](https://getfoundry.sh/introduction/installation),
  [container package](https://github.com/foundry-rs/foundry/pkgs/container/foundry)).
  Tags: `latest`, `stable`, `nightly`, and versioned tags — **pin a version tag**
  (current release `v1.8.1`, 2026-08-28). The connector currently uses `latest`
  (`connector/docker-compose.yml`).
- **Deploying the connector's contracts:** `packages/contracts` is a Foundry
  project (vendored OpenZeppelin 5.5.0 + forge-std as git submodules — clone with
  `--recurse-submodules`, or the compose entrypoint self-heals with a
  revision-pinned `forge install`). The connector's `anvil` service starts
  `anvil --host 0.0.0.0 --port 8545 --chain-id 31337`, then runs
  `forge script script/DeployLocal.s.sol --broadcast` inside the same container.
  `DeployLocal.s.sol` deploys, from Anvil account 0 at fixed nonces (so addresses
  are deterministic and committable): MockERC20 USDC (6 decimals,
  `0x5FbDB2315678afecb367f032d93F642f64180aa3`), **TokenNetworkRegistry**
  (`0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`), a TokenNetwork through the
  registry, and RollingSwapChannel; then funds test peers
  (`connector/packages/contracts/script/DeployLocal.s.sol`,
  `connector/docker-compose.yml`, `connector/local/solo/connector.toml`).
- **Health gate worth copying:** healthy means *deployed*, not merely RPC-up —
  the healthcheck is `cast code <registry>` returning non-`0x`, because everything
  downstream races the deploy otherwise (`connector/docker-compose.yml`, anvil
  healthcheck comment). Also copy the `user: ${HOST_UID}:${HOST_GID}` +
  `HOME=/tmp` handling — running forge as root corrupts the bind-mounted source
  tree's ownership (same file, issue #104 notes).

## Mina (local chain)

**There are no TOON Mina artifacts to deploy** — ADR 0002 dropped Mina as a
settlement chain (o1js proof generation is JavaScript-only; a Node sidecar was
refused) and ADR 0065 deleted the zkApp, tooling and faucet leg outright; the
connector merely refuses `mina`-named claims on the wire, and the repo forbids
reintroducing an o1js dependency
(`connector/docs/adr/0002-drop-mina-from-the-rust-connector.md`,
`connector/docs/adr/0065-mina-leaves-the-repository.md`, `connector/CLAUDE.md`).

If a Mina service is wanted anyway (future zkApp work), the current supported local
network is **Lightnet**:

- **Image: `o1labs/mina-local-network`** on Docker Hub (official o1Labs; last
  updated 2026-07-20; tag scheme `<mina-branch>-<profile>`, canonical
  `compatible-latest-lightnet`; multi-arch)
  ([hub.docker.com/r/o1labs/mina-local-network](https://hub.docker.com/r/o1labs/mina-local-network)).
  This is exactly what `zk lightnet start` runs
  ([docs.minaprotocol.com/zkapps/testing-zkapps-lightnet](https://docs.minaprotocol.com/zkapps/testing-zkapps-lightnet)).
  Note the GitHub repo `o1-labs/mina-local-network` now 404s; the Docker Hub
  description is the authoritative run reference.
- **Run:** `NETWORK_TYPE=single-node`, `PROOF_LEVEL=none`, `RUN_ARCHIVE_NODE=true`,
  `SLOT_TIME=20000`; ports **8080** (GraphQL, `http://localhost:8080/graphql`),
  **8181** (accounts manager, `GET /acquire-account` for pre-funded keys), **8282**
  (archive API), 5432 (Postgres), 3085 (daemon) (Docker Hub description).
- **Deploy path for a future zkApp:** `zk config --lightnet` + `zk deploy`, or in
  o1js `Mina.Network('http://localhost:8080/graphql')` +
  `Lightnet.acquireKeyPair()`; for pure unit tests, the in-process
  `Mina.LocalBlockchain({ proofsEnabled: false })` needs no container at all
  ([docs.o1labs.org local development](https://docs.o1labs.org/o1js/zkapps/local-development)).
- **Cost:** ~4.5 GB RAM at startup, 1.5–2 GB steady, 1–2 min boot (single-node);
  docs caveat it is for local dev/test only (Lightnet docs page). Recommend
  putting it behind a compose **profile** so it is opt-in.

---

## AR.IO stack

### The migration that changes everything

The premise "ARIO contracts run on AO" is obsolete. Archived with CAUTION banners
pointing at the Solana repo: `ar-io-network-process` (pushed 2026-06-09),
`ar-io-ant-process`, `ar-io-ant-registry-process`, and the standalone
`arns-resolver` (archived Sept 2024 — resolution moved inside the gateway)
([ar-io-network-process](https://github.com/ar-io/ar-io-network-process),
[arns-resolver](https://github.com/ar-io/arns-resolver)). The live stack:

- **[ar-io/ar-io-solana-contracts](https://github.com/ar-io/ar-io-solana-contracts)**
  (active, AGPL, open source): five Anchor programs — `ario-core` (ARIO SPL token,
  vaults, primary names), `ario-gar` (gateway registry/staking/epochs), `ario-arns`
  (name registry: buy/lease/permabuy, demand-factor pricing), `ario-ant` (ANT as a
  Metaplex Core NFT), `ario-ant-escrow`. Program ids are committed:
  `program-ids/mainnet.json` (e.g. ario_core
  `73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh`, ario_arns
  `2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ`) and `program-ids/staging.json`
  (Solana **devnet**, redeployed by CI on merges to `develop`; e.g. ario_arns
  `6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp`). Generated clients ship as npm
  **`@ar.io/solana-contracts`** (latest 1.2.0; `devnet`/`staging` dist-tags).
- **Fully-local is a designed-in flow:** `scripts/start-localnet.sh` boots a
  **Surfpool** localnet ([solana-foundation/surfpool](https://github.com/solana-foundation/surfpool))
  on port 8899 (`SURFPOOL_PORT`) with **all five programs preloaded via
  `--bpf-program`, plus Metaplex Core staged from a committed fixture**
  (`programs/ario-arns/tests/fixtures/mpl_core.so`, id
  `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`), and writes
  `localnet/out/localnet.env` (program ids + RPC URL) "so downstream tooling (SDK
  tests, migration import, indexer tests) can source it" (repo scripts/README).
- **[ar-io/ar-io-sdk](https://github.com/ar-io/ar-io-sdk)** (`@ar.io/sdk` v4.3.0):
  "The Solana-native SDK for the AR.IO network."
  `ARIO.init({ rpc, rpcSubscriptions, signer, ... })` over `@solana/kit`; the
  README's Networks section states the SDK talks to whatever cluster the RPC client
  points at, and "for devnet **or a local validator**, override the RPC URL and
  the per-program addresses" (`coreProgramId`/`garProgramId`/`arnsProgramId`/
  `antProgramId`). The old AO options (`processId`, `CU_URL`) are gone. The TOON
  store already exercises exactly this override surface
  (`store/src/arns-buy-handler.ts`).

### Component-by-component

**Gateway — [ar-io/ar-io-node](https://github.com/ar-io/ar-io-node)** (active;
latest release **r83**, 2026-09-02). Chain indexing, GraphQL, ANS-104 unbundling,
ArNS resolution, data serving. Its `docker-compose.yaml` (main):

| Service | Image | Port |
|---|---|---|
| envoy (entrypoint) | `ghcr.io/ar-io/ar-io-envoy:<sha-pinned>` | 3000 |
| core | `ghcr.io/ar-io/ar-io-core:<sha-pinned>` | 4000 |
| redis | `redis:7` | internal 6379 |
| observer | `ghcr.io/ar-io/ar-io-observer:<sha-pinned>` | 5050 |
| clickhouse / litestream / otel / autoheal | various | opt-in profiles |

The compose pins every ghcr image to a commit SHA by default (overridable via
`*_IMAGE_TAG`) — adopt that pinning style. Config comes from a root `.env` file
([repo compose](https://raw.githubusercontent.com/ar-io/ar-io-node/main/docker-compose.yaml),
[docs/envs.md](https://raw.githubusercontent.com/ar-io/ar-io-node/main/docs/envs.md),
[docs.ar.io env-var reference](https://docs.ar.io/build/run-a-gateway/manage/environment-variables)).

Key env for local wiring (exact names from compose + docs/envs.md):

- **Solana/ArNS state (the local-stack hook):** `SOLANA_RPC_URL` (default
  mainnet-beta) + `ARIO_CORE_PROGRAM_ID`, `ARIO_GAR_PROGRAM_ID`,
  `ARIO_ARNS_PROGRAM_ID`, `ARIO_ANT_PROGRAM_ID` (mainnet defaults baked in, all
  overridable; devnet values listed in envs.md). "The gateway reads protocol state
  from Solana on-chain programs. The OnDemandArNSResolver routes ANT lookups
  through `@ar.io/sdk/solana::SolanaANTReadable`" (docs/envs.md, Solana Backend).
  → Point these at the local validator and the localnet program ids.
- **ArNS serving:** `ARNS_ROOT_HOST` (e.g. `ar.localhost`; needs wildcard subdomain
  routing), `SANDBOX_PROTOCOL`, `APEX_ARNS_NAME`, `ARNS_RESOLVER_PRIORITY_ORDER`,
  `ARNS_CACHE_TYPE` (default redis).
- **Arweave upstream:** `TRUSTED_NODE_URL` (data fetching; default arweave.net via
  envoy's `TVAL_TRUSTED_NODE_HOST`/`PORT`), `TRUSTED_GATEWAYS_URLS` (proxying
  priority map), `START_HEIGHT`/`STOP_HEIGHT`, `GRAPHQL_HOST`/`GRAPHQL_PORT`
  (GraphQL pass-through), plus envoy's `FALLBACK_NODE_HOST` and
  `ARWEAVE_PEER_DNS_RECORDS` which reach mainnet unless overridden.
- **Unbundling:** `ANS104_UNBUNDLE_FILTER`, `ANS104_INDEX_FILTER` (default
  `{"never": true}`).
- **Admin:** `ADMIN_API_KEY` (generated + logged if unset; `ADMIN_API_KEY_FILE`
  wins).

**Uploads — Turbo bundler sidecar.** The standalone `turbo-upload-service` repo is
no longer public (404 under ardriveapp), **but the service ships as public images
with an official compose inside ar-io-node**: `docker-compose.bundler.yaml` brings
up `upload-service` (**`ghcr.io/ardriveapp/turbo-upload-service`**, SHA-pinned,
port **5100**), `fulfillment-service`
(`ghcr.io/ardriveapp/turbo-upload-service-fulfillment`), `postgres:13.8`, and
`ghcr.io/ardriveapp/turbo-upload-service-localstack` (S3+SQS emulation, 4566) —
all verified anonymously pullable
([ar-io-node README + docker-compose.bundler.yaml](https://github.com/ar-io/ar-io-node)).
Local wiring is the *default posture*:

- `ARWEAVE_GATEWAY` defaults to `http://envoy:3000` — bundles submit through your
  own gateway; `OPTICAL_BRIDGE_URL` defaults to the local admin endpoint
  (`http://envoy:3000/ar-io/admin/queue-data-item`) so uploads are served
  instantly by the local gateway.
- **No payment service needed:** `PAYMENT_SERVICE_BASE_URL` defaults empty; allow
  everything with `SKIP_BALANCE_CHECKS=true`, or gate by wallet via
  `ALLOW_LISTED_ADDRESSES` / by chain via `ALLOW_LISTED_SIGNATURE_TYPES` (README
  permissioning matrix).
- Bundler identity/filters (`.env.bundler.example`): `BUNDLER_ARWEAVE_WALLET`
  (stringified JWK), `BUNDLER_ARWEAVE_ADDRESS`,
  `ANS104_INDEX_FILTER={"always": true}`,
  `ANS104_UNBUNDLE_FILTER={"attributes":{"owner_address":"$BUNDLER_ARWEAVE_ADDRESS"}}`,
  localstack S3 (`AWS_S3_CONTIGUOUS_DATA_BUCKET=ar.io`,
  `AWS_ENDPOINT=http://localstack:4566`).
- Run: `docker compose --env-file ./.env.bundler --file docker-compose.bundler.yaml up`;
  data items land at `<gateway>/bundler/tx`. README caveat: the bundler expects the
  gateway's GraphQL index synced near chain head before starting.

**AO components — not required.** For completeness: legacy cu/mu/su images exist
and are pullable (`ghcr.io/permaweb/ao-cu|ao-mu|ao-su:latest`,
[permaweb/ao](https://github.com/permaweb/ao)), and aoconnect accepts custom
`MU_URL`/`CU_URL`/`GATEWAY_URL`
([AO cookbook](https://cookbook_ao.arweave.net/guides/aoconnect/connecting.html)) —
but the only turnkey composition, [permaweb/ao-localnet](https://github.com/permaweb/ao-localnet),
is unmaintained (last push 2024-07-04, "no Tier 1 support") and
[HyperBEAM](https://github.com/permaweb/HyperBEAM) (active successor, local-runnable
from source, port 8734, no public image) is irrelevant to ArNS now. Leave AO out of
the stack unless a concrete AO need appears.

### Verdict: fully-local AR.IO/ArNS feasibility

**Achievable today — as a Solana-backed stack, and with one honest limitation.**

Works fully locally, on official, documented paths:

1. **ArNS registry/ANTs**: local validator preloaded with the five AR.IO programs +
   Metaplex Core (AR.IO's own `start-localnet.sh` pattern); `@ar.io/sdk` v4
   officially supports "a local validator" via RPC + program-id overrides.
2. **Resolution/gateway**: ar-io-node with `SOLANA_RPC_URL` + the four
   `ARIO_*_PROGRAM_ID`s pointed at that validator; ArNS serving via
   `ARNS_ROOT_HOST`.
3. **Uploads**: the Turbo bundler sidecar with `SKIP_BALANCE_CHECKS=true`, bundling
   through the local gateway with instant optical-bridge serving.

**Not possible locally (evidence):**

- **A real local Arweave chain under the gateway.** ar-io-node has zero support for
  indexing ArLocal or any local/test Arweave network: no mention in README,
  docs/envs.md, or docs.ar.io; zero hits for "arlocal" in the repo's code and
  issues. `TRUSTED_NODE_URL` is a plain URL so pointing it at ArLocal is
  *mechanically* possible but undocumented and unsound — core's sync pipeline
  expects real node semantics (blocks, `/chunk`, peer lists), ArLocal implements
  none of that, and envoy's fallback/peer defaults still reach mainnet. The
  official Erlang node's localnet mode is source-build-only internal tooling.
  **Consequence:** locally, "permanence" is simulated — uploaded data items are
  optical-bridged into the local gateway and served immediately, but bundles are
  never finalized onto a chain. For flows that need real finality, the documented
  off-mainnet option is **Solana devnet** (CI-deployed staging program ids) plus
  Turbo's free devnet uploads ([docs.ar.io/build/upload/](https://docs.ar.io/build/upload/))
  and [ar-io/ar-io-faucet](https://github.com/ar-io/ar-io-faucet).
- **Fully-local AO** (if ever needed): only semi-viable — images exist but the
  turnkey compose is two years stale.

---

## Proposed compose topology (sketch)

One project, profile-gated. Chains + deploys first, AR.IO layer second, TOON apps
third. (Sketch, not a final file; image pins to be finalized.)

```yaml
services:
  # ── chains ────────────────────────────────────────────────────────
  anvil:                       # profile: evm  (pattern: connector/docker-compose.yml)
    image: ghcr.io/foundry-rs/foundry:v1.8.1
    # entrypoint: anvil :8545 --chain-id 31337, then forge script DeployLocal.s.sol
    # healthcheck: cast code <TokenNetworkRegistry> != 0x
    ports: ['8545:8545']

  solana-validator:            # profile: solana
    image: ghcr.io/beeman/solana-test-validator:latest   # frozen 2026-07; see risks
    # entrypoint: solana-test-validator --reset --limit-ledger-size 10000000
    #   --bpf-program HY4AYFNe... payment_channel.so            (TOON, from connector)
    #   --bpf-program <ario_core> ario_core.so ... (5 AR.IO programs)
    #   --bpf-program CoREENxT6... mpl_core.so                  (Metaplex Core fixture)
    # + seed USDC mint (connector/infra/solana/create-usdc-mint.sh pattern)
    ports: ['8899:8899', '8900:8900']
    security_opt: [seccomp=unconfined]

  arlocal:                     # profile: arweave (app-level simulator only)
    image: textury/arlocal:v1.1.66
    ports: ['1984:1984']

  mina-lightnet:               # profile: mina — OPTIONAL: no TOON artifacts exist
    image: o1labs/mina-local-network:compatible-latest-lightnet
    environment: { NETWORK_TYPE: single-node, PROOF_LEVEL: none, RUN_ARCHIVE_NODE: 'true' }
    ports: ['8080:8080', '8181:8181', '8282:8282']

  # ── AR.IO layer (profile: ario) ───────────────────────────────────
  redis:      { image: redis:7 }
  ar-io-core:                  # ghcr.io/ar-io/ar-io-core:<sha per r83>
    environment:
      SOLANA_RPC_URL: http://solana-validator:8899
      ARIO_CORE_PROGRAM_ID: <localnet id>      # + GAR/ARNS/ANT ids
      ARNS_ROOT_HOST: ar.localhost
      ANS104_UNBUNDLE_FILTER: '{"attributes":{"owner_address":"<bundler addr>"}}'
      ANS104_INDEX_FILTER: '{"always": true}'
    depends_on: [redis, solana-validator]
    ports: ['4000:4000']
  ar-io-envoy:                 # ghcr.io/ar-io/ar-io-envoy:<sha> — the entrypoint
    depends_on: [ar-io-core]
    ports: ['3000:3000']       # NOTE: collides with connector's client edge — remap one
  upload-service:              # ghcr.io/ardriveapp/turbo-upload-service:<sha>
    environment: { ARWEAVE_GATEWAY: 'http://ar-io-envoy:3000', SKIP_BALANCE_CHECKS: 'true' }
    depends_on: [upload-pg, localstack, ar-io-envoy]
    ports: ['5100:5100']
  fulfillment-service:         # ghcr.io/ardriveapp/turbo-upload-service-fulfillment:<sha>
    depends_on: [upload-pg, localstack]
  upload-pg:  { image: postgres:13.8 }
  localstack: { image: ghcr.io/ardriveapp/turbo-upload-service-localstack:<sha> }  # :4566

  # ── TOON apps ─────────────────────────────────────────────────────
  connector:                   # ghcr.io/toon-protocol/connector:rust-<handle>
    # connector.toml: settlement.evm → http://anvil:8545 (registry 0xe7f1..., USDC 0x5FbD...)
    #                 settlement.solana → http://solana-validator:8899 (HY4AYFNe..., mint H8HS...)
    depends_on: { anvil: {condition: service_healthy}, solana-validator: {condition: service_healthy} }
    ports: ['3001:3000']       # remapped off envoy's 3000
  store:                       # ghcr.io/toon-protocol/store:release — :3300/:3400
    # Turbo/ArNS wiring gap: see risks — SDK endpoints for local Turbo/validator
    depends_on: [connector, upload-service]
  gas-station:                 # SOLANA_RPC_URL=http://solana-validator:8899 — :3300/:3400
    depends_on: [solana-validator]
```

Deploy steps per chain, summarized: **EVM** — in-container `forge script
DeployLocal.s.sol` after anvil binds (deterministic addresses; health = registry
code present). **Solana** — build `payment_channel.so` (`make solana-build`,
platform-tools v1.52) and obtain the AR.IO `.so`s (build from
ar-io-solana-contracts, or `solana program dump` from devnet), then load all at
genesis via `--bpf-program`. **Arweave** — nothing to deploy; `/mint` + `/mine` as
needed. **Mina** — nothing to deploy (ADR 0065).

## Open questions / risks

1. **Solana validator image staleness.** `ghcr.io/beeman/solana-test-validator`
   nightly builds stopped 2026-07-06; official Anza Docker images are sunsetting.
   Options: keep the frozen image (works today, agave 4.0.3), or maintain a tiny
   own Dockerfile over Anza release binaries. AR.IO's localnet uses **Surfpool**
   (`cargo install surfpool`) rather than solana-test-validator — whether the AR.IO
   programs behave identically under plain `solana-test-validator --bpf-program`
   (vs. Surfpool's mainnet-style feature gates) needs a spike; alternatively check
   whether Surfpool ships a Docker image and could host the TOON program too.
2. **AR.IO program ids on a localnet.** `start-localnet.sh` writes
   `localnet/out/localnet.env`; the exact ids it assigns (fixed keypairs in-repo vs.
   generated) weren't pinned down — determine them so the gateway's
   `ARIO_*_PROGRAM_ID` env and the store's SDK overrides can be committed. Also:
   seeding local state (a registered ArNS name, a funded ARIO account) needs a
   provisioning script against the local programs.
3. **Store's local wiring gap.** The store's Turbo credential/env surface
   (`STORE_TURBO_*`, `store/README.md`) selects Solana network for *payment*, but
   whether `@ardrive/turbo-sdk` in the store can be pointed at the **local**
   upload-service URL (and `@ar.io/sdk` at the local validator beyond devnet ids)
   may need a small store change (the SDK supports custom endpoints; the store's
   env may not expose them yet).
4. **No real local Arweave finality** (see verdict): the local upload flow is
   optical-bridge-instant but chainless; ArLocal is archived; the official node's
   localnet is source-build-only. Decide whether simulated permanence is acceptable
   for local dev (recommended) and reserve Solana devnet + Turbo devnet for
   finality-sensitive testing.
5. **Port collisions**: envoy (3000) vs. connector client edge (3000); store and
   gas-station both default 3300/3400 (`store/README.md`, `gas-station/README.md`).
   Remap in compose.
6. **Mina**: carrying a 4.5 GB-RAM lightnet container for a chain the project
   deleted (ADR 0065) is pure cost unless zkApp work is actually planned — confirm
   with the team before including even behind a profile.
7. **Resource footprint** overall: validator ledger growth (cap with
   `--limit-ledger-size`, per connector's incident notes), gateway indexing
   (`START_HEIGHT`, narrow ANS-104 filters), clickhouse/observer left off by
   default.
8. **License note**: ar-io-solana-contracts is AGPL-3.0 — fine to run locally;
   flag if TOON ever redistributes modified programs.

## Sources

Local repos (this machine):
`/home/allidoizcode/Work/TOON-Protocol/connector` — `README.md`,
`docker-compose.yml`, `Makefile`, `Cargo.toml`, `local/README.md`,
`local/solo/connector.toml`, `infra/solana/entrypoint.sh`,
`tools/solana/build-sbf.sh`, `packages/contracts/script/DeployLocal.s.sol`,
`packages/solana-program/Cargo.toml`,
`docs/adr/0002-drop-mina-from-the-rust-connector.md`,
`docs/adr/0065-mina-leaves-the-repository.md`,
`crates/connector-bin/tests/devnet_store_leg_probe.rs` ·
`/home/allidoizcode/Work/TOON-Protocol/store` — `README.md`, `package.json`,
`src/arns-buy-handler.ts`, `src/arns-ant-prepare.ts` ·
`/home/allidoizcode/Work/TOON-Protocol/gas-station/README.md`

Web (primary):
[ar-io/ar-io-node](https://github.com/ar-io/ar-io-node) (README,
docker-compose.yaml, docker-compose.bundler.yaml, docs/envs.md) ·
[docs.ar.io gateway env vars](https://docs.ar.io/build/run-a-gateway/manage/environment-variables) ·
[docs.ar.io/learn/arns](https://docs.ar.io/learn/arns) ·
[docs.ar.io/build/upload](https://docs.ar.io/build/upload/) ·
[ar-io/ar-io-solana-contracts](https://github.com/ar-io/ar-io-solana-contracts) ·
[ar-io/ar-io-sdk](https://github.com/ar-io/ar-io-sdk) ·
[@ar.io/solana-contracts (npm)](https://www.npmjs.com/package/@ar.io/solana-contracts) ·
[ar-io/ar-io-network-process (archived)](https://github.com/ar-io/ar-io-network-process) ·
[ar-io/arns-resolver (archived)](https://github.com/ar-io/arns-resolver) ·
[ar-io/ar-io-faucet](https://github.com/ar-io/ar-io-faucet) ·
[ar-io/arns-service compose](https://raw.githubusercontent.com/ar-io/arns-service/main/docker-compose.yaml) ·
[solana-foundation/surfpool](https://github.com/solana-foundation/surfpool) ·
[textury/arlocal (archived)](https://github.com/textury/arlocal) ·
[arlocal (npm)](https://registry.npmjs.org/arlocal) ·
[textury/arlocal (Docker Hub)](https://hub.docker.com/r/textury/arlocal) ·
[ArweaveTeam/arweave](https://github.com/ArweaveTeam/arweave) ·
[permaweb/ao-localnet](https://github.com/permaweb/ao-localnet) ·
[permaweb/ao](https://github.com/permaweb/ao) ·
[permaweb/HyperBEAM](https://github.com/permaweb/HyperBEAM) ·
[AO cookbook — aoconnect](https://cookbook_ao.arweave.net/guides/aoconnect/connecting.html) ·
[getfoundry.sh installation](https://getfoundry.sh/introduction/installation) ·
[foundry container (GHCR)](https://github.com/foundry-rs/foundry/pkgs/container/foundry) ·
[beeman/solana-test-validator](https://github.com/beeman/solana-test-validator) ·
[anzaxyz/agave (Docker Hub)](https://hub.docker.com/r/anzaxyz/agave) ·
[docs.anza.xyz/cli/install](https://docs.anza.xyz/cli/install) ·
[solana-labs/solana (archived)](https://github.com/solana-labs/solana) ·
[Mina Lightnet docs](https://docs.minaprotocol.com/zkapps/testing-zkapps-lightnet) ·
[o1js local development](https://docs.o1labs.org/o1js/zkapps/local-development) ·
[o1labs/mina-local-network (Docker Hub)](https://hub.docker.com/r/o1labs/mina-local-network)
