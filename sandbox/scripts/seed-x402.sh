#!/bin/sh
# =============================================================================
# THE x402 LAYER: x402's batch-settlement contracts, Permit2 and an ERC-3009 USDC.
# =============================================================================
# Runs INSIDE the anvil container (foundry image), from the anvil entrypoint,
# after seed-toon-evm-amm.sh and BEFORE the anvil healthcheck can pass: the
# `x402-facilitator` service answers `/supported` for batch-settlement only if
# the settlement contract is on the chain it dials.
#
# WHY THE ADDRESSES ARE PRODUCTION'S (toon-protocol/infra#23, connector ADR 0074)
# ------------------------------------------------------------------------------
# The published `@x402/evm` package hardcodes the batch-settlement stack's
# addresses — `x402BatchSettlement` 0x4020…0003, `ERC3009DepositCollector`
# 0x4020…0004, `Permit2DepositCollector` 0x4020…0005 — and they are the same
# CREATE2 address on every chain x402 deploys to. A stock facilitator therefore
# only works on a chain where the contracts sit exactly there, and x402's own
# deploy script uses plain CREATE on chain 31337, which puts them elsewhere. So
# the RUNTIME bytecode is copied from Base Sepolia and placed with
# `anvil_setCode` at the canonical address, which is also what makes the
# sandbox rehearse the audited deployed code rather than a rebuild of it.
#
# WHAT IT PLACES, AND WHY EACH NEEDS NO STORAGE
# ---------------------------------------------
#   1. Permit2 (0x0000…22D4…8BA3) — Uniswap's canonical deployment. Its only
#      constructor state is the EIP-712 chain id and separator, both
#      immutables that it rebuilds when `block.chainid` differs from the cached
#      one, so it answers correctly on 31337 with no storage written.
#   2. Multicall3 (0xcA11…CA11) — the canonical deployment every public chain
#      carries and plain anvil does not. The facilitator batches its channel
#      reads through it (`tryAggregate`), so without it every `/verify` fails
#      500. Stateless.
#   3. x402BatchSettlement — ownerless; its constructor is OpenZeppelin EIP712
#      alone, which rebuilds its separator the same way. Channel state is
#      written by use.
#   4. The two deposit collectors — their constructor arguments (the settlement
#      address, and Permit2's) are immutables baked into the runtime, and both
#      are the canonical addresses above.
#   5. USDC as Circle's FiatToken v2.2 — deployed NORMALLY from the creation
#      bytecode of Base Sepolia's own deployment transactions, because a
#      FiatToken is a proxy whose initialisers write a dozen storage words. It
#      is what gives the sandbox ERC-3009 (`receiveWithAuthorization`), so a
#      depositor needs no gas, as on Base. The sandbox's `MockERC20` has
#      neither ERC-3009 nor EIP-2612. Its ADDRESS is local, and that is fine:
#      a token address travels as the greeting's `asset`, so it is
#      configuration, not code.
#      FiatToken v2.2 LINKS an external library, Circle's `SignatureChecker`,
#      whose Base Sepolia address (0xbA3b…7DA6) is baked into the creation
#      bytecode. It is placed at that address first, by `setCode`, like the
#      rest; its runtime opens with the usual library call guard comparing
#      `ADDRESS` to that same address, which is why the address must match.
#      Without it every `receiveWithAuthorization` reverts "call to
#      non-contract address", which surfaces in the facilitator as
#      `invalid_batch_settlement_evm_deposit_simulation_failed`.
#
# The FiatToken's name and version are Base Sepolia's ("USDC", "2") because
# ERC-3009 signs over the EIP-712 domain, and a client that learned them from
# Base Sepolia must sign the same way here.
#
# IDEMPOTENT: setCode is repeatable, and the token is deployed only if absent.
set -eu

RPC="${RPC_URL:-http://localhost:8545}"
ART="${ARTIFACTS_DIR:-/sandbox-artifacts}"

PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11
SIGNATURE_CHECKER=0xbA3b60c21e28C41df4bABd90f228e1D368627DA6
BATCH_SETTLEMENT=0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003
ERC3009_COLLECTOR=0x4020806089470a89826cB9fB1f4059150b550004
PERMIT2_COLLECTOR=0x4020425FAf3B746C082C2f942b4E5159887B0005
# keccak256("Voucher(bytes32 channelId,uint128 maxClaimableAmount)"), read off
# the deployed contract on Base Sepolia and Base mainnet.
VOUCHER_TYPEHASH=0x1e1bd6ff84c3e0d9029a292b212e039c0ca97ec497c55191a4a5874294609a69

# The x402 layer's three accounts are anvil-mnemonic indices 20-22: past the
# ten anvil funds at genesis (several of which other smokes spend as payers —
# smoke-hs 5, smoke-milestone4 6, rotate 4 and 7) and below the connectors'
# settlement keys (24+, scripts/gen-toon-keys.sh). They are funded with
# `anvil_setBalance`, which spends nobody's nonce.
#
# index 20 — the FiatToken's deployer and PROXY ADMIN, so the implementation
# is its nonce 0 and the proxy its nonce 1. A transparent proxy refuses every
# token call from its admin, so the token's roles go to a second account.
TOKEN_ADMIN=0x09DB0a93B389bEF724429898f539AEB7ac2Dd55f
TOKEN_ADMIN_KEY=0xeaa861a9a01391ed3d587d8a5a84ca56ee277629a8b02c22093a419bf240e65d
# index 21 — owner, master minter, minter, pauser and blacklister. The sandbox
# mints x402 USDC to a depositor from this key, on demand.
TOKEN_OWNER=0x02484cb50AAC86Eae85610D6f4Bf026f30f6627D
TOKEN_OWNER_KEY=0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b
# index 22 — the x402-facilitator service's gas payer (its key is that
# service's default). Funded here so it can relay from the first request.
FACILITATOR=0x08135Da0A343E492FA2d4282F2AE34c6c5CC1BbE
# The two CREATE addresses of index 20 at nonces 0 and 1.
FIAT_TOKEN_IMPL=0x6D8da4B12D658a36909ec1C75F81E54B8DB4eBf9
X402_USDC=0x0A867CA0442383c2A89951244B955AA19b615b58

