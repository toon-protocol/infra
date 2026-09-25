# The public TOON devnet

The sandbox is a whole TOON network on your machine. This is the other one: the
relay, store, gas station and workload gateway nodes, plus the faucet, on
public testnets, which anybody can reach and which the console leases from.
Nothing here touches mainnet — Base Sepolia and Solana devnet carry no value,
and the USDC is a mock mint anyone can draw from the faucet.

```bash
node sandbox/scripts/devnet-status.mjs     # or: make devnet-status, from sandbox/
```

That is the fastest way to see what is up. Every check it makes is free: it
opens no channel, signs nothing and holds no key, which matters because a
funded wallet is the one thing a newcomer does not have. Since 2026-09-25 it
will also report no provider in the Provider Directory — see "No provider"
below — and that is expected, not a failure.

## The host

Since 2026-09-25 the whole devnet runs on **one Host** (`CONTEXT.md`): the
relay's existing Linode, `g6-nanode-1` (961 MB), at `97.107.134.182`. It was
**not** resized — ADR 0001 originally planned a 2 GB Linode, but memory
measured at cutover (each connector 2–7 MB idle; the apps 28–92 MB apiece; the
host using about 600 of 961 MB in total) showed the fleet fits on the nanode
as it stood, so it stayed a $5/month box. Before the move this was six
Linodes at about $49/month; see ADR 0001's amendment for the corrected
before/after numbers.

One **Edge** (`edge/deploy` in this repo — Caddy, TLS issued over Porkbun
DNS-01, its image pinned by digest) terminates every public hostname the host
serves. Behind it sit four **Nodes**, each still GitOps from its own
repository (connector ADR 0068) — its own `deploy/` bundle, a shared-edge
overlay that joins only that node's `edge-<node>` network, and its own
`toon-auto-apply-<node>` timer and lock, so a stuck or dirty node never blocks
another node's or the edge's apply — plus the faucet, still hand-deployed.

| Node | Repository | Serves |
|---|---|---|
| relay | `toon-protocol/relay` | `proxy.relay.devnet…`, `relay-ws.devnet…` — paid Nostr writes at `g.toon.relay`, free reads over `wss://` |
| store | `toon-protocol/store` | `proxy.ario.devnet…`, `dvm.devnet…` — paid Arweave blob storage at `g.toon.store` |
| gas | `toon-protocol/gas-station` | `proxy.gas.devnet…` — sponsored transactions at `g.toon.gas` |
| workload-gateway | `toon-protocol/gateway` | `*.gw.devnet…`, `proxy.gateway.devnet…` — a hostname for a workload |
| faucet | (hand-deployed, from `/root/faucet-connector/infra/linode-faucet`) | `faucet.devnet…` — mock USDC on both chains |

Every node kept its own connector, its own keys, its own ILP address and its
own seal key across the move — nothing was re-keyed or republished, and no
client-facing hostname changed. Only DNS moved: see "DNS" below.

### No provider

The devnet runs no compute provider any more. The old provider Linode (it was
the one 4 GB box in the old fleet) was stopped and its identity backed up, not
folded into the host — ADR 0001 rejected a host that also ran the provider,
since tenants would then share a kernel, and with the `ci` tier a privileged
`dind`, with every node's settlement key and the faucet's mint authority. A
provider on the devnet is now a follow-up, run by its own operator on their
own machine — for example a Hidden Provider (spec §10) — rather than
something this repo stands up again.

### The Workload Gateway node

A tenant seals a **Gateway Handover** to its connector at
`proxy.gateway.devnet.toonprotocol.dev` (free), and the workload is then
served at `<label>.gw.devnet.toonprotocol.dev` over TLS. This node is
unchanged by the move other than its DNS: it still runs from
`toon-protocol/gateway`, still keeps its own connector and keys, and is still
what the console leases a hostname from.

The certificate is a **wildcard**, issued over **DNS-01** through the Porkbun
API — the gateway serves every label under its domain and a label is the
base32 of a workload id nobody can predict, so there is no per-name
certificate to issue. It is the only node on the host that validates that way
(the edge holds the same Porkbun keys the gateway node already used).

