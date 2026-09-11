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
  collateralised payment channels** — and a **denomination boundary**. The
  client leg and two of the three peerings settle 6-decimal mock USDC over
  Solana `payment_channel` accounts, at par. The third settles **ANYONE** on
  anvil (the real 18-decimal mainnet ERC-20, at its own mainnet address), and
  the hub converts onto it at a **live Uniswap v3 TWAP** read off pools this
  sandbox deploys and trades (§6.7).
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
| `g.anyone.credentials` | Anyone credentials bundle (`POST v1/bundles`) | 11000 ⇄ |
| `g.anyone.credentials.keys` | the issuer's epoch key document (`GET current`) | 110 ⇄ (**0** at `anytoon-connector`'s own edge) |

⇄ marks the two routes that **cross a denomination boundary**. Their hub price
is in µUSDC like every other row, but downstream they are priced in ANYONE
(`0.04` and `0`) and the hub converts at a rate that moves. A static price
against a floating rate has to carry an FX buffer, so these two are quoted
*generously* rather than derived: 11000 covers a 0.04 ANYONE bundle plus the
hop's fee with ~9% to spare, and the arithmetic behind that figure is written
out in `conf/connector-relay.toml`. See §6.7.

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
   claim books are asserted per leg **and in each leg's own unit**: the
   client leg on the buyer's Solana channel in µUSDC, the store and gas legs
   at par on their Solana channels, and the credentials leg in ANYONE base
   units on an anvil channel — ~10^12 times the integer that arrived, which
   is what a real conversion looks like. The smoke also polls `GET /rates` at
   both ends of the run and requires the ANYONE rate to have **moved**: every
   other assertion would pass against a frozen TWAP.

And one thing `make smoke` deliberately does **not** prove, because it takes a
third-party dependency: reaching a node whose **only** ingress is a `.anyone`
hidden service, which is how the credentials issuer actually deploys. That is
the opt-in `hs` profile — `make up-hs` + `make smoke-hs`, never part of a cold
start (§2, *Hidden-service ingress*).

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
- **Full stack and `credentials` profile** — the **anytoon sibling checkout**
  at `../../anytoon`: the `claim-minter` image is BUILT from it
  (`claim-minter/`), because that component publishes no image. Override with
  `ANYTOON_CONTEXT` if your checkout lives elsewhere:
  `make up ANYTOON_CONTEXT=/path/to/anytoon`; `make up` and
  `make up-credentials` preflight it (`make setup` only prints a note). Only
  `claim-minter/` is used — the issuer itself is the upstream image, pulled
  and run unmodified. The `payments` profile never builds it
- Free host ports: 3000, 3004, 5100, 4566, 1984, 8545, 8899, 8900, 3200,
  3210, 3220, 3230, 3300, 3400, 7100 — the `payments` profile only needs
  8545, 8899, 8900, 3200 and 7100; `credentials` needs those five plus 3230
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

Seven services instead of twenty-nine:

| in `payments` | why |
|---|---|
| `anvil` | the ANYONE asset layer lives here — and the hub cannot boot without it (§6.7) |
| `solana-validator` | the client leg and two peer legs settle here; carries `payment_channel` |
| `seed-toon-evm` | ETH + mock USDC + ANYONE for every settlement key, and the one EVM peering channel |
| `seed-toon-solana` | the Solana mock USDC mint, ATAs and SOL |
| `relay` | `g.toon.relay` is the hub's only TERMINATED route — the one destination a paid packet can reach with no peer running |
| `relay-connector` | the hub itself, client edge on **3200** |
| `open-toon-solana-channels` | opens + collateralises the hub's two Solana peering channels |

Left out: the AR.IO gateway and Turbo bundler (`envoy`, `core`, `redis`,
`arlocal`, `upload-service`, `fulfillment-service`, `upload-service-pg`,
`localstack`, `seed-gateway-block`, `seed-solana`), the `store`,
`gas-station` and credentials-issuer apps, the three peering connectors that
front them (`store-connector`, `gas-connector`, `anytoon-connector`), and
`swap-driver`.

The hub still LOADS all three peerings under this profile — nothing about its
config changes — so `g.toon.store`, `g.toon.gastation` and
`g.anyone.credentials` are still priced and routed, they simply answer `T01`
with nobody on the far side. `g.toon.relay` (price 1) and
`g.toon.relay.ephemeral` (free) work exactly as in the full stack, which is
what `make smoke-payments` proves: contracts + program live, the ANYONE asset
layer deployed and quoting a live TWAP, both Solana peering channels and the
ANYONE channel on anvil open and collateralised, a Solana USDC channel opened
against the hub, a paid write routed through it and journaled as a claim on
that channel.

**One thing is deliberately absent here: the market.** `swap-driver` is a
`full`-profile service, so under `payments` nothing trades, anvil mines
nothing, and the ANYONE rate goes **stale** a couple of minutes in — the hub
logs it and `make smoke-payments` tolerates it by name. Nothing on this
profile's path converts, so nothing on this profile's path cares. The pools
are still built (the hub cannot resolve its own ANYONE `TokenNetwork`
otherwise) and the smoke still requires that they priced at least once.

`make down`, `make clean`, `make logs` and `make ps` work the same either way.

### Buying credential bundles without the permaweb (the `credentials` profile)

If you are writing a TOON **client that buys Anyone credentials** — no app, no
route, no price of your own, just a channel against the hub and a real paid
counterparty on the far side of the **denomination boundary** (§6.7) — the
`payments` profile helps least: the peer it leaves out is precisely the one
you need. The `credentials` profile is `payments` plus that peer:

