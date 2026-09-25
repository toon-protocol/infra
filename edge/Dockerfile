# The devnet edge's Caddy: stock Caddy plus exactly two plugins.
#
#   caddy-dns/porkbun      DNS-01 through the Porkbun API. The wildcard
#                          *.gw.devnet.toonprotocol.dev can only be issued over
#                          DNS-01, and toonprotocol.dev is on Porkbun.
#   mholt/caddy-ratelimit  the nginx fronts' `limit_req`, carried over
#                          (edge/deploy/caddy/sites.caddy).
#
# Built by .github/workflows/edge-image.yml and pushed to
# ghcr.io/toon-protocol/edge-caddy; edge/deploy/docker-compose.yml pins the
# result by digest. We build our own rather than run a community image because
# the Porkbun API key -- which can rewrite every record in the zone -- is handed
# to whatever binary runs here.
#
# Everything is pinned: the base images by digest, porkbun by release tag, and
# caddy-ratelimit by commit (its only release, v0.1.0, predates the default
# directive order this bundle relies on). Bump them together, deliberately.

FROM caddy:2.11.4-builder-alpine@sha256:2b9f32cbba6045e79212bb253f595588d20be8f7d1edf61582c519e124e0d2d8 AS builder

RUN xcaddy build \
      --with github.com/caddy-dns/porkbun@v0.3.1 \
      --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Fail the build, not the deploy, if a plugin did not make it in.
RUN caddy list-modules | grep -qx 'dns.providers.porkbun' \
 && caddy list-modules | grep -qx 'http.handlers.rate_limit'