A hostname the gateway holds no grant for answers `503` with
`toon-gateway-reason: no_grant`. That is the healthy, empty state: the gateway
answered and dialled nobody.

```bash
curl -i https://anything.gw.devnet.toonprotocol.dev/
```

## Adding a node to the host

Landing another node on this host means four things, each already contracted
by `edge/deploy/README.md` and connector ADR 0068:

1. **The node's shared-edge overlay**, shipped off by default in the node's
   own repository, turned on. It joins the node to the edge's `edge-<node>`
   Docker network — and only that network — under the alias and port
   `caddy/sites.caddy` names for it.
2. **A per-node timer and lock**: `toon-auto-apply-<node>.{service,timer}` and
   `/var/lock/toon-auto-apply-<node>.lock`, so the new node's GitOps loop can
   never collide with another node's or the edge's.
3. **A distinct connector loopback port.** Every node's connector still binds
   its own loopback admin port, and on a shared host those now collide unless
   each node is given a different one. The four nodes here were fixed by
   separate per-node PRs: relay `3000`, workload-gateway `4001`, gas-station
   `4002`, store `4003`.
4. **Its own connector, keys, ILP address and seal key**, copied over from
   wherever the node ran before — never regenerated, since they are already
   funded and pinned.

The faucet is the one exception: it has no shared-edge overlay of its own yet
(GitOps for it is a follow-up), so it joins the edge through a **host-local**
`docker-compose.edge.yml` written next to its compose file on the host —
see `edge/deploy/README.md` § "The faucet".

## Money, and the one thing no faucet gives you

Every paid TOON route is paid from a **payment channel**, and opening one is an
on-chain transaction. So a payer needs two things:

* **mock USDC**, which the faucet mints freely on either chain:
  ```bash
  curl -X POST https://faucet.devnet.toonprotocol.dev/api/solana/usdc-request \
    -H 'content-type: application/json' -d '{"address":"<base58>"}'
  curl -X POST https://faucet.devnet.toonprotocol.dev/api/base-sepolia/request \
    -H 'content-type: application/json' -d '{"address":"0x…"}'
  ```
* **native gas** — devnet SOL, or Base Sepolia ETH — which **it does not give
  you**. `GET /api/info` says so: the Solana leg is `usdc-only` and the EVM
  leg's ETH drip is disabled. The public `requestAirdrop` on
  `api.devnet.solana.com` has a daily cap and answers
  *"You've either reached your airdrop limit today or the airdrop faucet has
  run dry"* once it is hit. <https://faucet.solana.com> is the alternative and
  it is gated behind a sign-in.

This is not a footnote. **A connector whose Solana settlement key holds no SOL
does not start**: `SolanaSettlementBackend::connect` submits and confirms a
real transaction at boot (an idempotent associated-token-account create), and
an unfunded key is

```
failed to construct the configured settlement backend: settlement backend error:
RPC response error -32002: Transaction simulation failed: Attempt to debit an
account but found no record of a prior credit.
```

followed by a restart loop. The EVM leg has no such requirement — Base Sepolia
boot is read-only — but a *payer* on either chain still needs gas of its own.

So standing a new paid node up has a human step in the middle of it, and it is
this one. Day to day, the operator also keeps a dev funder wallet on hand for
topping an existing node's settlement key back up if it runs low; no key,
mnemonic or address for it belongs in this file.

## Finishing a node that is waiting on gas

Each new node needs a small amount of devnet SOL on the Solana settlement key
its `deploy/` bundle generated. Print the address, fund it, and re-run the
bootstrap — which is idempotent and will pick up where it stopped.

```bash
# On the host. --print-keyid gives the raw ed25519 public key in hex; Solana
# spells the same bytes in base58.
cd /root/<repo>/deploy
T=$(mktemp -d); chmod 755 "$T"; cp settlement-solana.key "$T/k"; chmod 644 "$T/k"
docker run --rm -v "$T:/d:ro" ghcr.io/toon-protocol/connector:rust-2026.09.11.1 \
  send --operator-key /d/k --print-keyid
rm -rf "$T"
```

