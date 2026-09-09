#!/usr/bin/env bash
# Regenerates everything under artifacts/ — the committed copies are just a
# convenience so a fresh clone needs no network dumps.
#
#   artifacts/*.so                      program binaries dumped from live clusters
#   artifacts/genesis/name-registry.json  pre-created NameRegistry account (gen-genesis.mjs)
#
# The five AR.IO programs are dumped from Solana DEVNET under the staging ids
# (= @ar.io/sdk DEVNET_PROGRAM_IDS; the binaries carry declare_id! for these
# ids, so they MUST be loaded under them). mpl_core is the canonical Metaplex
# Core program dumped from mainnet-beta. Dumps only need refreshing when
# AR.IO redeploys staging (CI redeploys on merges to develop) AND you also
# upgrade @ar.io/sdk / @ar.io/solana-contracts — client and program versions
# must roughly match.
#
# `solana program dump` runs inside the same pinned validator image the
# sandbox uses, so no local Solana toolchain is needed. Requires network
# access to devnet/mainnet RPC. Usage:
#   ./scripts/fetch-artifacts.sh          # dump only missing artifacts
#   ./scripts/fetch-artifacts.sh --force  # re-dump everything
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=ghcr.io/beeman/solana-test-validator@sha256:419e56a8f2aeac073b7218cb16e982f4ad8ac44bec314b06bf6c2bc9f2756561
FORCE=${1:-}

dump() { # dump <cluster-url> <program-id> <outfile>
  local url=$1 id=$2 out=$3
  if [[ -s "artifacts/$out" && "$FORCE" != "--force" ]]; then
    echo "artifacts/$out exists — skipping (use --force to re-dump)"
    return
  fi
  echo "dumping $id ($url) -> artifacts/$out"
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/artifacts:/out" "$IMAGE" \
    solana program dump "$id" "/out/$out" --url "$url"
}

mkdir -p artifacts/genesis

dump devnet 8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1 ario_core.so
dump devnet 7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz ario_gar.so
dump devnet 6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp ario_arns.so
dump devnet DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX ario_ant.so
dump devnet bttco5oAnBwCucG63iKokBJCZmNr493f3Ewe9LM3oTx ario_ant_escrow.so
dump mainnet-beta CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so

# NameRegistry genesis account (+ keys/ if missing). Needs `npm ci` first.
node scripts/gen-genesis.mjs

echo "done."
