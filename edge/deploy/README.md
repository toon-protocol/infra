# The devnet edge

One Caddy on the devnet host that terminates TLS for every public hostname the
host's nodes serve (infra#24, ADR 0001, the **Edge** in `CONTEXT.md`). It owns
ports 80 and 443 and five Docker networks, **one per node**: `edge-relay`,
`edge-store`, `edge-gas`, `edge-gateway` and `edge-faucet`. Caddy joins all
five. Each node joins **only its own**, from its repository's shared-edge
overlay, and is reached as `alias:port`. The edge holds no node's keys and
never talks ILP.

```
visitor ──▶ caddy :443 ──(edge-store)────▶ store-proxy:4000, store-dvm:3400
                       ──(edge-gateway)──▶ gateway-gw:8443, gateway-proxy:4000
                       ──(…)─────────────▶ …
```

Why not one flat network: on one, every node could reach every other node's
connector, its `/admin` included, and the gateway's handover door, none of
which is ever public. With a network per node, only the edge reaches a node,
and nodes reach each other only through hops they pay for. `test/smoke.sh`
checks this.

## The contract

All hostnames are under `toonprotocol.dev`. `caddy/sites.caddy` is the source
of truth and `bundle.test.mjs` holds it still.

| Node | Network | Hostname | Alias | Port |
|---|---|---|---|---|
| relay | `edge-relay` | `proxy.relay.devnet` | `relay-proxy` | 3000 |
| relay | `edge-relay` | `relay-ws.devnet` (WebSocket) | `relay-ws` | 7100 |
| store | `edge-store` | `proxy.ario.devnet` | `store-proxy` | 4000 |
| store | `edge-store` | `dvm.devnet` | `store-dvm` | 3400 |
| gas | `edge-gas` | `proxy.gas.devnet` | `gas-proxy` | 4000 |
| gas | `edge-gas` | `gas.devnet` | `gas-web` | 3400 |
| gateway | `edge-gateway` | `gw.devnet`, `*.gw.devnet` | `gateway-gw` | 8443 (**TLS**) |
| gateway | `edge-gateway` | `proxy.gateway.devnet` | `gateway-proxy` | 4000 |
| faucet | `edge-faucet` | `faucet.devnet` | `faucet` | 3500 |

A node's overlay declares its network `external: true` and keeps its own
`default: {}` network for its services' traffic among themselves.

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

### Bumping the image

1. Merge a change under `edge/` to `main`. `edge-image.yml` builds it, pushes
   it, and prints `image: ghcr.io/toon-protocol/edge-caddy@sha256:…` in the
   run summary.
2. Commit that line into `docker-compose.yml`.
3. The host's timer pulls the image and recreates Caddy. This is the one
   change that restarts it. Certificates are on the `caddy_data` volume, so
   nothing is re-issued.

## Bring-up (on the host)

Start the edge **before** any node's overlay. This project creates the five
networks, and the overlays declare them external. Nothing else on the host may
hold 80 or 443: stop a node's old nginx, certbot or Caddy first (ADR 0001).

```bash
git clone https://github.com/toon-protocol/infra /root/infra
cd /root/infra/edge/deploy
cp .env.example .env && chmod 600 .env    # fill in ACME_EMAIL and the Porkbun pair
docker compose up -d
docker compose logs -f caddy              # watch the certificates issue

cp toon-auto-apply-edge.service toon-auto-apply-edge.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now toon-auto-apply-edge.timer
```

Every bundle on a shared host names its units `toon-auto-apply-<node>` and
takes the lock `/var/lock/toon-auto-apply-<node>.lock`, so several nodes can
live on one host without colliding. The edge's are `toon-auto-apply-edge.*`
and `/var/lock/toon-auto-apply-edge.lock`. The edge is new, so unlike the
nodes it has no old `toon-auto-apply.*` units to migrate at cutover.

## The faucet

The faucet is still hand-deployed from `connector/infra/linode-faucet` (GitOps
for it is a follow-up in infra#25). It joins `edge-faucet` under the alias
`faucet` through a **host-local** compose override. Nothing commits it
anywhere. Write it next to the faucet's compose file on the host, as
`connector/infra/linode-faucet/docker-compose.edge.yml`:

```yaml
# HOST-LOCAL, not committed: joins the hand-deployed faucet to the devnet edge
# (toon-protocol/infra#24, edge/deploy/README.md § "The faucet").
#
# The edge now terminates TLS for faucet.devnet.toonprotocol.dev and owns 80
# and 443, so this box's own nginx and certbot must not start: a profile
# nothing activates keeps them out of every `up`.
services:
  faucet:
    networks:
      default: {}
      edge-faucet:
        aliases: [faucet]
  nginx:
    profiles: [replaced-by-edge]
  certbot:
    profiles: [replaced-by-edge]

networks:
  edge-faucet:
    external: true
    name: edge-faucet
```

It also keeps the faucet's own nginx and certbot out of every `up`. The edge
now holds 80 and 443 and terminates `faucet.devnet` itself, carrying over that
nginx's rate limit, `/health` exemption and 1 MiB body cap. A profile that
nothing activates is what keeps them out. Profiles do not stop containers that
are already running, so take the old stack down first. From the connector
checkout's root on the host:

```bash
docker compose -f infra/linode-faucet/docker-compose.faucet.yml down
docker compose -f infra/linode-faucet/docker-compose.faucet.yml \
               -f infra/linode-faucet/docker-compose.edge.yml up -d --build
```

Run `docker compose config --services` with both files and it lists
`faucet` alone. The file is untracked in the connector checkout, so `git
status` there shows it. That is expected, and nothing on that checkout runs a
dirty-tree check.

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

If `.env` sets `COMPOSE_FILE`, the script passes no `-f` and lets
`docker compose` read it. It never reads the value. Otherwise it uses
`docker-compose.yml`. The edge ships no overlay today.

## Testing it

```bash
node --test edge/deploy/bundle.test.mjs   # the contract, the pins, the rules; no Docker
edge/deploy/test/smoke.sh                 # the edge on local Docker, end to end
```

`smoke.sh` builds the image and brings the edge up with production's compose
and production's `sites.caddy`. The only change is Caddy's internal CA in
place of ACME (`test/Caddyfile`), on loopback ports 18080 and 18443. It starts
two stub nodes, each in **its own** compose project on **its own** network,
the way an overlay joins: `store-proxy` on `edge-store`, and the wildcard's
`gateway-gw` on `edge-gateway`. Then it checks:

- routing, `Host`, `X-Forwarded-Proto`, the TLS hop and its SNI;
- the wildcard certificate and `no_grant`;
- `/admin`, the body cap, CORS, the redirect, and a 502 for a node that is down;
- the rate limit and `mem_limit`;
- that the edge is on all five networks and created them;
- that the store stub **cannot** reach the gateway stub by alias or by IP
  address, with a control probe that does reach the store's own alias.

It refuses to run where any of the five network names already exists.