say() { echo "[seed-x402] $*"; }
die() { echo "[seed-x402] FATAL: $*" >&2; exit 1; }
send() { cast send --rpc-url "$RPC" "$@" >/dev/null; }
rpc()  { cast rpc --rpc-url "$RPC" "$@" >/dev/null; }
lc()   { echo "$1" | tr 'A-F' 'a-f'; }
same() { [ "$(lc "$1")" = "$(lc "$2")" ]; }
has_code() { c="$(cast code "$1" --rpc-url "$RPC")"; [ -n "$c" ] && [ "$c" != 0x ]; }

for who in "$TOKEN_ADMIN" "$TOKEN_OWNER" "$FACILITATOR"; do
  rpc anvil_setBalance "$who" 0x56bc75e2d63100000 # 100 ETH
done

say "placing Permit2, Multicall3 and the batch-settlement stack at their canonical addresses"
rpc anvil_setCode "$PERMIT2" "$(cat "$ART/Permit2.runtime.hex")"
rpc anvil_setCode "$MULTICALL3" "$(cat "$ART/Multicall3.runtime.hex")"
rpc anvil_setCode "$SIGNATURE_CHECKER" "$(cat "$ART/SignatureChecker.runtime.hex")"
rpc anvil_setCode "$BATCH_SETTLEMENT" "$(cat "$ART/x402BatchSettlement.runtime.hex")"
rpc anvil_setCode "$ERC3009_COLLECTOR" "$(cat "$ART/ERC3009DepositCollector.runtime.hex")"
rpc anvil_setCode "$PERMIT2_COLLECTOR" "$(cat "$ART/Permit2DepositCollector.runtime.hex")"

got="$(cast call "$BATCH_SETTLEMENT" 'VOUCHER_TYPEHASH()(bytes32)' --rpc-url "$RPC")"
same "$got" "$VOUCHER_TYPEHASH" || die "x402BatchSettlement answers VOUCHER_TYPEHASH $got, not $VOUCHER_TYPEHASH"
domain="$(cast call "$BATCH_SETTLEMENT" 'eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])' --rpc-url "$RPC" | sed -n 4p | cut -d' ' -f1)"
[ "$domain" = 31337 ] || die "x402BatchSettlement's EIP-712 domain names chain $domain, not 31337 — the separator did not rebuild"
got="$(cast call "$ERC3009_COLLECTOR" 'x402BatchSettlement()(address)' --rpc-url "$RPC")"
same "$got" "$BATCH_SETTLEMENT" || die "ERC3009DepositCollector points at $got"
got="$(cast call "$PERMIT2_COLLECTOR" 'PERMIT2()(address)' --rpc-url "$RPC")"
same "$got" "$PERMIT2" || die "Permit2DepositCollector points at Permit2 $got"

if has_code "$X402_USDC"; then
  say "FiatToken USDC already at $X402_USDC"
else
  say "deploying Circle FiatToken v2.2 (implementation, then proxy)"
  [ "$(cast nonce "$TOKEN_ADMIN" --rpc-url "$RPC")" = 0 ] \
    || die "mnemonic index 20 has been used; the FiatToken would not land at $X402_USDC"
  send --private-key "$TOKEN_ADMIN_KEY" --create "$(cat "$ART/FiatTokenV2_2.creation.hex")"
  has_code "$FIAT_TOKEN_IMPL" || die "FiatTokenV2_2 did not land at $FIAT_TOKEN_IMPL"
  send --private-key "$TOKEN_ADMIN_KEY" --create \
    "$(cat "$ART/FiatTokenProxy.creation.hex")$(cast abi-encode 'f(address)' "$FIAT_TOKEN_IMPL" | cut -c3-)"
  has_code "$X402_USDC" || die "FiatTokenProxy did not land at $X402_USDC"

  send --private-key "$TOKEN_OWNER_KEY" "$X402_USDC" \
    'initialize(string,string,string,uint8,address,address,address,address)' \
    USDC USDC USD 6 "$TOKEN_OWNER" "$TOKEN_OWNER" "$TOKEN_OWNER" "$TOKEN_OWNER"
  send --private-key "$TOKEN_OWNER_KEY" "$X402_USDC" 'initializeV2(string)' USDC
  send --private-key "$TOKEN_OWNER_KEY" "$X402_USDC" 'initializeV2_1(address)' "$TOKEN_OWNER"
  send --private-key "$TOKEN_OWNER_KEY" "$X402_USDC" 'initializeV2_2(address[],string)' '[]' USDC
  send --private-key "$TOKEN_OWNER_KEY" "$X402_USDC" 'configureMinter(address,uint256)' \
    "$TOKEN_OWNER" "$(cast max-uint)"
fi

got="$(cast call "$X402_USDC" 'version()(string)' --rpc-url "$RPC")"
[ "$got" = '"2"' ] || die "FiatToken answers version $got, not \"2\""
got="$(cast call "$X402_USDC" 'decimals()(uint8)' --rpc-url "$RPC")"
[ "$got" = 6 ] || die "FiatToken answers decimals $got, not 6"
say "ready: batch-settlement at $BATCH_SETTLEMENT, ERC-3009 USDC at $X402_USDC"
