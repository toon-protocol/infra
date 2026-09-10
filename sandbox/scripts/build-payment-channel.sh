#!/usr/bin/env bash
# Regenerates artifacts/payment_channel.so from the connector sibling checkout.
#
# The artifact is committed (like the AR.IO program dumps) so a fresh clone
# needs no Solana toolchain; re-run this only together with a connector repo
# upgrade. The build MUST go through the connector's own `make solana-build`
# (tools/solana/build-sbf.sh): it pins platform-tools v1.52 and bootstraps
# the cargo-build-sbf cache a cold machine lacks. The Solana CLI line it
# expects is v3.1.12 (the connector repo's artifact-build pin; its devbox
# init_hook installs exactly this).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONNECTOR="${CONNECTOR_REPO:-$HERE/../../../connector}"

if [[ ! -d "$CONNECTOR/packages/solana-program" ]]; then
  echo "ERROR: no connector checkout at $CONNECTOR (set CONNECTOR_REPO)." >&2
  exit 1
fi

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
if ! command -v cargo-build-sbf >/dev/null 2>&1; then
  echo "Installing the Solana CLI v3.1.12 (the connector repo's pin)..."
  sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.12/install)"
fi

make -C "$CONNECTOR" solana-build
cp "$CONNECTOR/target/deploy/payment_channel.so" "$HERE/../artifacts/payment_channel.so"
echo "artifacts/payment_channel.so refreshed ($(stat -c%s "$HERE/../artifacts/payment_channel.so") bytes)"
