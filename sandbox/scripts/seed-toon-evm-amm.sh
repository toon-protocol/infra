#!/bin/sh
# =============================================================================
# THE EVM ASSET LAYER: real ANYONE, real WETH9, real Uniswap v3, real TWAP.
# =============================================================================
# Runs INSIDE the anvil container (foundry image), from the anvil entrypoint,
# after the connector's DeployLocal.s.sol and the sandbox's
# DeploySandboxExtras.s.sol — and BEFORE the anvil healthcheck can pass, which
# is deliberate: the hub refuses to start unless its `[settlement.evm]` token
# resolves a TokenNetwork, and its ANYONE rate poller refuses at startup unless
# both quote pools exist. Everything below has to be on the chain before any
# connector dials it.
#
# WHAT IT BUILDS, AND WHY EACH PIECE IS THE REAL THING
# ----------------------------------------------------
#   1. ANYONE (0xFeAc2Eae…) — the MAINNET RUNTIME BYTECODE, placed with
#      `anvil_setCode` at its own mainnet address. Not a mock: this is the
#      deployed AnyoneProtocolToken, and `decimals()` answering 18 below is
#      that contract answering, not a constructor argument this sandbox chose.
#      `setCode` copies code and not storage, so the four storage words the
#      real constructor wrote are written here by hand (see ANYONE STORAGE).
#   2. WETH9 (0xC02aaA39…) — likewise, mainnet runtime bytecode at the mainnet
#      address. Its balances need no storage surgery at all: `deposit()` is
#      payable and mints 1:1 against real anvil ETH, which is how this script
#      funds it.
#   3. UniswapV3Factory — the OFFICIAL @uniswap/v3-core@1.0.1 creation
#      bytecode, deployed normally so its constructor runs. Verified
#      byte-identical to mainnet's deployed factory apart from the
#      `NoDelegateCall` self-address immutable (see artifacts/evm/README).
#      Deploying it rather than `setCode`ing it is what makes `createPool`
#      work: the fee-tier table is constructor state, and the POOL creation
#      code is embedded in the factory's own runtime, so every pool this
#      script creates is genuine v3-core.
#   4. Two pools — ANYONE/WETH at 1% and WETH/USDC at 0.05%, the mainnet
#      venues' fee tiers — initialised, grown to an observation cardinality
#      that covers the connector's TWAP window, given one full-range position
#      each, and primed with 900 seconds of observation history.
#
# WHY THE PRIMING IS NOT OPTIONAL. A fresh v3 pool has observation cardinality
# 1: `observe([300, 0])` reverts `OLD`, the connector's EVM rate source maps
# that to `WindowNotServed`, and the ANYONE pair then silently never prices —
# config loads, node boots, every crossing refuses `F02`. So the pools are
# grown (`increaseObservationCardinalityNext`) AND walked forward in time with
# `evm_increaseTime` between priming swaps, because an observation is only
# written when a swap touches the pool. The 900 seconds consumed here are
# exactly the 900 anvil was started BEHIND wall-clock with (see the `anvil`
# service's `--timestamp`), so the chain comes out of priming at real time:
# a chain running early would make every rate look permanently fresh, and one
# running late would make every rate look permanently stale.
#
# IDEMPOTENT on a live chain in the useful direction: the TokenNetwork and the
# pools are created only if absent, and re-running re-primes rather than
# breaking. It is NOT idempotent about liquidity (a second run mints a second
# position) — nothing calls it twice, and `make clean` is the reset.
set -eu

RPC="${RPC_URL:-http://localhost:8545}"
ART="${ARTIFACTS_DIR:-/sandbox-artifacts}"
EXTRAS="${EXTRAS_DIR:-/sandbox-extras}"
TOPOLOGY="${AMM_TOPOLOGY:-/sandbox-conf/amm-topology.conf}"

# Every address and figure below the `.` comes from the one file all three
# consumers of this topology read (the other two are scripts/swap-driver.sh and
# scripts/smoke-toon.mjs).
. "$TOPOLOGY"
ANYONE="$ANYONE_TOKEN"
WETH="$WETH_TOKEN"
USDC="$USDC_TOKEN"
REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 # TokenNetworkRegistry (DeployLocal)

# anvil account 0 — the deployer everything else in this sandbox funds from.
FUNDER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
FUNDER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# anvil account 8 — dedicated to the AMM layer, so the factory is its nonce 0
# and SandboxAmm its nonce 1 whatever else the chain does.
AMM_DEPLOYER_KEY=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97

