---
status: accepted
---

# The devnet is one host; every node keeps its own connector

> **Amended 2026-09-25**: the numbers below were wrong at the time this ADR
> was written. All six Linodes were `g6-nanode-1` (961 MB) except the
> provider, a `g6-standard-2` (4 GB) — about $49/month, not $68, and the
> faucet was a nanode, not a 4 GB box. And at cutover the host was **not**
> resized to 2 GB as planned below: memory measured on the relay's own
> nanode showed the whole fleet fit on it as it stood, so it stayed a
> $5/month nanode. See `docs/devnet.md` for the shape that was actually
> deployed.

The devnet has to cost under $25 a month, and six Linodes (five nanodes and
one 4 GB box — the provider — about $49) did not. So the relay, store, gas
station, workload gateway and faucet nodes all run on one host — the relay's
Linode, resized to 2 GB — behind one edge that this repo owns, and the devnet
runs no compute provider of its own. We co-located the nodes rather than
merging them behind a single connector: a node's seal key is pinned by what it publishes (a relay's
information document, TOON_Network ADR 0024; a gateway's URL, ADR 0027; ADR 0013
has the gateway reached through its own connector), so merging would mean
re-keying and republishing all of it, and it would turn `g.toon.relay.store`
and `g.toon.relay.gas` into routes a connector serves to itself. That would
save a few hundred MB of RAM and nothing else. A hop between two nodes on the
same host is still a real hop.

## Considered Options

- **One connector for every app** — rejected: see above; it also puts every app's routes and prices in one repo, against connector ADR 0068.
- **One 4 GB host that also runs the provider** — rejected: tenants would share a kernel, and with `ci` a privileged `dind`, with every node's settlement key and the faucet's mint authority.
- **The faucet on GitHub** — not possible: Pages is static, and the Solana leg needs a server holding the mint authority.

## Consequences

- No app bundle ships its own nginx, certbot, Caddy or watchtower any more; ports 80 and 443 belong to the edge, and an old bundle that still starts a proxy fights it for them.
- The devnet has no guaranteed provider. Anybody's provider — hidden or public — is one the directory may or may not list.
- Every service carries a memory limit, since one node's leak now takes down the other four.