```bash
cd sandbox
make setup             # npm ci; fine with no store checkout
make up-credentials    # docker compose --profile credentials up -d --build
make smoke-credentials # payment layer + the denomination boundary
```

Fifteen services: the `payments` seven (above) plus

| added | why |
|---|---|
| `issuer-keys`, `issuer-migrate`, `issuer`, `issuer-postgres`, `issuer-redis` | the paid counterparty — the upstream issuer, its key/schema jobs and its datastores (§6.5) |
| `claim-minter` | turns the connector's statement of **who paid** into the signed payment claim the issuer requires |
| `anytoon-connector` | terminates `g.anyone.credentials` in ANYONE — the far side of the boundary, client edge on **3230** |
| `swap-driver` | **keeps the TWAP fresh.** Without it nothing trades, the ANYONE rate goes stale within a couple of minutes, the crossing refuses `T00`, and no bundle can be bought at all |

Still left out: the whole AR.IO/Turbo half (`arlocal`, `envoy`, `core`,
`redis`, `upload-service`, `fulfillment-service`, `upload-service-pg`,
`localstack`, `seed-solana`, `seed-gateway-block`) and the store /
gas-station apps with their two peering connectors.

**The checkout requirement is the real win.** `credentials` needs only the
**anytoon** sibling checkout (a plain clone at `../../anytoon` —
`claim-minter` builds from it), not the store checkout, which is a worktree
of an *unmerged branch*. Under `full`, buying a bundle needs both on disk,
one of them for an image the flow never renders.

`make smoke-credentials` proves everything `make smoke-payments` proves, plus
the boundary end to end: the price triple asserted at both edges, the ANYONE
rate **live** off the driver's market (no stale allowance here, unlike
`payments`), the free key document, the scoped free route, the unpaid
refusal, and one PAID hub-routed purchase of a blind-signed bundle — uUSDC on
the buyer's Solana channel converted at the live TWAP into ANYONE on anvil,
both sides' books asserted in their own units, and the rate required to have
**moved** during the run.

**Rehearsing the stale-rate refusal is a feature of this profile.**
`docker compose --profile credentials stop swap-driver`, wait ~2 minutes
(`ttl_secs`), and every purchase refuses `T00` on a route that *has* a live
counterparty — which `payments` cannot stage (nothing to buy) and `full`
makes expensive. Useful for client code that must tell `T00` (transient:
retry on a backoff, and each attempt still spends its covering claim) from
`F02` (no rate declared: config is immutable for the process lifetime, so
retrying never helps). `docker compose --profile credentials start
swap-driver` brings the market back within one poll (~40s).

### Hidden-service ingress (the `hs` profile) — opt-in, and it dials a real network

Everything above reaches every node at a published clearnet port. The Anyone
credentials issuer (§6.5) does not deploy that way: its connector publishes no
port at all and a `.anyone` hidden service is the only way in. The `hs` profile
rehearses exactly that, and **nothing else in this sandbox depends on it**:

```bash
make up-hs      # = --profile full --profile hs; expect 2-5 min of bootstrapping
make smoke-hs   # buy one bundle over the circuit, chain RPC included
```

> **This is the one target that takes a third-party dependency.** `anon`
> bootstraps against the **real Anyone Protocol network** — there is no local
> directory authority and no private relay set, so `make up-hs` and
> `make smoke-hs` can both fail because that network had a bad day. **They are
> deliberately excluded from `make up` and `make smoke`**: a sandbox whose cold
> start can go red because someone else's relays are having a bad afternoon has
> stopped being a sandbox. `make smoke-hs` is a **rehearsal, not a gate** — run
> it on purpose, and expect it to be flaky in a way nothing else here is.
> (`anytoon` splits `make hs-e2e` out of `make local-e2e` for the same reason,
> and the connector repo keeps its hidden-service rehearsals off CI.)

Three extra services, all `hs`-only:

| in `hs` | what |
|---|---|
| `anon` | the daemon, **v0.4.10.2 built from source-of-truth release binaries** (§6.6). Generates this sandbox's `.anyone` address, publishes a descriptor for it, forwards what arrives |
| `hs-ingress` | a two-port `socat` forwarder; owns the network namespace `anon` shares, so the daemon's config can name `127.0.0.1` (§6.6) |
| `anon-client` | a SOCKS5 proxy on `127.0.0.1:19050` — the buyer's way onto the network, and nothing else. On its own compose network with **no route to any other service** |

What `make smoke-hs` proves, in one paid purchase:

- the address is dialled through **`socks5h://`**, so the hostname is resolved
  by the daemon and never leaks into a local DNS query;
- the **chain RPC rides the same circuit** — `proxyRpc` is the TOON client's
  default and this script never turns it off, so the channel open, the deposit
  and the buyer's own mock-USDC mint all leave through the proxy. `conf/anonrc`
  publishes anvil on **virtual port 8545 of the same address** to make that
  possible: reaching the connector inside the overlay while reading chain state
  on clearnet would broadcast the payer's settlement address, from the payer's
  own IP, either side of every paid request;
- the issuer really blind-signs a bundle, and the payee's own claim book agrees
  it was paid.

**Two verdicts, never confused.** `smoke-hs` checks everything this sandbox
controls *before* it dials anything — the daemon is healthy (address on disk
**and** `Bootstrapped 100%`), the proxy is listening, the node advertises that
exact address, the price triple agrees — and only then opens a circuit. So:

