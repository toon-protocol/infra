# TOON Protocol dev sandbox — operator guide

This directory is a **complete TOON Protocol network on your machine**: one
`docker compose` project containing local chains, a local AR.IO permaweb
stack, the TOON payment layer, and the three first-party TOON apps — all
wired together, all seeded, all proven by one smoke test. Nothing here ever
touches mainnet (or even devnet); every wallet is a valueless committed
throwaway.

It exists so you can **develop against TOON, and develop your own TOON
apps**, with the whole network under your control: break it, wipe it,
cold-start it in ~2 minutes, and step through any paid flow end to end.

**Contents**

1. [What you get](#1-what-you-get)
2. [Quick start](#2-quick-start)
3. [The tour: what's running](#3-the-tour-whats-running)
4. [Cookbook: using each surface](#4-cookbook-using-each-surface)
5. [Build your own TOON app](#5-build-your-own-toon-app)
6. [Under the hood](#6-under-the-hood)
7. [Lifecycle and state](#7-lifecycle-and-state)
8. [Troubleshooting](#8-troubleshooting)
9. [Known limits and residue](#9-known-limits-and-residue)

---

## 1. What you get

Four layers, one compose project:

- **Chains** — a Solana test validator (with AR.IO's five Anchor programs,
  Metaplex Core, and TOON's `payment_channel` program preloaded at genesis),
  an EVM chain (anvil, chain-id 31337, the connector's settlement contracts
  auto-deployed), and a fake Arweave node (ArLocal).
- **AR.IO stack** — a real ar-io-node gateway (r83) plus the Turbo upload
  bundler, fully local: uploads are served back instantly, ArNS names bought
  on the local validator resolve at `http://<name>.ar.localhost:3000/`.
- **TOON payment layer** — four ILP connectors: the **hub**
  (`relay-connector`) and three peered connectors, with **real,
  collateralised payment channels**. The client leg settles USDC on anvil;
  all three peering legs settle USDC over Solana `payment_channel` accounts.
  Same 6-decimal unit end to end — conversion/FX is explicitly out of scope
  and unsupported.
- **TOON apps** — the relay (paid Nostr writes), the store (paid Arweave
  uploads + brokered ArNS buys), the gas station (pays your Solana rent or
  relays your EVM meta-tx), and the **Anyone Protocol credentials issuer**
  (blind-signed credential bundles, behind a claim minter). The first three
  are payment-oblivious HTTP apps behind their connector — the pattern
  **your** app will follow (§5); the issuer is the counter-example, an app
  that refuses to serve without proof of payment at its own layer (§6.5).

Everything can be reached through the hub by ILP address:

| ILP address | App | Price (hub, smallest USDC units) |
|---|---|---|
| `g.toon.relay` | Nostr relay write | 1 |
| `g.toon.relay.ephemeral` | ephemeral write | 0 |
| `g.toon.store` | blob store (kind:5094), ArNS broker (kind:5095) | 1100 base + 10/KiB |
| `g.toon.gastation` | gas station (kind:5096 Solana, kind:5098 EVM) | 1100 |
| `g.anyone.credentials` | Anyone credentials bundle (`POST v1/bundles`) | 10100 |
| `g.anyone.credentials.keys` | the issuer's epoch key document (`GET current`) | 100 (**0** at `anytoon-connector`'s own edge) |

What `make smoke` proves on every run — all flows paid, all entering at the
hub's edge:

1. **AR.IO**: upload via the local Turbo bundler → buy an ArNS name on the
   local validator → point the ANT's `@` record at the upload → fetch
   `http://<name>.ar.localhost:3000/` through the local gateway.
2. **TOON**: a real `@toon-protocol/client` opens a payment channel on anvil
   against the hub, then: a paid Nostr write (read back byte-identical over
   the free WS), a paid blob store (lands in the local bundler, served by
   the local gateway), the **full brokered ArNS ceremony** (paid
   `op=prepare` composes an ANT spawn → a SOL-less owner signs → the gas
   station pays rent + fee and broadcasts via paid kind:5096 → paid
   `op=buy` has the store's DVM purchase a fresh name → the gateway
   resolves it), a paid Solana gas quote, and a paid EVM ERC-2771 relay
   (an unfunded wallet's signed request lands on anvil with `_msgSender()`
   read back as the client), and a **paid credentials bundle** from the
   Anyone issuer (the free epoch key document first, then one routed
   purchase that comes back blind-signed — plus the proof that the free
   route cannot be walked into the issuer's paid root). The connectors' own
   claim books are asserted per leg: the client leg on the anvil channel,
   all three peering legs on the committed Solana channel accounts.

Everything here was distilled from three proven throwaway prototypes on the
`prototype/local-ar-io-stack` branch
(`prototypes/{solana-arns,gateway-upload,full-stack}` — their `VERDICT.md`s
hold the detailed findings).

## 2. Quick start

### Prerequisites

- Docker with the compose plugin
- Node.js >= 20 with npm (for the smoke test / driver scripts on the host)
- The **connector sibling checkout** at `../../connector` — the `anvil`
  service bind-mounts its Foundry project (`packages/contracts`) and deploys
  the settlement contracts in-container on every start (the connector repo's
  own proven pattern; submodules self-heal if the clone wasn't `--recursive`)
- **Full stack only** — the **store sibling checkout** at
  `../../store-gaps-worktree`: the `store` image is BUILT from it (compose
  build context), because the sandbox needs the local-endpoint-override
  change that checkout carries (branch `feat/local-endpoint-overrides`:
  `STORE_TURBO_UPLOAD_URL`, `ARNS_SOLANA_RPC_URL`/`ARNS_SOLANA_WS_URL`) and
  the pinned upstream image predates it. `make up` preflights it and says how
  to repoint the context (Makefile `STORE_CONTEXT` + the `store` service in
  `docker-compose.yml`) if your checkout lives elsewhere; once upstream
  ships the change, the commented image pin in `docker-compose.yml` works
  again. The `payments` profile below never builds the store, so it needs
  none of this
- **Full stack only** — the **anytoon sibling checkout** at `../../anytoon`:
  the `claim-minter` image is BUILT from it (`claim-minter/`), because that
  component publishes no image. Override with `ANYTOON_CONTEXT` if your
  checkout lives elsewhere: `make up ANYTOON_CONTEXT=/path/to/anytoon`;
  `make up` preflights it (`make setup` only prints a note). Only
  `claim-minter/` is used — the issuer itself is the upstream image, pulled
  and run unmodified. The `payments` profile never builds it
- Free host ports: 3000, 3004, 5100, 4566, 1984, 8545, 8899, 8900, 3200,
  3210, 3220, 3230, 3300, 3400, 7100 — the `payments` profile only needs
  8545, 8899, 8900, 3200 and 7100
- **Full stack only** — `*.localhost` resolving to loopback (default on
  modern Linux/macOS resolvers; check with `getent hosts foo.ar.localhost`)

### Cold start

```bash
cd sandbox
make setup          # npm ci + preflight checks (one-time)
make up             # docker compose up -d --build
# first run: pulls images + builds the seeder; stack settles in ~1-2 min
make smoke          # full end-to-end proof of both layers
```

`make up` alone brings up everything in the right order — all seeding is
expressed as one-shot compose services gated on healthchecks (§6.1), so
there is no separate provisioning step and re-running `make up` is always
safe.

```bash
make down    # stop, keep state (uploads, gateway caches, claim journals)
make clean   # stop + wipe ALL state; next `make up` is a cold start again
make logs    # follow everything        make ps   # service status
```

### Payment layer only (the `payments` profile)

If you are writing a TOON **client**, or iterating on your own route against
the hub (§5), you do not need the permaweb half of the sandbox — and you do
not need the store sibling checkout either:

```bash
cd sandbox
make setup           # npm ci; says so and moves on if there's no store checkout
make up-payments     # docker compose --profile payments up -d --build
make smoke-payments  # payment-layer proof only
```

Seven services instead of twenty-one:

| in `payments` | why |
|---|---|
| `anvil` | the CLIENT leg settles here (EVM mock USDC) |
| `solana-validator` | the PEER legs settle here; carries `payment_channel` |
| `seed-toon-evm` | ETH + mock USDC for every settlement key |
| `seed-toon-solana` | the Solana mock USDC mint, ATAs and SOL |
| `relay` | `g.toon.relay` is the hub's only TERMINATED route — the one destination a paid packet can reach with no peer running |
| `relay-connector` | the hub itself, client edge on **3200** |
| `open-toon-solana-channels` | opens + collateralises the hub's two Solana channels |

Left out: the AR.IO gateway and Turbo bundler (`envoy`, `core`, `redis`,
`arlocal`, `upload-service`, `fulfillment-service`, `upload-service-pg`,
`localstack`, `seed-gateway-block`, `seed-solana`), the `store` and
`gas-station` apps, and the two peering connectors that front them
(`store-connector`, `gas-connector`).

The hub still LOADS both peerings under this profile — nothing about its
config changes — so `g.toon.store` and `g.toon.gastation` are still priced and
routed, they simply answer `T01` with nobody on the far side. `g.toon.relay`
(price 1) and `g.toon.relay.ephemeral` (free) work exactly as in the full
stack, which is what `make smoke-payments` proves: contracts + program live,
both Solana peering channels open and collateralised on the validator, an EVM
channel opened against the hub, a paid write routed through it and journaled
as a claim on that channel.

`make down`, `make clean`, `make logs` and `make ps` work the same either way.

> **Driving compose by hand:** every service carries a profile, so a bare
> `docker compose …` in `sandbox/` selects nothing and does nothing. Pass the
> profile (`docker compose --profile full ps -a`) or export
> `COMPOSE_PROFILES=full` in your shell — or drop it in a local `sandbox/.env`
> once. A `--profile` flag on the command line replaces `COMPOSE_PROFILES`
> rather than adding to it. The `make` targets always pass one for you.

## 3. The tour: what's running

| service | what | host port |
|---|---|---|
| `solana-validator` | agave test validator with AR.IO's five Anchor programs + Metaplex Core + the TOON `payment_channel` program preloaded at genesis, 2MB NameRegistry account preloaded | 8899 (RPC), 8900 (WS) |
| `anvil` | local EVM chain (chain-id 31337) with the connector's settlement contracts auto-deployed (MockERC20 USDC, TokenNetworkRegistry, TokenNetwork) + the sandbox's ERC-2771 extras | 8545 |
| `arlocal` | fake Arweave node (the gateway's "trusted node") | 1984 |
| `envoy` + `core` + `redis` | AR.IO gateway (ar-io-node r83; service definitions vendored, images pinned to r83's SHAs — no ar-io-node checkout needed) | 3000 (gateway), 3004 (core direct) |
| `upload-service` + `fulfillment-service` + `upload-service-pg` + `localstack` | Turbo bundler stack | 5100 (upload), 4566 (localstack) |
| `relay-connector` | TOON ILP connector — the HUB (`g.toon.relay`, forwards `g.toon.store` / `g.toon.gastation` over peerings) | 3200 (client edge) |
| `store-connector` | TOON connector terminating `g.toon.store` | 3210 (client edge) |
| `gas-connector` | TOON connector terminating `g.toon.gastation` | 3220 (client edge) |
| `anytoon-connector` | TOON connector terminating `g.anyone.credentials` (paid) + `g.anyone.credentials.keys` (free) | 3230 (client edge) |
| `relay` | TOON Nostr relay (paid writes via connector only; write port 3100 unpublished) | 7100 (free NIP-01 reads) |
| `store` | paid Arweave blob store, kind:5094 + kind:5095 ArNS (op=prepare + brokered op=buy) — built from the store sibling checkout (paid handler 3300 unpublished) | 3300 → container 3400 (free /health) |
| `gas-station` | pays gas: kind:5096 (Solana) + kind:5098 (EVM ERC-2771 meta-tx relay on anvil) (paid handler 3300 unpublished) | 3400 (free /describe + /health) |
| `issuer` | the **upstream** `anyone-protocol/credentials-issuer`, unmodified — blind-signs credential bundles, refuses without a signed `X-Payment-Claim` | none (unpublished) |
| `claim-minter` | turns the connector's `X-TOON-Payer` attribution into that signed claim; proxies `POST /v1/bundles` and nothing else. Built from the anytoon sibling checkout | none (unpublished) |
| `issuer-postgres`, `issuer-redis` | the issuer's own datastores (issuance records, idempotency, rate limits) | none (unpublished) |
| `seed-solana`, `seed-gateway-block`, `seed-toon-solana`, `seed-toon-evm`, `open-toon-solana-channels`, `issuer-keys`, `issuer-migrate` | one-shot idempotent init jobs | — |

### Payment topology

```
smoke test / any client (host)
   │ POST /ilp (paid)                       ┌──────────────────────────────┐
   ▼                                        │  ws://localhost:7100 (free)  │
relay-connector :3200  ── g.toon.relay ──▶ relay:3100/write ──▶ relay reads┘
   │        (hub)      ── g.toon.relay.ephemeral ─▶ relay:3100/write-ephemeral
   ├─ g.toon.store ──[peering relay-store]──▶ store-connector :3210
   │        (settles on SOLANA)                 └─▶ store:3300/store (kind:5094/5095)
   ├─ g.toon.gastation ──[peering relay-gas]──▶ gas-connector :3220
   │        (settles on SOLANA)                 └─▶ gas-station:3300/gas (kind:5096 + 5098)
   └─ g.anyone.credentials ──[peering relay-anytoon]──▶ anytoon-connector :3230
            (settles on SOLANA)                 ├─▶ claim-minter:8080 ──▶ issuer:3000  (paid)
                                                └─▶ issuer:3000/v1/keys/              (free)
```

Cross-chain, same-asset: the CLIENT leg settles on anvil (EVM mock USDC —
the channel the smoke opens in step 1), all three PEERING legs settle on the
local validator (`payment_channel`-program channels in the Solana mock USDC
mint). Both mocks are 6-decimal USDC, so amounts cross the chain boundary
unconverted.

- Connector client edges: hub **3200**, store **3210**, gas **3220**,
  anytoon **3230** (all `GET /ilp` self-describing; the operator surface
  rides the same port).
- The apps' PAID handler ports (relay 3100, store 3300, gas-station 3300)
  are **unpublished** — the only route to them is a paid packet through a
  connector, and the relay leans on exactly that (it skips schnorr
  verification for paid ephemeral kinds). The whole issuer subsystem
  (`claim-minter`, `issuer`, `issuer-postgres`, `issuer-redis`) is
  unpublished for the same reason, and there the unreachability is what
  *authorises issuance*: the minter deliberately does not check
  `X-TOON-Amount`, so an ingress other than the connector would mint free
  claims (anytoon ADR 0001).
- Free surfaces: relay reads **:7100** (NIP-01 WS), store health **:3300**
  (container 3400), gas-station **:3400** (`/describe` + `/health`), and the
  issuer's epoch key document at `g.anyone.credentials.keys` — free at
  `anytoon-connector`'s own edge (**:3230**, price 0, no channel needed),
  and 100 through the hub, which is the hop's fee and nothing more.

## 4. Cookbook: using each surface

The two smoke scripts are living, working examples of everything below:
`scripts/smoke-test.mjs` (AR.IO layer) and `scripts/smoke-toon.mjs` (paid
flows, claim assertions).

**Upload via Turbo** — point `@ardrive/turbo-sdk` at the gateway proxy:

```js
TurboFactory.authenticated({ privateKey, token: 'arweave',
  uploadServiceConfig: { url: 'http://localhost:3000/bundler' } })
```

Uploads are served by the gateway instantly (optical path).

**Fetch by id** — `http://localhost:3000/raw/<id>`. Plain `/<id>` does NOT
work locally: with `ARNS_ROOT_HOST` set, the gateway 302s it to an
unreachable `https://<base32>.ar.localhost` sandbox URL.

**Buy ArNS names directly** (no payment layer) — `@ar.io/sdk` with
`DEVNET_PROGRAM_IDS` overrides against `http://localhost:8899` /
`ws://localhost:8900` (exactly the store's devnet path; complete example in
`scripts/smoke-test.mjs`). The default buyer is `keys/admin.json`, funded
with 10M local ARIO by the seeder.

**Resolve names** — `http://<name>.ar.localhost:3000/` in any browser, or
`http://localhost:3000/ar-io/resolver/<name>`. A freshly bought name
resolves within ~5s (the sandbox shrinks the gateway's name-list
miss-refresh interval; the first request may 404 once).

**GraphQL** — `http://localhost:3000/graphql`. Uploads appear immediately
with `block: null` (optimistic/pending — correct, nothing is mined).

**EVM** — anvil at `http://localhost:8545` (chain-id 31337, ten funded
accounts from the public test mnemonic). Deployed at deterministic,
committed addresses: MockERC20 USDC `0x5FbD…0aa3`, TokenNetworkRegistry
`0xe7f1…0512`, TokenNetwork `0xCafa…052c` (from the connector's
`DeployLocal.s.sol`), plus the sandbox's kind:5098 extras
(`contracts/DeploySandboxExtras.s.sol`, anvil account 9 nonces 0/1): OZ
v5.5.0 `ERC2771Forwarder("ToonSandboxForwarder")` at
`0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35` and the ERC-2771-aware
`SandboxTokenNetworkProbe` at `0xA15BB66138824a1c7167f5E85b957d04Dd34E468`.

**Paid packets** — hand a paid ILP packet to the hub at
`http://localhost:3200`:

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

NIP-90 jobs (the store's kinds 5094/5095, the gas station's 5096/5098) ride
the same mechanism — `scripts/smoke-toon.mjs` shows `sendJob` /
`buildJobEvent` usage for every kind, including the full brokered ArNS
ceremony (`buyArnsNameWithNewAnt`).

**Ask a node what it serves** — `curl http://localhost:3400/describe` (gas
station) lists its kinds, phases, chains, and per-phase params; `/health`
answers liveness. This self-describing pattern is worth copying in your own
app.

**Buy Anyone credentials** — the epoch key document first (free at the
anytoon node's own edge, so a client with no channel can read it), then one
paid purchase routed through the hub:

```js
// free: no channel needed, price 0 at this edge
const free = await ToonClient.create({ connector: 'http://localhost:3230', /* … */ });
const epoch = (await free.send('g.anyone.credentials.keys',
  { method: 'GET', target: 'current' })).json().epoch_id;

// paid: through the hub, sealed to the terminating (anytoon) connector
const bundle = await client.send('g.anyone.credentials', {
  method: 'POST', target: 'v1/bundles',
  body: { epoch, blinded_blanks: [/* 10 x 256 base64 bytes */] },
}, { sealTo: 'http://localhost:3230' });
bundle.json();   // { epoch, blind_signatures: [ …10… ] }
```

`target` is **relative** — `'v1/bundles'`, never `'/v1/bundles'`: a leading
slash is an absolute-path escape and comes back `F00`, unpaid, before the app
is touched. That is the same rule that keeps the free keys route off the
issuer's paid root (§6.5).

## 5. Build your own TOON app

This is what the sandbox is for. The design rule, straight from the relay
and store repos: **your app contains no payment code at all.** It is a
plain HTTP server; the connector in front meters the request, settles it
on-chain, and only then reverse-proxies it over the private network. By the
time your code runs, the money is already collected.

The whole contract between connector and app is two halves:

**The connector's side** — one route row in a `connector-*.toml`:

```toml
[[routes]]
prefix      = "g.toon.myapp"              # the ILP address clients pay
handler_url = "http://myapp:3300/myapp"   # your backend — the path is literal
price       = 1000                        # smallest unit of the token (0.001 USDC)
```

**Your side** — accept a POST, do the work, answer 200 with JSON. The
connector adds `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain` headers it
has **already validated** — trust them, never re-check payment in the app
(claim validation lives only in the connector). They are present only when
that connector collected the payment itself; a packet a hub forwarded to it
carries none, which is a design decision rather than a gap (see Level 2's
note, and §6.5 for the one app here that cares).

The worked examples: the **store repo** (its README calls swapping the
store for your own app "a three-line change"; `src/store-backend.ts` is the
entire seam at ~210 lines) and the **relay repo** (whose README diagrams
why everything below the connector line is identical for any app). NIP-90
job semantics (kinds, `/describe`) are a convention on top, not a
requirement — a plain POST endpoint is a complete TOON app.

### Level 1 — a route on the hub (five minutes)

Fastest way to see your app earn money. No new connector, no peering.

1. Add your app to `docker-compose.yml` — on the compose network, paid port
   **unpublished**:

   ```yaml
   myapp:
     profiles: ['payments', 'full']   # or just ['full']; omitting the key
                                      # entirely also means "always on"
     build: ../../myapp               # or image: ...
     # no ports: — reachable only through a connector
   ```

   Listing `payments` is usually what you want here: your app plus the hub
   and the chains is exactly the `make up-payments` set (§2), and it does not
   drag in the gateway, the bundler or the store checkout.

2. Add the route to the hub's config, `conf/connector-relay.toml` (next to
   the existing `g.toon.relay` rows):

   ```toml
   [[routes]]
   prefix      = "g.toon.myapp"
   handler_url = "http://myapp:3300/myapp"
   price       = 1000
   ```

3. Apply: `docker compose up -d myapp && docker compose restart
   relay-connector` (claim journals live in a named volume, so a hub
   restart loses nothing).

4. Drive it — a local route on the hub needs no `sealTo`:

   ```js
   await client.send('g.toon.myapp', { body: JSON.stringify(payload) });
   ```

   Your handler receives the POST with the `X-TOON-*` headers; the hub's
   client book grows by `price` (assert it over the operator surface the
   way `smoke-toon.mjs` does, with the committed bearer tokens).

### Level 2 — your own connector, peered to the hub (the production shape)

This is how the store and gas station actually run, and how you'd deploy
for real (each app ships with its own connector; peerings carry the
payment). Every step below has a committed working example to copy —
`store-connector` is the template:

1. **Keys** — extend `scripts/gen-toon-keys.sh` (or follow its pattern) to
   mint your connector's set: `signer.key` (random ILP identity, holds no
   money), `settlement.key` + `settlement-solana.key` (the identities value
   moves against — the sandbox derives them from anvil's public test
   mnemonic at fixed indices so their addresses are committable), and
   operator credentials. Place them under `keys/toon/` (world-readable is
   fine here; the connector image runs as uid 10001 and mounts key dirs
   read-only).
2. **Your connector's toml** — copy `conf/connector-store.toml`: the two
   `[settlement.*]` sections (point at `anvil:8545` /
   `solana-validator:8899` — startup is fail-closed on both backends),
   `peer_expose = "http"`, the mirror `[[peer_channels]]` row for the
   peering (see step 3), and your terminating `[[routes]]` row
   (`prefix = "g.toon.myapp"`, `handler_url` at your app, price = the
   forwarded amount).
3. **The hub's side** — in `conf/connector-relay.toml`, copy the
   `relay-store` block: a `[[peers]]` row (your connector's endpoint +
   `fee = 100`), a forwarded `[[routes]]` row (`peer_id` instead of
   `handler_url`; **hub price = your price + fee** — the fee arithmetic is
   enforced by nothing except these files agreeing), and a
   `[[peer_channels]]` + `[[pay_channels]]` pair naming the settlement
   channel. For a Solana-settled peering the channel identity is a PDA:
   `find_program_address(["channel", min, max, mint])` with participants
   sorted by 32-byte value — `scripts/open-solana-channel.py` derives and
   asserts it, so run it once to learn your channel account, then commit
   it in both tomls.
4. **Fund + open** — add your settlement keys to the seed jobs
   (`seed-toon-solana.mjs` airdrops SOL + mints mock USDC;
   `seed-toon-evm.sh` funds the EVM side) and your channel to the
   `open-toon-solana-channels` init job, which opens and collateralises
   peering channels through the hub's operator surface after boot
   (`POST /channels` + `POST /channels/:id/fund` — the connector repo's own
   mechanism; idempotent, deposits are top-ups).
5. **Compose** — add your connector (another instance of the same pinned
   connector image, new client-edge host port outside the taken set) and
   your app; gate them on the seed jobs like `store-connector` is.
6. **Drive + assert** — forwarded routes need
   `sealTo: 'http://localhost:<your-edge>'`. Prove your leg the way
   `smoke-toon.mjs` proves the store's: hub client book grows by hub
   price, your connector's peer-book watermark advances by your price on
   exactly the committed channel account.

> **If your app needs to know WHO PAID** (`X-TOON-Payer`), step 2 changes:
> a peer-role arrival carries no payer, by design (connector ADR 0040), so
> your connector must declare the hub's channel in `[[client_channels]]`
> instead of `[[peer_channels]]` and drop `peer_expose` — then the hub is
> your paying client and the header names its channel. Copy
> `conf/connector-anytoon.toml` instead of `conf/connector-store.toml`, and
> assert your leg in the CLIENT book (keyed `solana:<channel_account>`).
> The hub's side (step 3) is identical either way. Most apps do not need
> this: if yours never reads the header, take the peer role.

When it works in the sandbox, the path to a real deployment is the app
repos' `deploy/` dirs (Caddy + connector + app on one box) — the shape is
identical, only keys, domains and chain endpoints change.

## 6. Under the hood

### 6.1 Init jobs (all idempotent, all ordered by compose healthchecks)

- **`seed-solana`** — airdrops SOL, creates a local "ARIO" SPL mint +
  treasury/buyer ATAs, mints 10M ARIO to the buyer (and SOL + 10,000 ARIO
  to the store's ArNS DVM payer), then runs `ario_arns::initialize` +
  `ario_core::initialize`. The initialize instructions are gated to the
  *programs' upgrade authority*, which is why the validator loads the AR.IO
  programs with `--upgradeable-program <id> <so> <admin>` (never
  `--bpf-program`) and why `keys/admin.json` is committed. Exits 0 if the
  ArnsConfig PDA already exists.
- **`seed-gateway-block`** — inserts one fake block (height 1) into core's
  SQLite. The Turbo upload service resolves the current block height via
  the gateway's GraphQL to sign receipts; on a chainless gateway every
  upload would 503. The bundler services only start after this completes.
- **`seed-toon-solana`** — creates the deterministic mock USDC mint
  (`H8HSre…A77H`), airdrops SOL + mints USDC to every settlement key and
  the gas station's fee payer.
- **`seed-toon-evm`** — funds ETH + USDC on anvil (the client-leg channel
  lives there), funds the kind:5098 relayer, and asserts the forwarder +
  probe contracts are deployed.
- **`open-toon-solana-channels`** — after the hub is healthy, opens and
  collateralises the three Solana peering channels (100 USDC each) through
  the hub's own operator surface, then re-reads the on-chain accounts and
  fails unless participants, mint, `Opened` status and deposit all agree
  with the committed configs. An open channel is left alone; deposits are
  top-ups.
- **`issuer-keys`** — generates the credentials issuer's signed epoch
  keyring and the minter/issuer Ed25519 proxy pair into the `anytoon-keys`
  volume, by running the **upstream issuer image's own** dev-key generator
  (`bun run keys:dev`). Nothing about the image is modified — it is the same
  image with a different command. Idempotent, and it re-forges an epoch that
  has expired (the volume outlives the generator's 30-day window). Nothing
  here is committed: no committed config depends on these values, and an
  epoch key in git would silently expire 30 days after the commit.
- **`issuer-migrate`** — runs the issuer image's own TypeORM migrations
  against `issuer-postgres` exactly once, then exits, so no issuer replica
  ever races another to migrate.

The connectors gate on the seed jobs, and their startup is fail-closed on
BOTH settlement backends — the Solana backend submits a real ATA-create and
simulates an `InitializeChannel` against the genesis-loaded
`payment_channel` program, so four healthy connectors are themselves the
"payment_channel.so deployed and working" proof.

### 6.2 Peering mechanism

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
behind hub `{base=1100, per_kib=10}`; gas `1000` behind `1100`; anytoon
`10000` behind `10100`).

The same arithmetic is why `g.anyone.credentials.keys` is priced **100** at
the hub and not 0, even though it is free downstream: a hub route at price 0
charges the client nothing but still subtracts its fee from the packet's
carried amount, so every honest request (which carries 0) comes back `R01
Insufficient Source Amount`. Free downstream + a fee-taking hop = the hop's
fee. It is free where it is free: at `anytoon-connector`'s own edge.

The channel rows use the connector's SOLANA shape (`local/mixed-chain`,
connector issues #759/#1146/#1128): a `channel_account` PDA instead of an
EVM `channel_id`, base58 Solana settlement pubkeys as `counterparty_key`, no
`chain_id`/`token_network`/`program_id` (the program is bound in from
`[settlement.solana]` alone). The accounts are
`find_program_address(["channel", min, max, mint])` with the participants
sorted by 32-byte value — precomputed and committed in
`conf/connector-*.toml`.

**One asymmetry, and it is deliberate.** `store-connector` and
`gas-connector` hold their channel as `[[peer_channels]]` — they take the
peer role. `anytoon-connector` holds the *same kind of* channel as
`[[client_channels]]`, so the hub is its paying **client**. That is forced
by the app behind it and is explained at length at the top of
`conf/connector-anytoon.toml`: a connector states a payer to its app only
for a claim it admitted at its own client edge, and connector ADR 0040
forbids inventing one from the previous hop on a forwarded packet. The store
and the gas station never look at the payer; the claim minter cannot work
without it. The hub's side is unchanged either way — `[[peers]]`, the
forwarded `[[routes]]` row and the `[[peer_channels]]` + `[[pay_channels]]`
pair are identical in shape for all three peerings — so this shows up only
in where the payee books the money: peer book for store/gas, client book
(keyed `solana:<channel_account>`) for anytoon. The smoke asserts each in
its own book.

The channels are REAL: `InitializeChannel` is a positional account list no
chain CLI can build, so — exactly as the connector repo's
`local/keys.sh <topology> solana-channels` stage does — the
`open-toon-solana-channels` init job drives the hub's operator surface,
using the repo's own `open-solana-channel.py` vendored verbatim into
`scripts/`. The program's `Deposit` credits strictly by signer, so only the
hub can put its own collateral behind its own claims.

### 6.3 Committed keys and artifacts

**Everything under `keys/` is a valueless throwaway** generated for this
sandbox — zero real funds, zero mainnet standing. Committed on purpose so
the sandbox works from a fresh clone:

- `keys/admin.json` — Solana keypair `5ncaUQ…3TXX`: upgrade authority of the
  preloaded AR.IO programs, protocol authority, and the default ArNS buyer.
- `keys/treasury.json` — treasury ATA owner.
- `keys/uploader-wallet.json` / `keys/bundler-wallet.json` — Arweave JWKs
  with zero AR (nothing is ever broadcast; the gateway runs
  `ARWEAVE_POST_DRY_RUN=true`). The bundler JWK is also embedded in
  `conf/bundler.conf` and its address in the gateway's
  `ANS104_UNBUNDLE_FILTER`.
- `keys/toon/` — per-connector `signer.key`, `settlement.key` /
  `settlement-solana.key` (anvil public-mnemonic indices 24-26 + 28 / 34-37,
  because their addresses appear in committed configs), the kind:5098
  relayer `gas-evm-relayer.key` (index 27, embedded in
  `conf/gas-station.conf`), operator credentials, the deterministic
  mock-USDC mint keypairs, and the app keypairs embedded in `conf/*.conf`
  (gas station's Solana fee payer, store's Turbo signer, store's kind:5095
  ArNS DVM payer `arns-dvm.json`). `scripts/gen-toon-keys.sh` documents and
  regenerates the lot. The connector image runs as uid 10001 and mounts key
  dirs read-only; its `/app/state` claim journals are **named volumes** so
  they inherit uid-10001 ownership and die with `make clean` (a stale claim
  journal against a wiped chain satisfies payment assertions vacuously).

`artifacts/` (program `.so` dumps + the 2MB NameRegistry genesis account) is
committed for convenience but fully regenerable:
`./scripts/fetch-artifacts.sh` re-dumps the five AR.IO programs from devnet
and mpl_core from mainnet-beta using the pinned validator image (no Solana
toolchain needed), and `node scripts/gen-genesis.mjs` rebuilds the genesis
account (and keys, if missing — regenerating keys requires updating the
admin pubkey in `docker-compose.yml`). The program ids are the
staging/devnet ids (= `@ar.io/sdk` `DEVNET_PROGRAM_IDS`) — they cannot be
changed, the binaries carry `declare_id!` for them. Refresh the dumps only
together with an `@ar.io/sdk` / `@ar.io/solana-contracts` upgrade.

`artifacts/payment_channel.so` is built from the connector repo with its
pinned toolchain (platform-tools v1.52 via `make solana-build` there,
Solana CLI v3.1.12); `scripts/build-payment-channel.sh` regenerates it. The
validator loads it at genesis with plain `--bpf-program` under the bare id
`HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR` (no init gate — same id the
connector's own local tooling shares).

### 6.4 The store: local-endpoint overrides

The `store` image is **built from `../../store-gaps-worktree`** (see
Prerequisites) because that checkout carries the local-endpoint overrides
the sandbox stands on — the released image has no such knobs and always
aims at the production endpoints:

- `STORE_TURBO_UPLOAD_URL=http://upload-service:5100` points turbo-sdk's
  uploads at the LOCAL Turbo upload service, plain http inside the compose
  network. (`STORE_TURBO_PAYMENT_URL` stays unset: the keyless free-tier
  path never talks to a payment service.)
- `ARNS_SOLANA_RPC_URL` / `ARNS_SOLANA_WS_URL` point the kind:5095 `op=buy`
  path at the local validator (8899/8900). Program ids still follow
  `ARNS_NETWORK=devnet` = the SDK's `DEVNET_PROGRAM_IDS` = exactly what the
  validator loads at genesis. The DVM payer is the committed throwaway
  `keys/toon/arns-dvm.json` (`ARNS_DVM_SOLANA_SECRET_KEY` in
  `conf/store.conf` is its hex form).

Paid Turbo top-ups stay off (`STORE_TURBO_MAX_ARIO_PER_UPLOAD` unset), so
the store serves the free tier (data items ≤ 107,520 bytes). That ceiling
is the STORE's own gate on the keyless path; it is all the smoke needs, and
the local bundler skips balance checks anyway.

### 6.5 The Anyone credentials issuer (and its price-coupling hazard)

The fourth app is the one that is **not** payment-oblivious. The upstream
`anyone-protocol/credentials-issuer` image runs unmodified and blind-signs
nothing without an Ed25519-signed `X-Payment-Claim`. The chain:

```
anytoon-connector ──▶ claim-minter ──▶ issuer ──▶ issuer-postgres / issuer-redis
       :3230              :8080          :3000        (all unpublished)
```

- The **claim minter** turns the connector's `X-TOON-Payer` attribution into
  the signed claim, and does nothing else. It proxies `POST /v1/bundles`
  only — its `handler_url` is its root, so without that whitelist a caller
  could reach any issuer path with a freshly minted claim attached. It
  deliberately does **not** read `X-TOON-Amount`; what authorises issuance
  is that nothing but the connector can reach it (anytoon ADR 0001), which
  is why none of those four services publishes a port.
- The **free key route is scoped**, and that scoping is a security property,
  not tidiness. An envelope's `target` resolves *beneath* the route's
  `handler_url`, so `g.anyone.credentials.keys` points at
  `http://issuer:3000/v1/keys/` and **not** at the issuer root — a
  root-scoped free route would put `POST /v1/bundles` at price zero. Scoped
  as it is, `current` is the only reachable target and `../bundles`,
  `/v1/bundles` and `%2e%2e/bundles` are all refused `F00` by the connector
  before the issuer is touched. The smoke asserts all three.

> **⚠ THE PRICE-COUPLING HAZARD.** Three numbers must agree or **every paid
> request answers 402 `CLAIM_INVALID`**, with nothing in the error naming
> the cause:
>
> 1. the connector route price — `conf/connector-anytoon.toml`, **base units**
> 2. the claim minter's `BUNDLE_PRICE` — the decimal it signs into the claim
> 3. the issuer's `BUNDLE_PRICE` — the decimal it checks that claim against
>
> (2) and (3) are **one file**: `conf/anytoon.conf` is the `env_file` of both
> services, so they cannot drift from each other. (1) cannot be an env var —
> the connector has no environment layer, every value comes from its TOML —
> so it is the hand-kept derivation
> `price = BUNDLE_PRICE × 10^6` (mock USDC decimals), and the hub's forwarded
> row is `that + fee`:
>
> | site | value | source |
> |---|---|---|
> | `conf/anytoon.conf` `BUNDLE_PRICE` | `0.01` | **the source of truth** |
> | `conf/connector-anytoon.toml` `price` | `10000` | `0.01 × 10^6` |
> | `conf/connector-relay.toml` `price` | `10100` | `10000 + fee 100` |
>
> `scripts/smoke-toon.mjs` step 0c re-derives all of this from
> `conf/anytoon.conf` and asserts it against what the two nodes **advertise**
> at `GET /ilp`, so a drift fails the smoke by name. **Change the price in
> `conf/anytoon.conf`, then update both TOMLs, then re-run `make smoke`.**

**Who paid, and why this node is wired differently.** The minter needs the
connector to tell it who paid, and a connector only ever says that for a
claim it admitted at its *own* client edge — connector ADR 0040 explicitly
refuses to invent a payer from the previous hop on a forwarded packet ("puts
a wrong payer in an app's own permanent records"). So had `anytoon-connector`
taken the peer role like `store-connector` does, every routed purchase would
have reached the minter unattributed and been refused **after the client had
already paid**. It therefore declares the hub's channel in
`[[client_channels]]`: the hub signs a client-role cover-forward claim before
every forwarded PREPARE leaves (ADR 0042 item 2), so this states the literal
truth — on this hop the payer is the hub, `solana:3ZA8DPi1…`. Per-hub rather
than per-end-client bucketing is also the only shape the end client's
anonymity permits. See the header of `conf/connector-anytoon.toml`; the hub's
own config is unaffected (§6.2).

Key material for this subsystem is *not* committed (unlike everything else
under `keys/`): the `issuer-keys` job generates it at bring-up with the
issuer image's own generator (§6.1). The connector's own keys are committed
like the other three nodes' — `keys/toon/anytoon-connector/`, mnemonic
indices 28 (EVM) / 37 (Solana).

## 7. Lifecycle and state

- **`make down`** stops everything but keeps state: gateway/bundler data
  (`./data/`), claim journals (named volumes), bought names in gateway
  caches.
- **`make clean`** wipes all of it; the next `make up` is a true cold start.
- **Validator restarts wipe chain state**: the validator runs `--reset`, so
  a container restart loses bought names and channel accounts (the
  gateway's caches expire within ~30s). Re-running `make up` (or
  `make up-payments`) afterwards re-runs the seed jobs (they detect the
  missing state and reseed, and `open-toon-solana-channels` re-opens the
  peering channels) — but names bought before the restart are gone; re-buy
  them.
- Re-running `make up` on a healthy stack is a no-op: every init job checks
  before it writes.

## 8. Troubleshooting

- **Upload 503 "Unable to sign receipt"**: `seed-gateway-block` didn't run —
  `make ps` should show it `Exited (0)`; re-run with
  `docker compose up -d seed-gateway-block` (naming a service explicitly
  enables its profile, so no `--profile` flag is needed for that form).
- **Name never resolves**: check `seed-solana` logs
  (`docker compose logs seed-solana`) — if the validator restarted after
  seeding, run `make up` to reseed, then re-buy (chain state was wiped).
- **`*.ar.localhost` doesn't resolve**: use
  `curl -H 'Host: <name>.ar.localhost' http://localhost:3000/` (note: Node's
  `fetch()` silently drops a user-set Host header; curl is fine).
- **Connector refuses to boot**: its startup is fail-closed on both
  settlement backends — check that anvil is healthy (contracts deployed;
  the healthcheck requires code at the registry AND the sandbox extras) and
  the validator answers on 8899; then `docker compose logs <connector>`
  names the failing backend.
- **`make up` stops on the store or anytoon context**: those two images
  build from sibling checkouts — see Prerequisites for repointing
  `STORE_CONTEXT` / `ANYTOON_CONTEXT`, or use `make up-payments`, which
  never builds either. `make setup` only prints a note about them; the gate
  lives on `make up`, the one path that builds the images.
- **A bare `docker compose` command does nothing**: it selected no profile —
  see the note at the end of §2.
- **Every credentials purchase comes back PAID but `402 CLAIM_INVALID`**:
  the price triple has drifted — the connector's base-unit route price no
  longer equals `BUNDLE_PRICE × 10^6`. `make smoke-toon` step 0c names it
  exactly; fix per §6.5. (`402 PAYER_UNATTRIBUTED` instead means the
  connector delivered without an `X-TOON-Payer`, i.e. `anytoon-connector`'s
  `[[client_channels]]` row was turned into a `[[peer_channels]]` row —
  also §6.5.)
- **Credentials purchases fail after the stack has run a month**: the
  issuer's epoch expired. `docker compose up -d --force-recreate
  issuer-keys issuer` re-forges it.

### Known noise (harmless)

- envoy periodically logs DNS failures for the `observer` cluster — the
  observer service is deliberately not run (it has no wallet and would
  crash-loop); `/ar-io/observer/*` routes 503.
- core logs `Error during parallel resolution ... unregistered_arns` — the
  default not-found probe name, which doesn't exist locally.
- fulfillment logs SQS `NonExistentQueue` for ~20s at boot while localstack
  creates the queues, and occasional `Failed to fetch USD/AR rate` from an
  unreachable external service. Both self-recover/are irrelevant.

## 9. Known limits and residue

- **No real Arweave finality.** There is no maintained local Arweave chain;
  uploads are optical-bridged into the local gateway and served instantly,
  but bundles are never finalized onto a chain (the gateway runs
  `ARWEAVE_POST_DRY_RUN=true`). For finality-sensitive testing, use Solana
  devnet + Turbo's free devnet uploads.
- **Store free tier only**: data items ≤ 107,520 bytes (the store's own
  keyless-path gate — see §6.4).
- **kind:5098 targets a sandbox probe**, not the real TokenNetwork:
  `DeployLocal.s.sol` created the TokenNetwork with
  `trustedForwarder = address(0)` (an ERC2771Context immutable), so it can
  never accept meta-transactions; a from-scratch deploy that passes the
  forwarder to the registry before `createTokenNetwork` would close this
  upstream. The sandbox's `SandboxTokenNetworkProbe` exposes the whitelisted
  selectors and records `_msgSender()` instead.
- **Brokered-ArNS ceremony residue** (upstream properties, not sandbox
  bugs): the spawned ANT is not ACL-bootstrapped (the gas station's
  documented per-job ceiling), and the DVM's best-effort `syncAttributes`
  after a non-holder buy fails benignly (locally AnchorError 2006
  `ConstraintSeeds` on `ant_authority`; receipt carries
  `syncAttributesTxId: null`, logged non-fatal by the store).
- **Conversion/FX is unsupported and out of scope** — the cross-chain
  topology works because both mock USDCs share one 6-decimal unit. In
  particular the credentials peering is **Phase 1 only**: it settles in the
  same 6-decimal mock USDC as everything else. Settling it in an 18-decimal
  mock ANYONE under a USDC client leg (Phase 2) needs cross-asset forwarding,
  which is blocked upstream on `toon-protocol/connector#1286`; do not try it
  here.
- **The credentials issuer's epoch expires after 30 days.** The
  `issuer-keys` job re-forges an expired one on the next `make up`, but a
  stack left running past the window signs nothing until it is restarted
  (`docker compose up -d --force-recreate issuer-keys issuer`).
- **The smoke's blinded blanks are structurally valid, not genuinely
  blinded** — 256-byte values with a leading zero byte (RFC 9474 requires a
  blinded message below the RSA modulus, and a uniformly random 256-byte
  value exceeds a 2048-bit modulus about half the time). The issuer signs
  them either way; what the smoke proves is the paid path, not RSABSSA,
  which the issuer's own test vectors cover.
- **Store and claim-minter images must be built from sibling checkouts** —
  the store until upstream releases the local-endpoint overrides (then the
  commented image pin in `docker-compose.yml` works again), the claim minter
  indefinitely, since the anytoon repo publishes no image for it.
