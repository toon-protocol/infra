# infra

Infrastructure for the TOON Protocol.

## The dev sandbox

**[`sandbox/`](sandbox/README.md)** is a complete TOON Protocol network on
your machine: one `docker compose` project with local chains (Solana, EVM,
Arweave-sim), a local AR.IO permaweb stack (gateway + Turbo bundler + ArNS),
the TOON payment layer (a hub and five peered ILP connectors on the
x402-only connector release: every channel an x402 `batch-settlement`
channel — FiatToken USDC on the EVM chain, deposited gaslessly through a local
**Onboarder**, and mock USDC on Solana, sponsored by the receiving node — and
every payment a voucher; one of them is the **Dealer**, which pays the Anyone
credentials issuer's connector in ANYONE at a live Uniswap v3 TWAP), and the
first-party TOON apps (relay, store, gas station, two compute providers, the
Anyone credentials issuer). Nothing touches mainnet; every key is a valueless
committed throwaway.

```bash
cd sandbox
make setup && make up && make smoke
```

`make smoke` proves the whole thing end to end — every node's x402 terms, the
peerings open on chain, paid Nostr writes, paid Arweave uploads served by the
local gateway, the full brokered ArNS buy ceremony, paid gas on both chains,
and a gasless EVM deposit with a voucher paid on it: all entering at the hub
connector, every leg's voucher watermark asserted in the connectors' own
books. Coming from an older sandbox? `make clean` first — `make up` says so.

Working on the payment layer or on a TOON client? `make up-payments && make
smoke-payments` runs the chains, the hub and the two compute providers alone
— none of the permaweb half's prerequisites.

Want only part of it? `make up-topology` starts just the nodes you name, on
just the chains you name, with relay nodes optionally reached only over a
hidden service — and nothing else:

```bash
make up-topology NODES=relay                             # a connector and a relay
make up-topology NODES="relay relay2 store" CHAINS=evm    # two relay nodes and a store, EVM only
make up-topology NODES="relay relay2" HS=relay            # the hub reached only at a .anyone address
make smoke-topology                                       # prove whatever is running
```

`NODES` is any of `relay relay2 store gas provider provider2 anytoon dealer`,
`CHAINS` is `evm`, `solana` or both. The operator guide's §2, *A topology of
your own*, says what each node needs and what has been run.

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