| exit | meaning |
|---|---|
| `0` | bought |
| `1` | **SANDBOX-SIDE**: something here is wrong, and the message says what |
| `75` | **NETWORK-SIDE** (`EX_TEMPFAIL`): preflight passed, the overlay would not carry. It retries three times first (`SMOKE_HS_ATTEMPTS`) and prints both daemons' own last words. Try again later — this is not a bug to hunt |

**`make smoke` and `make smoke-hs` are alternatives, not a suite.** `make up-hs`
recreates `anytoon-connector` against a rendered config whose `[node]` endpoints
are the `.anyone` address, because **a client dials what a node publishes**.
That is the production shape — and it means a clearnet client pointed straight
at `localhost:3230` is handed a hidden-service endpoint it has no proxy for, and
refuses (by name) to dial it. The hub is unaffected (it dials the endpoint its
own `[[peers]]` row names), so hub-routed purchases still work; but
`make smoke`'s step 4c talks to that node directly and will not survive it. Run
`make smoke` against `make up`, `make smoke-hs` against `make up-hs`.

**The address is disposable here.** It lives in the `anon-data` named volume:
`make down` keeps it (same address next `make up-hs`), `make clean` wipes it and
the next cold start publishes a new one. In a deployment that same wipe would
strand every buyer's configuration silently; in a sandbox it is expected.

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
| `anvil` | local EVM chain (chain-id 31337): the connector's settlement contracts (MockERC20 USDC, TokenNetworkRegistry, TokenNetwork), the sandbox's ERC-2771 extras, and **the ANYONE asset layer** — real mainnet ANYONE + WETH9 bytecode, real Uniswap v3, two seeded pools with primed oracles (§6.7) | 8545 |
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
| `swap-driver` | trades both Uniswap pools every 15s so the hub's ANYONE TWAP is genuinely live and genuinely bounded (§6.7). `full` + `credentials`, never `payments` | none |
| `seed-solana`, `seed-gateway-block`, `seed-toon-solana`, `seed-toon-evm`, `open-toon-solana-channels`, `issuer-keys`, `issuer-migrate` | one-shot idempotent init jobs | — |

### Payment topology

```
smoke test / any client (host)
   │ POST /ilp (paid)   — pays uUSDC on a SOLANA channel
   ▼                                        ┌──────────────────────────────┐
relay-connector :3200  ── g.toon.relay ──▶ relay:3100/write ──▶ relay reads┘
   │        (hub)      ── g.toon.relay.ephemeral ─▶ relay:3100/write-ephemeral
   │                      (terminated here; ws://localhost:7100 reads free)
   ├─ g.toon.store ──[peering relay-store]──▶ store-connector :3210
   │        (uUSDC on SOLANA, at par)           └─▶ store:3300/store (kind:5094/5095)
   ├─ g.toon.gastation ──[peering relay-gas]──▶ gas-connector :3220
   │        (uUSDC on SOLANA, at par)           └─▶ gas-station:3300/gas (kind:5096 + 5098)
   └─ g.anyone.credentials ──[peering relay-anytoon]──▶ anytoon-connector :3230
       *** ANYONE on ANVIL — CONVERTED ***      ├─▶ claim-minter:8080 ──▶ issuer:3000  (paid)
       floor(amount x TWAP) - fee               └─▶ issuer:3000/v1/keys/              (free)
                 ▲
                 └── rate polled from two real Uniswap v3 pools on the same
                     anvil, kept live by the swap-driver service (§6.7)
```

Three legs, two chains, **two tokens**:

- the **client leg** settles 6-decimal mock USDC on the local validator — the
  `payment_channel` account the smoke's buyer opens in step 1
- **relay-store** and **relay-gas** settle the same token on their own Solana
  accounts, **at par**: same asset, same scale, amounts cross the chain
  boundary unconverted
- **relay-anytoon** settles **ANYONE on anvil** — the real 18-decimal mainnet
  ERC-20 — so every packet the hub forwards onto it is a **conversion**, at a
  live Uniswap v3 TWAP. That is the denomination boundary, and §6.7 is about
  nothing else.

A claim never says what it is denominated in and never had to: a claim is
denominated by the channel it is written against. The µUSDC the buyer signs
for and the ANYONE the hub signs for are the same wire format carrying
integers 10^12 apart.

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
   drag in the gateway, the bundler or the store checkout. (Add
   `'credentials'` too if your app should also be up under
   `make up-credentials`.)

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
> assert your leg in the CLIENT book (keyed by chain namespace —
> `solana:<channel_account>` or `evm:<channel_id>`). The hub's side (step 3)
> is identical either way. Most apps do not need this: if yours never reads
> the header, take the peer role.

> **If your app wants to be paid in a DIFFERENT TOKEN**, copy
> `conf/connector-anytoon.toml`'s ANYONE shape instead: settle your peering
> on the chain that token lives on, price your route in ITS base units, and
> then the hub needs a `[[tokens]]` row for it, a quote or a static rate to
> the numeraire, an explicit `max_packet_amount` on the peering, and a hub
> price with enough FX headroom to survive the rate moving. §6.7 is the whole
> checklist, and it is a genuinely bigger step than adding a peering — take
> the same token unless you have a reason not to.

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
  (`H8HSre…A77H`), airdrops SOL + mints USDC to every settlement key, the
  gas station's fee payer, **and the smoke's buyer**. That last one is new
  with the Solana client leg and it is not optional: `@toon-protocol/client`
  opens the channel but never creates the payer's ATA, and refuses below
  4,179,040 lamports — an unfunded buyer is a `ChannelFundingError` at smoke
  step 1.
