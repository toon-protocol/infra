# infra

Infrastructure for the TOON Protocol.

## The dev sandbox

**[`sandbox/`](sandbox/README.md)** is a complete TOON Protocol network on
your machine: one `docker compose` project with local chains (Solana, EVM,
Arweave-sim), a local AR.IO permaweb stack (gateway + Turbo bundler + ArNS),
the TOON payment layer (three ILP connectors with real, collateralised
payment channels — client leg on EVM, peerings on Solana), and the three
first-party TOON apps (relay, store, gas station). Nothing touches mainnet;
every key is a valueless committed throwaway.

```bash
cd sandbox
make setup && make up && make smoke
```

`make smoke` proves the whole thing end to end — paid Nostr writes, paid
Arweave uploads served by the local gateway, the full brokered ArNS buy
ceremony, and paid gas on both chains, all entering at the hub connector and
settling on local payment channels.

**Read the [operator guide](sandbox/README.md)** — it covers what's running,
a cookbook for every surface, and a step-by-step path to putting **your own
app** behind a TOON connector (from a five-minute route on the hub to your
own peered connector in the production shape).

## Also in this repo

- [`docs/research/local-dev-infra.md`](docs/research/local-dev-infra.md) —
  the primary-source research the sandbox was built from.
- Branch `prototype/local-ar-io-stack` — the three throwaway prototypes
  whose `VERDICT.md`s carry the detailed evidence behind the sandbox's
  design decisions.
- [`docs/agents/`](docs/agents/) — agent workflow conventions for this repo
  (issue tracker, triage labels, domain docs).
