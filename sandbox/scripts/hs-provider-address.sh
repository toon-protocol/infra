#!/usr/bin/env bash
#
# Reads the HIDDEN PROVIDER's hidden-service address out of its `anon-hs`
# daemon and renders it into the two configs that have to name it
# (TOON_Network #43, spec §10).
#
#   conf/connector-provider-hs.toml            committed, the source of truth,
#                                              [node] endpoints on a placeholder
#   conf/.rendered/connector-provider-hs.toml  generated, gitignored, the SAME
#                                              file with those two endpoints
#                                              pointed at <addr>.anyone
#
#   conf/provider-hs.toml                      committed, the source of truth,
#                                              connector_url and relay_set on a
#                                              placeholder
#   conf/.rendered/provider-hs.toml            generated, gitignored, the SAME
#                                              file with both pointed at
#                                              <addr>.anyone
#
#   conf/.rendered/hs-provider.env             generated, gitignored, the three
#                                              endpoint variables the hidden
#                                              provider's PUBLISHER needs — at
#                                              the ANYTOON daemon's address,
#                                              which carries the hub and the
#                                              relay
#
#   conf/.rendered/workload-gateway-hs.env     generated, gitignored, the
#                                              WORKLOAD GATEWAY's dial rewrite
#                                              (TOON_Network #53) with one more
#                                              entry: this provider's address,
#                                              dialled at its app's free
#                                              `status` route. Read only by
#                                              `make up-gateway-hs`
#
# FOUR outputs, where scripts/hs-address.sh renders one, because a HIDDEN
# PROVIDER names its address everywhere it is reached AND everything it reaches
# is named on the overlay:
#   - its connector advertises the address (a client dials what a node
#     publishes) and its Provider Profile carries it as `connector_url` (a
#     tenant dials what the directory says) — `hidden = true` refuses to start
#     unless that URL is at an `.anyone` host;
#   - its own outbound goes through `anon` with `socks5h`, and `anon` builds no
#     circuit to a private compose address — so its relay and its payer's hub
#     are named at virtual ports on THE ANYTOON DAEMON's address (conf/anonrc),
#     which is why this script reads two hostnames rather than one. Not on the
#     provider's own: a daemon dialling its own hidden service is the one
#     overlay path that does not reliably build.
#
# THIS SCRIPT IS THE OPERATOR, not the connector and not the provider. Neither
# binary reads the daemon's hostname file or speaks its control protocol for
# THIS address — connector ADR 0070 decision 7 rejects both. (The provider does
# speak the control protocol, for the PER-LEASE addresses of M4-3; those are
# created at runtime and never written to a config.)
#
# Idempotent: re-running it against unchanged addresses rewrites the same four
# files. `make up-hs` runs it; `make hs-address` runs it beside
# scripts/hs-address.sh, so one command prints both of this sandbox's
# addresses.
set -euo pipefail

cd "$(dirname "$0")/.."

CONNECTOR_TEMPLATE="${1:-conf/connector-provider-hs.toml}"
CONNECTOR_RENDERED="${2:-conf/.rendered/connector-provider-hs.toml}"
PROVIDER_TEMPLATE="${3:-conf/provider-hs.toml}"
PROVIDER_RENDERED="${4:-conf/.rendered/provider-hs.toml}"
PUBLISHER_ENV="${5:-conf/.rendered/hs-provider.env}"
GATEWAY_TEMPLATE="${6:-conf/workload-gateway.conf}"
GATEWAY_ENV="${7:-conf/.rendered/workload-gateway-hs.env}"
# The hub as the compose network names it: what the publisher is CONFIGURED
# with, never what it dials. See the env file's header below.
HUB_URL="${HUB_URL:-http://relay-connector:3000}"
HOSTNAME_FILE="/var/lib/anon/hidden_service/hostname"
# The daemon that carries this sandbox's stand-in for clearnet: the hub at
# virtual port 3200 and the relay at 7100 (conf/anonrc). A second service, and
# deliberately a second DAEMON.
SANDBOX_SERVICE="${SANDBOX_SERVICE:-anon}"

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