say() { echo "[seed-toon-evm-amm] $*"; }
die() { echo "[seed-toon-evm-amm] FATAL: $*" >&2; exit 1; }
send() { cast send --rpc-url "$RPC" "$@" >/dev/null; }
rpc()  { cast rpc --rpc-url "$RPC" "$@" >/dev/null; }
# Addresses are compared LOWERCASED throughout: `cast` answers EIP-55 checksum
# case, the connector lowercases every address it canonicalises, and the two
# would otherwise disagree about identical addresses.
lc()   { echo "$1" | tr 'A-F' 'a-f'; }
same() { [ "$(lc "$1")" = "$(lc "$2")" ]; }

# ── 1. ANYONE, at its own mainnet address ───────────────────────────────────
say "placing the mainnet AnyoneProtocolToken runtime at $ANYONE"
rpc anvil_setCode "$ANYONE" "$(cat "$ART/AnyoneProtocolToken.runtime.hex")"

# ANYONE STORAGE. The deployed contract is OpenZeppelin ERC20 + Ownable, whose
# layout was read off the bytecode rather than guessed (slot 0 `_balances`,
# 1 `_allowances`, 2 `_totalSupply`, 3 `_name`, 4 `_symbol`, 5 `_owner`
# packed with a `launched` flag at byte offset 20). `setCode` runs no
# constructor, so without these four words the token is a nameless,
# supply-less, PERMANENTLY UNLAUNCHED contract: every `transfer` reverts
# `AnyoneProtocolToken: Not launched.`, which is the one thing about this
# token that would otherwise only be discovered from inside a failing swap.
#
# Solidity short strings are stored as `data || 2*length` in one word, which
# is what the two literals below are.
SUPPLY=100000000000000000000000000 # 100,000,000 ANYONE at 18dp
rpc anvil_setStorageAt "$ANYONE" \
  "$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$FUNDER" 0)")" \
  "$(cast to-uint256 "$SUPPLY")"
rpc anvil_setStorageAt "$ANYONE" "$(cast to-uint256 2)" "$(cast to-uint256 "$SUPPLY")"
# "ANyONe Protocol" (the mainnet spelling, capitalisation included) and "ANYONE"
rpc anvil_setStorageAt "$ANYONE" "$(cast to-uint256 3)" \
  0x414e794f4e652050726f746f636f6c000000000000000000000000000000001e
rpc anvil_setStorageAt "$ANYONE" "$(cast to-uint256 4)" \
  0x414e594f4e45000000000000000000000000000000000000000000000000000c
# `_owner` (20 bytes at offset 0) packed with the `launched` bool at byte
# offset 20 — so the word is 22 zero nibbles, then 01, then the 40-nibble
# address. Without the 01 every transfer reverts "AnyoneProtocolToken: Not
# launched." and the first thing to hit it would be the pool mint.
rpc anvil_setStorageAt "$ANYONE" "$(cast to-uint256 5)" \
  "0x000000000000000000000001$(echo "$FUNDER" | cut -c3- | tr 'A-F' 'a-f')"

[ "$(cast call "$ANYONE" 'decimals()(uint8)' --rpc-url "$RPC")" = "18" ] \
  || die "ANYONE decimals() is not 18 — the wrong bytecode landed at $ANYONE"
