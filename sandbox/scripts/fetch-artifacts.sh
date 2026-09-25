#!/usr/bin/env bash
# Regenerates everything under artifacts/ — the committed copies are just a
# convenience so a fresh clone needs no network dumps.
#
#   artifacts/*.so                      program binaries dumped from live clusters
#   artifacts/genesis/name-registry.json  pre-created NameRegistry account (gen-genesis.mjs)
#   artifacts/evm/*.hex                 mainnet, Base Sepolia + Uniswap EVM bytecode (see artifacts/evm/README.md)
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
# solana-foundation payment-channels, the program x402's SVM batch-settlement
# scheme drives (connector ADR 0074). Dumped from MAINNET-BETA, the binary
# production runs — its devnet deployment is a different build.
dump mainnet-beta CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX payment_channels.so

# ── the EVM asset layer's bytecode (artifacts/evm/README.md) ────────────────
# Two mainnet contracts at their own mainnet addresses, and the official Uniswap
# v3 factory. Needs an Ethereum mainnet RPC; override with MAINNET_RPC. These
# are the ONLY artifacts here that come from a chain this sandbox does not run,
# which is exactly why they are committed: `make up` must never need one.
MAINNET_RPC=${MAINNET_RPC:-https://ethereum-rpc.publicnode.com}

getcode() { # getcode <address> <outfile> <label> [rpc]
  local addr=$1 out=$2 label=$3 rpc=${4:-$MAINNET_RPC}
  if [[ -s "artifacts/evm/$out" && "$FORCE" != "--force" ]]; then
    echo "artifacts/evm/$out exists — skipping (use --force to re-dump)"
    return
  fi
  echo "dumping $label runtime code ($addr) -> artifacts/evm/$out"
  curl -sS -X POST "$rpc" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["'"$addr"'","latest"]}' \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{
        const r=JSON.parse(b).result;
        if(!r||r==="0x"){console.error("no code at that address — is the RPC reachable?");process.exit(1);}
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

# ── the x402 layer's bytecode (artifacts/evm/README.md, scripts/seed-x402.sh) ──
# Copied from BASE SEPOLIA, where x402's batch-settlement stack is deployed at
# the CREATE2 addresses `@x402/evm` hardcodes. Override with BASE_SEPOLIA_RPC.
BASE_SEPOLIA_RPC=${BASE_SEPOLIA_RPC:-https://sepolia.base.org}
getcode 0x000000000022D473030F116dDEE9F6B43aC78BA3 Permit2.runtime.hex Permit2 "$BASE_SEPOLIA_RPC"
getcode 0xcA11bde05977b3631167028862bE2a173976CA11 Multicall3.runtime.hex Multicall3 "$BASE_SEPOLIA_RPC"
getcode 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003 x402BatchSettlement.runtime.hex x402BatchSettlement "$BASE_SEPOLIA_RPC"
getcode 0x4020806089470a89826cB9fB1f4059150b550004 ERC3009DepositCollector.runtime.hex ERC3009DepositCollector "$BASE_SEPOLIA_RPC"
getcode 0x4020425FAf3B746C082C2f942b4E5159887B0005 Permit2DepositCollector.runtime.hex Permit2DepositCollector "$BASE_SEPOLIA_RPC"
getcode 0xbA3b60c21e28C41df4bABd90f228e1D368627DA6 SignatureChecker.runtime.hex "Circle SignatureChecker" "$BASE_SEPOLIA_RPC"

# Circle's FiatToken is CREATION code, taken from the input of Base Sepolia
# USDC's own deployment transactions (implementation, then proxy). The proxy's
# input ends in its one constructor argument, the implementation address, which
# is stripped: seed-x402.sh appends the sandbox's own.
creation() { # creation <tx-hash> <outfile> <label> <strip-hex-chars>
  local tx=$1 out=$2 label=$3 strip=$4
  if [[ -s "artifacts/evm/$out" && "$FORCE" != "--force" ]]; then
    echo "artifacts/evm/$out exists — skipping (use --force to re-dump)"
    return
  fi
  echo "extracting $label creation code (tx $tx) -> artifacts/evm/$out"
  curl -sS -X POST "$BASE_SEPOLIA_RPC" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["'"$tx"'"]}' \
    | STRIP="$strip" node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{
        const t=JSON.parse(b).result;
        if(!t||t.to!==null){console.error("not a contract-creation transaction");process.exit(1);}
        const n=Number(process.env.STRIP);
        process.stdout.write((n?t.input.slice(0,-n):t.input).toLowerCase()+"\n");})' > "artifacts/evm/$out"
}
creation 0x6dbb9d759e3388911863490b3bde0e8fa3c22a8e70f48f758302592b7dc52fe1 FiatTokenV2_2.creation.hex FiatTokenV2_2 0
creation 0xd835c0abef5b7988ba6230f92da809391716b8dc5e6cd4e430263b52d3bf69f3 FiatTokenProxy.creation.hex FiatTokenProxy 64

# NameRegistry genesis account (+ keys/ if missing). Needs `npm ci` first.
node scripts/gen-genesis.mjs

echo "done."
