#!/usr/bin/env bash
# Regenerates everything under artifacts/ — the committed copies are just a
# convenience so a fresh clone needs no network dumps.
#
#   artifacts/*.so                      program binaries dumped from live clusters
#   artifacts/genesis/name-registry.json  pre-created NameRegistry account (gen-genesis.mjs)
#   artifacts/evm/*.hex                 mainnet + Uniswap EVM bytecode (see artifacts/evm/README.md)
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

# ── the EVM asset layer's bytecode (artifacts/evm/README.md) ────────────────
# Two mainnet contracts at their own mainnet addresses, and the official Uniswap
# v3 factory. Needs an Ethereum mainnet RPC; override with MAINNET_RPC. These
# are the ONLY artifacts here that come from a chain this sandbox does not run,
# which is exactly why they are committed: `make up` must never need one.
MAINNET_RPC=${MAINNET_RPC:-https://ethereum-rpc.publicnode.com}

getcode() { # getcode <address> <outfile> <label>
  local addr=$1 out=$2 label=$3
  if [[ -s "artifacts/evm/$out" && "$FORCE" != "--force" ]]; then
    echo "artifacts/evm/$out exists — skipping (use --force to re-dump)"
    return
  fi
  echo "dumping $label runtime code ($addr) -> artifacts/evm/$out"
  curl -sS -X POST "$MAINNET_RPC" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["'"$addr"'","latest"]}' \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{
        const r=JSON.parse(b).result;
        if(!r||r==="0x"){console.error("no code at that address — is MAINNET_RPC reachable?");process.exit(1);}
        process.stdout.write(r.toLowerCase()+"\n");})' > "artifacts/evm/$out"
}

mkdir -p artifacts/evm
getcode 0xFeAc2Eae96899709a43E252B6B92971D32F9C0F9 AnyoneProtocolToken.runtime.hex ANYONE
getcode 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 WETH9.runtime.hex WETH9

# The factory is CREATION code and comes from the published package rather than
# from a chain — see artifacts/evm/README.md for why, and for how to check it
# against mainnet's deployed factory.
if [[ ! -s artifacts/evm/UniswapV3Factory.creation.hex || "$FORCE" == "--force" ]]; then
  echo "extracting UniswapV3Factory creation code from @uniswap/v3-core@1.0.1"
  tmp=$(mktemp -d)
  (cd "$tmp" && npm pack @uniswap/v3-core@1.0.1 >/dev/null \
     && tar xzf uniswap-v3-core-1.0.1.tgz package/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json)
  node -p "require('$tmp/package/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json').bytecode.toLowerCase()" \
    > artifacts/evm/UniswapV3Factory.creation.hex
  rm -rf "$tmp"
else
  echo "artifacts/evm/UniswapV3Factory.creation.hex exists — skipping (use --force to re-extract)"
fi

# NameRegistry genesis account (+ keys/ if missing). Needs `npm ci` first.
node scripts/gen-genesis.mjs

echo "done."
