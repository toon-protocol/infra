#!/usr/bin/env bash
#
# The edge, end to end, on this machine's Docker: infra#24's "done when".
#
#   edge/deploy/test/smoke.sh            # builds the image, runs, cleans up
#   KEEP=1 edge/deploy/test/smoke.sh     # leave it running afterwards
#
# It brings up the edge project (production's compose and sites, the internal
# CA instead of ACME: ./docker-compose.edge.yml), then two stub nodes, each in
# its OWN project joined to its OWN per-node network the way a node's overlay
# is (./docker-compose.stub-store.yml on edge-store,
# ./docker-compose.stub-gateway.yml on edge-gateway). It asks real HTTPS
# questions with the real hostnames, verifying every certificate against the
# edge's own root, and checks that one stub node cannot reach the other.
#
# It needs Docker, curl and openssl, and the five network names edge-relay,
# edge-store, edge-gas, edge-gateway and edge-faucet to be free: it creates and
# removes them, so it refuses to run on a host that already has any of them (a
# real devnet host, say).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
EDGE=(docker compose -p edge-smoke --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml" -f "$HERE/docker-compose.edge.yml")
STUB_STORE=(docker compose -f "$HERE/docker-compose.stub-store.yml")
STUB_GATEWAY=(docker compose -f "$HERE/docker-compose.stub-gateway.yml")
NETWORKS=(edge-relay edge-store edge-gas edge-gateway edge-faucet)
ZONE=devnet.toonprotocol.dev
WORK=$(mktemp -d)

# The production compose requires these; the internal CA uses none of them.
export ACME_EMAIL=smoke@example.com PORKBUN_API_KEY=unused PORKBUN_SECRET_KEY=unused
export STUB_TLS_DIR=$WORK/tls

for net in "${NETWORKS[@]}"; do
  if docker network inspect "$net" >/dev/null 2>&1; then
    echo "REFUSING: a Docker network named '$net' already exists here. This test creates and removes its own."
    exit 1
  fi
done

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: left running. Tear down with:"
    echo "  ${STUB_STORE[*]} down; ${STUB_GATEWAY[*]} down; ${EDGE[*]} down -v"
  else
    "${STUB_STORE[@]}" down --remove-orphans >/dev/null 2>&1 || true
    "${STUB_GATEWAY[@]}" down --remove-orphans >/dev/null 2>&1 || true
    "${EDGE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "── building edge/Dockerfile"
docker build -q -t toon-edge-caddy:local "$DEPLOY/.." >/dev/null

# The gateway stub's internal certificate, made as gateway/deploy/bootstrap.sh
# makes the real one: self-signed, SAN includes `gateway`.
mkdir -p "$STUB_TLS_DIR"
openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -keyout "$STUB_TLS_DIR/internal.key" -out "$STUB_TLS_DIR/internal.crt" \
  -subj "/CN=*.gw.$ZONE" \
  -addext "subjectAltName=DNS:*.gw.$ZONE,DNS:gw.$ZONE,DNS:gateway" >/dev/null 2>&1
chmod 644 "$STUB_TLS_DIR"/*

echo "── starting the edge, then two stub nodes, each on its own network"
"${EDGE[@]}" up -d --wait
"${STUB_STORE[@]}" up -d --wait
"${STUB_GATEWAY[@]}" up -d --wait

"${EDGE[@]}" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$WORK/root.crt"

FAILED=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

# curl a real hostname at the loopback edge, trusting only its internal CA.
# No --retry: curl retries a 503, and the gateway's no_grant IS a 503.
get() {
  local host=$1 path=$2; shift 2
  curl -sS --max-time 20 \
    --cacert "$WORK/root.crt" --resolve "$host:18443:127.0.0.1" \
    "$@" "https://$host:18443$path"
}
expect() { # description, haystack, needle
  if grep -qiF -- "$3" <<<"$2"; then pass "$1"; else fail "$1 (wanted '$3')"; printf '%s\n' "$2" | sed 's/^/        /'; fi
}

# Ready once the internal CA has issued and a stub answers through the edge.
ready=0
for _ in $(seq 1 60); do
  get "proxy.ario.$ZONE" /ilp -o /dev/null -f 2>/dev/null && { ready=1; break; }
  sleep 2
done

[ "$ready" = 1 ] || { echo "FAILED: the edge never answered for proxy.ario through the stub"; exit 1; }

echo "── a plain node: proxy.ario -> store-proxy:4000"
out=$(get "proxy.ario.$ZONE" /ilp -i)
expect "reaches store-proxy" "$out" "upstream=store-proxy"
expect "passes Host through" "$out" "host=proxy.ario.$ZONE"
expect "sets X-Forwarded-Proto: https" "$out" "xfp=https"

echo "── the wildcard: <label>.gw -> https://gateway-gw:8443"
out=$(get "workload.gw.$ZONE" / -i)
expect "a granted label reaches gateway-gw over TLS" "$out" "upstream=gateway-gw"
expect "passes the label's Host through" "$out" "host=workload.gw.$ZONE"
expect "the workload is told https" "$out" "xfp=https"
expect "SNI to the gateway is 'gateway'" "$out" "sni=gateway"
out=$(get "nobody-granted-this.gw.$ZONE" / -i)
expect "an ungranted label is the gateway's 503" "$out" "HTTP/2 503"
expect "... with toon-gateway-reason: no_grant" "$out" "toon-gateway-reason: no_grant"
out=$(get "gw.$ZONE" / -i)
expect "the bare domain is the gateway's no_grant" "$out" "toon-gateway-reason: no_grant"

echo "── certificates"
san=$(openssl s_client -connect 127.0.0.1:18443 -servername "another-label.gw.$ZONE" -CAfile "$WORK/root.crt" </dev/null 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)
expect "a label is served the WILDCARD certificate" "$san" "DNS:*.gw.$ZONE"

echo "── rules carried over from the node fronts"
out=$(get "proxy.ario.$ZONE" /admin/anything -o /dev/null -w '%{http_code}')
expect "/admin* is 404" "$out" "404"
out=$(head -c $((5 * 1024 * 1024)) /dev/zero | get "proxy.ario.$ZONE" /upload -o /dev/null -w '%{http_code}' --data-binary @-)
expect "a 5 MiB body is refused on the store (4 MiB cap)" "$out" "413"
out=$(head -c $((3 * 1024 * 1024)) /dev/zero | get "proxy.ario.$ZONE" /upload -o /dev/null -w '%{http_code}' --data-binary @-)
expect "... and a 3 MiB one is not" "$out" "200"
out=$(get "proxy.ario.$ZONE" /ilp/identity -i)
expect "/ilp/identity carries the console's CORS origin" "$out" "access-control-allow-origin: https://proxy.$ZONE"
# Two Vary lines are one list (RFC 9110 §5.3), which is what nginx's
# add_header produced too: the upstream's value is kept, Origin is added.
expect "... keeps the upstream's Vary" "$out" "vary: Accept-Encoding"
expect "... and adds Origin to it" "$out" "vary: Origin"
out=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "proxy.ario.$ZONE:18080:127.0.0.1" "http://proxy.ario.$ZONE:18080/x")
expect "plain HTTP redirects to HTTPS" "$out" "308 https://proxy.ario.$ZONE/x"
out=$(get "dvm.$ZONE" /ilp/identity -o /dev/null -w '%{http_code}')
expect "dvm's /ilp/identity goes to the store's connector, as nginx's did" "$out" "200"
out=$(get "dvm.$ZONE" / -o /dev/null -w '%{http_code}')
expect "a node that is not up is a 502, never another node's answer" "$out" "502"
codes=$(seq 1 600 | xargs -P 60 -I{} curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 \
  --cacert "$WORK/root.crt" --resolve "proxy.ario.$ZONE:18443:127.0.0.1" "https://proxy.ario.$ZONE:18443/ilp" | sort | uniq -c)
expect "a burst past 400 per 2s is rate-limited" "$codes" " 429"

echo "── one network per node: only the edge reaches a node"
# The routing checks above already prove the edge reaches both stubs. Now
# the other direction: from inside the store stub, the gateway stub must be
# unreachable, by its alias AND by its address on edge-gateway (a name that
# fails to resolve alone would prove nothing about the route).
store_cid=$("${STUB_STORE[@]}" ps -q store)
gw_cid=$("${STUB_GATEWAY[@]}" ps -q gateway)
gw_ip=$(docker inspect "$gw_cid" --format '{{(index .NetworkSettings.Networks "edge-gateway").IPAddress}}')
if docker exec "$store_cid" wget -q -T 3 --no-check-certificate -O /dev/null https://gateway-gw:8443/ 2>/dev/null; then
  fail "a store node cannot reach gateway-gw by name"
else
  pass "a store node cannot reach gateway-gw by name"
fi
if [ -n "$gw_ip" ] && ! docker exec "$store_cid" nc -z -w 3 "$gw_ip" 8443 2>/dev/null; then
  pass "a store node cannot reach the gateway at its edge-gateway address ($gw_ip)"
else
  fail "a store node cannot reach the gateway at its edge-gateway address (${gw_ip:-no address})"
fi
# The control, so the two passes above are not a broken probe: the same tools
# from the same container DO reach the store's own alias.
if docker exec "$store_cid" nc -z -w 3 store-proxy 4000 2>/dev/null; then
  pass "... while the same probe reaches its own node (control)"
else
  fail "... while the same probe reaches its own node (control)"
fi

echo "── the host contract"
cid=$("${EDGE[@]}" ps -q caddy)
out=$(docker inspect "$cid" --format '{{.HostConfig.Memory}}')
expect "caddy runs under its mem_limit (128m)" "$out" "134217728"
out=$(docker inspect "$cid" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')
for net in "${NETWORKS[@]}"; do
  expect "caddy is on $net" "$out" "$net "
  owner=$(docker network inspect "$net" --format '{{index .Labels "com.docker.compose.project"}}')
  expect "the edge project created $net" "$owner" "edge-smoke"
done

if [ "$FAILED" = 0 ]; then echo "── all checks passed"; else echo "── FAILED"; exit 1; fi
