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
  Metaplex Core, solana-foundation's `payment-channels` and mainnet's p-token
  preloaded at genesis), an EVM chain (anvil, chain-id 31337, with x402's
  `x402BatchSettlement` at its production address and Circle's FiatToken as
  USDC), and a fake Arweave node (ArLocal).
- **AR.IO stack** — a real ar-io-node gateway (r83) plus the Turbo upload
  bundler, fully local: uploads are served back instantly, ArNS names bought
  on the local validator resolve at `http://<name>.ar.localhost:3000/`.
- **TOON payment layer** — the **hub** (`relay-connector`) and five peered
  connectors (store, gas station, two compute providers, and the **Dealer**,
  `dealer-connector`, which pays anytoon in ANYONE), on the connector
  release `rust-2026.09.29.1`, which is **x402-only**: every channel is an
  x402 `batch-settlement` channel (connector ADR 0075) — on EVM in
  `x402BatchSettlement`, in the FiatToken USDC, deposited gaslessly through
  the sandbox's **Onboarder**; on Solana in `payment-channels`, in a 6-decimal
  mock USDC mint, opened through the receiving node's own sponsor endpoint —
  and every payment is a **voucher** on one. A peering is two such channels,
  opened at runtime by each node's own `POST /peers` (§6.2). The ANYONE
  denomination boundary lives in the Dealer, which converts µUSDC into ANYONE
  at a live Uniswap v3 TWAP (§6.7).
- **TOON apps** — the relay (paid Nostr writes), the store (paid Arweave
  uploads + brokered ArNS buys), the gas station (pays your Solana rent or
  relays your EVM meta-tx), two compute providers, and the **Anyone Protocol
  credentials issuer** (blind-signed credential bundles, behind a claim
  minter and `anytoon-connector`, paid in ANYONE). The first three are
  payment-oblivious HTTP apps behind their connector — the pattern **your**
  app will follow (§5); the issuer is the counter-example, an app that
  refuses to serve without proof of payment at its own layer (§6.5).

Everything can be reached through the hub by ILP address:

| ILP address | App | Price (hub, smallest USDC units) |
|---|---|---|
| `g.toon.relay` | Nostr relay write | 1 |
| `g.toon.relay.ephemeral` | ephemeral write | 0 |
| `g.toon.store` | blob store (kind:5094), ArNS broker (kind:5095) | 1100 base + 10/KiB |
| `g.toon.gastation` | gas station (kind:5096 Solana, kind:5098 EVM) | 1100 |
| `g.toon.provider.*`, `g.toon.provider2.*` | the two compute providers (spawn/extend paid, four routes free) | listing price + 100 |
| `g.anyone.credentials` | a blind-signed credentials bundle, through the Dealer (§6.7) | 11000 |
| `g.anyone.credentials.keys` | the issuer's epoch key document, through the Dealer (free at anytoon) | 210 |

Every forwarded row is the payee's own price plus the hub's flat 100 fee —
the two credentials rows included: the Dealer charges 10900 and 110, and it
is the Dealer's price, not anytoon's, that carries the FX buffer (§6.7).
Those rows are not in the hub's config any more: a peering is established at
runtime, and so are the routes over it — `scripts/peerings.mjs` is the table,
and `npm test` holds every hub price to the payee's (§6.2), and the Dealer's
to anytoon's at the worst rate the sandbox's market can show.

What `make smoke` proves on every run — all flows paid, all entering at the
hub's edge:

1. **AR.IO**: upload via the local Turbo bundler → buy an ArNS name on the
   local validator → point the ANT's `@` record at the upload → fetch
   `http://<name>.ar.localhost:3000/` through the local gateway.
2. **TOON**: every node publishes its x402 terms; every peering's channel is
   open and collateralised on the validator; a directory publisher whose
   channel store is wiped still gets its next write through (§8); then a
   real `@toon-protocol/client` (4.1.1) opens an x402 channel on Solana
   against the hub, through the hub's sponsor endpoint, and: a paid Nostr
   write (read back byte-identical over
   the free WS), a paid blob store (lands in the local bundler, served by
   the local gateway), the **full brokered ArNS ceremony** (paid
   `op=prepare` composes an ANT spawn → a SOL-less owner signs → the gas
   station pays rent + fee and broadcasts via paid kind:5096 → paid
   `op=buy` has the store's DVM purchase a fresh name → the gateway
   resolves it), a paid Solana gas quote, and a paid EVM ERC-2771 relay
   (an unfunded wallet's signed request lands on anvil with `_msgSender()`
   read back as the client), and a **credentials bundle bought through the
   Dealer**: the key document read through the hub at 210, then 11000 µUSDC
   for a bundle the Dealer pays anytoon for in ANYONE at the live TWAP (§6.7).
   The connectors' own books are asserted per leg: the hub's voucher
   watermark on the buyer's channel, each payee's watermark on the hub's
   channel toward it, at par, and anytoon's CLIENT book holding the Dealer's
   payment in ANYONE, keyed by the Dealer's channel — and the ANYONE rate has
   to have moved during the run.
3. **x402 on EVM** (`make smoke-x402`): a wallet holding FiatToken USDC and
   no ETH deposits into a channel to the hub through the Onboarder the hub
   names as its `facilitator`, then pays the hub a relay write with a voucher
   on that channel, and the hub's own `GET /claims` holds it (§6.10).

Opt-in on top of all that, the **Workload Gateway** (TOON_Network Milestones 5
and 6, ADR 0013, spec §12): a stable hostname per workload, keyed by its
workload id and resolved to whichever sandbox provider is running it, behind a
connector of its own — `make up-gateway`, then seal a Gateway Handover to it
with one command and `curl http://<label>.gw.localhost:3280/` (§2, *The
Workload Gateway*). **Nothing on that path is published.** `make smoke-m5` is
that path as an acceptance test, with a Takeover in the middle of it;
`make smoke-m6` is the whole tenant path with nothing signed and nothing
published, and it sweeps the relay to say so; `make smoke-m7` revokes a
gateway's reading by rotating the lease's tokens, and spawns from an image
whose Blob Record is paged.

