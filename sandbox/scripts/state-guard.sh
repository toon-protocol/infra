#!/bin/sh
# =============================================================================
# `make up*` refuses a sandbox whose connector volumes predate the x402-only
# migration (infra#39), by name, pointing at `make clean`.
# =============================================================================
# The connector release the sandbox pins speaks x402 vouchers and nothing else
# (connector ADR 0075), and it refuses to boot on a `state_dir` whose claim
# journal holds `toon-channel` entries. It says why in its log — and then
# compose restarts it, forever, and `make up` stalls on a hub that never turns
# healthy. There is no drain in a sandbox (the chains are disposable and
# `make clean` wipes both); this check turns that restart loop into one line
# before anything starts.
#
# A connector state volume is pre-migration when it holds a file only an older
# build wrote (`peer-claims.log`, `evm-channel-index.json`,
# `outbound-client.log`), or a journal line only TOON's own channels ever
# produced (`outbound_claim_signed`, `inbound_fulfillment_recorded`; the
# connector's own rule is in connector-client-edge's
# `first_toon_channel_entry`). A fresh volume has none of them, and neither
# has one this release wrote.
set -eu

PROJECT="${COMPOSE_PROJECT_NAME:-toon-sandbox}"

stale=""
for volume in $(docker volume ls -q --filter "name=^${PROJECT}_" | grep -- '-connector-state$' || true); do
  if docker run --rm -v "$volume:/s:ro" alpine:3.20 sh -c '
       test -e /s/peer-claims.log || test -e /s/evm-channel-index.json || test -e /s/outbound-client.log ||
       grep -qsE "^(outbound_claim_signed|inbound_fulfillment_recorded)[[:space:]]" /s/client-edge-claims.log'; then
    stale="$stale $volume"
  fi
done

if [ -n "$stale" ]; then
  echo "ERROR: this sandbox's state predates the x402-only connector (infra#39):"
  for volume in $stale; do echo "    $volume"; done
  echo
  echo "Every channel is an x402 channel now, and the pinned connector refuses to boot"
  echo "on a claim journal holding toon-channel entries — it would restart-loop and"
  echo "\`make up\` would stall on a hub that never turns healthy. The chains are"
  echo "disposable and there is nothing to drain, so wipe the old state and start cold:"
  echo
  echo "    make clean && make up"
  echo
  echo "(\`make clean\` removes every sandbox volume and ./data. Nothing in it outlives"
  echo "the chains it was paid on.)"
  exit 1
fi
