# The public TOON devnet

The sandbox is a whole TOON network on your machine. This is the other one: a
small fleet of Linodes on public testnets, which anybody can reach and which
the console leases from. Nothing here touches mainnet — Base Sepolia and
Solana devnet carry no value, and the USDC is a mock mint anyone can draw from
the faucet.

```bash
node sandbox/scripts/devnet-status.mjs     # or: make devnet-status, from sandbox/
```

That is the fastest way to see what is up. Every check it makes is free: it
opens no channel, signs nothing and holds no key, which matters because a
funded wallet is the one thing a newcomer does not have.

## The boxes

Each one is **GitOps** (connector ADR 0068): its own repository holds a
`deploy/` bundle, a `toon-auto-apply` timer on the box fast-forwards the branch
it follows every five minutes and applies it, and **nothing outside the box can
make the box deploy**. A dirty working tree there stops the timer, loudly.

| Box | Repository | Serves |
|---|---|---|
| store | `toon-protocol/store` | `proxy.ario.devnet…`, `dvm.devnet…` — paid Arweave blob storage at `g.toon.store` |
| relay | `toon-protocol/relay` | `proxy.relay.devnet…`, `relay-ws.devnet…` — paid Nostr writes at `g.toon.relay`, free reads over `wss://` |
| gas | `toon-protocol/gas-station` | `proxy.gas.devnet…` — sponsored transactions at `g.toon.gas` |
| faucet | (hand-deployed) | `faucet.devnet…` — mock USDC on both chains |
| **provider** | `toon-protocol/provider` | `proxy.provider.devnet…`, `provider.devnet…` — compute at `g.toon.provider` |
| **workload-gateway** | `toon-protocol/gateway` | `*.gw.devnet…`, `proxy.gateway.devnet…` — a hostname for a workload |

The last two are new (TOON_Network#86) and are what the console leases from.

### The provider box

`g.toon.provider`, a Linode 4 GB in us-east. It sells containers on its own
Docker daemon; a tenant reaches its workload at the box's public address on the
host port its lease was given — **40000–40099** for SSH forwards and
**41000–42599** for published ports, which is why this is the one box in the
fleet with a wide open range.

Two tiers, published as Listings:

| Tier | Resources | Interval | Price | Capacity | Notes |
|---|---|---|---|---|---|
| `basic` | 500 mc / 512 MiB / 5 GB | 3600 s | 1000 µUSDC | 3 | also prices a Warm Standby at 400 |
| `ci` | 1000 mc / 1024 MiB / 10 GB | 3600 s | 5000 µUSDC | 1 | `capabilities = ["docker"]` — a `dind` sidecar of the lease's own |

`isolation = "shared-kernel"`, and that is not a placeholder. The provider's
only `ComputeBackend` is Docker, and **Linode's shared-CPU plans expose no
`/dev/kvm`** — verified on the box — so there is no hypervisor to build
`dedicated-host` on and no Kata to run. A relay filters on that tag, so it has
to be true.

A **Standby Set has to span two providers** (spec §7): a standby bought from
the provider already running the primary is no standby at all. This box sells
the standby *half*; the other half wants a second provider box, which is a
follow-up.

### The Workload Gateway box

`g.toon.workload-gateway`, a nanode. A tenant seals a **Gateway Handover** to
its connector at `proxy.gateway.devnet.toonprotocol.dev` (free), and the
workload is then served at `<label>.gw.devnet.toonprotocol.dev` over TLS.

The certificate is a **wildcard**, issued over **DNS-01** through the Porkbun
API — the gateway serves every label under its domain and a label is the
base32 of a workload id nobody can predict, so there is no per-name
certificate to issue. It is the only box in the fleet that validates that way.

A hostname the gateway holds no grant for answers `503` with
`toon-gateway-reason: no_grant`. That is the healthy, empty state: the gateway
answered and dialled nobody.

```bash
curl -i https://anything.gw.devnet.toonprotocol.dev/
```

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

So standing a new paid box up has a human step in the middle of it, and it is
this one.

## Finishing a box that is waiting on gas

Each new box needs a small amount of devnet SOL on the Solana settlement key
its `deploy/` bundle generated. Print the address, fund it, and re-run the
bootstrap — which is idempotent and will pick up where it stopped.

```bash
# On the box. --print-keyid gives the raw ed25519 public key in hex; Solana
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

The provider box needs a second funded identity: the **directory publisher's**
wallet, which holds the payment channel that buys one `g.toon.relay` write per
directory event. Its address is derived from `PUBLISHER_MNEMONIC` in
`deploy/.env`; give it a little SOL and 1000 mock USDC from the faucet. Until
it can pay, the provider runs perfectly and **publishes nothing**, so it does
not appear in the Provider Directory at all — which is the failure
`devnet-status.mjs` exists to name out loud.

## Verifying it end to end

`devnet-status.mjs` covers everything that costs nothing. Past that:

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

`toonprotocol.dev` is on Porkbun. The devnet's records:

| Record | Points at |
|---|---|
| `proxy.ario.devnet`, `dvm.devnet` | the store box |
| `proxy.relay.devnet`, `relay-ws.devnet` | the relay box |
| `proxy.gas.devnet`, `gas.devnet` | the gas box |
| `faucet.devnet` | the faucet box |
| `proxy.provider.devnet`, `provider.devnet` | the provider box |
| `gw.devnet`, `*.gw.devnet`, `proxy.gateway.devnet` | the workload-gateway box |

Three stale records are worth knowing about, because they resolve and answer
nothing: `*.pay.toonprotocol.dev` and `connector.toonprotocol.xyz` point at an
address that is not in the account, and `proxy.devnet.toonprotocol.dev` points
at a box that is gone.
