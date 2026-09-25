# The devnet edge

One Caddy on the devnet host that terminates TLS for every public hostname the
host's nodes serve (infra#24, ADR 0001, the **Edge** in `CONTEXT.md`). It owns
ports 80 and 443 and the Docker network `edge`. Each node joins that network
from its own repository's shared-edge overlay and is reached as
`alias:port`. The edge holds no node's keys and never talks ILP.

```
visitor ──▶ caddy :443 ──(network `edge`)──▶ relay-proxy:3000, store-proxy:4000, …
```

## The contract

All hostnames are under `toonprotocol.dev`. `caddy/sites.caddy` is the source
of truth and `bundle.test.mjs` holds it still.

| Node | Hostname | Alias on `edge` | Port |
|---|---|---|---|
| relay | `proxy.relay.devnet` | `relay-proxy` | 3000 |
| relay | `relay-ws.devnet` (WebSocket) | `relay-ws` | 7100 |
| store | `proxy.ario.devnet` | `store-proxy` | 4000 |
| store | `dvm.devnet` | `store-dvm` | 3400 |
| gas | `proxy.gas.devnet` | `gas-proxy` | 4000 |
| gas | `gas.devnet` | `gas-web` | 3400 |
| gateway | `gw.devnet`, `*.gw.devnet` | `gateway-gw` | 8443 (**TLS**) |
| gateway | `proxy.gateway.devnet` | `gateway-proxy` | 4000 |
| faucet | `faucet.devnet` | `faucet` | 3500 |

The ports are each container's own listening port, read off the front that
node shipped before (`relay/deploy/Caddyfile`, the nginx templates under
`store/`, `gas-station/`, `gateway/` `deploy/nginx/`, and
`connector/infra/linode-faucet/nginx/`). The rules those fronts applied beyond
plain proxying are carried over, each with its source cited in
`caddy/sites.caddy`:

- `/admin*` answers 404 on the store, gas and gateway-proxy names.
- Body limits: 4 MiB for the store, 512 KiB for gas, 1 MiB for the
  gateway proxy and the faucet, and 64 MiB for gateway workloads.
- Per-client rate limits: 400 per 2s on store, gas and gateway, and 60 per
  2s on the faucet, with `/health` exempt. An excess request gets **429**,
  where nginx answered 503.
- CORS on `/ilp/identity` for store and gas. That path always reaches the
  node's connector, on either of its names.
- The gateway's workload hop is TLS, with SNI `gateway` and no verification,
  so that the gateway tells a workload `X-Forwarded-Proto: https`. That hop
  sets `Host` to the visitor's explicitly, because Caddy would otherwise
  rewrite it to `gateway-gw` for an HTTPS upstream, and the gateway keys
  every grant off Host.

On every other hop, `Host`, `X-Forwarded-For`, `X-Forwarded-Proto: https`
and WebSocket upgrades are Caddy's defaults. Caddy re-resolves an alias on
every dial, so a recreated node container needs no edge reload.

## Certificates

Every name is issued over **DNS-01 through Porkbun** (`caddy/Caddyfile`). The
wildcard `*.gw.devnet` can only be issued that way. For the other names it
means a certificate exists **before** their DNS is flipped to this host, so
moving a node (infra#25) has no TLS gap. Porkbun API access must be enabled
for `toonprotocol.dev`. The keys are the same pair the workload gateway node
already uses.

## The image

`ghcr.io/toon-protocol/edge-caddy` is stock Caddy plus `caddy-dns/porkbun` and
`mholt/caddy-ratelimit`, built from `edge/Dockerfile` by
`.github/workflows/edge-image.yml`. We build it ourselves, not a community
image, because the Porkbun key, which can rewrite the whole zone, is handed to
it. `docker-compose.yml` pins it **by digest**.

> **PLACEHOLDER.** No image has been published yet.
> `docker-compose.yml` pins `sha256:000…000`, which is not a real image.
> `auto-apply.sh` refuses it by name. Replace it before the first deploy.

### Bumping the image

1. Merge a change under `edge/` to `main`. `edge-image.yml` builds it, pushes
   it, and prints `image: ghcr.io/toon-protocol/edge-caddy@sha256:…` in the
   run summary.
2. Commit that line into `docker-compose.yml`.
3. The host's timer pulls the image and recreates Caddy. This is the one
   change that restarts it. Certificates are on the `caddy_data` volume, so
   nothing is re-issued.

## Bring-up (on the host)

Start the edge **before** any node's overlay. This project creates `edge`, and
the overlays declare it external. Nothing else on the host may hold 80 or 443:
stop a node's old nginx, certbot or Caddy first (ADR 0001).

```bash
git clone https://github.com/toon-protocol/infra /root/infra
cd /root/infra/edge/deploy
cp .env.example .env && chmod 600 .env    # fill in ACME_EMAIL and the Porkbun pair
docker compose up -d
docker compose logs -f caddy              # watch the certificates issue

cp toon-edge-auto-apply.service toon-edge-auto-apply.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now toon-edge-auto-apply.timer
```

The units are named `toon-edge-auto-apply`, not `toon-auto-apply`, because
every node on this host installs a `toon-auto-apply` of its own. For the same
reason the script takes its own lock.

## How updates arrive

`auto-apply.sh`, every five minutes, runs the same GitOps loop as every node
(connector ADR 0068). It fast-forwards `TRACK_BRANCH` (default `main`). Then
it runs `compose pull` and `up -d`, waits for Caddy to be healthy, and runs
`caddy reload`. A reload is graceful and keeps open WebSockets for up to 5
minutes (`stream_close_delay`). An **invalid config is rejected and the old
one keeps serving**, and the run fails loudly. A dirty working tree stops the
timer. The last commit applied successfully is recorded in `.applied`, so a
failed apply is retried, and keeps failing loudly, every five minutes rather
than going quiet once `HEAD` matches `origin`.

## Testing it

```bash
node --test edge/deploy/bundle.test.mjs   # the contract, the pins, the rules; no Docker
edge/deploy/test/smoke.sh                 # the edge on local Docker, end to end
```

`smoke.sh` builds the image and brings the edge up with production's compose
and production's `sites.caddy`. The only change is Caddy's internal CA in
place of ACME (`test/Caddyfile`), on loopback ports 18080 and 18443. It starts
two stub nodes in a separate compose project that joins `edge` the way an
overlay does: `store-proxy` and the wildcard's `gateway-gw`. Then it checks
routing, `Host`, `X-Forwarded-Proto`, the TLS hop and its SNI, the wildcard
certificate, `no_grant`, `/admin`, the body cap, CORS, the redirect, a 502
for a node that is down, the rate limit, `mem_limit`, and who owns the
network. It refuses to run where a network named `edge` already exists.