- **the anvil entrypoint's third stage** (`scripts/seed-toon-evm-amm.sh`, not
  a separate service) — the ANYONE asset layer: mainnet ANYONE and WETH9
  bytecode placed at their own mainnet addresses, ANYONE's `TokenNetwork`,
  the official Uniswap v3 factory, two pools with full-range liquidity, and
  900 seconds of primed oracle history. It runs **inside** the anvil
  container and **before** the healthcheck can pass because two connectors
  refuse to start without ANYONE's `TokenNetwork` and the hub's rate poller
  has nothing to read without the pools. See §6.7.
- **`seed-toon-evm`** — funds ETH + mock USDC + ANYONE on anvil, funds the
  kind:5098 relayer, asserts the forwarder + probe contracts are deployed,
  and **opens + collateralises the relay-anytoon channel** (100 ANYONE). The
  EVM half of a peering needs no operator surface: `openChannel` and
  `setTotalDeposit` are ordinary contract calls `cast` can build from a
  signature string.
- **`open-toon-solana-channels`** — after the hub is healthy, opens and
  collateralises the **two** Solana peering channels (100 USDC each) through
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

Two of the three peerings settle the same token as the client edge and are
plain carriage. The third settles a different token on a different chain and
is a **conversion** — everything specific to that is in §6.7.

Fee arithmetic (enforced by nothing — kept true by these committed files):
the hub collects `price`, retains `fee`, forwards the rest; the payees
terminate at exactly the forwarded amount. **At par** that is one subtraction
— store `{base=1000, per_kib=10}` behind hub `{base=1100, per_kib=10}`, gas
`1000` behind `1100`, `fee = 100` µUSDC on both.

**Across the denomination boundary it is `floor(amount × rate) − fee`**, with
the fee in the OUTGOING unit (ADR 0071 decision 1, ADR 0061). The
relay-anytoon row therefore charges `fee = 400000000000000` — 0.0004 ANYONE,
which is the same money as the other two peerings' 100 µUSDC and is written
in the unit it is collected in rather than converted from one. That row also
carries an explicit `max_packet_amount`, because the 1000000 default is
10^-12 of one token on an 18-decimal leg and would refuse every crossing
`T04`. §6.7 has the whole model.

The fee is also why `g.anyone.credentials.keys` is priced **110** at the hub
and not 0, even though it is free downstream: a hub route at price 0 charges
the client nothing but still subtracts its fee from the packet's carried
amount, so every honest request (which carries 0) comes back `R01
Insufficient Source Amount`. Free downstream + a fee-taking hop = the hop's
fee — 110 µUSDC rather than 100 because the conversion has to clear the fee
at the *worst* rate in the band. It is free where it is free: at
`anytoon-connector`'s own edge.

