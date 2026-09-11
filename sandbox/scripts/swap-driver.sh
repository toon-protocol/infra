#!/bin/sh
# =============================================================================
# THE SWAP DRIVER — what makes the ANYONE rate LIVE rather than merely floating.
# =============================================================================
# Runs as the long-lived `swap-driver` compose service (foundry image, `full`
# profile only — the payment profile has no AMM and needs none).
#
# WHY A SERVICE AND NOT A SEED JOB
# --------------------------------
# A Uniswap v3 pool's oracle only advances when a SWAP touches it: the ring of
# observations is written in `Pool.swap`, nowhere else. A pool that is seeded
# and then left alone answers `observe()` from a frozen history for ever — the
# connector's TWAP would be a constant, the `[[tokens]] quote` would be a
# decorated static rate, and `GET /rates` would never move. Worse, anvil
# auto-mines only when a transaction arrives, so with nothing trading there are
# no new BLOCKS either, the rate source's `observed_at` (which is the head
# block's own timestamp, not the poller's clock) stops advancing, and one
# `ttl_secs` later every ANYONE crossing refuses `T00`. This loop is what keeps
# both of those alive.
#
# WHAT IT TRADES, AND WHY IT IS A TRIANGLE WAVE
# ---------------------------------------------
# ANYONE/WETH is steered between `target + band` and `target - band`, flipping
# every half period. Two properties matter and neither is decoration:
#
#   * it MOVES, so `GET /rates` genuinely changes between two polls a minute
#     apart, and the smoke test's liveness assertion is about a live market
#     rather than about a number someone typed;
#   * it is BOUNDED, and stays bounded for ever. The hub quotes a STATIC price
#     in uUSDC for a route whose downstream price is in ANYONE, so the hub's
#     price has to carry enough headroom to cover the worst rate inside the
#     band (see conf/connector-relay.toml's arithmetic). A random walk would
#     eventually leave that headroom and start refusing purchases at 3am, which
#     is a true fact about FX risk and a terrible property in a sandbox.
#
# WETH/USDC is steered straight back to its target every tick instead. It is
# the "stable" leg: it contributes observations and blocks without contributing
# drift, so all of the movement the smoke test sees comes from one pool and can
# be reasoned about.
#
# LOGGING IS BOUNDED: one line per LOG_EVERY ticks, plus every failure. At the
# committed cadence that is one line a minute, which `docker compose logs` can
# live with for the lifetime of a sandbox.
set -eu

RPC="${RPC_URL:-http://anvil:8545}"
TOPOLOGY="${AMM_TOPOLOGY:-/sandbox-conf/amm-topology.conf}"
. "$TOPOLOGY"

# anvil account 8 — the same account that deployed the AMM and holds nothing
# else in this sandbox.
DRIVER_KEY=0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
LOG_EVERY="${LOG_EVERY:-4}"

say() { echo "[swap-driver] $*"; }

tick_of() { # tick_of <pool>
  cast call "$SANDBOX_AMM" 'tickOf(address)(int24)' "$1" --rpc-url "$RPC" 2>/dev/null | cut -d' ' -f1
}
trade() { # trade <pool> <zeroForOne> <amountIn>
  cast send --rpc-url "$RPC" --private-key "$DRIVER_KEY" \
    "$SANDBOX_AMM" 'trade(address,bool,int256)' "$1" "$2" "$3" >/dev/null 2>&1
}

# The chain has to be there, and PRIMED, before the first trade: this service
# starts alongside the connectors and compose only guarantees anvil is healthy,
# which it is not until seed-toon-evm-amm.sh has finished.
until [ -n "$(tick_of "$POOL_ANYONE_WETH")" ]; do
  say "waiting for $POOL_ANYONE_WETH to answer tickOf()"
  sleep 3
done
say "driving $POOL_ANYONE_WETH around tick $ANYONE_TARGET_TICK +/-$ANYONE_BAND_TICKS" \
    "(half period ${ANYONE_HALF_PERIOD_SECS}s) and pinning $POOL_WETH_USDC at $WETH_USDC_TARGET_TICK," \
    "every ${SWAP_INTERVAL_SECS}s"

n=0
while :; do
  n=$((n + 1))
  # Triangle wave off the wall clock rather than off a counter, so a restarted
  # driver rejoins the phase it would have been in rather than starting over.
  if [ $((($(date +%s) / ANYONE_HALF_PERIOD_SECS) % 2)) -eq 0 ]; then
    goal=$((ANYONE_TARGET_TICK + ANYONE_BAND_TICKS))
  else
    goal=$((ANYONE_TARGET_TICK - ANYONE_BAND_TICKS))
  fi

  tick="$(tick_of "$POOL_ANYONE_WETH")"
  if [ -z "$tick" ]; then
    say "ANYONE/WETH tickOf() failed — chain unreachable? retrying"
    sleep "$SWAP_INTERVAL_SECS"
    continue
  fi
  # token0 is WETH and token1 is ANYONE, so selling token0 IN (zeroForOne) buys
  # ANYONE and lowers ANYONE-per-WETH, i.e. lowers the tick.
  if [ "$tick" -gt "$goal" ]; then
    trade "$POOL_ANYONE_WETH" true "$STEP_WETH" || say "ANYONE/WETH sell failed"
  else
    trade "$POOL_ANYONE_WETH" false "$STEP_ANYONE" || say "ANYONE/WETH buy failed"
  fi

  # token0 is USDC and token1 is WETH here, so zeroForOne buys WETH with USDC
  # and lowers WETH-per-USDC: the same direction rule, one pool over.
  tickb="$(tick_of "$POOL_WETH_USDC")"
  if [ -n "$tickb" ]; then
    if [ "$tickb" -gt "$WETH_USDC_TARGET_TICK" ]; then
      trade "$POOL_WETH_USDC" true "$STEP_USDC" || say "WETH/USDC sell failed"
    else
      trade "$POOL_WETH_USDC" false "$STEP_WETH_SMALL" || say "WETH/USDC buy failed"
    fi
  fi

  if [ $((n % LOG_EVERY)) -eq 0 ]; then
    say "tick $(tick_of "$POOL_ANYONE_WETH") -> $goal (ANYONE/WETH), $(tick_of "$POOL_WETH_USDC") -> $WETH_USDC_TARGET_TICK (WETH/USDC)"
  fi
  sleep "$SWAP_INTERVAL_SECS"
done