Convert that hex to base58, fund it with ~1 SOL, then:

```bash
./bootstrap.sh          # idempotent: re-running reconciles rather than rebuilds
```

A provider node, when one is stood up again, will need a second funded
identity: the **directory publisher's** wallet, which holds the payment
channel that buys one `g.toon.relay` write per directory event. Its address is
derived from `PUBLISHER_MNEMONIC` in `deploy/.env`; give it a little SOL and
1000 mock USDC from the faucet. Until it can pay, a provider runs perfectly
and **publishes nothing**, so it does not appear in the Provider Directory at
all — which is the failure `devnet-status.mjs` exists to name out loud (and,
today, with no provider running at all, is expected to name every time).

## Verifying it end to end

`devnet-status.mjs` covers everything that costs nothing. Past that, once a
provider is running again:

1. **A spawn.** Buy `g.toon.provider.basic.v1.spawn` at
   `https://proxy.provider.devnet.toonprotocol.dev` with a funded client. The
   sandbox's `scripts/spawn.mjs` is the same ceremony, written for the
   sandbox's own addresses and its committed test wallet.
2. **A handover.** Seal a Gateway Handover to
   `g.toon.workload-gateway.handover` at
   `https://proxy.gateway.devnet.toonprotocol.dev`, using
   `provider/tools/grant`. The gateway sends `status` to the members the
   handover names and admits it only if one of them takes the grant — there is
   no signature to check any more (spec §12.1, ADR 0016).
3. **The hostname.** `curl https://<label>.gw.devnet.toonprotocol.dev/` should
   reach the workload, with `X-Forwarded-Proto: https`.

### An extension's body is bare, and a wrong shape costs an interval

Driving the routes by hand is where this bites, so it is written down here
rather than left to spec §5. **`.extend` and `.standby.extend` take their
content bare:**

```json
{ "workload_id": "…" }
```

Every other lease route — `.spawn`, `.standby`, `.status`, `.terminate`,
`.rotate` — takes the spec §6.1 Lease Request envelope instead:

```json
{ "request": { "request_id": "…", "op": "…", "provider": "…", "expiration": 0, "continuation": "…", "content": { … } } }
```

That is deliberate (ADR 0025): an extension presents no Continuation Token,
because paying the route is its whole authority and any payer may extend any
lease (ADR 0005). The envelope is the token's carriage, and there is nothing
here to carry.

**Getting it wrong is not free.** A connector collects a paid route's price
before the provider app sees the body (ADR 0003), so an extension wrapped in
`request` is answered

```json
{ "error": "invalid_request", "message": "body is not { \"workload_id\": \"…\" }: unknown field `request`, expected `workload_id`" }
```

**and is still billed a full Lease Interval** — 1000 µUSDC on devnet's `basic`
— with no refund. That is how TOON_Network#115 was found: a lease that should
have cost 2000 cost 3000. Build the body with the sandbox's `extendBody()` and
let `checkLeaseBody()` see every lease packet
(`sandbox/scripts/lib/lease-body.mjs`); `make smoke-extend-shape` measures both
outcomes on the connector's own book.

## DNS

`toonprotocol.dev` is on Porkbun. Since 2026-09-25 every one of the devnet's
records points at the one host, `97.107.134.182`:

| Record | Node |
|---|---|
| `proxy.ario.devnet`, `dvm.devnet` | store |
| `proxy.relay.devnet`, `relay-ws.devnet` | relay |
| `proxy.gas.devnet`, `gas.devnet` | gas |
| `faucet.devnet` | faucet |
| `gw.devnet`, `*.gw.devnet`, `proxy.gateway.devnet` | workload-gateway |

`proxy.provider.devnet` and `provider.devnet` are no longer part of the
devnet's contract: the edge has no `edge-provider` network and fronts no
provider node, so there is nothing configured to answer either name until a
provider runs again (see "No provider" above).

Three more stale records are worth knowing about, because they resolve and answer
nothing: `*.pay.toonprotocol.dev` and `connector.toonprotocol.xyz` point at an
address that is not in the account, and `proxy.devnet.toonprotocol.dev` points
at a host that is gone.
