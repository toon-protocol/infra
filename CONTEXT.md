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

### Where things run

**Host**:
One machine a network's nodes run on — on the devnet, a Linode.
_Avoid_: box, server, VM

**Node**:
One app's deployed stack — its connector, the app behind it and their keys — with its own ILP address and seal key, deployed from that app's own repository.
_Avoid_: box, service, deployment

**Edge**:
The single TLS front on a host that terminates every public hostname its nodes serve.
_Avoid_: proxy, ingress, load balancer

**Hop**:
One connector forwarding a packet to a peered connector, whichever host each runs on.
_Avoid_: network hop, loopback

### Relationships

- A **Host** runs one **Edge** and any number of **Nodes**.
- A **Node** has exactly one connector; nodes are never merged into a shared connector, because each one's seal key is pinned by what it publishes.
- A **Hop** between two nodes on the same host is still a real hop: two connectors, two keys, one payment channel.
