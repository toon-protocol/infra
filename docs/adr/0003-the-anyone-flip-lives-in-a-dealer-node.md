---
status: accepted
---

# The sandbox's ANYONE flip lives in a Dealer node

The sandbox sells Anyone credentials, which `anytoon-connector` is paid for in
ANYONE on anvil, to clients who pay in USDC. Until the sandbox went x402-only
(infra#39), the hub did the conversion: it held mock USDC on Solana and ANYONE on
EVM, and dealt between them at a live Uniswap v3 TWAP (connector ADR 0071).
Under #39 the hub settles FiatToken USDC on EVM like every other node, and a node
holds one token per chain, so the hub can no longer be the one that pays ANYONE
out (infra#42).

We give the flip its own **Dealer** (`CONTEXT.md`), `dealer-connector` at
`g.toon.dealer`. It holds USDC on Solana and ANYONE on EVM, carries the
`[[tokens]]` quote and the FX buffer, and is reached by the hub over Solana USDC
at par. It pays anytoon as a **client**, not as a peer: anytoon binds nothing for
it. A forwarded packet states no payer (connector ADR 0040), and the claim minter
behind anytoon refuses a purchase it cannot attribute. On a client-role
arrival, anytoon's app is told the payer, which is the dealer's channel.

## Considered Options

- **Anytoon takes a Solana table**: rejected. A route has one `price` in base
  units, and a claim is denominated by the chain its channel is on, so a Solana
  client would be charged anytoon's ANYONE price as µUSDC, off by 10^12. The
  connector deliberately has no per-chain price.
- **The hub keeps the flip**: not possible under #39, which moves the hub's EVM
  table to FiatToken USDC.
- **The dealer peers with anytoon**: rejected. Every paid bundle would reach the
  claim minter unattributed and be refused after the client had paid.

## Consequences

- One more connector in the sandbox, with its own keys and seed step. The devnet
  has no anytoon, so it gets no dealer.
- Two hops' fees now sit in front of anytoon. The key document costs a client
  210 µUSDC instead of 110, because 10 µUSDC at the worst expected rate does not
  cover the dealer's fee on the ANYONE leg.
- A voucher's amount is `u64` in the connector, so the dealer's channel to
  anytoon carries at most about 18.45 ANYONE over its lifetime. That is fine for
  a sandbox that `make clean` resets.
