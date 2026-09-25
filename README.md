# infra

Infrastructure for the TOON Protocol.

## The dev sandbox

**[`sandbox/`](sandbox/README.md)** is a complete TOON Protocol network on
your machine: one `docker compose` project with local chains (Solana, EVM,
Arweave-sim), a local AR.IO permaweb stack (gateway + Turbo bundler + ArNS),
the TOON payment layer (four ILP connectors with real, collateralised
payment channels, settling mock USDC on Solana and **ANYONE on the EVM chain
across a live Uniswap v3 rate**), and the four first-party TOON apps (relay,
store, gas station, Anyone credentials issuer). Nothing touches mainnet; every
key is a valueless committed throwaway.

```bash
cd sandbox
make setup && make up && make smoke
```

`make smoke` proves the whole thing end to end — paid Nostr writes, paid
Arweave uploads served by the local gateway, the full brokered ArNS buy
ceremony, paid gas on both chains, and a blind-signed credentials bundle
bought **across a denomination boundary**: all entering at the hub connector,
settling on local payment channels, in the unit each leg is actually
denominated in.

Working on the payment layer or on a TOON client? `make up-payments && make
smoke-payments` runs the chains, the hub and its seed jobs alone — seven
services, five ports, and none of the permaweb half's prerequisites.

**Read the [operator guide](sandbox/README.md)** — it covers what's running,
a cookbook for every surface, and a step-by-step path to putting **your own
app** behind a TOON connector (from a five-minute route on the hub to your
own peered connector in the production shape).

## The public devnet

**[`docs/devnet.md`](docs/devnet.md)** is the other network: relay, store, gas
station and **Workload Gateway** nodes, plus the faucet, on public testnets
that anybody can reach and that the console leases from. Since 2026-09-25
(infra#25) they all run on **one host** behind one **edge** — the relay's
existing Linode, about $5/month, not resized — and the devnet runs no compute
provider of its own any more. Every node is still GitOps: its own repository
holds its `deploy/` bundle, a shared-edge overlay, and a per-node timer that
applies what merged.

```bash
cd sandbox && make devnet-status
```

Free, and needs neither `make up` nor a funded wallet: it asks each node what
it terminates and what it settles in, asks the gateway for a hostname nobody
handed over, and reads the Provider Directory off the relay.

## Also in this repo

- [`edge/deploy/`](edge/deploy/README.md): the devnet host's **edge**
  (infra#24, ADR 0001). One Caddy terminates TLS for every node on the
  host, and it owns the per-node networks (`edge-relay`, `edge-store`, …)
  each node joins.
- [`docs/research/local-dev-infra.md`](docs/research/local-dev-infra.md) —
  the primary-source research the sandbox was built from.
- Branch `prototype/local-ar-io-stack` — the three throwaway prototypes
  whose `VERDICT.md`s carry the detailed evidence behind the sandbox's
  design decisions.
- [`docs/agents/`](docs/agents/) — agent workflow conventions for this repo
  (issue tracker, triage labels, domain docs).
