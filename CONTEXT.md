# infra

The infrastructure TOON Protocol networks run on: the local sandbox, and the
public devnet on public testnets.

## Language

### Networks

**Sandbox**:
A whole TOON network on one machine, as one `docker compose` project, on local chains.
_Avoid_: local devnet, dev stack

**Devnet**:
The public TOON network on public testnets (Base Sepolia, Solana devnet), which anybody can reach and the console leases from.
_Avoid_: testnet, staging, the fleet

**Topology**:
A Sandbox run with only the Nodes named, settling only on the chains named, and with the Nodes named as hidden reached only over a hidden service.
_Avoid_: profile (compose's mechanism for it), stack, custom sandbox

### Where things run

**Host**:
One machine a network's nodes run on — on the devnet, a Linode.
_Avoid_: box, server, VM

**Node**:
One connector's deployed stack — the connector, the app behind it if any, and their keys — with its own ILP address and seal key, deployed from that app's own repository, or from infra when there is no app.
_Avoid_: box, service, deployment

**Dealer**:
A Node with no app behind it, which converts a forward from one token to another at a live rate and carries the FX risk between quoting a price and settling it (connector ADR 0071).
_Avoid_: bridge, swap, exchange

**Edge**:
The single TLS front on a host that terminates every public hostname the host serves: its nodes', and its Onboarder's.
_Avoid_: proxy, ingress, load balancer

**Hop**:
One connector forwarding a packet to a peered connector, whichever host each runs on.
_Avoid_: network hop, loopback

### Onboarding

**Onboarder**:
The service that puts a user's Funding Authorization (toon-meta's glossary) on chain and pays its gas, so a wallet holding USDC and no native gas can open a payment channel. On the wire it is a stock x402 facilitator offering `batch-settlement`; it never holds the user's funds. The sandbox runs one on anvil, and the devnet runs the same image on Base Sepolia at `onboard.devnet`.
_Avoid_: facilitator (x402's word for it), gas station (which relays operations on a channel the user already has), sponsor

### Relationships

- A **Topology** is a star: the relay Node named `relay` is the hub every other Node in it is peered to, and a Node run without the hub is paid at its own edge.
- A **Host** runs one **Edge** and any number of **Nodes**.
- A **Node** that accepts payment on EVM names the **Onboarder** its payers deposit through (connector ADR 0076).
- A **Node** has exactly one connector; nodes are never merged into a shared connector, because each one's seal key is pinned by what it publishes.
- A **Hop** between two nodes on the same host is still a real hop: two connectors, two keys, one payment channel.
- An **Onboarder** is not a **Node**: it has no connector, no ILP address and no seal key. On the devnet it runs on the **Host** behind the **Edge**, on its own network, the way a node does (ADR 0002).
- A **Dealer** pays the next Node as its client, not its peer, so that Node's app is still told who paid.
- An **Onboarder** serves EVM chains only. On Solana the receiving connector's operator sponsors the channel open itself.