[ "$(cast call "$ANYONE" 'symbol()(string)' --rpc-url "$RPC" | tr -d '"')" = "ANYONE" ] \
  || die "ANYONE symbol() is not ANYONE"
say "ANYONE: $(cast call "$ANYONE" 'name()(string)' --rpc-url "$RPC") / $(cast call "$ANYONE" 'symbol()(string)' --rpc-url "$RPC"), decimals 18, supply $(cast call "$ANYONE" 'totalSupply()(uint256)' --rpc-url "$RPC")"

# ── 2. WETH9, at its own mainnet address ────────────────────────────────────
say "placing the mainnet WETH9 runtime at $WETH"
rpc anvil_setCode "$WETH" "$(cat "$ART/WETH9.runtime.hex")"
# WETH9's layout: 0 `name`, 1 `symbol`, 2 `decimals`, 3 `balanceOf`,
# 4 `allowance`. Only the three metadata words are constructor state; balances
# come from `deposit()` and need no surgery.
rpc anvil_setStorageAt "$WETH" "$(cast to-uint256 0)" \
  0x577261707065642045746865720000000000000000000000000000000000001a
rpc anvil_setStorageAt "$WETH" "$(cast to-uint256 1)" \
  0x5745544800000000000000000000000000000000000000000000000000000008
rpc anvil_setStorageAt "$WETH" "$(cast to-uint256 2)" "$(cast to-uint256 18)"
[ "$(cast call "$WETH" 'decimals()(uint8)' --rpc-url "$RPC")" = "18" ] \
  || die "WETH9 decimals() is not 18"
say "WETH9: $(cast call "$WETH" 'symbol()(string)' --rpc-url "$RPC"), decimals 18"

# ── 3. a TokenNetwork for ANYONE ────────────────────────────────────────────
# The hub and the anytoon node both point `[settlement.evm]` at ANYONE, and a
# connector resolves `getTokenNetwork(token)` through the registry at startup,
# refusing to start on a zero answer. `createTokenNetwork` is permissionless on
# this registry (the whitelist is off on the local deploy).
TN="$(cast call "$REGISTRY" 'getTokenNetwork(address)(address)' "$ANYONE" --rpc-url "$RPC")"
if [ "$TN" = "0x0000000000000000000000000000000000000000" ]; then
  send --private-key "$FUNDER_KEY" "$REGISTRY" 'createTokenNetwork(address)(address)' "$ANYONE"
  TN="$(cast call "$REGISTRY" 'getTokenNetwork(address)(address)' "$ANYONE" --rpc-url "$RPC")"
fi
same "$TN" "$ANYONE_TOKEN_NETWORK" \
  || die "ANYONE TokenNetwork is $TN, but the committed configs name $ANYONE_TOKEN_NETWORK"
say "ANYONE TokenNetwork: $TN"

# ── 4. Uniswap v3 factory + the sandbox's own liquidity contract ────────────
if [ "$(cast code "$UNISWAP_V3_FACTORY" --rpc-url "$RPC")" = "0x" ]; then
  say "deploying the official UniswapV3Factory creation bytecode"
  send --private-key "$AMM_DEPLOYER_KEY" --create "$(cat "$ART/UniswapV3Factory.creation.hex")"
fi
[ "$(cast code "$UNISWAP_V3_FACTORY" --rpc-url "$RPC")" != "0x" ] \
  || die "no code at the committed factory address $UNISWAP_V3_FACTORY"

if [ "$(cast code "$SANDBOX_AMM" --rpc-url "$RPC")" = "0x" ]; then
  say "deploying SandboxAmm"
  forge script "$EXTRAS/SandboxAmm.s.sol:DeploySandboxAmmScript" \
    --rpc-url "$RPC" --broadcast --skip-simulation >/dev/null
fi
[ "$(cast code "$SANDBOX_AMM" --rpc-url "$RPC")" != "0x" ] \
  || die "no code at the committed SandboxAmm address $SANDBOX_AMM"
say "UniswapV3Factory $UNISWAP_V3_FACTORY, SandboxAmm $SANDBOX_AMM"

# ── 5. fund the liquidity contract ──────────────────────────────────────────
# It pays its own `mint`/`swap` callbacks out of its own balance, so it has to
# hold all three tokens before anything is minted. WETH comes from real ETH.
send --private-key "$AMM_DEPLOYER_KEY" --value "${WETH_FLOAT}" "$WETH" 'deposit()'
send --private-key "$AMM_DEPLOYER_KEY" "$WETH" 'transfer(address,uint256)' "$SANDBOX_AMM" "$WETH_FLOAT"
send --private-key "$FUNDER_KEY" "$ANYONE" 'transfer(address,uint256)' "$SANDBOX_AMM" "$ANYONE_FLOAT"
send --private-key "$FUNDER_KEY" "$USDC" 'mint(address,uint256)' "$SANDBOX_AMM" "$USDC_FLOAT"
say "SandboxAmm float: $(cast call "$WETH" 'balanceOf(address)(uint256)' "$SANDBOX_AMM" --rpc-url "$RPC") WETH, $(cast call "$ANYONE" 'balanceOf(address)(uint256)' "$SANDBOX_AMM" --rpc-url "$RPC") ANYONE, $(cast call "$USDC" 'balanceOf(address)(uint256)' "$SANDBOX_AMM" --rpc-url "$RPC") USDC (base units)"

# ── 6. the two pools ────────────────────────────────────────────────────────
# create <label> <tokenA> <tokenB> <fee> <expected> <sqrtPriceX96> <tickLower> <tickUpper> <liquidity>
create_pool() {
  label=$1 a=$2 b=$3 fee=$4 expect=$5 sqrtp=$6 lo=$7 hi=$8 liq=$9
  got="$(cast call "$UNISWAP_V3_FACTORY" 'getPool(address,address,uint24)(address)' "$a" "$b" "$fee" --rpc-url "$RPC")"
  if [ "$got" = "0x0000000000000000000000000000000000000000" ]; then
    send --private-key "$AMM_DEPLOYER_KEY" "$UNISWAP_V3_FACTORY" 'createPool(address,address,uint24)(address)' "$a" "$b" "$fee"
    got="$(cast call "$UNISWAP_V3_FACTORY" 'getPool(address,address,uint24)(address)' "$a" "$b" "$fee" --rpc-url "$RPC")"
    send --private-key "$AMM_DEPLOYER_KEY" "$got" 'initialize(uint160)' "$sqrtp"
    send --private-key "$AMM_DEPLOYER_KEY" "$got" 'increaseObservationCardinalityNext(uint16)' "$OBSERVATION_CARDINALITY"
    send --private-key "$AMM_DEPLOYER_KEY" "$SANDBOX_AMM" 'provide(address,int24,int24,uint128)' "$got" "$lo" "$hi" "$liq"
  fi
  same "$got" "$expect" || die "$label pool is $got, but the committed connector config names $expect"
  say "$label pool $got: tick $(cast call "$SANDBOX_AMM" 'state(address)(uint160,int24,uint16,uint16)' "$got" --rpc-url "$RPC" | tr '\n' ' ')"
}
create_pool "ANYONE/WETH 1%" "$ANYONE" "$WETH" 10000 "$POOL_ANYONE_WETH" \
  "$POOL_ANYONE_WETH_SQRTP" "$FULL_RANGE_LO_200" "$FULL_RANGE_HI_200" "$POOL_ANYONE_WETH_LIQUIDITY"
create_pool "WETH/USDC 0.05%" "$WETH" "$USDC" 500 "$POOL_WETH_USDC" \
  "$POOL_WETH_USDC_SQRTP" "$FULL_RANGE_LO_10" "$FULL_RANGE_HI_10" "$POOL_WETH_USDC_LIQUIDITY"

# ── 7. prime the oracles ────────────────────────────────────────────────────
# A grown cardinality is an EMPTY ring until swaps fill it, and swaps only
# write an observation when the block timestamp moves. So: step the clock,
# trade a dust amount on each pool, repeat — until the oldest observation is
# older than the widest TWAP window any connector will ask for.
say "priming $PRIME_STEPS observations at ${PRIME_STEP_SECS}s apart (${PRIME_SPAN_SECS}s of history)"
i=0
while [ "$i" -lt "$PRIME_STEPS" ]; do
  rpc evm_increaseTime "$PRIME_STEP_SECS"
  # alternate direction so the priming walk leaves the price where it started
  if [ $((i % 2)) -eq 0 ]; then zfo=true; else zfo=false; fi
  send --private-key "$AMM_DEPLOYER_KEY" "$SANDBOX_AMM" 'trade(address,bool,int256)' \
    "$POOL_ANYONE_WETH" "$zfo" "$(if [ "$zfo" = true ]; then echo "$PRIME_DUST_WETH"; else echo "$PRIME_DUST_ANYONE"; fi)"
  send --private-key "$AMM_DEPLOYER_KEY" "$SANDBOX_AMM" 'trade(address,bool,int256)' \
    "$POOL_WETH_USDC" "$zfo" "$(if [ "$zfo" = true ]; then echo "$PRIME_DUST_USDC"; else echo "$PRIME_DUST_WETH"; fi)"
  i=$((i + 1))
done

# ── 8. the assertion the whole script exists for ────────────────────────────
# If this reverts, the connector's rate poller would have answered
# `WindowNotServed` for ever and the ANYONE pair would have priced NOTHING,
# with a green boot and an `F02` on every crossing. Fail here instead.
for p in "$POOL_ANYONE_WETH" "$POOL_WETH_USDC"; do
  cast call "$p" 'observe(uint32[])(int56[],uint160[])' "[$TWAP_WINDOW_SECS,0]" --rpc-url "$RPC" >/dev/null \
    || die "pool $p cannot serve a ${TWAP_WINDOW_SECS}s TWAP window — priming did not take"
done
say "both pools serve a ${TWAP_WINDOW_SECS}s TWAP window"
say "done."