The two Solana channel rows use the connector's SOLANA shape
(`local/mixed-chain`, connector issues #759/#1146/#1128): a `channel_account`
PDA instead of an EVM `channel_id`, base58 Solana settlement pubkeys as
`counterparty_key`, no `chain_id`/`token_network`/`program_id` (the program is
bound in from `[settlement.solana]` alone). The accounts are
`find_program_address(["channel", min, max, mint])` with the participants
sorted by 32-byte value — precomputed and committed in
`conf/connector-*.toml`.

The relay-anytoon rows use the **EVM** shape: `channel_id` =
`keccak256(p1, p2, epoch)` with the participants sorted (ADR 0059), plus
`chain_id` and `token_network` — and that `token_network` is a *different
contract* from the mock-USDC one every other EVM thing here names, because a
`TokenNetwork` is per token.

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
(keyed `evm:<channel_id>`, in ANYONE base units) for anytoon. The smoke
asserts each in its own book and in its own unit.

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

`artifacts/` (program `.so` dumps, the 2MB NameRegistry genesis account, and
the EVM bytecode blobs under `artifacts/evm/`) is committed for convenience
but fully regenerable:
`./scripts/fetch-artifacts.sh` re-dumps the five AR.IO programs from devnet
and mpl_core from mainnet-beta using the pinned validator image (no Solana
toolchain needed), and `node scripts/gen-genesis.mjs` rebuilds the genesis
account (and keys, if missing — regenerating keys requires updating the
admin pubkey in `docker-compose.yml`). The program ids are the
staging/devnet ids (= `@ar.io/sdk` `DEVNET_PROGRAM_IDS`) — they cannot be
changed, the binaries carry `declare_id!` for them. Refresh the dumps only
together with an `@ar.io/sdk` / `@ar.io/solana-contracts` upgrade.

`artifacts/evm/` holds the three blobs the EVM asset layer places on anvil —
ANYONE's and WETH9's mainnet RUNTIME bytecode, and the official Uniswap v3
factory's CREATION bytecode. Those are the only artifacts here that come from
a chain this sandbox does not run, which is exactly why they are committed:
`make up` must never need an internet connection. `./scripts/fetch-artifacts.sh`
re-dumps them (`MAINNET_RPC` overrides the endpoint) and
`artifacts/evm/README.md` explains the provenance, the runtime-vs-creation
split, and how to check the factory blob against mainnet's deployed one.

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
> so it is the hand-kept derivation `price = BUNDLE_PRICE × 10^18`, **in
> ANYONE**, because that is the token this node settles in:
>
> | site | value | source |
> |---|---|---|
> | `conf/anytoon.conf` `BUNDLE_PRICE` | `0.04` (ANYONE) | **the source of truth** |
> | `conf/connector-anytoon.toml` `price` | `40000000000000000` | `0.04 × 10^18` |
>
> 0.04 ANYONE is 0.01 USDC at the rate this sandbox deals at — the same money
> the route always cost, said in the currency the node is actually paid in.
>
> **THE HUB IS NO LONGER A FOURTH SITE, and that is the one thing the
> cross-asset flip changed here.** It charges µUSDC and pays ANYONE at a rate
> no file can know, so its price cannot be `this + fee`; it is a static quote
> with an FX buffer, and the arithmetic behind it lives in
> `conf/connector-relay.toml` where the band is (§6.7). What `make smoke`
> asserts about it is therefore an **inequality**, computed on every run from
> the hub's own `GET /rates` exactly as the forwarding path computes it:
>
> ```
> floor(hubPrice × liveRate) − peeringFee  ≥  BUNDLE_PRICE × 10^18
> ```
>
> — which is precisely the condition for a purchase to clear, and fails the
> same way whether the rate moved, the spread changed, the fee changed or
> someone edited a price. **Change the price in `conf/anytoon.conf`, then
> update `conf/connector-anytoon.toml`, then re-check the headroom
> arithmetic in `conf/connector-relay.toml`, then re-run `make smoke`.**

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
truth — on this hop the payer is the hub, `evm:0x94ab42f9…`. Per-hub rather
than per-end-client bucketing is also the only shape the end client's
anonymity permits. See the header of `conf/connector-anytoon.toml`; the hub's
own config is unaffected (§6.2).

Key material for this subsystem is *not* committed (unlike everything else
under `keys/`): the `issuer-keys` job generates it at bring-up with the
issuer image's own generator (§6.1). The connector's own keys are committed
like the other three nodes' — `keys/toon/anytoon-connector/`, mnemonic
indices 28 (EVM) / 37 (Solana).

### 6.6 The hidden-service ingress (`hs` profile)

Read §2's *Hidden-service ingress* first for what it is and why it is opt-in.
This is how it is put together, and the four facts that are easy to get wrong.

**The daemon is BUILT, not pulled, and the version is the whole point.**
`ghcr.io/anyone-protocol/ator-protocol` publishes nothing past **v0.4.9.7**
(October 2024), and Anyone Protocol renamed the hidden-service TLD after it:
v0.4.9.7 writes `<56-base32>.onion`, **v0.4.10.2 writes `.anyone` and refuses
the same address spelled `.onion`**. `@toon-protocol/client` accepts `.anyone`
alone — its hostname regex is `/^[a-z2-7]+\.anyone$/` and it rejects `.onion`
by name, because that is Tor. So a daemon at the published tag would publish an
address every client here refuses. `anon/Dockerfile` overlays the official
v0.4.10.2 release binary — **sha256-verified before it is ever executed** — onto
that ghcr image, keeping the image contract (the `anond` user, `/var/lib/anon`,
the entrypoint) identical. It is vendored from the anytoon checkout's
`anon-image/Dockerfile`, which is the reference implementation.

**`hs-ingress` exists to break a circle.** `anon` resolves a `HiddenServicePort`
target when it *parses* its config — before a stream ever arrives, and before
the connector it fronts can possibly exist, because that connector's config has
to name an address only the daemon can generate. anytoon breaks the circle with
a pinned subnet and a fixed container IP; this sandbox breaks it with a shared
loopback: `anon` runs inside `hs-ingress`'s network namespace, `conf/anonrc`
names `127.0.0.1` (which always parses), and `socat` there resolves
`anytoon-connector` and `anvil` **by name, once per connection**. No existing
service acquires a fixed IP, this project pins no subnet that could collide with
someone else's, and `make up-hs` can recreate the connector without leaving the
daemon pointed at an address that has moved.

**Two virtual ports on one address**, both in `conf/anonrc`:

| virtual port | forwards to | why |
|---|---|---|
| `80` | `anytoon-connector:3000` | the issuer path — the client edge a buyer pays through |
| `8545` | `anvil:8545` | the buyer's chain RPC, on the same address and the same circuit |

The second is not a second ingress; it is what makes the first honest. See §2.

**The connector's config is rendered, and that is the load-bearing step.**
`scripts/hs-address.sh` reads `hidden_service/hostname` out of the daemon and
writes `conf/.rendered/connector-anytoon.toml` — the committed
`conf/connector-anytoon.toml` with its two `[node]` endpoints repointed at
`http://<addr>.anyone`. `make up-hs` then brings the stack up with
`ANYTOON_CONNECTOR_CONF` naming that file (nothing else ever sets it, so every
other target mounts the committed config unchanged). This matters because **a
client dials the endpoint a node publishes, not the URL the caller typed**: a
node behind a hidden service still advertising `http://127.0.0.1:3230/ilp` sends
every buyer's packet at the buyer's own loopback, through the proxy. A relative
endpoint is not a way out — this connector refuses one at load
(`[node] http_endpoint '/ilp' is not a URL: relative URL without a base`).
`smoke-hs`'s preflight asserts the published endpoint before it dials, so that
particular mistake can never masquerade as a bad day on the network.

**`smoke-hs` buys as its own party** (`accountIndex 5`, not 0). `make smoke`
deliberately opens a **zero-deposit** channel between account 0 and this node —
that is how its step 4c proves an unpaid request is refused. A client reusing
account 0 would *adopt* that channel (an open channel is taken as found,
deposit and all) and could never pay from it; collateralising it instead would
silently break the assertion `make smoke` makes. Two buyers, two channels,
no interference in either direction. The buyer is **funded in ANYONE** — this
node's settlement token since the cross-asset flip — by the sandbox's faucet
account, over the circuit like everything else it does. It cannot mint its own
the way it used to: ANYONE is the real contract with a fixed supply and no
`mint()`. There is no hub in this path and therefore no conversion; the buyer
simply holds the money the node charges in.

### 6.7 The denomination boundary: ANYONE, Uniswap v3 and a live rate

Everything else in this sandbox moves one token. The `relay-anytoon` peering
moves a different one, and the hub converts. This section is the whole of how.

#### The asset layer is the real thing

`anvil` builds it on every start, inside its own container, **before its
healthcheck can pass** — two connectors refuse to boot unless ANYONE resolves a
`TokenNetwork`, and the hub's rate poller has nothing to read until the pools
exist. `scripts/seed-toon-evm-amm.sh` is the script; `conf/amm-topology.conf`
is every address and figure it uses; `artifacts/evm/` holds the bytecode (with
its provenance in `artifacts/evm/README.md`).

| on chain | what | how |
|---|---|---|
| `0xFeAc2Eae…` | **ANYONE**, the Anyone Protocol ERC-20 | mainnet RUNTIME bytecode, `anvil_setCode` at its own mainnet address |
| `0xC02aaA39…` | **WETH9** | same |
| `0x95bD8D42…` | **UniswapV3Factory** | official `@uniswap/v3-core@1.0.1` CREATION bytecode, deployed normally |
| `0x8983f136…` | ANYONE/WETH pool, fee 1% | `factory.createPool` — genuine v3-core |
| `0xef5d6240…` | WETH/USDC pool, fee 0.05% | same |
| `0x9f1ac54B…` | ANYONE's `TokenNetwork` | `registry.createTokenNetwork(ANYONE)` |

`decimals()` answering 18 is that contract answering, not a constructor
argument this sandbox chose. Two consequences of `setCode` are worth knowing
because they are invisible until they bite:

- **it copies code, not storage.** The constructor's words are written by hand
  afterwards. For ANYONE one of them is a `launched` flag packed beside
  `_owner`, and without it **every `transfer` reverts
  `AnyoneProtocolToken: Not launched.`** — first noticed from inside a failing
  pool mint.
- **ANYONE has a fixed 100M supply and no `mint()`.** Nothing can conjure it
  the way the mock USDC is conjured; the seed script hands anvil account 0 the
  supply and everything else is a transfer. (This is also why the `hs` buyer is
  now *sent* tokens by a faucet rather than minting its own.)

The factory is deployed rather than etched because `createPool` depends on
constructor state — and deploying it gets the pools right for free, since
`UniswapV3Pool`'s creation code is embedded in the factory's own runtime. The
package's `initCodeHash` is the canonical
`0xe34f199b…8b54`, and the committed pool addresses are CREATE2 derivations
from it, so a substituted factory fails the bring-up by name.

`contracts/SandboxAmm.s.sol` is the 60-line stand-in for v3-periphery: a v3
pool calls **back** into `msg.sender` for what a `mint` or `swap` owes it, so
the caller has to be a contract. It holds the tokens, holds one full-range
position per pool, and pays its own callbacks.

#### Priming the oracles, and why anvil starts in the past

A fresh v3 pool has observation **cardinality 1**: `observe([300, 0])` reverts
`OLD`, the connector maps that to `WindowNotServed`, and the pair then
**silently never prices** — config loads, node boots, every crossing refuses
`F02` and nothing says why. So the seed script grows both pools to cardinality
128 and then *walks the clock*, alternating `evm_increaseTime` with a dust
swap, because an observation is only written when a swap touches the pool. Ten
steps of 90 seconds gives 900 seconds of history before any connector starts.

Those 900 seconds are exactly how far **behind wall-clock** the `anvil` service
is started (`--timestamp`). anvil's clock runs at wall speed from whatever
genesis it is given and `evm_increaseTime` shifts that offset permanently, so
priming brings the chain back to real time. It matters in both directions: a
chain left running early makes every rate look permanently fresh, and one left
running late makes every rate look permanently **stale** — `T00` on the first
packet. The script then calls `observe()` itself and refuses to report success
otherwise; the anvil healthcheck gates on the same call, which is the entire
asset layer in one RPC.

#### The swap driver

`scripts/swap-driver.sh`, `full` and `credentials` profiles, every 15 seconds. It exists because a
seeded-and-abandoned pool is a frozen constant with a decorated config:

- v3 writes observations in `swap()` and **nowhere else**, so without trades
  the TWAP never changes;
- anvil mines only when a transaction arrives, so without trades the head
  block's timestamp never advances either — and `observed_at` is the head
  block's own timestamp, so the pair goes stale one `ttl_secs` later.

It steers ANYONE/WETH as a **bounded triangle wave** — ±200 ticks (≈ ±2%)
around the 0.25 USDC target, flipping every 300 seconds — and pins WETH/USDC at
its own target so all the movement comes from one pool. Bounded rather than
random is the load-bearing choice: the hub quotes a *static* price against this
rate, and a random walk would eventually leave the headroom that price was
sized for and start refusing purchases at 3am. That would be a true fact about
FX risk and a terrible property in a sandbox. Logging is one line a minute.

#### What the hub declares

```toml
[[tokens]] asset = "evm:<mock USDC>"   numeraire = true
[[tokens]] asset = "evm:<ANYONE>"      quote = [ANYONE/WETH pool, WETH/USDC pool]  # 300s TWAP each
[[tokens]] asset = "solana:<mock USDC>"
[[rates]]  from = "solana:<mock USDC>" to = "evm:<mock USDC>"  rate = 1/1  spread = 0/1
[rate_guards] spread = 30/10000   ttl_secs = 120   max_move = 5/100
```

Five things about that block are easy to get wrong and each is a named boot
failure or a silent refusal:

1. **The numeraire is a token nothing on this node settles in.** That is legal
   and it is the point — a numeraire is a unit of account, not a balance — and
   it is *forced*, because a quote's last leg must end at the numeraire on the
   numeraire's own chain, and the quote legs are EVM pools. The Solana mock
   USDC could not be the numeraire however convenient that sounds.
2. **Every `[settlement.<chain>]` table's token must be declared**, not just
   the ones a `[[client_channels]]` row names — a settlement table is what lets
   a node accept a claim on a channel it was never configured for (ADR 0052).
   Omit one and it is `ClientChannelTokenNotDeclared` at load.
3. **The `[[rates]]` row's direction is load-bearing.** Only `token →
   numeraire` is visible to the composer. Written the other way it is invisible
   and every credentials purchase is `F02`.
4. **The pair the packets actually convert is declared nowhere.**
   `solana:USDC → evm:ANYONE` is *composed* at lookup: the par row, then the
   ANYONE quote **read backwards**, with the spread applied once on top. It
   appears on no surface, including `GET /rates` — only declared pairs are
   listed, because a composition is derived and a refusal is not.
5. **A v3 tick is already `token1 per token0 in base units`.** The 18-vs-6
   decimal gap is folded into it and nothing applies a second scale;
   `decimals` in the settlement tables is a boot-time assertion against the
   chain, never an input to value arithmetic.

The guards are not read from the same place either: `spread` comes from the
pair being looked up (the composed one), while `ttl_secs` and `max_move` are
read **per leg** from that leg's own `(token, numeraire)` pair. `ttl_secs` also
sets the polling cadence — `ttl/3`, no separate knob, so 40 seconds here.

#### Why the hub's price is static, and what the smoke asserts instead

**A route price is config.** `GET /ilp` reads it straight out of the route
table and never touches the rate table; there is no route-advertisement
protocol and no way for a price to float. So a dealing hub does what a dealer
does: it quotes its client a fixed price **in the client's own money** and
carries the risk between quoting and settling.

`conf/connector-relay.toml` writes the sizing out:

```
downstream 0.04 ANYONE + fee 0.0004 ANYONE     = 4.04e16 must arrive
mid 4e12 ANYONE base units per µUSDC
  less spread 0.3%, less the driver's band 2.02%  = 3.908e12 worst rate
4.04e16 / 3.908e12 = 10338                     →  the route charges 11000
```

The 662 µUSDC of headroom is about four times the driver's band. What the old
"price triple" guaranteed by multiplication, `scripts/smoke-toon.mjs` now
guarantees by **inequality** (§6.5) — and it adds two assertions the old
topology had no need for:

- **step 0d / step 6** poll `GET /rates` at both ends of the run and require
  the ANYONE leg's `last_refreshed` *and its price* to have moved. Every other
  assertion in the file would pass against a frozen TWAP.
- **step 5** checks the crossing from both sides: the client paid the hub
  *exactly* 11000 µUSDC (a static quote, off the claim the client itself
  holds), and the hub paid the anytoon node a number that is ≥ the bundle
  price, ~10^12× the integer that arrived, and within 5% of what the
  pre-flight rate predicted. Any one of those alone would pass on a broken
  conversion.

#### Operator surfaces worth knowing

```bash
# the hub's rate table — the only surface that moves with the rate
curl -s localhost:3200/rates \
  -H "authorization: Bearer $(cat keys/toon/relay-connector/operator-bearer.token)" | jq
```

A row with `last_refreshed: null` is a **declaration** (static, never stale); a
row with a timestamp is an **observation**. `state` is `live` / `stale` /
`refused`, and `refused_refresh` shows a reading the `max_move` guard rejected
— which leaves the previous rate in force and ageing, rather than taking
anything down.

```bash
docker compose --profile full logs -f swap-driver   # one line a minute
```

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
- **The `.anyone` address (`hs` profile) survives `make down` and dies with
  `make clean`.** It lives in the `anon-data` volume with the private key
  behind it; `make down`/`make up-hs` keeps the same address, `make clean`
  publishes a new one on the next cold start (and drops
  `conf/.rendered/`). That is fine here and expensive in a deployment — §6.6.
- `make down` and `make clean` sweep **every** profile's containers, whichever
  one brought them up, so `make up-hs && make down` leaves no daemon running.

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
- **Connector refuses to boot**: its startup is fail-closed on every
  settlement backend AND on every quote path — check that anvil is healthy
  (the healthcheck requires code at the registry, the sandbox extras, AND a
  live `observe()` over the ANYONE pool's TWAP window) and the validator
  answers on 8899; then `docker compose logs <connector>` names the failure.
  Boot-time refusals in this area are all named:
  `ClientChannelTokenNotDeclared` / `PeeringTokenNotDeclared` (a settlement
  or peering token with no `[[tokens]]` row), `MixedNumeraire`,
  `TokenQuoteDoesNotEndAtNumeraire`, `RateGuardsMissing`, and
  `QuotePathUnusable::NoSourceForChain` (a `quote` on a chain with no rate
  source — i.e. any Solana one). §6.7.
- **Every credentials purchase refuses `F02`**: the hub declares no rate for
  the pair. Either the `[[rates]]` par row is written `numeraire → token`
  instead of `token → numeraire`, or the ANYONE quote never produced an
  observation. `GET /rates` on the hub tells you which (§6.7).
- **Every credentials purchase refuses `T00`**: the ANYONE pair went **stale**
  — nothing is trading, so no blocks are being mined and the observation aged
  past `ttl_secs`. Check `docker compose logs swap-driver`. Expected under the
  `payments` profile, which runs no driver; under `credentials` the driver is
  part of the profile, so a `T00` there means it stopped — or you stopped it
  on purpose to rehearse exactly this refusal (§2).
- **Every crossing refuses `T04` naming a tiny ceiling**: the ANYONE peering
  lost its explicit `max_packet_amount` and fell back to the 1000000 default,
  which is 10^-12 of one token on an 18-decimal leg.
- **The ANYONE pair never prices and nothing says why**: the pools cannot
  serve the TWAP window (`WindowNotServed` — a cardinality or priming
  failure, which is *not* a startup refusal). `seed-toon-evm-amm.sh` calls
  `observe()` itself before reporting success and the anvil healthcheck gates
  on the same call, so this should be impossible without editing one of them.
- **`make up` stops on the store or anytoon context**: those two images
  build from sibling checkouts — see Prerequisites for repointing
  `STORE_CONTEXT` / `ANYTOON_CONTEXT`, or use `make up-payments`, which
  never builds either (`make up-credentials` builds only the claim-minter,
  so it needs just the anytoon checkout). `make setup` only prints a note
  about them; the gates live on `make up` and `make up-credentials`, the
  paths that build the images.
- **A bare `docker compose` command does nothing**: it selected no profile —
  see the note at the end of §2.
- **Every credentials purchase comes back PAID but `402 CLAIM_INVALID`**:
  the price coupling has drifted — the anytoon node's base-unit route price
  no longer equals `BUNDLE_PRICE × 10^18`. `make smoke-toon` step 0c names it
  exactly; fix per §6.5. (`402 PAYER_UNATTRIBUTED` instead means the
  connector delivered without an `X-TOON-Payer`, i.e. `anytoon-connector`'s
  `[[client_channels]]` row was turned into a `[[peer_channels]]` row —
  also §6.5.)
- **Credentials purchases fail after the stack has run a month**: the
  issuer's epoch expired. `docker compose up -d --force-recreate
  issuer-keys issuer` re-forges it.
- **`make up-hs` waits five minutes and gives up on `anon`**: read the
  daemon's own log (`docker compose --profile hs logs --tail 80 anon`). A
  container that is *Up* but not healthy is bootstrapping against the real
  Anyone network and is usually not your fault; a container that **exited at
  once** is a config fault — almost always a missing `AgreeToTerms 1` or a
  missing explicit `Nickname` in `conf/anonrc` (the image's entrypoint would
  append one, and the file is mounted read-only, so it fails at boot instead).
- **`make smoke-hs` exits 75**: network-side, by construction — it only reaches
  that verdict after preflight has proved the daemon holds the address, the
  proxy is listening and the node advertises exactly that address. Re-run it
  later. Exit 1 is the other kind and names what is wrong here.
- **`make smoke` fails at step 4c after `make up-hs`**: expected, not a
  regression. That node now advertises its `.anyone` address, and a clearnet
  client has no proxy to reach it with — §2, *Hidden-service ingress*.
- **`F01 … no record of that channel` after `make down` + `make up-hs`**:
  anvil keeps nothing across a restart, so a kept channel store outlives its
  chain. `smoke-hs` reads its channel's collateral back off the chain before it
  signs anything and starts a fresh channel when the old one is gone; a client
  of your own needs the same check, or a `make clean`.

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
- **The hub carries real FX risk, on purpose, and it is bounded by a shell
  script.** A route price is static config and cannot float (§6.7), so the
  hub's µUSDC quote for the ANYONE routes covers the worst rate inside the
  swap driver's band with ~9% to spare. Stop `swap-driver` and let the pair
  go stale and every credentials purchase refuses `T00`; make it wander
  further than its band and they start refusing `F06`. Both are true
  properties of dealing rather than sandbox bugs — but it does mean the
  ANYONE routes are the only ones here whose correctness depends on a running
  service rather than on committed numbers.
- **The pair the packets actually convert is invisible on `GET /rates`.**
  `solana:<mock USDC> → evm:ANYONE` is composed at lookup out of the par row
  and the ANYONE quote read backwards; only *declared* pairs are listed, so
  its health has to be inferred from the two legs. `scripts/smoke-toon.mjs`
  composes it the same way the connector does.
- **Two legs is the maximum for a quote path**, and this sandbox uses both
  (ANYONE → WETH → USDC). A token whose price needed three hops could not be
  quoted here at all.
- **There is no Solana rate source in the connector.** Every token quoted
  live has to be on an EVM chain with a Uniswap v3 pool; a `quote` on a
  Solana token refuses startup by name (`QuotePathUnusable::NoSourceForChain`).
  That is why the numeraire is the *EVM* mock USDC and the Solana one reaches
  it through a declared 1/1 row.
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
