---
status: accepted
---

# The Onboarder runs on the devnet host, but is not a node

The devnet needs an **Onboarder** (`CONTEXT.md`): x402's stock facilitator on
Base Sepolia, so a wallet holding devnet USDC and no ETH can open a channel,
the way it would on mainnet (infra#23, connector ADR 0074). We run our own
rather than point at x402.org's hosted one, for the reasons in connector
`docs/research/x402-devnet-facilitators.md`: that one is marked for testing
only, shares one signer across everyone, and nobody has seen it relay a
batch-settlement deposit. The hosted one stays useful as an interop check,
never as a dependency.

We run it on the one devnet host, behind the edge, on its own network
`edge-onboarder`, and from this repo (`onboarder/deploy`, GitOps on its own
timer). It is **not a Node**. It has no connector, no ILP address and no seal
key, and nothing pays it over ILP, so none of what ADR 0001 says a node keeps
applies to it. What it shares with a node is only how it is fronted and
deployed. It measured 49 MiB idle, which the nanode has room for.

## Considered Options

- **A node of its own, in its own repository**: rejected. There is nothing
  node-like to keep: no connector and no keys to pin. And it is built from the
  same directory the sandbox builds, which lives here.
- **Inside the gas station**: rejected. The gas station relays operations on a
  channel the user already has, paid over that channel. Onboarding comes
  before any channel exists, and x402 already has a client, a facilitator and
  an audited contract for it. Folding it in would mean re-implementing x402's
  facilitator inside a TOON app.
- **A separate Linode**: rejected. It would cost more than the whole devnet
  does now ($5/month), for a 49 MiB service that holds no one's funds.
- **x402.org's hosted facilitator**: rejected as the devnet's dependency, for
  the reasons above.

## Consequences

- The edge fronts six networks: five nodes, and the Onboarder.
- `/root/infra` on the host is applied by two timers, the edge's and the
  Onboarder's. They share a checkout lock around the git steps.
- The host now holds one more funded key, the Onboarder's gas payer, with no
  other role. Its balance is the only thing of value the service has. Every
  `/settle` spends it, so the edge rate-limits `onboard.devnet` like the
  faucet.
