# The devnet's Onboarder

The **Onboarder** (`CONTEXT.md`) puts a user's Funding Authorization on chain
and pays its gas, so a wallet holding devnet USDC and **no ETH** can open a
payment channel, the way it would on mainnet (infra#23, connector ADR 0074).
On the wire it is a stock **x402 facilitator** offering `batch-settlement` on
Base Sepolia (`eip155:84532`). It is the same image the sandbox builds from
`../`, pointed at a real chain.

```
https://onboard.devnet.toonprotocol.dev
  GET  /supported   batch-settlement on eip155:84532, no receiverAuthorizer
  GET  /health      ok, or 503 with the reason
  POST /verify      x402 v2 §7
  POST /settle      x402 v2 §7: relays the deposit, pays the gas
```

It is **not a Node**. It has no connector, no ILP address and no seal key, and
nothing pays it over ILP. It runs on the devnet host behind the edge, on its
own network `edge-onboarder`, the way a node would (ADR 0002 says why it lives
here). It never holds a user's funds. The only thing of value it has is the
gas payer's Base Sepolia ETH.

It offers **no `receiverAuthorizer`**. That key could refund a connector's
earned-but-unclaimed value, so a connector always names its own (ADR 0074
decision 5). Solana needs no Onboarder: there the receiving connector's
operator sponsors the open (decision 9).

## The key

`onboarder.key`, next to this README, holds the gas payer's private key as
`0x`-hex. It is mounted read-only as a file, so it never appears in
`docker inspect`. It is gitignored. Give it **no other role**: it is not a
node's settlement key, and not the dev funder.

Generate it with the image itself, so the host needs no other tooling. The
address goes to stderr and the key to the file:

```bash
cd /root/infra/onboarder/deploy
IMAGE=$(sed -n 's/^ *image: //p' docker-compose.yml)
(umask 077; docker run --rm --entrypoint node "$IMAGE" --input-type=module -e \
  "import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
   const key = generatePrivateKey(); console.log(key);
   console.error(privateKeyToAccount(key).address);" > onboarder.key)
```

Then fund that address with Base Sepolia ETH from the dev funder
(`docs/devnet.md` § "Money"). Each deposit it relays costs it gas, so keep a
few thousandths of an ETH there. `/health` goes 503 with `holds no ETH` when it
runs out. Back the key up with the others from the host.

## Bring-up (on the host)

1. **DNS**: an `A` record for `onboard.devnet.toonprotocol.dev` pointing at the
   host. The edge issues the certificate over DNS-01, so this can be done at
   any point.
2. **The edge first.** Its project creates `edge-onboarder`, and Caddy has to
   join it. The edge's own timer applies that once this change is merged.
   Adding a network recreates the Caddy container, which is a short blip for
   every node.
3. **This bundle.** `/root/infra` is the checkout the edge already runs from:

```bash
cd /root/infra/onboarder/deploy
cp .env.example .env && chmod 600 .env    # EVM_RPC_URL
# onboarder.key: § "The key", then fund its address
docker compose up -d
docker compose ps                          # healthy within ~30s

cp toon-auto-apply-onboarder.service toon-auto-apply-onboarder.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now toon-auto-apply-onboarder.timer
```

The units and lock follow the host's convention: `toon-auto-apply-onboarder.*`
and `/var/lock/toon-auto-apply-onboarder.lock`. This bundle shares the
`/root/infra` checkout with the edge, so both scripts also take
`/var/lock/toon-infra-checkout.lock` while they fetch and fast-forward.

## The image

`ghcr.io/toon-protocol/onboarder` is built from `onboarder/Dockerfile` by
`.github/workflows/onboarder-image.yml`, and pinned **by digest** in
`docker-compose.yml`, because the gas payer's key is handed to it.

### Bumping the image

1. Merge a change under `onboarder/` to `main`. `onboarder-image.yml` builds
   and pushes it, and prints `image: ghcr.io/toon-protocol/onboarder@sha256:…`
   in the run summary.
2. The **first** time, the package is created private. Make it public in the
   org's package settings, or the host's anonymous pull fails.
3. Commit that line into `docker-compose.yml`. The timer pulls it and
   recreates the service.

Until step 3 has happened once, the bundle pins an all-zero placeholder, and
`auto-apply.sh` refuses it by name rather than failing a pull.

## How updates arrive

`auto-apply.sh` runs every five minutes, in the edge's shape (see its header
for the differences). It fast-forwards `TRACK_BRANCH` (default `main`), runs
`compose pull` and `up -d`, and waits for `/health`. A failed apply prints
`/health`'s reason, is not recorded in `.applied`, and is retried.

## Verifying it

```bash
curl -s https://onboard.devnet.toonprotocol.dev/supported   # batch-settlement, eip155:84532, signers
curl -s https://onboard.devnet.toonprotocol.dev/health      # "status":"ok", the gas payer and its balance
```

`/supported` must list `batch-settlement` on `eip155:84532`, and no extra
`receiverAuthorizer`. The end-to-end check is a deposit of devnet USDC, from a
wallet holding 0 ETH, to a devnet connector's `payTo`, then reading the channel
back on chain. The sandbox's `../smoke.mjs` does exactly that against anvil.

## Testing it

```bash
node --test onboarder/config.test.mjs onboarder/deploy/bundle.test.mjs
```