And one thing `make smoke` deliberately does **not** prove, because it takes a
third-party dependency: reaching a node whose **only** ingress is a `.anyone`
hidden service. That is the opt-in `hs` profile — `make up-hs` + `make
smoke-m4` (the hidden provider) and `make smoke-hs` (a credentials bundle
bought over the anytoon node's `.anyone` address), never part of a cold start
(§2, *Hidden-service ingress*).

Everything here was distilled from three proven throwaway prototypes on the
`prototype/local-ar-io-stack` branch
(`prototypes/{solana-arns,gateway-upload,full-stack}` — their `VERDICT.md`s
hold the detailed findings).

## 2. Quick start

### Prerequisites

- Docker with the compose plugin
- Node.js >= 20 with npm (for the smoke test / driver scripts on the host)
- The **provider sibling checkout** at `../../provider` (every profile with
  a provider in it: `payments`, `full`, `hs`, `gateway`): the providers and
  their directory publishers are BUILT from it, and it must carry
  toon-protocol/provider#52 — the publisher on `@toon-protocol/client` 4.x.
  An older publisher pays in `toon-channel` claims the connector refuses, so
  `make up*` checks first (`require-provider-publisher`) and stops by name;
  `PROVIDER_CONTEXT=/path/to/provider` points elsewhere. No connector
  checkout is needed any more: anvil runs the sandbox's own Foundry project
  (`./contracts`), and fetches its two libraries into `contracts/lib` on the
  first start
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
- **`gateway` profile only** — the **gateway sibling checkout** at
  `../../gateway` (toon-protocol/gateway): the Workload Gateway image is BUILT
  from it (it publishes no image). Override with `GATEWAY_CONTEXT` if your
  checkout lives elsewhere: `make up-gateway GATEWAY_CONTEXT=/path/to/gateway`.
  Its tenant side, `scripts/handover.mjs`, runs the handover tool out of the
  **provider checkout** (`../../provider/tools/grant`, the same checkout the
  provider images build from); `make setup` installs that tool's deps
- Free host ports: 3000, 3004, 5100, 4566, 1984, 8545, 8899, 8900, 3200,
  3210, 3220, 3240, 3250, 3300, 3400, 4022, 7100 — the `payments` profile
  only needs 8545, 8899, 8900, 3200, 3240, 3250, 4022 and 7100 (plus 40000–42599
  for the first provider's workload SSH forwards and ports and 43000–45599
  for the second's — disjoint on purpose, both providers publish on this one
  host daemon); `credentials` needs 8545, 8899, 8900, 3200, 4022 and 7100; `gateway` adds
  3260 (the gateway's connector), 3280 (its plain listener) and 3443 (TLS)
- **Full stack only** — `*.localhost` resolving to loopback (default on
  modern Linux/macOS resolvers; check with `getent hosts foo.ar.localhost`).
  The `gateway` profile leans on the same thing for `*.gw.localhost`, with a
  52-character label — §2, *The Workload Gateway*, says how to check and what
  to do when it does not

### Cold start

```bash
cd sandbox
make setup          # npm ci + preflight checks (one-time)
make up             # state guard + checkouts, then docker compose up -d --build
# first run: pulls images + builds the seeder; stack settles in ~1-2 min
make smoke          # full end-to-end proof of both layers
```

`make up` alone brings up everything in the right order — all seeding is
expressed as one-shot compose services gated on healthchecks (§6.1), so
there is no separate provisioning step and re-running `make up` is always
safe. **Coming from a sandbox older than infra#39** (the x402-only
migration)? `make up` refuses its volumes by name and tells you to run
`make clean` first (§7).

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

Thirteen services instead of thirty-four:

| in `payments` | why |
|---|---|
| `anvil` | `x402BatchSettlement` + the FiatToken USDC; every EVM key funded before it reports healthy |
| `solana-validator` | `payment-channels` (every Solana channel) + p-token; the client leg and every peering settle here |
| `seed-toon-solana` | the Solana mock USDC mint, ATAs and SOL |
| `onboarder` | relays a 0-ETH payer's EVM deposit and pays its gas (§6.10) |
| `relay` | `g.toon.relay` is the hub's only TERMINATED route — the one destination a paid packet can reach with no peer running |
| `relay-connector` | the hub itself, client edge on **3200** |
| `open-peerings` | every peering this profile runs, through each node's own `POST /peers`, and the hub's routes over them (§6.2) |
| `provider` + `provider-connector` | the TOON_Network compute provider and the connector terminating `g.toon.provider.*` (client edge **3240**; peered to the hub) |
| `directory-publisher` | the provider's payer for its relay writes (Profile, Listings, Liveness) |
| `provider2` + `provider2-connector` | the SECOND compute provider and its own connector, terminating `g.toon.provider2.*` (client edge **3250**; its own peering with the hub). A Standby Set spans two providers, so the sandbox runs two (TOON_Network #34) |
| `directory-publisher2` | the second provider's payer, on its own account — two payers never share one channel's watermark |

**The compute provider** (TOON_Network Milestone 1) lives on this profile
too, and has five smokes of its own, all runnable back to back in any order:
`make smoke-provider` (one paid spawn through the hub, SSH in, the books, a
billed replay, a terminate bearing the lease's token), `make smoke-provider2`
(THE SAME SCRIPT against the second provider — `TOON_SMOKE_PROVIDER=provider2`, one
provider argument through the same helpers: its edge at :3250, its pubkey,
its config, its peering with the hub), `make smoke-directory` (the
Profile, Listings and Liveness read back off the relay, paid writes only),
`make smoke-eviction` (the operator command and its Eviction Notice), and
**`make smoke-m1` — Milestone 1's acceptance test**: the whole lease
lifecycle (directory → availability → paid spawn → paid extend → expiry →
claim books to the unit), once paying through the hub and once paying the
provider connector directly at :3240, with the provider's answers compared
between the two. It buys the sandbox-only `smoke` listing
(`conf/provider.toml`, a 30 s Lease Interval) and takes three to four
minutes; the provider repo's README describes what it proves.

**`make smoke-m2` — Milestone 2's acceptance test** (`scripts/smoke-milestone2.mjs`):
the TOON-native image path end to end. It needs the FULL stack (`make up`),
because the store and the gateway are not on the payments profile. It builds
a two-layer sshd image on the host daemon and publishes it with the base
layer left upstream as an `oci` source and the built layer, config and
manifest stored as parts in the TOON store (one Blob Record each, one Image
Registry entry), publishes a Template for it, expands the Template
tenant-side and pays a spawn with `{ digest, registry_entry }` and no
`reference` — the provider fetches the base layer from Docker Hub and the
rest from the local gateway, verifies every part and blob, `docker load`s
the layout and runs the workload by digest; the tenant reaches it over SSH
and `status` echoes the Template's address. It then publishes a tiny
all-store image (busybox plus a marker layer, every blob in the store) and
spawns it by `{ digest }` alone, twice: the second spawn fetches nothing,
which the smoke sees in the provider's blob cache being byte-for-byte
unchanged. Every entry, Blob Record, store copy and part is read back from
the relay and the gateway with every hash checked (the publisher's
`*-verify` commands), and the store, relay and provider books are closed
to the unit from what each packet was charged. Three spawns of the `smoke`
listing, each ended by the tenant; about two minutes. `make smoke-m1`
still passes afterwards.

**`make smoke-ci` — the `ci` listing** (TOON_Network #14, spec §4.4 and
Appendix A.1, `scripts/smoke-ci.mjs`): the tier that grants `docker`. The
`ci` Listing on the relay carries `["t","docker"]` and A.1's content (2000
millicores, 4 GiB, 10 GB, amd64, 5000 uUSDC per 600 s); a tenant pays
`g.toon.provider.ci.v1.spawn` through the hub and gets the sshd workload
plus, beside it on the host daemon, the provider's own **privileged
`toon-<id>-dind` sidecar** — a Docker daemon of the lease's own, whose
socket the workload mounts at `/var/run/docker.sock` through a per-lease
volume. The smoke checks the shape on the host (the workload is
unprivileged and mounts no socket file; both containers sit under the
lease's cgroup slice `toon.slice/toon-<id>.slice`, whose `cpu.max` and
`memory.max` are the tier's limits, so the workload, the daemon and every
nested container are bounded as one unit), then over SSH as the tenant's
non-root user drives the socket with `curl`: the daemon's id is not the
host daemon's, it pulls `hello-world` (a nested pull is the lease's own
egress) and runs it. A tenant-signed terminate then removes the workload,
the sidecar, both volumes, the network and the slice. Needs only the
payments profile; about a minute. The target pre-pulls the pinned dind
image so the spawn does not pay for it. A run aborted mid-way leaves its
lease for the sweep (600 s), counting against the tier's capacity of 2.

**Two providers, not one** (TOON_Network #34, Milestone 3). A Warm Standby
is only worth buying from a provider that is not the one already running the
workload, so the sandbox runs `provider` and `provider2` as two genuinely
separate providers: two Nostr identities in the directory, two connectors
(:3240 and :3250) with two sealing keys, two peerings with the hub (each two
x402 channels), two directory publishers on two accounts, and — because both create
their containers on this one host daemon — disjoint workload id, SSH and
published-port ranges (1000–1099 / 40000–42599 against 1100–1199 /
43000–45599). Both price the same `warm` tier, whose 600 s Lease Interval
outlives the takeover timeline (five cadences of Liveness expiry, one to
trigger, two to settle — about four minutes at the sandbox's 30 s cadence)
and whose `standby_price` is what makes each connector terminate
`g.toon.provider<n>.warm.v1.standby` and `.standby.extend` at 400. Everything
Milestone 1 and 2 built still means the first provider: `make smoke-provider2`
is the one target that says otherwise, and it is the same script with a
provider argument.

**`make smoke-m3` — Milestone 3's acceptance test** (TOON_Network #11 / #35,
`scripts/smoke-milestone3.mjs`): Warm Standby end to end, across both
providers. A tenant sends ONE spawn content naming the Standby Set
`[provider, provider2]` to each member in a **request of its own** — naming
only that member and bearing only that member's Continuation Token, under the
`op` its route serves (spec §6.1, §7) — and pays it on the first provider's
`g.toon.provider.warm.v1.spawn` at the full price and on the second's
`g.toon.provider2.warm.v1.standby` at `standby_price`. The primary answers
`role: primary` with access and runs the workload in its own id range
(`toon-10xx`), reachable over SSH with the tenant's key; the standby answers `role: standby` with no access, `status`
says `reserved`, its next Liveness has `available.warm` one lower, it is
paid on `.standby.extend` and refuses `.extend` as `not_running`. The smoke
then runs `docker compose stop provider` and waits: the primary's Liveness
expires five cadences after its last publication, one cadence of silence
later the standby announces a Takeover on the relay (kind 30433, `d` = the
workload id, `{ workload_id, primary }`, signed by provider2, paid as one
`g.toon.relay` unit on `directory-publisher2`'s own channel), two cadences
after that it settles the race and starts the workload from the image in
ITS OWN id range (`toon-11xx`), reachable with the same key; `status` on
provider2 says `running`, `role: standby`, `takeover.winner` = itself and
an unchanged `expires_at`, so `.extend` at the full price is bought and
`.standby.extend` is refused `not_standby`. `docker compose start provider`
then has the primary find the Takeover at startup and stand down — `status`
`stopped`, no access — leaving exactly one running copy on the host daemon.
Every book is closed to the unit (both providers' watermarks on the hub's
channels toward them, the hub's watermark on the buyer's channel, the
publisher's relay units) and both leases are ended by the tenant. Buys
the 600 s `warm` tier on both providers; five to six minutes, four of them
the takeover timeline. It stops and restarts the FIRST provider's container,
so run it alone. `TOON_M3_STANDBY_ONLY=1` runs the reservation side against
provider2 alone for a first provider that does not sell `warm`, and its
verdict says it is not a pass. `make smoke-m1` and `make smoke-m2` still
pass afterwards. **Milestone 4's, `make smoke-m4`, lives on the `hs` profile**
— it buys from the hidden provider over the real Anyone network, so it is
documented under *Hidden-service ingress* below.

**`make smoke-m5` — Milestone 5's acceptance test** (TOON_Network #46 / #54,
`scripts/smoke-milestone5.mjs`), on Milestone 6's tenant path: the **Workload
Gateway** end to end, and the milestone's promise in one sentence — *a workload
has a stable URL that survives a Takeover with no tenant online*. That promise
is unchanged; what moved underneath it is how a tenant chooses a gateway (a
sealed handover, not a published grant) and how a request authenticates (a
Continuation Token, not a signature). It needs the `gateway` profile (`make
up-gateway`, or `make up-gateway COMPOSE_PROFILE=payments`); §2's *The Workload
Gateway* is the same path by hand. First the gateway's own connector
(`http://localhost:3260/ilp`) is read and terminates **exactly one route, and
it is free** — the handover door; a gateway is party to no lease and sells
nothing (ADR 0013) — and a hostname it holds no grant for is answered by the
gateway itself, `503 no_grant`, dialling nothing. Then a tenant spawns
`traefik/whoami` on container port **80** across the Standby Set `[provider,
provider2]` (the `smoke-m3` shape, with `ports`) and **seals ONE Gateway
Handover** to the gateway's connector with `node scripts/handover.mjs`: one
Gateway Grant derived per member from the lease's root secret for one moment,
the `http_port`, both members primary first, and a fresh short name. The smoke
re-derives all of those itself and requires them to match the tool's byte for
byte, and it reads the relay and requires **not one event on it to name the
workload** — there is no publish step any more, and the absence is asserted
where the read-back used to be. **Nothing else is told to the gateway**; the
one packet is the whole ceremony, and the tenant signed nothing to send it. The
canonical hostname (the 52-character base32 of the workload id) and the
handover's name then both answer with the workload's **own body**, over HTTP
and over HTTPS with the committed dev certificate, carrying the tenant's `Host`
unchanged and the `X-Forwarded-For` / `-Proto` / `-Host` of spec §12.5. `docker
compose stop provider` next, and the `smoke-m3` timeline runs underneath: the
standby announces a Takeover on the relay, the gateway's own settle window (two
cadences from the claim's `created_at`) passes, and **the same two URLs come
back answered by the copy on the standby** — whoami reports its own container,
so the move is visible in the response body and in nobody's log. The restarted
primary stands down, leaving one copy; `terminate` on both leases leaves both
URLs answering `503 no_running_member` in spec §5's error shape and in the
`toon-gateway-reason` header; and neither provider's book grew by a single
unit for anything the gateway asked, because `status` is free and a gateway
calls no other route. Buys the 600 s `warm` tier on both providers; five to
seven minutes, four of them the takeover timeline. Like `smoke-m3` it stops and
restarts the FIRST provider's container, so run it alone. `make smoke-m1` to
`make smoke-m4` still pass afterwards.

**`make smoke-m6` — Milestone 6's acceptance test** (TOON_Network #56 / #63,
`scripts/smoke-milestone6.mjs`): the whole path a tenant walks — pay, spawn,
poll, delegate, front, withdraw, terminate — **without signing anything and
without publishing anything**, with every step asserting that what the
milestone removed is really gone rather than merely unused. Same profile as
`smoke-m5` (`make up-gateway`), two to three minutes.

- **The lease path.** A paid spawn bearing the Continuation Token derived for
  the provider starts a workload, and `status` with that token answers. Then
  the four refusals, each with its own code (spec §6.1.2): a **wrong** token is
  `not_tenant` and quotes no token back; an **absent** token is `not_tenant`
  too, so nothing reads as an unauthenticated success; a **replayed**
  `request_id` is `stale_request`; and a request naming the **other provider**
  is `invalid_request`. The lease is untouched by all four.
- **The restart.** `provider`'s container is stopped — the workload goes on
  running on the host daemon, which is the point — and started again, and the
  **same token still reads and still ends the lease**. A provider that forgot
  the token would have left a paid workload nobody could read, extend or stop.
- **The gateway path.** `node scripts/handover.mjs` seals a handover and a
  `curl` of the canonical hostname reaches the workload's own body. A
  **delegated `status`** — the grant as the request's `continuation`, its
  moment in `gateway_expires_at` — is answered byte for byte what the tenant is
  answered; a grant derived for a moment that has passed is `bad_grant`; and a
  **delegated `terminate` is refused both ways it can be sent**
  (`invalid_request` with the moment, `not_tenant` without it). A **Gateway
  Withdrawal** then takes the workload off and the same `curl` answers the
  gateway's own `no_grant`, while the lease runs on untouched.
- **The Standby Set.** A spawn forms a set across both providers, one request
  per member, and then the regression the per-provider derivation exists to
  prevent: a request bearing the **primary's** token is refused `not_tenant` at
  the **standby**, on `status` and on `terminate` alike, while the standby's own
  token reads it perfectly — so the refusal is about the token and not about the
  standby.
- **The assertion that closes the milestone,** which no other test can make:
  the relay is read across the whole namespace and **no event on it is signed
  by a key this run's tenants held**, none is of kind `4432` or `30438`, none
  names either `workload_id` the run chose, and every author in the namespace
  is a provider or a publisher. Before that sweep runs for real it is run over
  a **fabricated** relay carrying exactly those events and required to catch
  all four — because a sweep that finds nothing is worth only what its ability
  to find something is worth. Nothing is ever published to make that point: a
  relay keeps what it is given, and there would be no taking it back.

**`make smoke-m7` — Milestone 7's acceptance test** (TOON_Network #69 / #76,
`scripts/smoke-milestone7.mjs`): a tenant can **revoke a Workload Gateway's
reading before its grant runs out**, and keep serving from an image too large
for one Blob Record. Needs the **full stack plus the gateway**, `make
up-gateway` (the default `COMPOSE_PROFILE=full`: the paged image lives in the
store, so the payments-only gateway stack is not enough). Two to three
minutes, most of it the gateway's 30 s cadence and the store uploads. Every
step is asserted on the wire — response bodies and the gateway's reasons,
never a log — and each one uses the developer's own command:

- **Spawn and hand over.** `node scripts/spawn.mjs --standby provider
  --standby provider2` forms a two-member Standby Set on `warm` and writes the
  lease file; `node scripts/handover.mjs <lease>` seals one grant per member
  (each re-derived by the smoke from the lease's root secret and matched), the
  gateway admits it and the canonical hostname answers with whoami's own body.
  A delegated `status` bearing each member's grant is answered at both.
- **Rotate.** `node scripts/rotate.mjs <lease>` rotates both members; the lease
  file then holds a new root secret and no rotation record. At **each** member
  the grant the gateway holds is now `bad_grant`, the old token is
  `not_tenant`, and the new token reads the lease.
- **The gateway notices, told nothing.** Within a cadence or two the same
  hostname answers 503 `member_unreachable` in spec §5's error shape, its
  message naming `bad_grant` at both members — while the primary still answers
  `running` to the new token. Rotation ends READING; a withdrawal
  (`smoke-m6`) ends only serving.
- **Hand over again.** The same `handover.mjs` command seals grants of the
  ROTATED tokens (none of them one the old root could derive); it is admitted
  and the hostname serves again. The lease ends with the new token.
- **A paged image.** busybox plus a 2 MiB random layer, published with the
  publisher's record ceiling **lowered** to 2,048 bytes and four parts to a
  page (`--record-max` / `--parts-per-page` on the CLI) — the shape a 70 MB
  layer takes without 700 paid uploads. The layer's Blob Record, read from the
  relay and from its store copy, carries `pages` and no `parts`; every page
  fetched from `/raw/` hashes and counts as recorded, the parts join to the
  layer's digest, and `publisher.mjs blob-verify` / `image-verify` read it back
  through its pages. `availability` says `would_run`, and a paid `smoke` spawn
  runs it by `{ digest, registry_entry }` — the provider read every page — and
  is ended.

**The publisher** (TOON_Network Milestone 2, `scripts/publisher.mjs`) is
the development tool that puts images on the TOON Network — it needs the
FULL stack (`make up`): the store, the gateway and the relay. `node
scripts/publisher.mjs blob <file> --key <hex>` stores a file as 100 KiB
parts, one paid `kind:5094` job each on `g.toon.store`, publishes its
**Blob Record** (kind 30435, `d = sha256:<hex>`, findable by `#x`) as a
paid `g.toon.relay` write, and uploads the same signed record once more to
the store so an Image Registry entry can cite that copy's txid. A blob the
relay already records is skipped. `node scripts/publisher.mjs blob-verify
sha256:<hex>` reads it all back the way a provider would (relay by `#x`,
the copy and every part at the gateway's `/raw/<txid>`, every hash
checked) and pays nothing.

`node scripts/publisher.mjs image <layout> <name>:<tag> --key <hex>` puts a
locally built image on the network: point it at an OCI image layout — a
directory, or the tar `docker save --platform linux/amd64 <image> -o
image.tar` writes — and it walks every blob reachable from the image digest
(the index if there is one, every manifest, every config and every layer),
stores the ones that are not already public through `blob` above, and
publishes the **Image Registry entry** (kind 30434, `d = <name>:<tag>`,
`x` = the digest hex) that makes `<npub>/<name>:<tag>` resolve. Say which
blobs are already public with `--upstream <registry>/<repository>` — as
`…@sha256:<hex>` for one blob, `…=<layout>` for every blob of a base image
export (`docker save busybox:latest -o base.tar`), or bare for every blob
the layout does not hold — and those are listed as `oci` sources instead of
being paid for. No form of `--upstream` calls the registry. An image whose
blob list would be incomplete is refused before anything is paid for, and
`--dry-run` prints the list without publishing. Republishing the same
`<name>:<tag>` moves the tag. `node scripts/publisher.mjs image-verify
30434:<pubkey>:<name>:<tag>` reads the entry back from the relay and every
`toon-store` blob's Blob Record from the gateway, free.

`node scripts/publisher.mjs template <file> <name> --key <hex>` publishes a
**Template** (kind 30436, `d = <name>`): a description of a spawn — an image
by content address, its ports, where it keeps state, the settings its author
fixed and the names a tenant may supply — that a TENANT expands and signs
itself. A Template grants nothing (ADR 0004), so a content field that looks
like a capability, or one spec §8.3 does not define, is refused before
anything is signed. `node scripts/publisher.mjs template-verify
30436:<pubkey>:<name> --value NAME=VALUE` reads it back from the relay and
prints the spawn content it expands to, free, without sending a spawn
anywhere. The expander itself is `scripts/lib/template.mjs`, tenant-side:
`expandTemplate(template, { values, workloadId, sshPublicKey, volumeGb })`.

`make test` runs the publisher's and the expander's unit tests against fakes
and real OCI layouts in a temp directory; see `scripts/publisher/README.md`.

Left out: the AR.IO gateway and Turbo bundler (`envoy`, `core`, `redis`,
`arlocal`, `upload-service`, `fulfillment-service`, `upload-service-pg`,
`localstack`, `seed-gateway-block`, `seed-solana`), the `store`,
`gas-station` and credentials-issuer apps, the connectors that front them
(`store-connector`, `gas-connector`, `anytoon-connector`), the Dealer
(`dealer-connector`) and `swap-driver`.

The `open-peerings` job establishes the two provider peerings and skips the
store, gas and Dealer ones **by name** — their far side does not exist on this
profile — so `g.toon.store` and `g.toon.gastation` are simply not routed
here. `g.toon.relay` (price 1) and `g.toon.relay.ephemeral` (free) work
exactly as in the full stack, which is what `make smoke-payments` proves:
`x402BatchSettlement`, the FiatToken and `payment-channels` live with no
TOON contract left on either chain, every node publishing its x402 terms,
both provider peering channels open and collateralised on the validator, a
directory publisher recovering from a wiped channel store, a sponsored
Solana channel opened against the hub and a paid write journaled as a
voucher on it — then `make smoke-x402`, the gasless EVM deposit and a
voucher on it (§6.10).

The ANYONE pools are still built on anvil here (anvil builds them on every
profile), but nothing trades them without `swap-driver` and nothing on this
profile prices off them: the Dealer does, and it is not on this profile.

`make down`, `make clean`, `make logs` and `make ps` work the same either way.

### Buying credential bundles without the permaweb (the `credentials` profile)

For a TOON client that buys Anyone credentials across the **denomination
boundary**: µUSDC in at the hub, ANYONE out to `anytoon-connector`, converted
by the **Dealer** at a live Uniswap v3 TWAP (§6.7).

```bash
make up-credentials    # chains, the hub, the Dealer, the issuer path and the swap driver
make smoke-credentials # the purchase end to end, then smoke-x402
```

What starts: the chains and their seed jobs, the hub, the relay, the
Onboarder, `dealer-connector`, `anytoon-connector`, the issuer path
(`issuer-keys`, `issuer-migrate`, `issuer`, `issuer-postgres`,
`issuer-redis`, `claim-minter`, §6.5), `swap-driver`, which keeps the ANYONE
TWAP the Dealer converts at live, and the `open-peerings` job, which
establishes `relay-dealer` and `dealer-anytoon` and skips the rest by name.
It needs the **anytoon** sibling checkout (`claim-minter` builds from it) and
not the store one.

`make smoke-credentials` checks the price triple against what anytoon
advertises, the hub's and the Dealer's prices against `scripts/peerings.mjs`,
both of the Dealer's inequalities against its own `GET /rates`, the free key
document at anytoon and through the hub (210), every escape off the free
route refused before the issuer, an unpaid request refused, and one paid
bundle: 11000 µUSDC from the client, the Dealer's payment landing in
anytoon's CLIENT book in ANYONE, keyed `evm:<the Dealer's channel id>`, and
the ANYONE rate having moved during the run.

### A topology of your own (`make up-topology`)

The profiles above are fixed stacks. A **topology** is the sandbox with only
the nodes you name, settling only on the chains you name:

```bash
make up-topology NODES=relay                             # a connector and a relay
make up-topology NODES="relay relay2 store" CHAINS=evm    # two relay nodes and a store, on anvil alone
make up-topology NODES="relay gas" CHAINS=solana          # the hub and the gas station, on Solana alone
make up-topology NODES=relay HS=relay                     # one relay node, reached only at a .anyone address
make topology    NODES="relay relay2" CHAINS=evm          # print what that would run; start nothing
make smoke-topology                                       # prove whatever is running
```

| `NODES` | what starts | client edge | needs |
|---|---|---|---|
| `relay` | `relay` + `relay-connector` — **the hub** | 3200 (reads 7100) | — |
| `relay2` | `relay2` + `relay2-connector` — a second relay node, `g.toon.relay2*` | 3290 (reads 7110) | — |
| `store` | `store` + `store-connector`, with the AR.IO gateway and the Turbo bundler | 3210 | the store checkout |
| `gas` | `gas-station` + `gas-connector` | 3220 | — |
| `provider`, `provider2` | the provider, its connector and its directory publisher | 3240, 3250 | `relay`; the provider checkout |
| `anytoon` | the issuer path + `anytoon-connector` | 3230 | `evm`; the anytoon checkout |
| `dealer` | `dealer-connector` + `swap-driver` | 3270 | `relay`, `anytoon`, both chains |

- **`relay` is the hub.** Every other node that runs beside it is peered to
  it by the `open-peerings` job, exactly as under `make up`, and reachable
  through it; `relay2` is one more spoke (a write to `g.toon.relay2` through
  the hub costs its 1 plus the hop's 100). A node that runs WITHOUT the hub is
  simply paid at its own edge — `NODES=relay2`, or `NODES=store`, is a valid
  topology with no peering in it. The star is the only shape: there is no
  `relay2`-to-`store` peering, and `relay2` forwards nothing.
- **`CHAINS`** is `evm`, `solana` or both (the default), and is what the nodes
  **settle** on. A connector has no environment layer, so a node on one chain
  mounts a rendered copy of its committed config with the other
  `[settlement.*]` table removed (`conf/.rendered/topology/`, through that
  connector's `*_CONNECTOR_CONF` variable); with both chains it mounts the
  committed file as it is. Each peering opens on Solana when both ends settle
  there and on anvil otherwise (`fallback` in `scripts/peerings.mjs`) — both
  are six-decimal USDC, so every fee and price holds. On `evm` alone the
  directory publishers pay the hub from anvil, through the Onboarder. A chain
  an **app** reads still runs: the validator with `store` (ArNS) and `gas`,
  anvil with `gas` — `make topology` says so when it happens.
- **`HS`** names relay nodes to reach only over a hidden service. It starts
  the `anon` daemon, its forwarder and the buyer's SOCKS proxy (and none of
  the rest of the `hs` profile), opens the peerings on compose names, then
  restarts each hidden node on a config whose endpoint is
  `http://<address>.anyone:<its port>/ilp` — the order `make up-hs` uses, for
  its reason. The chain RPCs are on the same address (8545; 8899 and 8900), so
  a buyer's reads ride the circuit with its packets; the Onboarder is not, so
  a buyer on EVM pays its own deposit gas. Like `up-hs` it **dials the real
  Anyone network**: expect a minute or two, and `make smoke-topology` exits 75
  when the overlay, not the sandbox, failed. `HS=relay` refuses to run with a
  provider — its publisher dials the hub from the compose network.
- **Only the selection runs.** `up-topology` first removes every sandbox
  container the selection does not name (volumes stay), so it can follow any
  other `make up*` or another topology. A connector whose rendered config
  changed is recreated on it, and the peerings reopen on the chain both ends
  now share; `make clean` first is still the unambiguous start, since a
  journal otherwise keeps the channels of the chain a node left.
- **A relay node says where a write to it is paid.** Its relay answers a
  plain `GET /` on the read port, asked with
  `Accept: application/nostr+json`, with the relay information document, and
  the document's `toon` object says where a write to that node is paid:

  ```bash
  curl -s -H 'Accept: application/nostr+json' http://localhost:7100/ | jq .toon
  # { "ilp_address": "g.toon.relay",
  #   "connector_url": "http://relay-connector:3000/ilp",
  #   "connector_seal_key": "0x0437…",
  #   "price": 1,
  #   "settlement": [ { "network": "eip155:31337", "asset": "0x0a86…" } ] }
  ```

  The relay is told two things — its connector and the one address whose
  route reaches its `POST /write` (`TOON_CONNECTOR_URL` and
  `TOON_WRITE_ILP_ADDRESS`, `conf/relay.conf` and `conf/relay2.conf`) — and
  reads the rest off that connector's free `GET /ilp`, so the price, the seal
  key and the settlement terms are the connector's own and list only the
  chains the topology was started with. `connector_url` is what the connector
  **publishes**: its compose-network name, or a hidden node's `.anyone`
  endpoint. A reader on the host moves a compose name onto the host with
  `hostUrl` / `hostFetch` (`scripts/lib/sandbox-endpoints.mjs`), as the smokes
  do for everything else a node publishes; the sandbox does not publish
  host-reachable endpoints. The relay re-reads its connector every five
  minutes (every five seconds until the first answer, which is the few
  seconds after boot in which the document has no `toon` object yet), so
  `up-topology` restarts a relay together with a connector it restarts on
  another config. Anything else that restarts a connector on other terms —
  `make up` straight after a one-chain topology — leaves the document on the
  old ones for up to five minutes.

`make smoke-topology` reads what `up-topology` recorded and asserts the
selection: nothing else runs; every node publishes x402 terms on exactly its
chains; each relay node's information document carries a `toon` object that
says what that node's connector says — its own write address, the endpoint
and seal key the connector publishes, the price it charges for the route and
settlement on exactly the selected chains, compared with the connector's
answer and never with a literal, and named by node when it is missing or
disagrees; each relay node takes a paid write on each of them (gasless through
the Onboarder on EVM, sponsored by the node on Solana, over the circuit when
hidden) and its book moves by its price; a write to the second relay paid
through the hub lands; and every peering is open, collateralised and routed.
It does not exercise the apps behind the other nodes — the profile smokes do.

**What has been run.** Each of these was brought up cold and passed
`make smoke-topology` (2026-10-01):

| selection | what it showed |
|---|---|
| `NODES=relay CHAINS=evm` | a paid write from a 0-ETH wallet, through the Onboarder |
| `NODES="relay relay2 store" CHAINS=evm` | both peerings open on anvil; a write to `relay2` paid through the hub |
| `NODES="relay relay2" CHAINS=solana` | the same on Solana — started on top of the run above, with no `make clean` between |
| `NODES="relay relay2" HS=relay` | the hub paid over the real Anyone network on both chains, and `relay2` still reached through it |
| `NODES="relay provider" CHAINS=evm` | the directory publisher paying the hub from an EVM channel; Profile, Listings and Liveness accepted |

The information-document step (infra#51) was added on the relay image that
serves the document (2.3.1) and passed for `NODES=relay`, for
`NODES="relay relay2"` on `evm` and then on `solana`, and for
`NODES="relay relay2" HS=relay`, where the hub's document names its `.anyone`
endpoint. It also failed where it should: with `relay2-connector` stopped,
naming `relay2`; and for a hub brought back from hidden while its relay kept
running, whose document still named the `.anyone` endpoint — which is why
`up-topology` now restarts a relay behind a connector it replaces. On the same
image `make up-payments` + `make smoke-payments` and `make up` + `make smoke`
passed unchanged.

Not run as topology selections: `gas`, `anytoon`, `dealer`, `provider2`, and
`HS=relay2`. They are wired the same way and held to the committed files by
`scripts/lib/topology.test.mjs`, but nothing has paid through them in a
topology yet.

**What it changed for everyone else.** `make down`, `clean`, `ps` and `logs`
now sweep every profile (`--profile '*'`), so they see a topology and the
`hs` and `gateway` services too. The anvil seed mints 1000 USDC to the two
directory publishers' wallets (anvil accounts 1 and 2), `conf/anonrc`
publishes four more virtual ports (3290, 7110, 8899, 8900), and the
`open-peerings` job no longer insists on a hub. `make up`, `up-payments`,
`up-credentials` and `up-hs` start exactly the services they did.

The workload gateway and the hidden provider are not topology nodes; they
stay on `make up-gateway` and `make up-hs`.

### Hidden-service ingress (the `hs` profile) — opt-in, and it dials a real network

Everything above reaches every node at a published clearnet port. A hidden
node does not: its connector publishes no port at all and a `.anyone` hidden
service is the only way in. The `hs` profile rehearses exactly that, and
**nothing else in this sandbox depends on it**:

```bash
make up-hs      # = --profile full --profile hs; expect 2-5 min of bootstrapping
make smoke-m4   # Milestone 4: buy a lease from the HIDDEN PROVIDER over the circuit
make smoke-hs   # buy a credentials bundle from the anytoon node over ITS circuit
```

> **This is the one target that takes a third-party dependency.** `anon`
> bootstraps against the **real Anyone Protocol network** — there is no local
> directory authority and no private relay set, so `make up-hs` and
> `make smoke-m4` can both fail because that network had a bad day. **They are
> deliberately excluded from `make up` and `make smoke`**: a sandbox whose cold
> start can go red because someone else's relays are having a bad afternoon has
> stopped being a sandbox. `make smoke-m4` is a **rehearsal, not a gate** — run
> it on purpose, and expect it to be flaky in a way nothing else here is.
> (`anytoon` splits `make hs-e2e` out of `make local-e2e` for the same reason,
> and the connector repo keeps its hidden-service rehearsals off CI.)

Eight extra services, all `hs`-only. Three are the **anytoon ingress**:

| in `hs` | what |
|---|---|
| `anon` | the daemon, **v0.4.10.2 built from source-of-truth release binaries** (§6.6). Generates this sandbox's `.anyone` address, publishes a descriptor for it, forwards what arrives |
| `hs-ingress` | a four-port `socat` forwarder; owns the network namespace `anon` shares, so the daemon's config can name `127.0.0.1` (§6.6). Two of its ports are the issuer path and the chain; the other two are the hub and the relay, on the overlay, for the hidden provider (§6.8) |
| `anon-client` | a SOCKS5 proxy on `127.0.0.1:19050` — the buyer's way onto the network, and nothing else. On its own compose network with **no route to any other service** |

...and five are **the hidden provider** (`g.toon.provider-hs`, TOON_Network
Milestone 4), a third compute provider that is hidden the way spec §10 and
ADR 0008 define it — no published host, a connector reachable only at an
`.anyone` address, every workload's egress through `anon`, and its own
settlement RPC:

| in `hs` | what |
|---|---|
| `anon-hs` | its own daemon, and the only one here that does three jobs: the address in front of its connector, a **cookie-authenticated control port** (one `.anyone` address per lease), and the **SOCKS + transparent-proxy egress** its own process and its workloads leave through. `conf/anonrc-hs` |
| `hs-provider-ingress` | a one-port `socat` forwarder: `anvil`, which has to be resolved per connection because the daemon's config can only name an address that always parses (§6.8) |
| `provider-hs` | the provider app with `hidden = true` (`conf/provider-hs.toml`), workload ids **1200-1299**, SSH **46000-46099**, ports **47000-48599** — disjoint from the other two providers, which share this one host daemon |
| `provider-hs-connector` | its connector, terminating `g.toon.provider-hs.*`. **No `ports:` line at all**: one address, over a circuit |
| `directory-publisher-hs` | its relay-write payer, on **account index 3** (index 1 and 2 are the other two providers'), dialling through `anon` because a hidden provider's directory writes must not name this host |

**Nothing of the hidden provider is published to the host** — no client edge, no
control port, no SOCKS port. `make hs-address` prints both addresses; the hidden
provider's is the second one, and `http://<addr>.anyone/ilp` through
`127.0.0.1:19050` is the only way to its client edge:

```bash
make hs-address
curl --socks5-hostname 127.0.0.1:19050 http://<addr>.anyone/ilp   # its self-description
```

§6.8 is how it is put together. A tenant buying from it **pays it directly** —
there is no hub peering, by decision (spec Appendix A): it opens an x402 channel against that edge over its
own SOCKS proxy, and settles on `http://<addr>.anyone:8545`, the same `anvil`
this sandbox runs, on the same circuit. Account indices are the scarce thing
here: `0` is `make smoke`'s buyer, `1`/`2`/`3` are the three directory
publishers, `5` is `smoke-hs`'s own buyer (§6.6), and **`6` is
`smoke-m4`'s** — the hidden provider's one tenant. It is not seeded — no seed
job funds it, deliberately — so the smoke has the FiatToken's minter
(anvil-mnemonic index 21) mint it USDC over the circuit, and it pays its
channel deposit's gas from its own anvil ETH (`depositGas: 'self'`): the
Onboarder the hidden connector names is a private compose service no circuit
reaches.

What `make smoke-hs` proves, in one paid purchase from the anytoon node — no
hub and no Dealer in the path, so it pays anytoon's own price in ANYONE:

- the address is dialled through **`socks5h://`**, so the hostname is resolved
  by the daemon and never leaks into a local DNS query;
- the **chain RPC rides the same circuit** — `proxyRpc` is the TOON client's
  default and this script never turns it off, so the channel open, the deposit
  and the buyer's funding all leave through the proxy. `conf/anonrc`
  publishes anvil on **virtual port 8545 of the same address** to make that
  possible: reaching the connector inside the overlay while reading chain state
  on clearnet would broadcast the payer's settlement address, from the payer's
  own IP, either side of every paid request;
- the channel is an x402 channel in **ANYONE by Permit2**: ANYONE has no
  ERC-3009, so the buyer (account index 5, sent 1 ANYONE by anvil account 0
  over the circuit) approves Permit2 once and deposits through
  `Permit2DepositCollector`, both from its own anvil ETH
  (`depositGas: 'self'`) — the Onboarder pays for no Permit2 approval;
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

**`make smoke-m4` — Milestone 4's acceptance test** (TOON_Network #12 / #44,
`scripts/smoke-milestone4.mjs`) is the same kind of rehearsal with the same two
verdicts, against the **hidden provider** (§6.8). It follows the Milestone 1–3
smokes' structure and helpers (`scripts/lib/provider-smoke.mjs`, where
`provider-hs` is the third provider), and it dials the real network for
everything a tenant would: the connector, the chain RPC and the lease itself.
In order:

- **preflight, sandbox-side, nothing dialled on the overlay**: the `hs`
  services are up and the three daemons healthy; the address `anon-hs`
  generated is the one the rendered configs name and the one
  `provider-hs-connector` publishes as its own endpoint (read out of band on the
  compose network — a client dials what a node publishes); the routes are
  priced as `conf/provider-hs.toml` says, the free ones at 0 (no hub, no fee);
  and **the private-RPC gate**: the provider's `settlement_rpc_url`, its
  connector's two settlement RPCs and its publisher's `TOON_RPC_URL` are the
  sandbox chains (compose service names), never a public URL. The host's own
  public address is read here, on clearnet, to compare against later;
- **the directory**: the Profile on the relay has `hidden: true`, **no `host`**
  and a `connector_url` at the `.anyone` address; every Listing carries
  `["l","hidden:true","toon.network"]`, the two public providers' Listings carry
  none, and `#l = hidden:true` on the relay returns exactly the hidden
  provider's (the relay does the search); an unexpired Liveness says the full
  capacity;
- **the buyer, over the circuit**: with only the address and the proxy it reads
  the connector's x402 terms, is minted FiatToken USDC and opens an x402
  channel on EVM, paying its own deposit gas — every JSON-RPC call through the
  same `socks5h://` proxy — and the free availability route
  answers `would_run: true` spending no claim;
- **a paid spawn on the `.anyone` endpoint**: `access.host` is a **per-lease**
  `.anyone` address (the lease's own, not the connector's), no IP appears
  anywhere in the answer, and the free signed `status` returns the same access.
  On the host daemon the lease is **three containers** (`toon-<id>-egress`
  owning the namespace on `hs-egress` alone, `toon-<id>` sharing it,
  `toon-<id>-ingress` publishing the ports) in the `1200-1299` range; `anon-hs`
  holds the address as a detached service (`GETINFO onions/detached`); and the
  forwarder answers an SSH banner at the host port the address is forwarded to
  — so if the circuit fails next, this side has already been proven;
- **SSH to the per-lease address through the proxy** — `ssh -o
  ProxyCommand='nc -X 5 -x 127.0.0.1:19050 %h %p'`, OpenBSD `nc` handing the
  hostname to the proxy — with the tenant's key; the lease's published port
  answers at the same address;
- **from inside the workload**: a public what-is-my-IP service sees an `anon`
  exit, not this host's address (nor any address this host holds); `ip route`
  names nothing but the gateway and the egress subnet; ICMP to a clearnet
  address is unanswered; and a dial to the host at `anon.forward_host`
  (`172.17.0.1` — the very address this lease's own ports are forwarded to)
  carries nothing back. A bare TCP `connect()` proves nothing here, because the
  transparent proxy completes every handshake itself and only then refuses the
  private destination: the dial has to read bytes;
- **terminate**: `{ ended: termination }`; the daemon no longer holds the
  address, the address no longer answers through the proxy, no `toon-<id>*`
  container exists on the host daemon, and the next Liveness has the capacity
  back;
- **the book**: the hidden connector's voucher watermark on the tenant's channel grew
  by exactly the listing price, read out of band on the compose network (it
  publishes no host port).

Buys the 180 s `basic` tier rather than the 30 s `smoke` one: a fresh `.anyone`
address needs its descriptor published and fetched before the first circuit
builds, and that — not the image — is the slow part. Two to three minutes on a
good day; `TOON_M4_LISTING` overrides the tier. Exit `75` is reached only after
this side is proven, and a carriage failure **after** the spawn is not retried
(a second spawn is a second lease): the run terminates the lease if a circuit
still carries and otherwise leaves it to expire. Its buyer is account index 6
(above). Between attempts to reach the connector it **restarts the buyer's
proxy** (`anon-client`): a buyer that fetched the provider's descriptor before
`anon-hs` was last recreated keeps a stale one and waits 120 s for a circuit
that cannot build — see *Troubleshooting*.

`make up-hs` renders the anytoon connector's config with its `.anyone`
address (`scripts/hs-address.sh`) — **a client dials what a node publishes**
— and recreates `anytoon-connector` against it only after the `open-peerings`
job has finished, because the Dealer's peering is a `POST /peers`, which dials
what anytoon publishes, and the Dealer cannot dial a `.anyone` address. The
runtime peering keeps the compose name, so hub-routed purchases work on
`up-hs` too, and a later run of the job leaves that peering be.

**The address is disposable here.** It lives in the `anon-data` named volume:
`make down` keeps it (same address next `make up-hs`), `make clean` wipes it and
the next cold start publishes a new one. In a deployment that same wipe would
strand every buyer's configuration silently; in a sandbox it is expected.

### The Workload Gateway (the `gateway` profile)

A workload is reachable, so far, only at whichever provider is running it — a
host and a host port that provider chose, or for the hidden provider a
per-lease `.anyone` address and no host at all — and a Takeover (`make
smoke-m3`) moves it. **The Workload Gateway** (TOON_Network Milestones 5 and
6, ADR 0013, spec §12) is the party that owns the stable name: it serves every
workload handed over to it at

```
http://<canonical label>.gw.localhost:3280/      the plain listener, for curl and smokes
https://<canonical label>.gw.localhost:3443/     TLS, with the self-signed wildcard below
```

where the canonical label is the **lowercase, unpadded base32 of the workload
id** — 52 characters, derived and never assigned — and forwards each request
to whichever member of the workload's Standby Set is running it. It finds that
member by sending every member a plain `status` presenting the tenant's
**Gateway Grant** — not an event but a **value**, derived from the lease's
root secret for that member and for one moment (spec §6.5.1), which the
provider recomputes from the Continuation Token it already stores and admits
for `status` and nothing else. **The gateway holds no lease, pays nothing,
calls no paid route, signs nothing and publishes nothing** — it has no key of
its own at all — and its own connector terminates exactly one route, free: the
sealed packet below.

**Nothing on this path is published. Read that twice if you followed these
notes before Milestone 6.** There is no grant event, no kind `30438`, no
`--relay` flag, no relay write and no relay read on the tenant's account. The
tenant tells the gateway what to serve by **sealing one packet — a Gateway
Handover — to the gateway's own connector** (spec §12.1, ADR 0011), exactly as
it seals a Lease Request to a provider's, and the gateway admits it by asking
the members whether the grant works: being sent something is proof because
only the holder of the lease's root secret can derive a grant a provider will
take. If you are looking for the publish step, there is none, and the relay
holds nothing a tenant made — which is the point of the milestone (ADR 0016).

(Not the AR.IO gateway of §1 — `CONTEXT.md` never says "gateway" unqualified,
and neither does anything in this profile: the services are `workload-gateway`
and `workload-gateway-connector`, the conf is `conf/workload-gateway.conf`.)

```bash
make up-gateway                            # = --profile full --profile gateway (+ the gateway checkout)
make up-gateway COMPOSE_PROFILE=payments   # the payment layer + the gateway: no store or anytoon checkout
```

Two services on top of whatever profile you chose:

| in `gateway` | what |
|---|---|
| `workload-gateway` | the gateway itself, built from `../../gateway`. Domain `gw.localhost`; **no key**. It reads `ws://relay:7100` for exactly two things, both downstream of a handover it has admitted: the Provider Profiles of the members the handover names and the Takeovers that move a workload between them. HTTP on host **3280**, HTTPS on **3443** with `conf/workload-gateway-tls/`; its door for sealed handovers and withdrawals (`GATEWAY_HANDOVER_PORT`, 8081) reachable from its connector only, published on no host port; its SOCKS proxy for `.anyone` hosts pointed at the `hs` profile's `anon-client` (validated at startup; dialled only when a handover names a hidden member) |
| `workload-gateway-connector` | its own connector (ADR 0013), client edge **3260**, `conf/connector-workload-gateway.toml`: terminates **one free route**, `g.toon.workload-gateway.handover`, forwarded to the gateway's door at `/handover` — the Gateway Handover and the Gateway Withdrawal both ride it, the body's one key says which — and settles on Solana so a tenant can open a channel against it and pay it **directly**. No peers: the hub does not peer with it |

Here is the whole path by hand — four commands from a running stack to a URL,
one more to take it off again, and one to end the lease:

```bash
# 1. a workload with an HTTP port. `traefik/whoami` on 80, the `warm` tier (600 s),
#    paid through the hub from the smokes' buyer — exactly what the Milestone smokes do,
#    as one command. It MINTS THE LEASE'S ROOT SECRET and prints it with the workload id
#    and the access block; the same goes to .toon-client/spawn-<id>.json, mode 0600.
#    Nothing is signed. (`--direct` pays the provider's own edge instead; §8 says when.)
node scripts/spawn.mjs
#    a two-member Standby Set instead (the `make smoke-m3` shape; primary first):
node scripts/spawn.mjs --standby provider --standby provider2

# 2. the Gateway Handover: derive a grant PER MEMBER for an hour from now and SEAL it to
#    the gateway's connector, paid from the handover script's own wallet (account index
#    4, directly at :3260). spawn.mjs printed this exact command as `next`; the root
#    secret is read out of the file, never typed. Nothing is published.
node scripts/handover.mjs .toon-client/spawn-<id prefix>.json --expires-in 1h [--name whoami]
#    -> one JSON report: the handover as sealed, the route and the key it was sealed to,
#       `delivered: true`, and `hostnames` / `urls` — where the workload is now served.
#       The moment and the URLs are recorded back into the lease file for step 4.

# 3. open it. The gateway admitted the handover by asking the members, so it already
#    knows where the workload is; a 503 `not_resolved` means ask again.
curl http://<canonical label>.gw.localhost:3280/
curl http://whoami.gw.localhost:3280/                         # the --name, if it was free
curl --cacert conf/workload-gateway-tls/gw.localhost.crt https://<canonical label>.gw.localhost:3443/

# 3b. (optional) rotate: replace the lease's Continuation Token at BOTH members (spec §6.8).
#    A fresh root secret goes into the lease file, beside the old one until every member
#    has confirmed; each member gets one request naming only itself, paid through the hub
#    from account index 4 (`.toon-client/rotate-channels.json`). Free at the providers.
node scripts/rotate.mjs .toon-client/spawn-<id prefix>.json
#    -> { "rotated": true, "members": [ { "provider": …, "rotated": true }, … ] }, exit 0.
#    Every grant of the OLD root is now `bad_grant` at both members: within a cadence
#    (30 s) the URL answers 503 `member_unreachable` — the gateway stopped READING, not
#    only serving. Hand over again and the grants derive from the new root in the file:
node scripts/handover.mjs .toon-client/spawn-<id prefix>.json --expires-in 1h
curl -si http://<canonical label>.gw.localhost:3280/         # -> HTTP/1.1 200 again

# 4. take it off the gateway: a Gateway Withdrawal over the same route, bearing the grant
#    in force (the moment step 2 recorded). The same URL then answers the GATEWAY'S OWN
#    503 `no_grant` instead of the workload. The lease itself runs on, untouched.
node scripts/handover.mjs --withdraw .toon-client/spawn-<id prefix>.json
curl -si http://<canonical label>.gw.localhost:3280/         # -> HTTP/1.1 503, toon-gateway-reason: no_grant

# 5. done with it (free; otherwise it expires with the lease interval)
node scripts/spawn.mjs --terminate .toon-client/spawn-<id prefix>.json
```

`whoami` answers with the request it saw, which is the point of choosing it:
`Host` is the name **you** used, and `X-Forwarded-For`, `X-Forwarded-Proto`
(`https` on the 3443 listener) and `X-Forwarded-Host` are set (spec §12.5):

```
$ curl -i http://kwcrjzpok35a47emsfl63w5cmt2wii7cxjns57y3makzeligjilq.gw.localhost:3280/
HTTP/1.1 200 OK
Hostname: ac058da00dbb
GET / HTTP/1.1
Host: kwcrjzpok35a47emsfl63w5cmt2wii7cxjns57y3makzeligjilq.gw.localhost:3280
X-Forwarded-For: 172.20.0.1
X-Forwarded-Host: kwcrjzpok35a47emsfl63w5cmt2wii7cxjns57y3makzeligjilq.gw.localhost:3280
X-Forwarded-Proto: http
```

and the gateway's own log (`docker compose --profile gateway logs
workload-gateway`) says what it did: `holding a grant for workload … at
<label>, until <expiry>`, then `workload …: watching ws://relay:7100 for a
Takeover`. Those two lines **are** the admission round — a member answered
`status` on the strength of the grant, and the gateway kept where that answer
said the workload was running — which is why step 3 answers `200` first time
rather than `503 not_resolved`. It logs `workload … is running at
127.0.0.1:41016 on member b78bca6e…` only when that target CHANGES, so a
handover does not print it and a Takeover does. A withdrawal logs `withdrawn:
workload … is no longer served here. Its grant is untouched and works until
<expiry>`.

**Where the root secret lives, and what losing it costs.** `scripts/spawn.mjs`
mints one 32-byte root secret per lease and writes it as `root_secret` into
`.toon-client/spawn-<id>.json` — mode 0600, gitignored, gone with `make clean`
— and prints it once on stdout. **That file is the lease.** Everything that
controls the lease derives from the secret and nothing else does: the
Continuation Token each member stores (spec §6.1.1) and every Gateway Grant a
gateway is handed (§6.5.1). There is no tenant key any more, nothing is
registered anywhere, and the provider holds the token and nothing about who
minted it. **Lose the file and you have lost control of the lease, with
nothing to fall back on** — no party can read it, hand it over, withdraw it or
terminate it, and it runs until its interval ends. That is the deniability the
milestone buys, paid for in the only currency it could be; if a lease is worth
more than its ten minutes to you, copy the `root_secret` line somewhere you
will find it. The Nostr key the sandbox still generates beside the SSH key is
used for **nothing** on this path.

Renewal and rotation are the same act as handing over: run `handover.mjs`
again with a later `--expires-in` and the gateway holds a grant that outlives
the one it had — a handover that passes admission **replaces** what is held,
with no `created_at` weighed and no restart (spec §12.1). **A withdrawal ends
serving, not reading**: the withdrawn gateway keeps a working grant until the
moment the handover named and could still ask a member for `status` with it
(spec §6.5.1, §12.7). **Rotation ends reading too**: `node scripts/rotate.mjs
<lease.json>` runs the handover tool's `rotate`, which replaces every member's
token with one derived from a fresh root secret, so every grant of the old
root is refused `bad_grant` at once (spec §6.8, ADR 0018). The lease file
keeps both root secrets until every member has confirmed; a member that could
not be reached leaves the script exiting `1` with the set partly rotated —
each member still read with its own current token — and running it again
finishes the job with the same new root. A lost answer is recovered by the
tool asking `status` with the new token, never by resending. **`provider-hs`
rotates too** (spec §10, §12.8; TOON_Network #81): reached DIRECTLY over anon
through the buyer's own `anon-client` SOCKS proxy, not through the hub — the
same `.anyone` connector `smoke-hs.mjs` and `smoke-milestone4.mjs` already dial
for a spawn and a `status` — on account index 7 of the committed test phrase
(distinct from `smoke-hs`'s 5 and `smoke-milestone4`'s 6), a chain of its own
(`evm`, the sandbox chain `provider-hs` settles on). `<addr>.rotate` and
`<addr>.status` are free routes, so nothing is paid for and no channel opens
there — the account index is for identity only. A lost answer over the hidden
path is recovered exactly the same way, through `status` with the new token,
over the same connector. Keep `--expires-in` short anyway: rotation ends every grant of the old root
together, not one gateway's. A `--name` is first come, first served across every grant
in force on the gateway (spec §12.6): a name another workload's unexpired grant
holds is logged and dropped, and the canonical hostname still works; a
withdrawal frees the name at once, an expiry does not until another grant
claims it. What the gateway answers when it cannot forward is its own `503`
with a reason in the body and in a `toon-gateway-reason` header — `no_grant`,
`grant_expired`, `not_resolved`, `no_running_member`, `member_unreachable`,
`no_proxy` (spec §12.3) — never a dropped connection: `curl -si
http://anything.gw.localhost:3280/` shows the shape. What it answers a
**handover** it refuses is the same two-key error shape, in the script's
report under `failed`: `invalid_handover`, `grant_expired`, `rate_limited`
(any one provider is asked to admit at most `GATEWAY_ADMIT_PER_MINUTE` — six —
handovers a minute, so a developer re-running the command in a loop hits it),
`not_admitted` (no member took the grant: the wrong root secret, a member that
is not in the lease's Standby Set, or a lease that has ended), `no_proxy`,
`admission_failed` (spec §12.1); a withdrawal bearing the wrong grant is
`not_withdrawn` and changes nothing (§12.7).

**Two smokes walk this path in code.** `make smoke-m5` is the URL surviving a
Takeover with no tenant online, and `make smoke-m6` is the whole tenant path
with nothing signed and nothing published — including the delegated `status`
that works, the delegated `terminate` that does not, the withdrawal that leaves
the lease running, and a sweep of the relay for anything a tenant could have
put there; §2 describes each in full. Both run `scripts/handover.mjs` — this
same script, these same flags — rather than sealing a handover of their own,
so a walk-through that drifts from the smokes fails one of them.

**How `*.gw.localhost` resolves, and what to do when it does not.** Nothing is
added to anyone's DNS or `/etc/hosts`. A modern stub resolver answers every
name under `.localhost` with loopback — systemd-resolved does, and so do the
resolvers this README already relies on for `*.ar.localhost` — and a
52-character label is an ordinary label (the limit is 63). Check it the way
§2 checks the permaweb names:

```bash
getent hosts vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva.gw.localhost   # -> ::1 / 127.0.0.1
```

If that prints nothing (macOS's resolver, for one, does not special-case
subdomains of `localhost`), tell `curl` where the name lives instead of
telling the system — either pins the name without touching DNS, and the
gateway sees the same `Host`:

```bash
curl --resolve '<label>.gw.localhost:3280:127.0.0.1' http://<label>.gw.localhost:3280/
curl -H 'Host: <label>.gw.localhost' http://localhost:3280/
```

(A browser is fine either way: Chromium and Firefox resolve `*.localhost` to
loopback themselves.)

**The certificate.** `conf/workload-gateway-tls/gw.localhost.{crt,key}` is a
self-signed ECDSA P-256 certificate for `*.gw.localhost` (and `gw.localhost`),
valid ten years, committed like every other throwaway under `conf/` and
`keys/`. `curl --cacert conf/workload-gateway-tls/gw.localhost.crt https://…`
validates against it; a browser will warn once. It is not a CA and signs
nothing else. Regenerate it with the one command in §6.9.

**Sandbox-only, said plainly.** Two things here are true in this sandbox and
would be wrong anywhere else. One line of `conf/workload-gateway.conf`,
`GATEWAY_DIAL_REWRITE`, and it is now about the **workload** rather than about
the member: a running member's `access.host` is `127.0.0.1`, this host, where
the workloads are published, which from inside the container is the gateway
itself — so `127.0.0.1` is dialled at `host.docker.internal`. It is the
gateway's counterpart of the hidden publisher's `TOON_ENDPOINT_REWRITE`. A MEMBER is
reached where its own Profile says it is, here exactly as in a deployment: the
gateway seals `status` through the member's connector, addressed
`<ilp_address>.status` (TOON_Network#114), and `provider-connector:3000` is
that connector, on this network, under the name its Profile advertises. Until
#114 the gateway sent `status` as a plain `POST` that only the provider **app**
serves, and two more entries dialled each connector's name at its app; both are
gone. And the tenant **pays the gateway's connector directly** at `:3260`
rather than through the hub, the way `spawn.mjs --direct` pays a provider's
edge: the hub does not peer with it. §6.9 has the whole of both.

#### Reaching a hidden workload by hand

A Hidden Provider's lease has no host, only a per-lease `.anyone` address
(§6.8), and the gateway reaches one through its anon client — an ordinary
client of that address, which is what puts a hidden workload on a public URL
while its provider stays hidden (spec §12.8; the tenant's choice, stated in
the spec). **This is not part of `make up-gateway`** and no smoke depends on
it: the gateway's own tests cover the `.anyone` path in-process against a stub
proxy, and this recipe is how to see it for real, with the same two verdicts as
every `hs` rehearsal (a circuit that will not build is the network, not this
sandbox). Only the grant step changed with Milestone 6: it is a handover now,
and it is the one step of the recipe that publishes nothing because nothing on
the tenant's side does any more.

```bash
make up-hs                 # the three daemons, the hidden provider (§6.8); minutes
make up-gateway-hs         # the gateway on top; nothing is rendered for it
```

`up-gateway-hs` starts the two services with the rendered `hs` configs passed
again, so nothing already up is recreated. **There is no shortcut left in it**
(TOON_Network#114): the hidden provider's `status` goes to the `.anyone`
address its own Profile advertises, sealed to its `connector_seal_key`,
through `socks5h://anon-client:9050` — the same rule the lease is reached by.
Until #114 this recipe rendered one more `GATEWAY_DIAL_REWRITE` entry, sending
`<hidden provider address>.anyone:80` at `provider-hs:8080` on the compose
network, because the gateway sent `status` as a plain `POST` the hidden
connector does not serve. Both legs now go the same way, which is what §12.8
says they should.

```bash
# a lease on the hidden provider, over the circuit: scripts/smoke-milestone4.mjs step 3 is the
# reference — a buyer with the address and the proxy (account index 6, minted FiatToken USDC),
# a spawn with `ports: [{ container_port: 80 }]` and an HTTP image, the request built by
# `tokenRequest(rootSecret, 'spawn', …)` from scripts/lib/provider-smoke.mjs. Mint the root
# secret with `newRootSecret()`; keep it and the workload id — the handover below needs both.
#
# the handover, naming the hidden provider as the one member. The lease was spawned by hand,
# so there is no lease file: the values are flags, and the root secret is the environment's
TOON_ROOT_SECRET=<64 hex> node scripts/handover.mjs --workload <id> --standby provider-hs \
    --http-port 80 --ports 80 --expires-in 1h
#
# then the URL, and the gateway's log showing the dial through the proxy:
curl http://<canonical label>.gw.localhost:3280/
docker compose --profile hs --profile gateway logs --tail 20 workload-gateway
#
# and off again, bearing the moment the handover's report named as `expires_at`:
TOON_ROOT_SECRET=<64 hex> node scripts/handover.mjs --withdraw --workload <id> --standby provider-hs \
    --expires-at <that expires_at>
```

A first `curl` can take a while and may answer `503 member_unreachable` once
or twice: a fresh per-lease address needs its descriptor published and
fetched before the first circuit builds, exactly as `smoke-m4` waits for SSH.
`docker compose --profile hs restart anon-client` is the same remedy as there.
The admission round itself does not cross the circuit — the hidden provider's
`status` is the rewritten, out-of-band dial above — so a handover naming
`provider-hs` is admitted as quickly as one naming a public member.

> **Driving compose by hand:** every service carries a profile, so a bare
> `docker compose …` in `sandbox/` selects nothing and does nothing. Pass the
> profile (`docker compose --profile full ps -a`) or export
> `COMPOSE_PROFILES=full` in your shell — or drop it in a local `sandbox/.env`
> once. A `--profile` flag on the command line replaces `COMPOSE_PROFILES`
> rather than adding to it. The `make` targets always pass one for you.

## 3. The tour: what's running

| service | what | host port |
|---|---|---|
| `solana-validator` | agave test validator with AR.IO's five Anchor programs + Metaplex Core + solana-foundation's **payment-channels** (`CHNLx…`, every Solana channel here, §6.10) + mainnet's **p-token** at the SPL Token id preloaded at genesis, 2MB NameRegistry account preloaded | 8899 (RPC), 8900 (WS) |
| `anvil` | local EVM chain (chain-id 31337), seeded by its own entrypoint from the sandbox's own Foundry project (`./contracts`): the sandbox's ERC-2771 extras, **the x402 layer** — x402's batch-settlement contracts, Permit2 and Multicall3 at their production addresses, and Circle's FiatToken as an ERC-3009 USDC, the one USDC every EVM node settles in (§6.10) — **the ANYONE asset layer** (real mainnet ANYONE + WETH9 bytecode, real Uniswap v3, two seeded pools with primed oracles, which the Dealer quotes ANYONE off, §6.7), and every connector's EVM key funded in ETH and FiatToken (the Dealer's in ANYONE, anytoon's in ETH alone) | 8545 |
| `arlocal` | fake Arweave node (the gateway's "trusted node") | 1984 |
| `envoy` + `core` + `redis` | AR.IO gateway (ar-io-node r83; service definitions vendored, images pinned to r83's SHAs — no ar-io-node checkout needed) | 3000 (gateway), 3004 (core direct) |
| `upload-service` + `fulfillment-service` + `upload-service-pg` + `localstack` | Turbo bundler stack | 5100 (upload), 4566 (localstack) |
| `onboarder` | the **Onboarder**: a stock x402 facilitator (the published `@x402/core` + `@x402/evm`), built from `../onboarder`: `batch-settlement` on `eip155:31337`, relays a client's gasless deposit and pays the gas; offers no `receiverAuthorizer` (§6.10). `make smoke-x402` | 4022 (`/supported`, `/verify`, `/settle`, `/health`) |
| `relay-connector` | TOON ILP connector — the HUB (`g.toon.relay`, forwards `g.toon.store` / `g.toon.gastation` / `g.toon.provider*` / `g.anyone.credentials*` over runtime peerings) | 3200 (client edge) |
| `store-connector` | TOON connector terminating `g.toon.store` | 3210 (client edge) |
| `gas-connector` | TOON connector terminating `g.toon.gastation` | 3220 (client edge) |
| `anytoon-connector` | TOON connector terminating `g.anyone.credentials` (0.04 ANYONE, through the claim minter) and `.keys` (free, scoped to the issuer's `/v1/keys/`), paid in ANYONE on anvil by Permit2 deposits. Binds nothing for the Dealer, which pays it as a client (§6.7) | 3230 (client edge) |
| `dealer-connector` | **the Dealer** (`g.toon.dealer`, no app): paid µUSDC by the hub over Solana at par, pays anytoon ANYONE from its own x402 channel on anvil at the live TWAP, and carries the FX risk (§6.7). `full` + `credentials` | 3270 (client edge, `GET /rates`) |
| `provider-connector` | TOON connector terminating `g.toon.provider.*` — spawn/extend per listing version (paid), availability/status/terminate (free) | 3240 (client edge) |
| `provider` | the TOON_Network compute provider (`toon-provider`, built from the provider sibling checkout); runs workloads on the HOST daemon through the mounted socket, as `toon-<id>` containers with SSH published at 40000+ (handler 8080 unpublished). Sells `basic` (180 s Lease Interval), the sandbox-only `smoke` (30 s), `warm` (600 s, `standby_price = 400` — the tier that sells Warm Standbys, spec §7) and spec Appendix A.1's `ci` (600 s, `capabilities = ["docker"]`: each lease of it also gets a privileged `toon-<id>-dind` sidecar, a `toon-<id>-run` / `toon-<id>-docker` volume pair, a `toon-<id>-net` network and a `toon.slice/toon-<id>.slice` cgroup on the host, all removed with the lease) — `make smoke-m1`, `make smoke-m2`, `make smoke-m3` (with `provider2`) and `make smoke-ci` are the acceptance tests. Reads TOON-store parts from the gateway (`gateway_url_pattern` in `conf/provider.toml`) and keeps verified blobs on its volume | — |
| `directory-publisher` | the compute provider's payer for RELAY WRITES (`provider/tools/publisher`): the Profile, Listings and Liveness are paid `g.toon.relay` packets (TOON_Network ADR 0007), and this sidecar holds the x402 channel that buys them, so the provider's Nostr key never shares a process with money (8081 unpublished) | — |
| `provider2-connector` | TOON connector terminating `g.toon.provider2.*` — the SECOND provider's, on its own peering with the hub. Same rows as the first, plus the two the `warm` tier prices: `.standby` and `.standby.extend` at 400 (spec §7) | 3250 (client edge) |
| `provider2` | the SECOND compute provider (TOON_Network #34, Milestone 3), the same image and the same host daemon as `provider`, with its own config (`conf/provider2.toml`), its own Nostr identity, its own lease table and **disjoint ranges**: workload ids 1100–1199, SSH at 43000+, port blocks from 44000. A Standby Set has to span two PROVIDERS — a Warm Standby bought from the provider already running the primary is no standby — so the sandbox runs a second one, whole. Sells `basic`, `smoke` and `warm` (600 s, `standby_price = 400`) | — |
| `directory-publisher2` | the second provider's payer for relay writes, on ACCOUNT INDEX 2 of the test phrase (the first is on 1): its own wallet, its own channel, its own watermark (8081 unpublished) | — |
| `relay` | TOON Nostr relay (paid writes via connector only; write port 3100 unpublished). A plain `GET /` asked with `Accept: application/nostr+json` answers the relay information document, whose `toon` object says where a write is paid, as read off `relay-connector` (§2) | 7100 (free NIP-01 reads, and the information document) |
| `relay2` + `relay2-connector` | **the second relay node**, only in a topology that names it (`make up-topology NODES="relay relay2"`, §2): its own relay identity, its own connector terminating `g.toon.relay2*`, peered to the hub when both run. Its information document names `g.toon.relay2` at `relay2-connector`, never the hub | 3290 (client edge), 7110 (free reads, and the information document) |
| `store` | paid Arweave blob store, kind:5094 + kind:5095 ArNS (op=prepare + brokered op=buy) — built from the store sibling checkout (paid handler 3300 unpublished) | 3300 → container 3400 (free /health) |
| `gas-station` | pays gas: kind:5096 (Solana) + kind:5098 (EVM ERC-2771 meta-tx relay on anvil) (paid handler 3300 unpublished) | 3400 (free /describe + /health) |
| `issuer` | the **upstream** `anyone-protocol/credentials-issuer`, unmodified — blind-signs credential bundles, refuses without a signed `X-Payment-Claim` | none (unpublished) |
| `claim-minter` | turns the connector's `X-TOON-Payer` attribution into that signed claim; proxies `POST /v1/bundles` and nothing else. Built from the anytoon sibling checkout | none (unpublished) |
| `issuer-postgres`, `issuer-redis` | the issuer's own datastores (issuance records, idempotency, rate limits) | none (unpublished) |
| `swap-driver` | trades both Uniswap pools every 15s so the ANYONE TWAP the Dealer converts at stays live and bounded (§6.7). `full` + `credentials`, never `payments` | none |
| `seed-solana`, `seed-gateway-block`, `seed-toon-solana`, `open-peerings`, `issuer-keys`, `issuer-migrate` | one-shot idempotent init jobs | — |

### Payment topology

```
smoke test / any client (host)
   │ POST /ilp (paid) — a voucher on its own x402 channel: Solana (sponsored
   │                    by the hub) or EVM (deposited through the Onboarder)
   ▼                                        ┌──────────────────────────────┐
relay-connector :3200  ── g.toon.relay ──▶ relay:3100/write ──▶ relay reads┘
   │        (hub)      ── g.toon.relay.ephemeral ─▶ relay:3100/write-ephemeral
   │                      (terminated here; ws://localhost:7100 reads free)
   ├─ g.toon.store ──[peering relay-store]──▶ store-connector :3210
   │                                            └─▶ store:3300/store (kind:5094/5095)
   ├─ g.toon.gastation ──[peering relay-gas]──▶ gas-connector :3220
   │                                            └─▶ gas-station:3300/gas (kind:5096 + 5098)
   ├─ g.toon.provider.* ──[peering relay-provider]──▶ provider-connector :3240
   │                                               └─▶ provider:8080/listings/<l>/v<n>/spawn … ──▶ toon-<id> on the host
   ├─ g.toon.provider2.* ─[peering relay-provider2]─▶ provider2-connector :3250
   │                                               └─▶ provider2:8080/listings/<l>/v<n>/spawn … ──▶ toon-<id> on the host
   └─ g.anyone.credentials* ─[peering relay-dealer]─▶ dealer-connector :3270  (µUSDC in)
                  ANYONE out, at the live TWAP ─[dealer-anytoon, as a CLIENT]─▶ anytoon-connector :3230
                                                   └─▶ claim-minter:8080 ──▶ issuer:3000 (keys: issuer:3000/v1/keys/)
```

**Every channel is an x402 `batch-settlement` channel** (connector ADR 0075),
and every leg the hub is on holds 6-decimal USDC, so nothing converts there;
the one leg that converts is the Dealer's (§6.7):

- the **client leg** is the buyer's own channel toward the hub — on the
  validator a `payment-channels` account it opens by posting a payer-signed
  `open` to the hub's sponsor endpoint (the hub pays the rent), on anvil an
  `x402BatchSettlement` channel it deposits into through the Onboarder the
  hub names (§6.10);
- **each peering** is two one-way channels on the validator, one opened by
  each node's own `POST /peers` (§6.2): the hub's channel toward the payee
  carries every forwarded packet's voucher, the payee's small channel back is
  the other half and carries nothing. A payee is paid exactly what the hub
  was paid for the packet less its flat 100 fee.
- **the Dealer's leg to anytoon** is ONE channel, in ANYONE on anvil, opened
  by the Dealer's `POST /peers` alone (a Permit2 deposit): anytoon binds
  nothing, so the Dealer's vouchers arrive there as a client's and the claim
  minter is told who paid (infra ADR 0003).

A voucher never says what it is denominated in and never had to: it is
denominated by the channel it is written against.

- Connector client edges: hub **3200**, store **3210**, gas **3220**,
  anytoon **3230**, provider **3240**, provider2 **3250**, Dealer **3270**
  (all `GET /ilp` self-describing; the operator surface rides the same port).
  **The seven peered connectors publish their compose-network names** (`http://relay-connector:3000/ilp` …) at
  `GET /ilp`, because a peer dials the endpoint a node publishes and every
  container can reach that name. A client on the host cannot, so host-run
  clients are handed `hostFetch()` from `scripts/lib/sandbox-endpoints.mjs`,
  which moves exactly those origins (and the Onboarder's `http://onboarder:4022`)
  onto their published ports; `HOST_REWRITE` is the same map as the
  `TOON_ENDPOINT_REWRITE` a provider tool takes. Your own client needs the
  same when it runs on the host: `fetch: hostFetch()` in `ToonClient.create`.
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
  (container 3400), gas-station **:3400** (`/describe` + `/health`), and every
  node's `GET /ilp`.

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
committed addresses: x402's `x402BatchSettlement` `0x4020…0003` and its two
deposit collectors, Permit2 and Multicall3 at their production addresses, the
FiatToken USDC `0x0A86…5b58` (named "USDC", version "2"; its minter is
anvil-mnemonic index 21) — all `scripts/seed-x402.sh`, §6.10 — plus the
sandbox's kind:5098 extras
(`contracts/DeploySandboxExtras.s.sol`, anvil account 9 nonces 0/1): OZ
v5.5.0 `ERC2771Forwarder("ToonSandboxForwarder")` at
`0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35` and the ERC-2771-aware
`SandboxTokenNetworkProbe` at `0xA15BB66138824a1c7167f5E85b957d04Dd34E468`.

**Paid packets** — hand a paid ILP packet to the hub at
`http://localhost:3200`:

```js
import { ToonClient } from '@toon-protocol/client';
import { hostFetch } from './scripts/lib/sandbox-endpoints.mjs';
const client = await ToonClient.create({
  connector: 'http://localhost:3200',                       // the hub
  mnemonic: 'test test test test test test test test test test test junk',
  chain: 'solana', rpcUrl: 'http://127.0.0.1:8899',          // seed-toon-solana funds index 0
  channelStore: '.toon-client/channels.json',
  deposit: 10_000_000n,                                     // 10 USDC; the hub opens nothing below 1
  fetch: hostFetch(),                                       // the hub publishes relay-connector:3000
});
await client.channel.open();                                // a sponsored payment-channels open
await client.send('g.toon.relay', { body: JSON.stringify({ event }) });
// forwarded routes need sealTo = the TERMINATING connector's edge:
await client.send('g.toon.store', { body }, { sealTo: 'http://localhost:3210' });
```

On EVM, `chain: 'evm'` with `rpcUrl: 'http://localhost:8545'` deposits into
`x402BatchSettlement` through the Onboarder the hub names (§6.10); a wallet
needs FiatToken USDC for it (mint from index 21, as `onboarder/smoke.mjs`
does) and no ETH.

NIP-90 jobs (the store's kinds 5094/5095, the gas station's 5096/5098) ride
the same mechanism — `scripts/smoke-toon.mjs` shows `sendJob` /
`buildJobEvent` usage for every kind, including the full brokered ArNS
ceremony (`buyArnsNameWithNewAnt`).

**A lease route's body: two shapes, and the wrong one is billed** — the five
routes that act on a lease under the tenant's authority take the spec §6.1
Lease Request envelope, and the two extension routes take their content BARE:

```js
import { extendBody, checkLeaseBody, tokenRequest } from './lib/lease-body.mjs'; // and provider-smoke.mjs
await send(statusRoute, { request: tokenRequest(rootSecret, 'status', { workload_id }) });
await send(extendRoute, extendBody(workload_id));   // { "workload_id": "…" }, and nothing else
```

An extension presents no Continuation Token — paying the route is its whole
authority, and any payer may extend any lease (spec §6.3, ADR 0005, ADR 0025)
— so there is no envelope to fill in. **Wrapping one is `invalid_request` at
the route's full price**: a connector collects before the provider app reads a
byte (ADR 0003) and nothing is refunded, which on `basic` is 1000 µUSDC for an
answer that bought nothing (TOON_Network#115). Every script here sends through
`checkLeaseBody(route, body)`, which refuses a mismatched shape before there is
a packet; `make smoke-extend-shape` measures both outcomes on the connector's
own book, and `scripts/lib/lease-body.mjs` is the whole of the rule.

**Ask a node what it serves** — `curl http://localhost:3400/describe` (gas
station) lists its kinds, phases, chains, and per-phase params; `/health`
answers liveness. This self-describing pattern is worth copying in your own
app.

**Buy Anyone credentials** — through the hub, from the same client that pays
the relay. The key document first (210 µUSDC through the hub; free at
anytoon's own edge, `http://localhost:3230`), then a bundle (11000), both
sealed to anytoon, which terminates them:

```js
const anytoon = 'http://localhost:3230';
const keys = await client.send('g.anyone.credentials.keys', { method: 'GET', target: 'current' }, { sealTo: anytoon });
const { epoch_id } = keys.json();
const bundle = await client.send('g.anyone.credentials', {
  method: 'POST', target: 'v1/bundles', headers: { 'idempotency-key': crypto.randomUUID() },
  body: { epoch: epoch_id, blinded_blanks /* 10 × 256-byte RSABSSA blinded messages, base64 */ },
}, { sealTo: anytoon });
```

`smoke-toon.mjs` step 4c is the working version, including what it asserts on
each node's book (§6.7).

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
   voucher watermark on your client's channel grows by `price` (assert it
   over the operator surface the way `smoke-toon.mjs` does, with the
   committed bearer tokens).

### Level 2 — your own connector, peered to the hub (the production shape)

This is how the store, the gas station and the providers actually run, and
how you'd deploy for real (each app ships with its own connector; peerings
carry the payment). **A peering is two one-way x402 channels, one opened by
each side** (connector ADR 0075), with fresh salts — so no config file names
a channel, and the sandbox establishes every peering at runtime through each
node's own signed `POST /peers` (§6.2). `store-connector` is the template:

> **The most recent worked example is the SECOND compute provider**
> (TOON_Network #34): `provider2` + `provider2-connector` +
> `directory-publisher2`. Adding a SECOND instance of an app you already run
> costs two things beyond the list: a payer of its own (its directory
> publisher pays from account index 2, because two payers on one wallet share
> one channel's watermark and the loser has every later voucher refused),
> and disjoint host resources — the two providers share this host's Docker
> daemon, so their workload id, SSH and published-port ranges must not
> overlap.

1. **Keys** — extend `scripts/gen-toon-keys.sh` (or follow its pattern) to
   mint your connector's set: `signer.key` (random ILP identity, holds no
   money), `settlement.key` + `settlement-solana.key` (the identities value
   moves against, and the keys that sign your vouchers — the sandbox derives
   them from anvil's public test mnemonic at fixed indices), and operator
   credentials (`operator-send.key`, its public half in
   `operator-write.keys`, and `operator-bearer.token`). Place them under
   `keys/toon/` (world-readable is fine here; the connector image runs as uid
   10001 and mounts key dirs read-only).
2. **Your connector's toml** — copy `conf/connector-store.toml`: the two
   x402 settlement tables exactly as they are (FiatToken USDC on anvil with
   `asset_eip712_name`/`version`, `asset_transfer_method` and the Onboarder
   as `facilitator_url`; the mock mint on the validator with
   `min_sponsored_deposit` — startup is fail-closed on both), `peer_expose =
   "http"` and `peer_allow_plaintext_endpoints = true`, a `[node]`
   `http_endpoint` at your **compose-network name** (`http://myapp-connector:3000/ilp`)
   with **no** `btp_endpoint` (`POST /peers` prefers BTP wherever a node
   publishes it), the `[operator]` block, and your terminating `[[routes]]`
   row (`prefix = "g.toon.myapp"`, `handler_url` at your app, price = what
   arrives). No `[[peers]]` and no channel rows.
3. **The peering and the hub's routes** — add your node to
   `scripts/peerings.mjs`: a `NODES` entry (its compose URL and host port)
   and a `PEERINGS` row (`id`, `payer: 'relay-connector'`, `payee`, `chain:
   'solana'`, `fee: 100`) whose `routes` are the hub's forwarding rows —
   **hub price = your price + fee**. `npm test` holds that arithmetic against
   your committed toml and fails if you terminate a route the hub does not
   forward (`scripts/lib/peering-plan.test.mjs`); nothing in the connector
   checks it.
4. **Fund** — add your Solana settlement key to `seed-toon-solana.mjs` (SOL
   + mock USDC: a connector refuses to boot on a key with no lamports, and
   its sponsor endpoint refuses to open into an ATA that does not exist) and
   your EVM one to `scripts/seed-evm-nodes.sh`.
5. **Compose** — add your connector (another instance of the same pinned
   connector image, new client-edge host port outside the taken set) and
   your app; gate them on `anvil`, `solana-validator` and `seed-toon-solana`
   like `store-connector` is, and add your connector to `relay-connector`'s
   `depends_on` (`required: false` if a profile leaves it out), so the
   `open-peerings` job, which waits on the hub, finds you serving.
6. **Drive + assert** — `make up` (or `docker compose run --rm open-peerings`
   on a running stack: it is idempotent) opens both channels and writes the
   routes. Forwarded routes need `sealTo: 'http://localhost:<your-edge>'`.
   Prove your leg the way `smoke-toon.mjs` proves the store's: the hub's
   watermark on the buyer's channel grows by the hub price, and yours on the
   hub's channel toward you — found on the hub's `GET /channels` by your
   Solana key — by your price.

> **If your app needs to know WHO PAID** (`X-TOON-Payer`): a peer-role
> arrival carries no payer, by design (connector ADR 0040), and a voucher
> whose signer your node has bound to a peering is a peer's. A node that must
> attribute is paid by its upstream as a CLIENT instead: it binds nothing, and
> only the upstream writes `POST /peers` — the shape the Dealer and anytoon
> have (`payeeBinds: false` in `scripts/peerings.mjs`,
> `docs/adr/0003-the-anyone-flip-lives-in-a-dealer-node.md`).
> Most apps do not need this: if yours never reads the header, take the peer
> role.

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
  gas station's fee payer, **the smoke's buyer** and the directory
  publishers. The payers' ATAs are not optional: `@toon-protocol/client`
  opens the channel (a payer-signed `payment-channels` `open` the receiving
  node co-signs at its sponsor endpoint) but never creates the payer's ATA —
  an unfunded buyer is a `ChannelFundingError` at smoke step 1. It first
  checks `payment-channels` is loaded, since no connector boots without it.
- **the anvil entrypoint** (not a separate service) seeds the EVM layer
  **inside** the anvil container and **before** its healthcheck can pass, in
  four stages, from the sandbox's own Foundry project (`./contracts`, mounted
  read-write at `/contracts`; `forge-std` and OpenZeppelin are fetched into
  `contracts/lib` at pinned revisions on the first start, and no connector
  checkout is involved): `contracts/DeploySandboxExtras.s.sol` (the kind:5098
  forwarder and probe), `scripts/seed-x402.sh` (the x402 contracts and the
  FiatToken, §6.10), `scripts/seed-toon-evm-amm.sh` (the ANYONE asset layer:
  mainnet ANYONE and WETH9 bytecode, the official Uniswap v3 factory, two
  pools with full-range liquidity and 900 seconds of primed oracle history,
  §6.7) and `scripts/seed-evm-nodes.sh` (every USDC connector's EVM
  settlement key funded with 100 ETH + 1000 FiatToken USDC, anytoon's with
  100 ETH, the Dealer's with 100 ETH + 100 ANYONE from anvil account 0, and
  the gas station's kind:5098 relayer with ETH). The healthcheck gates on the last write of each stage,
  ending on the relayer's balance, so a healthy anvil is a funded one.
- **`open-peerings`** — after the hub is healthy, every peering in
  `scripts/peerings.mjs` that this profile runs, the way an operator would,
  through each node's own RFC 9421-signed operator writes: `POST /peers` on
  the payee naming the payer (binding the payer's voucher signer and opening
  the payee's own 1 USDC channel back), `POST /peers` on the payer naming the
  payee (opening the channel that carries traffic, 100 USDC, through the
  payee's sponsor endpoint), a `POST /channels/:id/fund` top-up for any
  shortfall, the channel read back off the validator — owner
  `payment-channels`, Open, paid and signed for by the hub, payable to the
  payee, in the mock mint, holding the target — and `POST /routes/peers` for
  each forwarding row (§6.2). Re-run on a healthy stack it finds every
  channel (`"status":"found"`), opens nothing, refills each channel's
  headroom by what has been spent from it since, and upserts the same routes;
  a peering whose far side the profile does not run is skipped by name. The
  Dealer's peering to anytoon is **one-sided** (`payeeBinds: false`): only
  the Dealer writes `POST /peers`, its channel is on anvil in ANYONE with a
  10 ANYONE target, and it is read back off `x402BatchSettlement` (§6.7).
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

The connectors gate on anvil and the Solana seed, and their startup is
fail-closed on BOTH settlement backends: a connector reads each chain at boot
and refuses, by name, one without `x402BatchSettlement` (EVM) or
`payment-channels` (Solana), a token whose `decimals()` disagree, a FiatToken
whose EIP-712 domain does not reproduce the configured name/version, and a
Solana key with no lamports — so healthy connectors are themselves the "x402
layer deployed" proof.

### 6.2 Peering mechanism

**A peering is two one-way x402 channels, one opened by each side** (connector
ADR 0075), and it is established from a URL (ADR 0058): each node's signed
`POST /peers` reads the other's self-description, opens its OWN outbound
channel toward it — on Solana by posting a payer-signed `open` to the other's
sponsor endpoint, so the other holds the `payee` and `rent_payer` seats — and
binds the other's channel by the voucher signer it publishes. An x402 channel
is opened with a fresh salt, so its id is a fact of the run and no config
names it: the peerings, and the hub's forwarding routes over them, live in
each node's runtime table (`runtime-peers.json` under its state volume) and
survive a restart. A config route may only name a peer the same file declares
(ADR 0034), so the hub's forwarding rows are runtime too — written by
`POST /routes/peers`. The `open-peerings` init job (§6.1) makes all of those
writes from one table, `scripts/peerings.mjs`; `GET /peers`, `GET /channels`
and `GET /routes/peers` on the hub show them live.

The payee goes first, so the hub's very first voucher already arrives in the
**peer** role. Every peering of the hub's settles on Solana, in the mock USDC
mint: the hub's channel toward each payee holds 100 USDC and carries every
forwarded packet's voucher; the payee's channel back holds 1 USDC (every
node's `min_sponsored_deposit`) and carries nothing. The exception is the
Dealer's to anytoon, which is one channel that only the Dealer opens, so that
its vouchers arrive as a **client**'s (§6.7).

**Every node that peers publishes its compose-network name** at `GET /ilp`
(`http://store-connector:3000/ilp`, …): `POST /peers` dials exactly the
endpoints the other node publishes, BTP first where one is published — which
is why none of them publishes a `btp_endpoint` — and a host loopback URL
would be unreachable from the other container. All six that are dialled as
peers set `peer_expose = "http"` and `peer_allow_plaintext_endpoints = true`;
anytoon, which is only ever paid as a client, sets neither. The cost falls on
host-run clients, which get `hostFetch()` (§3).

Fee arithmetic: the hub collects `price`, retains the peering's `fee`, and
forwards the rest; each payee terminates at exactly the forwarded amount —
store `{base=1000, per_kib=10}` behind hub `{base=1100, per_kib=10}`, gas
`1000` behind `1100`, each provider route at its listing price behind listing
price + 100, and the free provider routes at 0 behind **100** (a hub row at 0
would still subtract its fee from what the packet carries and refuse every
honest request `R01`), and the two credentials rows at the Dealer's 10900 and
110 behind 11000 and 210. Nothing in the connector checks this; `npm test` does
(`scripts/lib/peering-plan.test.mjs` holds every row in `scripts/peerings.mjs`
to the payee's committed `[[routes]]` — or, for the Dealer, to its own rows
in the table — and fails on a payee route its payer does not forward; the
Dealer's rows, which convert, are held to anytoon's prices at the worst rate
instead, §6.7).

A voucher is journaled in ONE book whichever role it arrived in, so a payee's
`GET /claims` cannot say whether a crossing came from the peering or from a
paying client — the channel does. The smokes read a payee's takings as its
watermark on the hub's channel toward it, found on the hub's own
`GET /channels` (the outbound row whose counterparty is the payee's Solana
key; `peeringChannel()` in `scripts/lib/provider-smoke.mjs`).

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
  `settlement-solana.key` (anvil public-mnemonic indices 24-26 + 28-32 /
  34-42 — derived so they are the same on every machine: 24/34 the hub,
  25/35 the store, 26/36 the gas station, 28/37 anytoon (whose Solana key
  nothing reads), 29/38 the provider connector, 30/39 the second provider's,
  31/40 the hidden provider's, 41 the Workload Gateway connector's Solana
  key, 32/42 the Dealer's), the kind:5098
  relayer `gas-evm-relayer.key` (index 27, embedded in
  `conf/gas-station.conf`), operator credentials, the deterministic
  mock-USDC mint keypairs, and the app keypairs embedded in `conf/*.conf`
  (gas station's Solana fee payer, store's Turbo signer, store's kind:5095
  ArNS DVM payer `arns-dvm.json`). `scripts/gen-toon-keys.sh` documents and
  regenerates the lot. The connector image runs as uid 10001 and mounts key
  dirs read-only; its `/app/state` (claim journal, outbound-channel journal,
  runtime peer table) is a **named volume** so it inherits uid-10001
  ownership and dies with `make clean` (a stale journal against a wiped chain
  satisfies payment assertions vacuously). The operator keys are what the
  `open-peerings` job signs with (`scripts/lib/operator-write.mjs`, held byte
  for byte to the connector's own `sign-write.sh` by its unit test).

`artifacts/` (program `.so` dumps, the 2MB NameRegistry genesis account, and
the EVM bytecode blobs under `artifacts/evm/`) is committed for convenience
but fully regenerable:
`./scripts/fetch-artifacts.sh` re-dumps the five AR.IO programs from devnet
and mpl_core, payment-channels (`payment_channels.so`, §6.10) and p-token
(`p_token.so`) from mainnet-beta using the pinned validator image (no Solana
toolchain needed), and `node scripts/gen-genesis.mjs` rebuilds the genesis
account (and keys, if missing — regenerating keys requires updating the
admin pubkey in `docker-compose.yml`). The program ids are the
staging/devnet ids (= `@ar.io/sdk` `DEVNET_PROGRAM_IDS`) — they cannot be
changed, the binaries carry `declare_id!` for them. Refresh the dumps only
together with an `@ar.io/sdk` / `@ar.io/solana-contracts` upgrade.

`artifacts/evm/` holds the three blobs the EVM asset layer places on anvil —
ANYONE's and WETH9's mainnet RUNTIME bytecode, and the official Uniswap v3
factory's CREATION bytecode — and the x402 layer's eight, copied from Base
Sepolia (§6.10). Those are the only artifacts here that come from
a chain this sandbox does not run, which is exactly why they are committed:
`make up` must never need an internet connection. `./scripts/fetch-artifacts.sh`
re-dumps them (`MAINNET_RPC` and `BASE_SEPOLIA_RPC` override the endpoints) and
`artifacts/evm/README.md` explains the provenance, the runtime-vs-creation
split, and how to check the factory blob against mainnet's deployed one.

`artifacts/p_token.so` is mainnet-beta's Token program (p-token), the
connector's own pinned fixture (`crates/connector-settlement-solana/fixtures/p_token.so`
at release 2026.09.29.1). The validator loads it over the bundled SPL Token at
`TokenkegQ…`, because the bundled one refuses the `Batch` a two-payout
`distribute` sends when a channel closes (connector#1358). TOON's own
`payment_channel.so` is gone with the program (connector ADR 0075).

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
nothing without an Ed25519-signed `X-Payment-Claim`. Its connector,
`anytoon-connector`, is paid in ANYONE, and its hub-routed customer is the
Dealer (§6.7). The chain:

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
> The Dealer is not a fourth site: it quotes a static µUSDC price with an FX
> buffer, held to this price at the worst rate by `npm test` and at the live
> rate by `make smoke` (§6.7).

**Who paid.** The minter needs the connector to tell it who paid, and a
connector only says that for a payment it admitted at its *own* client edge —
connector ADR 0040 refuses to invent a payer from the previous hop on a
forwarded packet. So whatever pays anytoon pays it as a **client**, not a
peer: anytoon binds nothing — no `[[peers]]`, no `[[peer_channels]]`, no
`POST /peers` — and the Dealer's vouchers arrive at its client edge, where
the minter is told `X-TOON-Payer = evm:0x<the Dealer's channel id>` (infra
ADR 0003, §6.7).

Key material for this subsystem is *not* committed (unlike everything else
under `keys/`): the `issuer-keys` job generates it at bring-up with the
issuer image's own generator (§6.1). The connector's own keys are committed
like every other node's — `keys/toon/anytoon-connector/`, mnemonic
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

**Four virtual ports on one address**, all in `conf/anonrc`:

| virtual port | forwards to | why |
|---|---|---|
| `80` | `anytoon-connector:3000` | the issuer path — the client edge a buyer pays through |
| `8545` | `anvil:8545` | the buyer's chain RPC, on the same address and the same circuit |
| `3200` | `relay-connector:3000` | the hub, for the HIDDEN PROVIDER's publisher (§6.8) |
| `7100` | `relay:7100` | the relay, for the HIDDEN PROVIDER's own reads and writes (§6.8) |

The second is not a second ingress; it is what makes the first honest. See §2.
The last two are not this node's business at all: they are this sandbox's
stand-in for "somewhere on clearnet an exit could reach", and they are on THIS
daemon because the provider that dials them must not have to dial its own
hidden service — §6.8.

**The connector's config is rendered, and that is the load-bearing step.**
`scripts/hs-address.sh` reads `hidden_service/hostname` out of the daemon and
writes `conf/.rendered/connector-anytoon.toml` — the committed
`conf/connector-anytoon.toml` with its `[node]` endpoint repointed at
`http://<addr>.anyone`. `make up-hs` brings the stack up on the committed
config first, waits for the `open-peerings` job (the Dealer's `POST /peers`
dials what anytoon publishes, and cannot dial a `.anyone` address), and then
recreates `anytoon-connector` alone with `ANYTOON_CONNECTOR_CONF` naming the
rendered file (nothing else ever sets it, so every other target mounts the
committed config unchanged). This matters because **a client dials the
endpoint a node publishes, not the URL the caller typed**: a node behind a
hidden service still advertising its compose name sends every buyer's packet
at a name nothing past the circuit resolves. A relative
endpoint is not a way out — this connector refuses one at load
(`[node] http_endpoint '/ilp' is not a URL: relative URL without a base`).
`smoke-hs`'s preflight asserts the published endpoint before it dials, so that
particular mistake can never masquerade as a bad day on the network.

`smoke-hs` buys as its own party (`accountIndex 5`), funded in ANYONE by the
sandbox's faucet account over the circuit, from an x402 channel it opens with
a Permit2 deposit, its approval and deposit paid from its own anvil ETH (§2).
The hub and relay ports on this daemon (3200, 7100) are the hidden provider's
(§6.8).

### 6.7 The Dealer: ANYONE, Uniswap v3 and a live rate

Anytoon is paid in **ANYONE** on anvil; clients pay in **µUSDC**. The flip
between them is the **Dealer**'s (`dealer-connector`, `g.toon.dealer`,
`conf/connector-dealer.toml`; `CONTEXT.md` **Dealer**,
`docs/adr/0003-the-anyone-flip-lives-in-a-dealer-node.md`), a node with no
app behind it. Until infra#39 the hub dealt; a node holds **one token per
chain**, and the hub settles FiatToken USDC on EVM, so it can no longer pay
ANYONE out. It keeps no ANYONE and no quote, and forwards
`g.anyone.credentials*` to the Dealer over Solana at par, like any peering.

```
client ──11000 µUSDC──▶ hub ──10900 µUSDC, Solana, relay-dealer──▶ Dealer
       ──floor(10900 × rate) − 0.0004 ANYONE, anvil, as a CLIENT──▶ anytoon (0.04 ANYONE)
```

**The Dealer holds USDC on Solana and ANYONE on EVM**, and deals between them
at a live Uniswap v3 TWAP (connector ADR 0071): `[[tokens]]` names the
FiatToken USDC as the **numeraire** (the USDC people pay in, which nothing
on the Dealer settles in), ANYONE with a two-leg quote (ANYONE → WETH → USDC,
the pools below) and the Solana mock USDC; one static `[[rates]]` row puts
Solana µUSDC at par with the numeraire, and the pair the packets cross is
composed from it and the quote read backwards; `[rate_guards]` sets a 0.3%
spread, a 120 s ttl (a 40 s poll) and a 5% `max_move`. `GET /rates` on
`:3270` (bearer) shows every declared pair.

**It pays anytoon as a client, not a peer.** Anytoon's claim minter refuses a
purchase it cannot attribute, and a forwarded, peer-role packet states no
payer (connector ADR 0040). So anytoon binds nothing for the Dealer: the
`open-peerings` job writes `POST /peers` on the Dealer alone
(`payeeBinds: false`), which binds anytoon's voucher signer, opens the
Dealer's own x402 channel toward anytoon in ANYONE (a **Permit2** deposit —
ANYONE has no ERC-3009 — after a one-time `approve` the connector sends from
its settlement key) and carries two routes. Anytoon sees the Dealer's
vouchers at its client edge and tells the minter `X-TOON-Payer =
evm:0x<the Dealer's channel id>`; the payment lands in anytoon's **client**
book under that key, which `make smoke` asserts. The peering is runtime, not
config, because a `[[pay_channels]]` row must name a channel the node's own
journal already holds, and an x402 channel's id is a fact of the run.

**The prices** (all in `scripts/peerings.mjs`):

| route | client pays the hub | hub pays the Dealer | Dealer's floor at the worst rate |
|---|---|---|---|
| `g.anyone.credentials` | 11000 | 10900 | 10338 |
| `g.anyone.credentials.keys` | **210** | 110 | 103 |

A route price is static and in the incoming unit, while the rate floats, so
the Dealer carries the FX risk and its prices carry the buffer the hub's used
to. The worst rate is the mid (4e12 ANYONE base units per µUSDC, ANYONE =
0.25 USDC) less the spread (×0.997) and the swap driver's band (200 ticks,
×0.98): about 3.908e12. At that rate 10900 µUSDC still forwards more than
anytoon's 0.04 ANYONE plus the 0.0004 ANYONE fee, and 110 still clears the fee
on the free key document. The key document costs **210**, not the 110 it
cost when the hub dealt: at 110 the Dealer would get 10 µUSDC, which at the
worst rate does not buy the fee. `npm test` re-derives both inequalities from
the committed topology and the Dealer's spread; `make smoke` re-derives them
from the Dealer's live `GET /rates`, and requires the rate to have **moved**
during the run.

> **⚠ The u64 ceiling.** A voucher's amount is a `u64` in the connector (the
> contract's is `uint128`), so the Dealer's channel to anytoon carries at most
> about **18.45 ANYONE over its whole life — some 460 bundles**. The job keeps
> 10 ANYONE of headroom behind it and tops it up from the Dealer's 100, but a
> sandbox that has sold ~460 bundles needs `make clean`.
> toon-protocol/connector#1429 tracks widening it.

**The market.** `anvil` builds the asset layer on every start
(`scripts/seed-toon-evm-amm.sh`, numbers in `conf/amm-topology.conf`, bytecode
and provenance in `artifacts/evm/`), and its healthcheck gates on an
`observe()` over the ANYONE pool's 300-second window. No MockERC20 is left:
the WETH/USDC pool and the numeraire are the FiatToken.

| on chain | what | how |
|---|---|---|
| `0xFeAc2Eae…` | **ANYONE**, the Anyone Protocol ERC-20 | mainnet RUNTIME bytecode, `anvil_setCode` at its own mainnet address |
| `0xC02aaA39…` | **WETH9** | same |
| `0x95bD8D42…` | **UniswapV3Factory** | official `@uniswap/v3-core@1.0.1` CREATION bytecode, deployed normally |
| `0x8983f136…` | ANYONE/WETH pool, fee 1% | `factory.createPool` — genuine v3-core |
| `0x9668CFaD…` | WETH/USDC pool, fee 0.05% | same — **in the FiatToken USDC**, whose float the FiatToken's minter mints; it replaced the retired MockERC20 pool, and since both sort below WETH the price is unchanged and only the address moved |

A few facts about the market:

- **`setCode` copies code, not storage.** The constructor's words are written
  by hand afterwards; for ANYONE one of them is a `launched` flag, without
  which every `transfer` reverts `AnyoneProtocolToken: Not launched.`
- **ANYONE has a fixed 100M supply and no `mint()`**; the seed hands anvil
  account 0 the supply and everything else is a transfer.
- **A fresh v3 pool cannot serve a TWAP** (cardinality 1, `observe` reverts
  `OLD`), so the seed grows both pools to cardinality 128 and walks the clock
  — ten `evm_increaseTime` steps of 90 s with a dust swap each. Those 900
  seconds are exactly how far **behind wall-clock** the `anvil` service is
  started (`--timestamp`), so priming brings the chain back to real time.
- **`scripts/swap-driver.sh`** (`full` and `credentials`, every 15 s) steers
  ANYONE/WETH as a bounded triangle wave — ±200 ticks around the 0.25 USDC
  target, flipping every 300 s — and pins WETH/USDC, because v3 writes an
  observation only in `swap()` and anvil mines only when a transaction
  arrives. `docker compose --profile full logs -f swap-driver` is one line a
  minute.
- `contracts/SandboxAmm.s.sol` is the 60-line stand-in for v3-periphery (a
  pool calls back into `msg.sender` for what a `mint` or `swap` owes).

### 6.8 The hidden provider (`hs` profile)

Read §2's *Hidden-service ingress* first. §6.6 is the anytoon ingress; this is
the **third compute provider**, `g.toon.provider-hs`, and it is the sandbox's
rehearsal of spec §10 / ADR 0008: a provider that publishes no host, sells from
an `.anyone` address, routes every workload's egress through `anon`, and reads
its chain on its own private RPC. `make up` renders none of it.

**Its daemon does three jobs, where the anytoon one does a third of one.**
`conf/anonrc-hs`, and every surface on it is reachable inside the project's own
networks and nowhere else:

| surface | where | for |
|---|---|---|
| `ControlPort` | `172.30.1.2:9051`, `CookieAuthentication 1` | `toon-provider` creating one `.anyone` address per lease (`ADD_ONION … Flags=Detach`) and destroying it at lease end |
| `SocksPort` | `172.30.1.2:9050` | the provider's OWN outbound — relay reads and writes, image fetches — and its publisher's |
| `TransPort` / `DNSPort` | `10.203.0.2:9040` / `:5353` | every hidden workload's only route out |

**Every one of them is bound to one address, never `0.0.0.0`.** The first two
are on `hs-provider`, the network the daemon shares with the provider and its
publisher; the last two are on `hs-egress`, the network it shares with every
tenant's workload. A control port bound on `0.0.0.0` would be a control port a
**tenant's own image** could dial, and the whole apparatus below exists because
tenant images are not trusted.

**The cookie is on a volume of its own.** `CookieAuthFile` is
`/var/lib/anon/control/control_auth_cookie` — *not* the default beside the
DataDirectory — because the volume that holds it is mounted **read-only into
the provider container at the same path**, and the DataDirectory beside it
holds the private key of this provider's address. The provider needs the first
and has no business with the second, so they are two volumes (`anon-hs-control`
and `anon-hs-data`). `conf/provider-hs.toml`'s `[anon.control]` names that path.
Proving it by hand:

```bash
docker compose --profile hs exec provider-hs sh -c '
  C=$(od -An -tx1 -v /var/lib/anon/control/control_auth_cookie | tr -d " \n")
  printf "AUTHENTICATE %s\r\nGETINFO version\r\nQUIT\r\n" "$C" | curl -s telnet://172.30.1.2:9051'
```

**Two pinned networks, and pinning is the mechanism rather than a convenience.**
The rest of this file avoids fixed IPs on purpose (§6.6); here a fixed address
*is* the contract:

| network | docker name | what |
|---|---|---|
| `hs-egress` | `toon-sandbox_hs-egress`, `internal: true`, `10.203.0.0/24` | every hidden workload attaches here, with `anon-hs` at **10.203.0.2** as gateway and resolver. `conf/provider-hs.toml`'s `[anon.egress]` names both — and it names the **prefixed** name, because the provider attaches workloads through the HOST daemon, which knows no compose keys |
| `hs-provider` | `toon-hs-provider`, `172.30.1.0/24`, dynamic pool `172.30.1.128/25` | `anon-hs` (.2, and where its control and SOCKS ports are bound), `provider-hs-connector` (.3), `hs-provider-ingress` (.4) — so `conf/anonrc-hs` can name its targets as IP literals, which always parse. The unpinned members (`provider-hs`, `directory-publisher-hs`) draw from the upper half only: Docker does not reserve a pinned address for a container that has not started yet, so with one pool the start order decided whether the connector could bind .3 |

An **internal** network gets no NAT and Docker installs **no default route** in
a container on it, so a workload there can reach `10.203.0.0/24` and nothing
else until something gives it one. The provider's own namespace-owner sidecar is
what does: it sets `default via 10.203.0.2` and the resolver with it, and
`anon-hs`'s `iptables` rules (installed by its entrypoint, which is why that
container has `NET_ADMIN`) do the rest —

```
nat/PREROUTING -s 10.203.0.0/24                    -p udp --dport 53 -j REDIRECT --to-ports 5353
nat/PREROUTING -s 10.203.0.0/24                    -p tcp --dport 53 -j REDIRECT --to-ports 5353
nat/PREROUTING -s 10.203.0.0/24 ! -d 10.203.0.0/24 -p tcp --syn     -j REDIRECT --to-ports 9040
INPUT          -s 10.203.0.0/24 -p tcp --dport 9040 -j ACCEPT
INPUT          -s 10.203.0.0/24 -p tcp --dport 5353 -j ACCEPT
INPUT          -s 10.203.0.0/24 -p udp --dport 5353 -j ACCEPT
INPUT          -s 10.203.0.0/24                     -j DROP
```

— so a workload needs no proxy settings, cannot opt out, and has no second
route to try. The two halves are both load-bearing: the REDIRECTs put its
traffic on a circuit, and the `INPUT` pair leaves the TransPort and the DNSPort
as the **only** two things it can reach on the daemon (a redirected packet
arrives at `INPUT` already rewritten, which is why the ACCEPTs come first and
why the DROP does not swallow them). Checking the whole path by hand, with any
image:

```bash
docker run -d --name probe --network toon-sandbox_hs-egress --dns 10.203.0.2 debian:bookworm-slim sleep 600
docker run --rm --network container:probe --cap-add NET_ADMIN alpine ip route add default via 10.203.0.2
docker exec probe bash -c 'exec 3<>/dev/tcp/api.ipify.org/80; printf "GET / HTTP/1.0\r\nHost: api.ipify.org\r\n\r\n" >&3; cat <&3' | tail -1
docker rm -f probe
```

The address that comes back is an `anon` exit, and it is not this host's.
`nslookup`/`getent hosts` work too, on any image, musl (Alpine, BusyBox)
included (TOON_Network#166): the daemon's own DNSPort answers an AAAA query
with NXDOMAIN even when the name has a good A record, which used to break a
musl resolver's parallel A/AAAA lookup outright, but port 53 now goes to
`dns-shim-hs` — on the egress network, at `10.203.0.3` — which forwards A to
the DNSPort unchanged and answers AAAA itself with NOERROR and no records.
provider's `src/dns_shim.rs` has the full account.

**A hidden lease is three containers**, not one (TOON_Network #41):
`toon-<id>-egress` owns the network namespace on `hs-egress` and sets the single
route out, `toon-<id>` is the tenant's workload sharing that namespace, and
`toon-<id>-ingress` republishes the lease's SSH forward and ports on the host —
which is what the daemon's `ADD_ONION` targets reach, at
`anon.forward_host = 172.17.0.1` (docker0: this host, as the daemon's container
sees it). The two sidecars run one pinned Alpine, and `make up-hs` **pre-pulls
it** so the first hidden spawn does not pay for the pull inside a tenant's
lease.

**Two virtual ports on the provider's address** (`conf/anonrc-hs`) — and two
more on the *anytoon* daemon's (`conf/anonrc`), which is the part worth reading
twice:

| address | virtual port | forwards to | why |
|---|---|---|---|
| the hidden provider's | `80` | `provider-hs-connector:3000` (pinned `.3`) | the client edge a tenant pays through |
| the hidden provider's | `8545` | `anvil:8545` | the tenant's chain RPC, same address, same circuit — §6.6 says why that is not optional |
| **the anytoon daemon's** | `3200` | `relay-connector:3000` | the hub, as the hidden provider's publisher reaches it |
| **the anytoon daemon's** | `7100` | `relay:7100` | the relay, as the hidden provider reads and writes it |

The last two exist because of what hiding a provider's *own* outbound means: it
dials every relay and its payer's connector through `socks5h`, and `anon` builds
no circuit to a private address — `relay:7100` and `relay-connector:3000` are
private on this compose network. In a deployment the hub and the relays are on
clearnet and an exit reaches them; this sandbox has no clearnet, so the same
shape is rehearsed by giving them a virtual port. The packets still leave over a
circuit and arrive naming nothing about this host, which is the property under
test.

**They are on the other daemon's address for a reason you will otherwise
discover the hard way.** A daemon dialling *its own* hidden service is the one
overlay path that does not reliably build: the path restrictions that keep a
rendezvous anonymous exclude the relays it is already using, and it sits in
`waiting for circuit` until it gives up (`Tried for 120 seconds to get a
connection to [scrubbed]:3200. Giving up.`). It works often enough to look
correct for an hour and then stops after a restart. Two daemons, an ordinary
client-to-service circuit, and the property under test is unchanged.

**Three rendered files, not one** (`scripts/hs-provider-address.sh`, run by
`make up-hs` and by `make hs-address`):

| rendered | what it fixes up |
|---|---|
| `conf/.rendered/connector-provider-hs.toml` | the `[node]` endpoints — a client dials what a node publishes |
| `conf/.rendered/provider-hs.toml` | `connector_url` (the Profile's, which `hidden = true` refuses unless it is `.anyone`) **and** `relay_set`, at port 7100 |
| `conf/.rendered/hs-provider.env` | the publisher's `TOON_CONNECTOR_URL`, `TOON_ENDPOINT_REWRITE` and `RELAY_WRITE_ROUTES` |

The second and third of those carry **the anytoon daemon's** address, not the
hidden provider's — which is why the script reads two hostnames and why
`make hs-address` prints both.

The publisher's env file has one wrinkle worth knowing before it surprises you:
`TOON_CONNECTOR_URL` is the hub's **compose name**, and the `.anyone` hub is
reached by `TOON_ENDPOINT_REWRITE` instead. `@toon-protocol/client` refuses to
be *configured* with a hidden-service connector unless it was handed
`socksProxy`, and this publisher deliberately hands it a carriage instead (the
library's own option refuses a proxy beside a clearnet connector, and for a
hidden *provider* covering the clearnet hop is the whole point). The rewrite is
applied to every request the carriage makes, so the configured URL stays
clearnet-shaped and every actual packet goes to the overlay.

**Start the publisher before the provider.** `docker-compose.yml` orders them
that way on purpose. A hidden provider dials its publisher *directly* when
`publish_url` is on a private address and *through `anon`* when it is not — and
it decides which **once, at startup, by resolving that name**. A publisher that
has not started yet does not resolve, so the provider settles on "not private"
and asks the daemon for a circuit to `directory-publisher-hs` for the rest of
its life: `SOCKS error: host unreachable` on every Profile, Listing and
Liveness, with nothing in the network at fault.

**What is not hidden here, stated plainly.** The workload images are pulled by
the **host's** Docker daemon, not by the provider, so an image fetched from a
registry leaves from this host's address; and `gateway_url_pattern` points at
`envoy`, which is private and therefore unreachable through the proxy, so a
TOON-store image (§Milestone 2) cannot be fetched by this provider today. Both
are sandbox facts rather than protocol ones, and neither is on the path of a
lease spawned from a registry reference.

### 6.9 The Workload Gateway (`gateway` profile)

Read §2's *The Workload Gateway* first; this is how the two services are put
together and which of it is this sandbox's rather than the protocol's.

**The gateway is built, not pulled.** `docker-compose.yml`'s `workload-gateway`
builds `${GATEWAY_CONTEXT:-../../gateway}` — the gateway repo's own
`Dockerfile`, a `node:22-slim` image running `src/main.mjs` — the way the
providers build from `../../provider`. Its configuration is environment only
(`conf/workload-gateway.conf`, an `env_file` like the relay's); there is no
config file to drift. What that file sets, and where each value comes from:

| variable | value | why |
|---|---|---|
| *(no key)* | — | until Milestone 6 this file set `GATEWAY_SECRET_KEY`, the Nostr key a published grant named and `status` was signed with. Nothing is signed or published on either side now (spec §12.1, ADR 0016), so the line is gone and the gateway has no key. Its identity to a tenant is its **connector's** sealing key, `keys/toon/workload-gateway-connector/signer.key`, which `scripts/handover.mjs` derives the public half of |
| `GATEWAY_DOMAIN` | `gw.localhost` | resolves to loopback with nothing added to DNS (§2) |
| `GATEWAY_HANDOVER_PORT` | `8081`, published on **no** host port | where its connector forwards a sealed Gateway Handover or Withdrawal (spec §12.1, §12.7): its own listener, never a path on the ones that front workloads. Required by the gateway, no default. Reachable from `workload-gateway-connector` on the compose network and from nowhere else — a host port here would be a way to tell the gateway something without a packet through its connector |
| `GATEWAY_ADMIT_PER_MINUTE` | `6` (the gateway's default, stated) | how many admission rounds any one provider may be asked for in a minute; a handover naming a member over its rate is refused `rate_limited` whole and nothing is asked (spec §12.1's amplification bound). Stated so a developer who trips it knows where the number lives |
| `GATEWAY_RELAYS` | `ws://relay:7100` | the relay by its compose name, read for exactly two things, both downstream of an admitted handover: the members' Provider Profiles and the Takeovers that move a workload (spec §12.1). It watches for no grants. The gateway also reads every relay a member's Profile names, which here is the same one under the same name |
| `GATEWAY_HTTP_PORT` / `GATEWAY_HTTPS_PORT` | `8080` / `8443`, published at host **3280** / **3443** | both listeners side by side: TLS is what spec §12.2 requires, the plain one is what smokes and `curl` use |
| `GATEWAY_TLS_CERT` / `_KEY` | `conf/workload-gateway-tls/gw.localhost.{crt,key}`, mounted read-only | a self-signed ECDSA P-256 wildcard for `*.gw.localhost` and `gw.localhost`, ten years, not a CA |
| `TOON_SOCKS_PROXY` | `socks5h://anon-client:9050` | the `hs` profile's buyer-side proxy, on the `hs-payer` network the gateway joins. Only validated at startup; dialled the first time a handover names a hidden member (TOON_Network #52). Under `make up-gateway` alone no such container exists and nothing is dialled |
| `GATEWAY_DIAL_REWRITE` | one entry, below | **sandbox-only** |

**The rewrite, and why it is honest.** The gateway reaches two addresses it
did not choose — a member's `connector_url` out of its Provider Profile, and
the `access.host` a running member answers — and each names the member as
*its own* clients reach it. Here the first one is where this container can
reach it and the second is not:

| the member says | the gateway reaches | because |
|---|---|---|
| `http://provider-connector:3000/ilp` (the Profile) | **the same address** | the gateway seals `status` through the member's own connector — addressed `<ilp_address>.status`, sealed to `connector_seal_key` (TOON_Network#114) — and `provider-connector` is that connector, on this network, under the name its Profile advertises. Nothing to rewrite |
| `127.0.0.1` (`access.host`, from `public_ip` in `conf/provider*.toml`) | `host.docker.internal` | the workloads run on the **host** daemon and publish there; inside the container `127.0.0.1` is the gateway. `extra_hosts` maps the name to the host gateway |

**What the other two entries were, and why they are gone.** Until #114 this
map also sent `provider-connector:3000` at `provider:8080` and
`provider2-connector:3000` at `provider2:8080`, because the gateway sent
`status` as a plain `POST` to a path beside `connector_url` — a carriage only
the provider **app** serves, since a connector's client edge terminates
*sealed* ILP packets and answers nothing on a plain `POST`. Every deployment
fronts its provider with a connector, so that carriage reached no real one:
the devnet provider answers that path `404` with an empty body, and the
gateway read the 404 as "this member answered, and is not running it". The
sealed carriage needs no shortcut, so the sandbox stopped pretending.

The forwarding leg applies the map in front of the gateway's dial seam
(`src/rewrite.mjs` wrapping `src/dial.mjs`) and the `status` leg applies the
same table to the connector's URL (`src/status.mjs`), so the two cannot
disagree; it rewrites no header, no ILP destination and no sealing key — the
request is what spec §6.5 fixes; only the socket moves. It is the gateway's
counterpart of `TOON_ENDPOINT_REWRITE` on the hidden directory publisher: "a client
dials what a node publishes", and in a sandbox what a node publishes is a
compose name. In a deployment the variable is unset.

**The connector terminates one route, free, and it is the only way in.**
`conf/connector-workload-gateway.toml` is `conf/connector-gas.toml` with one
`[[routes]]` row — `g.toon.workload-gateway.handover` at `price = 0`,
`handler_url = http://workload-gateway:8081/handover` — a Solana
`[settlement.*]` table, and no `[[peers]]`. Three
things about that row are the sandbox's own doing and worth knowing:

- **The handler path decides where a handover lands.** The tenant tool seals
  with the connector client's default target, `''`, and the connector resolves
  that to the `handler_url` unchanged (connector ADR 0025) — while the
  gateway's door answers `POST /handover` and 404s anything else. So the path
  is configured **here**, on the connector, and the tool sets none: a tenant
  knows the route it pays for, not the listener behind it. Both the Gateway
  Handover and the Gateway Withdrawal ride this one route, and the body's
  single key (`handover` / `withdrawal`) says which (spec §12.1, §12.7).
- **Settlement is there for the tenant's sake.** Every channel is an x402
  channel (connector ADR 0075) and a free route carries no voucher, so
  nothing has to open one to reach this route; the Solana table is what makes
  the node a counterparty a tenant tool can describe and pay at all, and it
  takes the same `min_sponsored_deposit` as every other node. Solana only —
  every host-run tool here pays on Solana — and the key is
  `keys/toon/workload-gateway-connector/settlement-solana.key`, test-phrase
  index 41, which `scripts/gen-toon-keys.sh` derives and
  `scripts/seed-toon-solana.mjs` funds (a connector whose settlement key holds
  no SOL refuses to boot). Its claim journal stays empty: a free route books
  nothing, which `GET /claims` with the bearer token shows.
- **The tenant pays it directly, at `:3260`**, the shape `spawn.mjs --direct`
  already has against a provider's edge. The hub does not peer with it: a
  peering would fund a 100 USDC channel from the hub's collateral for a route
  that costs nothing. `sealTo` in the tool is then the terminating node's own
  key, which is exactly what a direct payment seals to anyway.

That is the shape ADR 0013 asks for with the price Milestone 5 deferred (#46,
Out of Scope) still deferred: a gateway is run by or for its tenant, and the
gateway behind it holds no lease, no channel, no mnemonic and calls no paid
route. Its HTTP listeners are published on their own host ports because a
browser reaches a hostname, not an ILP address; its handover door is
published on none.

**The handover script pays from its own wallet.** `scripts/handover.mjs` runs
`../../provider/tools/grant/seal.mjs` (the tenant tool of TOON_Network #59,
where it lives, so the sandbox seals exactly the bytes that tool's tests
prove against the wire fixtures) with the sandbox's values filled in: the
gateway's connector at `:3260`, the route and the sealing key read off
`conf/connector-workload-gateway.toml` and `keys/toon/workload-gateway-connector/signer.key`
(pinned out of band, as ADR 0011 has a tenant pin a Provider Profile's — the
tool fetches nothing to learn it), Standby Set members by compose name out of
`conf/provider*.toml`, the root secret out of the lease file `spawn.mjs`
wrote, and **account index 4** of the committed test phrase — its own wallet,
its own channel and its own store (`.toon-client/handover-channels.json`),
because a smoke holds the smokes' buyer (index 0, `channels.json`) open while
it runs this script, and two processes on one channel share one
watermark. `scripts/seed-toon-solana.mjs` funds it on every profile, like the
three publishers' wallets. `scripts/rotate.mjs` pays from the same wallet but
on a channel with the **hub** (`.toon-client/rotate-channels.json`), because a
rotate goes to each provider's `<addr>.rotate` — free there, 100 at the hub
like every other free row — and the members, their `ilp_address` and their
pinned `connector_seal_key` come out of `conf/provider*.toml`. The hub
publishes its compose-network name (§6.2), so `rotate.mjs` hands the tool
`TOON_ENDPOINT_REWRITE` = `HOST_REWRITE` from `scripts/lib/sandbox-endpoints.mjs`,
which moves it back onto the host. **`provider-hs`
is a fifth wallet again** (spec §10, §12.8; TOON_Network #81): account index 7,
no channel store worth the name — `<addr>.rotate` is free there too, direct,
so `openHiddenClient` never opens one — reached through the buyer's own
`anon-client` SOCKS proxy rather than the hub, because the hub does not peer
with a Hidden Provider. It reads no relay and writes none; the tenant's
Nostr key is nowhere in it. `scripts/spawn.mjs`, by contrast, *is* the smokes'
buyer — it is the smokes' spawn as one command, for the README walk-through,
minting the root secret the way the Milestone 6 smoke does — and must not run
while a smoke does.

**Regenerating the certificate** (only ever needed to change the domain):

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -keyout conf/workload-gateway-tls/gw.localhost.key -out conf/workload-gateway-tls/gw.localhost.crt \
  -subj '/CN=*.gw.localhost/O=TOON sandbox (development, self-signed)' \
  -addext 'subjectAltName=DNS:*.gw.localhost,DNS:gw.localhost' \
  -addext 'basicConstraints=critical,CA:FALSE' -addext 'extendedKeyUsage=serverAuth'
```

**Under `hs`.** `make up-gateway-hs` (after `make up-hs`) is the same two
services and **nothing rendered for them**. A hidden member's connector is
reached at the `.anyone` address its own Profile advertises, sealed to its
`connector_seal_key`, through `TOON_SOCKS_PROXY` — the same rule as the
per-lease address a hidden lease answers in `access.host`, which was never
rendered anywhere either. Until #114 this recipe wrote
`conf/.rendered/workload-gateway-hs.env`, the committed `GATEWAY_DIAL_REWRITE`
restated with a fourth entry sending `<hidden provider address>.anyone:80` at
`provider-hs:8080`, because the plain `POST` the gateway then sent was not
something the hidden connector serves. `scripts/hs-provider-address.sh` now
renders three files rather than four, and `docker-compose.yml` reads one
`env_file` rather than two.

### 6.10 The x402 layer: batch-settlement, the Onboarder, and production's addresses

**Every channel in the sandbox is an x402 `batch-settlement` channel** (connector ADRs 0074,
0075; infra#23, #39), and every payment is a voucher on one: on EVM it is x402's own audited
`x402BatchSettlement`, whose deposits an **Onboarder** (`CONTEXT.md`; x402 calls it a
facilitator) relays and pays the gas for; on Solana it is solana-foundation's
`payment-channels`, sponsored by the receiving connector. Production has an Onboarder, so the
sandbox runs one — otherwise the one step a gasless client cannot do for itself is the one step
nothing here could rehearse.

**Every node publishes its terms.** Each connector's `[settlement.evm]` names the FiatToken
below with its EIP-712 domain (`asset_eip712_name = "USDC"`, `asset_eip712_version = "2"`,
checked against the token's own `DOMAIN_SEPARATOR()` at boot), `asset_transfer_method =
"eip3009"`, and `facilitator_url = "http://onboarder:4022"` — the Onboarder by its
compose-network name, published verbatim as `facilitator` (connector ADR 0076: the operator
names the facilitator and its gas is a cost of the sale; the node never calls it). Each
`[settlement.solana]` sets `min_sponsored_deposit = 1000000`, 1 USDC as on the devnet, published
as `minDeposit` beside the node's `sponsorEndpoint`. `GET /ilp` shows both under
`batchSettlements`, and `make smoke` asserts them for every node it runs. A host-run client
reaches `http://onboarder:4022` at `localhost:4022` through `hostFetch()` (§3). The hidden
provider names the Onboarder too, and its buyer ignores it: no circuit reaches a private
compose service, so it pays its own deposit gas (§2).

**Everything sits where production has it.** The published `@x402/evm` package hardcodes the
batch-settlement addresses (`0x4020…0003` settlement, `…0004` ERC-3009 collector, `…0005`
Permit2 collector), so a stock facilitator only works on a chain where the contracts are exactly
there — and x402's own deploy script uses plain CREATE on 31337, which puts them elsewhere.
`scripts/seed-x402.sh` therefore copies the **runtime** bytecode from Base Sepolia and places it
with `anvil_setCode`, the same way §6.7 places ANYONE and WETH9:

| what | address | why it is there |
|---|---|---|
| `x402BatchSettlement` | `0x4020074e…0003` | the channel contract; ownerless, EIP-712 domain rebuilt for 31337 |
| `ERC3009DepositCollector` | `0x40208060…0004` | pulls a deposit by `receiveWithAuthorization` — the gasless path |
| `Permit2DepositCollector` | `0x4020425F…0005` | the Permit2 path, for a token without ERC-3009 |
| Permit2 | `0x00000000…8BA3` | Uniswap's canonical deployment; the Permit2 collector's immutable |
| Multicall3 | `0xcA11bde0…CA11` | the Onboarder batches its channel reads through it; plain anvil has none |
| Circle `SignatureChecker` | `0xbA3b60c2…7DA6` | the external library FiatToken v2.2 links at this address |
| USDC (FiatToken v2.2) | `0x0A867CA0…5b58` | Circle's real proxy + implementation, deployed from Base Sepolia's own creation transactions; EIP-712 name `USDC`, version `2`, as on Base Sepolia |

The USDC is the one address that is local rather than production's: a FiatToken's initialisers
write a dozen storage words, so it is deployed and initialised rather than placed. That is fine,
because a token address travels as the greeting's `asset` — configuration, not code. It is the
one USDC every EVM node here settles in; the connector's `MockERC20`, which had neither ERC-3009
nor permit, is gone with the rest of `DeployLocal`. Mint it from anvil-mnemonic index 21, the
token's minter:

```sh
cast send 0x0A867CA0442383c2A89951244B955AA19b615b58 'mint(address,uint256)' <you> 5000000 \
  --private-key 0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b --rpc-url http://localhost:8545
```

**The Onboarder** (`../onboarder/`, the `onboarder` service) is x402's own e2e facilitator reduced
to one scheme and one network. Its gas payer is anvil-mnemonic index 22, funded by the seed. It offers **no
`receiverAuthorizer`**, deliberately and like x402.org's hosted facilitator on Base Sepolia: a
`receiverAuthorizer` can refund a connector's earned-but-unclaimed value to the payer, so a
connector always names its own (ADR 0074 decision 5).

**The same image serves the devnet**, at `onboard.devnet.toonprotocol.dev`
(`../onboarder/deploy/README.md`). With nothing set it is the sandbox's Onboarder. Point it at
a real network and it **fails closed**: off chain 31337 there is no default RPC and no default key.
The anvil key is public, so defaulting to it anywhere else would be signing with a key the whole
world holds. `../onboarder/config.mjs` owns the rules, and `config.test.mjs` pins them. The
sandbox's compose service still sets `X402_NETWORK`, `EVM_RPC_URL` and the key explicitly, so it
reads like the devnet's; `docker compose up` needs nothing from the operator. `EVM_RPC_URL` must be
an http(s) URL, and only its host is logged, since a hosted RPC URL often carries its API key.

| variable | sandbox default | off the sandbox |
|---|---|---|
| `X402_NETWORK` | `eip155:31337` | e.g. `eip155:84532` (Base Sepolia) |
| `EVM_RPC_URL` | `http://anvil:8545` | **required** |
| `ONBOARDER_EVM_PRIVATE_KEY_FILE` / `ONBOARDER_EVM_PRIVATE_KEY` | index 22, funded by the seed | **required** — one or the other, never both; prefer the file. x402's own `FACILITATOR_EVM_PRIVATE_KEY` is not read |
| `PORT` | `4022` | `4022` |

`/health` is 503 in three cases, each of which would otherwise surface only as a failed deposit:
the RPC serves a different chain than `X402_NETWORK` names, `x402BatchSettlement` is not on the
chain, or the gas payer holds no ETH. Why the devnet runs this image rather than x402.org's hosted
facilitator is connector `docs/research/x402-devnet-facilitators.md`.

**`make smoke-x402`** is the whole path, and runs inside `make smoke` and `make smoke-payments`
(`../onboarder/smoke.mjs`): the hub's EVM offer, read off its own `GET /ilp`, must name the
Onboarder as its `facilitator` and take an `eip3009` deposit; a fresh wallet holding USDC and
**no ETH** signs one ERC-3009 authorization, built by the published `@x402/evm` client; the
Onboarder verifies it, relays the deposit and pays the gas; the channel — receiver and
`receiverAuthorizer` both the hub's settlement address — is read back off anvil holding the
deposit. Then the wallet **pays the hub**: the published `@toon-protocol/client` adopts that
channel and sends one relay write (`g.toon.relay`, 1 µUSDC) with a voucher on it, the hub
fulfils it, its `POST /ilp/claim-state` names a 1 µUSDC watermark, and its own `GET /claims`
(read with the committed bearer token) holds a `batch-settlement` row at 1 on
`evm:<channel id>` — with the payer still at zero ETH. It also runs the one
question ADR 0074 could only answer by reading: a deposit whose voucher is **zero** is refused on a
fresh channel (`invalid_batch_settlement_evm_cumulative_below_claimed`). x402's reference
facilitators disagree on that — Go accepts it — so the smoke pins this one's answer and fails if a
package bump changes it. Last, it checks `payment-channels` is loaded and executable.
`node ../onboarder/smoke.mjs --devnet` runs the same path against the devnet relay.

## 7. Lifecycle and state

- **`make down`** stops everything but keeps state: gateway/bundler data
  (`./data/`), the connectors' journals and runtime peer tables (named
  volumes), bought names in gateway caches.
- **`make clean`** wipes all of it; the next `make up` is a true cold start.
- **Upgrading across the x402-only migration (infra#39) needs `make clean`.**
  The pinned connector (`rust-2026.09.29.1`) speaks vouchers and nothing
  else, and refuses to boot on a claim journal holding `toon-channel`
  entries — it would restart-loop and `make up` would stall on a hub that
  never turns healthy. So every `make up*` runs `scripts/state-guard.sh`
  first: a connector state volume holding a file only an older build wrote
  (`peer-claims.log`, `evm-channel-index.json`, `outbound-client.log`) or a
  journal line only TOON's own channels produced is refused **by name**, and
  the message says `make clean && make up`. There is nothing to drain: the
  chains are disposable and `make clean` wipes both together.
- **Chain restarts wipe chain state**: the validator runs `--reset` and anvil
  keeps nothing, so a container restart loses bought names and every channel
  — while the connectors' journals and runtime peer tables, on their named
  volumes, still name the old ones. Re-running `make up` re-runs the seed
  jobs (they detect the missing state and reseed), but the peerings' channels
  are gone from under the nodes that opened them; `make clean && make up` is
  the reliable way back, and names bought before the restart are gone
  either way.
- Re-running `make up` on a healthy stack is a no-op: every init job checks
  before it writes.
- **BOTH `.anyone` addresses (`hs` profile) survive `make down` and die with
  `make clean`.** They live in the `anon-data` and `anon-hs-data` volumes with
  the private keys behind them; `make down`/`make up-hs` keeps the same two
  addresses, `make clean` publishes new ones on the next cold start (and drops
  `conf/.rendered/`, which is where both are written into configs). That is
  fine here and expensive in a deployment — §6.6, §6.8. The hidden provider's
  control cookie (`anon-hs-control`) and its lease table
  (`provider-hs-state`) go the same way.
- `make down` and `make clean` sweep **every** profile's containers, whichever
  one brought them up, so `make up-hs && make down` leaves no daemon running
  (and no Workload Gateway).
- **The Workload Gateway keeps no state, and that is now load-bearing.** Its
  grants are held in memory: nothing is published, so there is nothing to
  re-read at a start, and a restarted gateway serves nothing until a tenant
  hands over again (`node scripts/handover.mjs <lease.json>` — the same
  command, the same grant). Its connector's (empty) claim journal is a named
  volume like every other. **A lease's root secret lives in
  `.toon-client/spawn-<id>.json` and nowhere else**; `make clean` removes
  `.toon-client/` and with it every root secret, which is loss of control of
  every lease still running — they run on until their intervals end. The
  handover script's channel store, `.toon-client/handover-channels.json`, and
  the rotate script's, `.toon-client/rotate-channels.json`, go the same way.
  While a rotation is only partly done the file carries a `rotation` record
  beside `root_secret`; `make clean` in that window loses both.

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
- **`*.gw.localhost` doesn't resolve**: the same resolver, the same fix —
  `curl --resolve '<label>.gw.localhost:3280:127.0.0.1' http://<label>.gw.localhost:3280/`
  or the `Host` header form above against `http://localhost:3280/`. §2, *The
  Workload Gateway*, has the `getent` check.
- **The gateway answers `503`** — read the reason (`toon-gateway-reason`
  header, and the body): `no_grant` means this gateway holds no handover for
  that label — none was sealed to it since it last started, or a withdrawal
  took it off (a label is the base32 of the workload id, not the hex; there is
  no relay to look on); `not_resolved` on a first request is the gateway still
  asking — ask again; `member_unreachable` with the log saying `refused status
  (invalid_request)` is a **provider built before Milestone 6** that still
  reads a signed request — `docker compose --profile full up -d --build
  provider provider2` rebuilds them from the provider checkout;
  `no_running_member` means every member answered and none is running it
  (expired, terminated, or a standby still `reserved`).
- **The handover is refused** — the reason is in the script's report under
  `failed` (spec §12.1): `not_admitted` means no member took the grant, which
  is the wrong root secret, a `--standby` that is not in the lease's Standby
  Set, or a lease that has ended (`node scripts/spawn.mjs` again);
  `rate_limited` is `GATEWAY_ADMIT_PER_MINUTE` (six a minute per provider) —
  wait; `grant_expired` is an `--expires-at` already past; a `404
  invalid_handover` answered by the gateway with *POSTed to /handover* in the
  message means the connector's `handler_url` in
  `conf/connector-workload-gateway.toml` no longer ends in `/handover` (§6.9).
  A spawn refused `invalid_request` from `scripts/spawn.mjs` against a provider
  that is up is the reverse: a provider built before Milestone 6 being sent a
  plain Lease Request — rebuild as above.
- **A spawn through the hub refuses `T01` ("peer did not answer in time")
  while the provider goes on and starts the lease**: the hub gives a peer 30 s,
  and a spawn is a `docker pull` by digest plus a container start on the host
  daemon. On a daemon that is slow — dozens of healthchecks, a `docker stats`
  viewer, a leak of socket clients — a *local* `docker image inspect` can take
  20 s and the spawn 200. **Measure it before blaming the code**: `time docker
  ps -q` is milliseconds on a healthy daemon here and has been seen at a
  hundred seconds on a loaded one, and the culprit is usually one process
  holding thousands of `docker.sock` clients — `ss -x | grep -c docker.sock`
  counts them, and

  ```bash
  for p in /proc/[0-9]*; do echo "$(ls $p/fd 2>/dev/null | wc -l) $(tr '\0' ' ' < $p/cmdline)"; done | sort -rn | head -3
  ```

  names it (a `lazydocker` or `docker stats` left open in another terminal is
  the usual answer). Closing it is the fix — its connections go with it and
  nothing in this sandbox needs restarting. `scripts/spawn.mjs --direct` pays the
  provider's own edge instead, where the only timeout is the client's; the
  Milestone 1 smoke's second half does the same. The refusal is billed
  (ADR 0003). Every smoke that spawns through the hub — `smoke-m1`,
  `smoke-m2`, `smoke-m3`, `smoke-m5` — fails this way on a loaded daemon, and
  the failure is the machine rather than the change under test.
- **`make up` refuses with "this sandbox's state predates the x402-only
  connector"**: `scripts/state-guard.sh` found a connector volume an older
  sandbox wrote. `make clean && make up` (§7); there is nothing to drain.
- **`make up` refuses with "the directory publisher … is not on
  @toon-protocol/client 4.x"**: the provider checkout predates
  toon-protocol/provider#52 — `git -C ../../provider pull`, or
  `PROVIDER_CONTEXT=/path/to/provider`.
- **Connector refuses to boot**: its startup is fail-closed on every
  settlement backend — check that anvil is healthy (its healthcheck requires
  the sandbox extras, the FiatToken, a live `observe()` over the ANYONE pool
  and the gas relayer funded, i.e. every seed stage landed) and the validator
  answers on 8899; then `docker compose logs <connector>` names the failure.
  The x402-era refusals are all named: a retired key (`contract_address`,
  `program_id`, a `[[client_channels]]` or `toon-channel` channel row) with
  the ADR that retired it, a chain without `x402BatchSettlement` or
  `payment-channels`, a FiatToken whose EIP-712 domain the configured
  `asset_eip712_name`/`version` do not reproduce, a Solana key with no
  lamports, and a journal holding `toon-channel` entries (§7).
- **`open-peerings` exits non-zero**: it names the node and the write, and
  quotes the node's answer — `docker compose logs open-peerings`, then that
  node's own log. A `502` from `POST /peers` is about the OTHER node (its
  self-description unreachable, or publishing an endpoint this one cannot
  dial — every peered node must publish its compose-network name, no
  `btp_endpoint`); a `400`/`409` is about the writer. It is idempotent:
  `docker compose --profile <p> run --rm open-peerings` re-runs it.
- **A host-run client fails to reach `relay-connector:3000`** (or any
  `*-connector:3000`, or `onboarder:4022`): it dialled what the node
  publishes, a compose-network name, without `fetch: hostFetch()` from
  `scripts/lib/sandbox-endpoints.mjs` (§3). A provider-repo tool takes the
  same map as `TOON_ENDPOINT_REWRITE` (`HOST_REWRITE`).
- **`make up` stops on the store or anytoon context**: those two images
  build from sibling checkouts — see Prerequisites for repointing
  `STORE_CONTEXT` / `ANYTOON_CONTEXT`, or use `make up-payments`, which
  never builds either (`make up-credentials` builds only the claim-minter,
  so it needs just the anytoon checkout). `make setup` only prints a note
  about them; the gates live on `make up` and `make up-credentials`, the
  paths that build the images.
- **A bare `docker compose` command does nothing**: it selected no profile —
  see the note at the end of §2.
- **The issuer's epoch expired after the stack has run a month**:
  `docker compose up -d --force-recreate issuer-keys issuer` re-forges it.
- **`make up-hs` waits five minutes and gives up on `anon`** (or on
  `anon-hs`): read the daemon's own log (`docker compose --profile hs logs
  --tail 80 anon`). A container that is *Up* but not healthy is bootstrapping
  against the real Anyone network and is usually not your fault; a container
  that **exited at once** is a config fault — almost always a missing
  `AgreeToTerms 1` or a missing explicit `Nickname` (the image's entrypoint
  would append one, and the file is mounted read-only, so it fails at boot
  instead), or, in `conf/anonrc-hs`, a `HiddenServicePort` target that is not
  an IP literal: `anon` resolves those when it PARSES its config and aborts
  rather than starting (§6.6, §6.8).
- **The hidden provider publishes nothing and its log says `SOCKS error: host
  unreachable` for `directory-publisher-hs`**: the provider started before its
  publisher and decided, once, that the publisher was not on a private address.
  `docker compose --profile full --profile hs up -d directory-publisher-hs` and
  then recreate `provider-hs` — §6.8 has the whole story.
- **The hidden provider publishes nothing and `anon-hs` says `Tried for 120
  seconds to get a connection to [scrubbed]:3200. Giving up. (waiting for
  circuit)`**: its CLIENT side cannot build a rendezvous circuit to the hub's
  virtual port, which is the overlay having a bad minute rather than this
  sandbox — the same class of failure `make smoke-m4` calls exit 75. Check the
  other side first (`curl --socks5-hostname 127.0.0.1:19050
  http://<anytoon-addr>.anyone:3200/ilp` through the BUYER's daemon: a 200 says
  the service and its forwarder are fine), then
  `docker compose --profile hs restart anon-hs`, which re-picks guards and
  refetches the descriptor. It comes back within a minute or two. The provider
  and its publisher need no restart of their own: they retry every cadence.
- **anvil never turns healthy with `Insufficient funds for gas` in its log**:
  anvil's funder account (index 0) has been drained — `seed-evm-nodes.sh`
  hands out 100 ETH per node on every anvil start. Refill it:
  `cast rpc anvil_setBalance 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x21e19e0c9bab2400000 --rpc-url http://localhost:8545`.
- **`make smoke-m4` exits 75, or the BUYER's daemon says `Tried for 120 seconds
  to get a connection to [scrubbed]:80. Giving up. (waiting for circuit)` for
  the hidden provider's address while the anytoon address answers at once**:
  the buyer holds a stale descriptor. `anon-hs` has been recreated since
  `anon-client` last fetched the provider's descriptor (every recreate
  re-establishes its introduction points), and the client keeps trying the old
  ones for the descriptor's lifetime. `docker compose --profile hs restart
  anon-client` — ten seconds — and it fetches the current one. `smoke-m4` does
  exactly this between its attempts to reach the connector, so a run that still
  exits 75 after that is the network. `curl --socks5-hostname 127.0.0.1:19050
  http://<provider-hs-addr>.anyone/ilp` is the one-line check; `make hs-address`
  prints the address.
- **A payer's channel store fell behind the connector's watermark** — a
  store carried over from an older snapshot, a `make down` between a signed
  voucher and its ack, or a store deleted outright. A voucher has no nonce
  and must strictly exceed the connector's watermark, so the first voucher
  such a payer signs is refused; `@toon-protocol/client` 4.x then adopts the
  watermark the refusal names, or asks `POST /ilp/claim-state` with a signed
  challenge, and signs again — on the same channel. It heals itself.
  `make smoke-toon` step 1b proves it on every run: it stops
  `directory-publisher`, deletes its `channels.json` (keeping the channel
  binding beside it, `channels.peers.json`), starts it, and requires its next
  relay write to land on the same channel above the old watermark. That is
  what replaced the channel-state preflight every relay-writing smoke used to
  run first. The two numbers, by hand:

  ```bash
  docker compose --profile payments exec -T directory-publisher cat /var/lib/toon-publisher/channels.json
  curl -s -H "authorization: Bearer $(cat keys/toon/relay-connector/operator-bearer.token)" \
      http://localhost:3200/claims | grep <that channel account>
  ```
- **`F01`/collateral refusals after a chain restart**: anvil keeps nothing
  and the validator runs `--reset`, so a kept channel store — a client's, or
  a connector's outbound journal — outlives its chain. `smoke-m4` reads its
  channel's collateral back off the chain before it signs anything and
  starts a fresh channel when the old one is gone; a client of your own
  needs the same check, or a `make clean` (§7).

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
- **kind:5098 targets a sandbox probe**: the gas station whitelists
  `setTotalDeposit(bytes32,address,uint256)` on one target, and the sandbox's
  `SandboxTokenNetworkProbe` exposes exactly that selector and records
  `_msgSender()`. It stood in for the connector's TokenNetwork, which could
  never accept meta-transactions, and outlived it: nothing here settles
  through a TokenNetwork any more.
- **Brokered-ArNS ceremony residue** (upstream properties, not sandbox
  bugs): the spawned ANT is not ACL-bootstrapped (the gas station's
  documented per-job ceiling), and the DVM's best-effort `syncAttributes`
  after a non-holder buy fails benignly (locally AnchorError 2006
  `ConstraintSeeds` on `ant_authority`; receipt carries
  `syncAttributesTxId: null`, logged non-fatal by the store).
- **The Dealer's channel to anytoon has a lifetime ceiling** (§6.7): a
  voucher amount is a `u64` in the connector, so it carries at most ~18.45
  ANYONE, some 460 bundles, before `make clean` (connector#1429).
- **Every Solana peering channel's rent is the payee's, and the hub's.**
  A sponsored open costs the receiving node ~0.0047 SOL of rent until the
  channel is reclaimed; the sandbox airdrops 100 SOL per key, far beyond any
  run.
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
- **A topology is a star, and its smoke stops at the payment layer** (§2, *A
  topology of your own*): every node is peered to `relay` and to nothing
  else, `relay2` forwards nothing, and only relay nodes can be hidden.
  `make smoke-topology` proves the selection, the paid writes, the peerings
  and the routes — not a stored blob or a spawned workload.
- **Store and claim-minter images must be built from sibling checkouts** —
  the store until upstream releases the local-endpoint overrides (then the
  commented image pin in `docker-compose.yml` works again), the claim minter
  indefinitely, since the anytoon repo publishes no image for it.