[ -f "$CONNECTOR_TEMPLATE" ] || die "$CONNECTOR_TEMPLATE is missing."
[ -f "$PROVIDER_TEMPLATE" ] || die "$PROVIDER_TEMPLATE is missing."

# --- Read it out of the daemon ----------------------------------------------
if [ -z "$(docker compose --profile hs ps -q anon-hs 2>/dev/null)" ]; then
  die "The hidden provider's \`anon-hs\` daemon is not running, so no address
  exists to read. \`make up-hs\` starts it first and waits for it. By hand:
      docker compose --profile hs up -d anon-hs
      docker compose --profile hs logs -f anon-hs   (look for Bootstrapped 100%)"
fi

ADDRESS="$(docker compose --profile hs exec -T anon-hs cat "$HOSTNAME_FILE" 2>/dev/null | tr -d '[:space:]' || true)"

if [ -z "$ADDRESS" ]; then
  die "\`anon-hs\` has not generated an address yet.
  A container that is Up is not a container that has a circuit — wait for
  \`Bootstrapped 100%\` in \`docker compose --profile hs logs anon-hs\` and run
  this again. If it exits immediately, check conf/anonrc-hs (AgreeToTerms 1, an
  explicit Nickname, and the two HiddenServicePort targets being IP literals)."
fi

# 56 characters of the base32 alphabet, then `.anyone` — the shape
# @toon-protocol/client demands and the provider's own `.anyone` check
# (is_anyone_host) accepts. Checked here rather than left to either, because a
# truncated read is the plausible failure and it would otherwise surface as an
# address that parses, loads, and resolves to nothing.
if ! printf '%s' "$ADDRESS" | grep -Eqx '[a-z2-7]{56}\.anyone'; then
  die "Read something that is not a hidden-service address: '$ADDRESS'
  Expected 56 characters of [a-z2-7] followed by .anyone.
  A .onion address means the daemon is the OLD v0.4.9.7 release, whose TLD
  every current client refuses — see anon/Dockerfile."
fi

# --- ...and the anytoon daemon's, which carries the hub and the relay --------
if [ -z "$(docker compose --profile hs ps -q "$SANDBOX_SERVICE" 2>/dev/null)" ]; then
  die "The \`$SANDBOX_SERVICE\` daemon is not running, and it is what publishes the
  hub (virtual port 3200) and the relay (7100) on the overlay — the two this
  hidden provider reaches its own directory through. \`make up-hs\` starts it
  beside \`anon-hs\`."
fi

SANDBOX_ADDRESS="$(docker compose --profile hs exec -T "$SANDBOX_SERVICE" cat "$HOSTNAME_FILE" 2>/dev/null | tr -d '[:space:]' || true)"

if ! printf '%s' "$SANDBOX_ADDRESS" | grep -Eqx '[a-z2-7]{56}\.anyone'; then
  die "\`$SANDBOX_SERVICE\` has not generated a usable address yet ('$SANDBOX_ADDRESS').
  scripts/hs-address.sh explains that one; run it first, or wait for
  \`Bootstrapped 100%\` in \`docker compose --profile hs logs $SANDBOX_SERVICE\`."
fi

# --- Has it changed? ---------------------------------------------------------
# Routine here (`make clean` wipes the anon-hs volume), an incident in a
# deployment: every tenant's Profile reading just went stale.
if [ -f "$CONNECTOR_RENDERED" ]; then
  PREVIOUS="$(grep -oE '[a-z2-7]{56}\.anyone' "$CONNECTOR_RENDERED" | head -1 || true)"
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$ADDRESS" ]; then
    printf '\n  note: the hidden provider address changed (%s -> %s).\n' "$PREVIOUS" "$ADDRESS" >&2
    printf '        expected after `make clean`; the anon-hs volume was wiped.\n\n' >&2
  fi
fi

# --- Render ------------------------------------------------------------------
mkdir -p "$(dirname "$CONNECTOR_RENDERED")" "$(dirname "$PROVIDER_RENDERED")"

grep -q '^http_endpoint = ' "$CONNECTOR_TEMPLATE" && grep -q '^btp_endpoint = ' "$CONNECTOR_TEMPLATE" \
  || die "$CONNECTOR_TEMPLATE has no [node] http_endpoint/btp_endpoint lines to
  rewrite. This script rewrites exactly those two, at the start of a line. If
  they moved or were renamed, fix this script rather than hand-editing the
  rendered file."

grep -q '^connector_url = ' "$PROVIDER_TEMPLATE" && grep -q '^relay_set = ' "$PROVIDER_TEMPLATE" \
  || die "$PROVIDER_TEMPLATE has no connector_url/relay_set lines to rewrite."

{
  printf '# GENERATED by scripts/hs-provider-address.sh — do not edit, do not commit.\n'
  printf '# conf/connector-provider-hs.toml with its [node] endpoints pointed at the\n'
  printf '# address the `anon-hs` daemon generated: %s\n' "$ADDRESS"
  printf '# Re-rendered on every `make up-hs`; wiped by `make clean`.\n\n'
  sed -e "s|^http_endpoint = .*|http_endpoint = \"http://${ADDRESS}/ilp\"|" \
      -e "s|^btp_endpoint = .*|btp_endpoint = \"ws://${ADDRESS}/ilp/btp\"|" \
      "$CONNECTOR_TEMPLATE"
} > "$CONNECTOR_RENDERED"

{
  printf '# GENERATED by scripts/hs-provider-address.sh — do not edit, do not commit.\n'
  printf '# conf/provider-hs.toml with its connector_url pointed at the address the\n'
  printf '# `anon-hs` daemon generated: %s\n' "$ADDRESS"
  printf '# Re-rendered on every `make up-hs`; wiped by `make clean`.\n\n'
  sed -e "s|^connector_url = .*|connector_url = \"http://${ADDRESS}/ilp\"|" \
      -e "s|^relay_set = .*|relay_set = [\"ws://${SANDBOX_ADDRESS}:7100\"]|" \
      "$PROVIDER_TEMPLATE"
} > "$PROVIDER_RENDERED"

# The publisher's three endpoints, as an env file docker-compose.yml reads
# (`env_file`, required: false). They are NOT in the compose file because an
# `environment:` key would win over this, and because none of them can be
# written before the address exists.
#
#   TOON_CONNECTOR_URL    the hub, BY ITS COMPOSE NAME — and that is not a
#                         mistake. @toon-protocol/client REFUSES to be
#                         configured with a `.anyone` connector unless it was
#                         handed `socksProxy`, and this publisher deliberately
#                         hands it a carriage instead (see
#                         tools/publisher/publish.mjs: the library's own option
#                         refuses a proxy beside a clearnet connector, and for
#                         a hidden PROVIDER covering the clearnet hop is the
#                         whole point). So the configured URL stays
#                         clearnet-shaped and the REWRITE below is what carries
#                         every request to the overlay.
#   TOON_ENDPOINT_REWRITE two entries, and each is a real hop: the URL above
#                         (the first fetch, before any self-description has
#                         been read) and http://127.0.0.1:3200 (what this hub
#                         ADVERTISES, because its smokes run on the host — a
#                         client dials what a node publishes). Both land on the
#                         hub's virtual port, so the packet leaves through
#                         `anon` and arrives naming nothing about this host.
#   RELAY_WRITE_ROUTES    relay READ url -> the paid ILP destination that
#                         writes to it. The key must be exactly what the
#                         provider's rendered `relay_set` says, because that is
#                         the URL its publish request names.
{
  printf '# GENERATED by scripts/hs-provider-address.sh — do not edit, do not commit.\n'
  printf '# The hidden provider publisher'"'"'s endpoints, on the anytoon daemon'"'"'s\n'
  printf '# address (%s), which carries the hub and the relay.\n' "$SANDBOX_ADDRESS"
  printf 'TOON_CONNECTOR_URL=%s\n' "$HUB_URL"
  printf 'TOON_ENDPOINT_REWRITE={"%s":"http://%s:3200","http://127.0.0.1:3200":"http://%s:3200"}\n' \
    "$HUB_URL" "$SANDBOX_ADDRESS" "$SANDBOX_ADDRESS"
  printf 'RELAY_WRITE_ROUTES={"ws://%s:7100":"g.toon.relay"}\n' "$SANDBOX_ADDRESS"
} > "$PUBLISHER_ENV"

# The Workload Gateway's `status` to THIS provider (`make up-gateway-hs`). Its
# Profile says connector_url = http://<addr>.anyone/ilp, and the gateway would
# dial <addr>.anyone:80 through its proxy — which lands on the hidden
# CONNECTOR's client edge, where a plain `status` body is not served (the
# connector terminates sealed packets; conf/workload-gateway.conf explains the
# same shortcut for the two public providers). So the address is dialled at
# the provider APP on the compose network instead, out of band, exactly as
# smoke-m4's preflight reads the hidden connector's self-description: what the
# recipe rehearses is the LEASE reached through the proxy, and that entry is
# not here — a per-lease address is never written to a config. An env var
# cannot be merged, so the committed map is restated with the entry added; the
# committed file stays the source of truth for the other three.
grep -q '^GATEWAY_DIAL_REWRITE=' "$GATEWAY_TEMPLATE" \
  || die "$GATEWAY_TEMPLATE has no GATEWAY_DIAL_REWRITE line to extend."
COMMITTED_REWRITE="$(sed -n 's/^GATEWAY_DIAL_REWRITE=//p' "$GATEWAY_TEMPLATE" | head -1)"
{
  printf '# GENERATED by scripts/hs-provider-address.sh — do not edit, do not commit.\n'
  printf '# conf/workload-gateway.conf'"'"'s GATEWAY_DIAL_REWRITE plus the hidden provider'"'"'s\n'
  printf '# address (%s), dialled at its app'"'"'s free status route.\n' "$ADDRESS"
  printf 'GATEWAY_DIAL_REWRITE=%s\n' \
    "$(printf '%s' "$COMMITTED_REWRITE" | sed -e "s|}\$|,\"${ADDRESS}:80\":\"provider-hs:8080\"}|")"
} > "$GATEWAY_ENV"

grep -q "$ADDRESS" "$CONNECTOR_RENDERED" || die "rendering $CONNECTOR_RENDERED did not substitute the address."
grep -q "$ADDRESS" "$GATEWAY_ENV" || die "rendering $GATEWAY_ENV did not add the address."
grep -q "$ADDRESS" "$PROVIDER_RENDERED" || die "rendering $PROVIDER_RENDERED did not substitute the address."
grep -q "$SANDBOX_ADDRESS" "$PUBLISHER_ENV" || die "rendering $PUBLISHER_ENV did not substitute the anytoon daemon's address."

printf '\n  %s   (the HIDDEN PROVIDER)\n\n' "$ADDRESS"
printf '  rendered into %s\n' "$CONNECTOR_RENDERED"
printf '            and %s\n' "$PROVIDER_RENDERED"
printf '            and %s\n' "$PUBLISHER_ENV"
printf '            and %s  (read only by `make up-gateway-hs`)\n' "$GATEWAY_ENV"
printf '  it reaches the hub and the relay at http://%s:3200 and ws://%s:7100\n' \
  "$SANDBOX_ADDRESS" "$SANDBOX_ADDRESS"
printf '  tenants reach its client edge at: http://%s/ilp\n' "$ADDRESS"
printf '  and settle against its chain at:  http://%s:8545\n\n' "$ADDRESS"
