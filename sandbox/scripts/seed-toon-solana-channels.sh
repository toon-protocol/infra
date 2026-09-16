#!/bin/sh
# Opens + collateralises the three SOLANA peering channels (runs as the
# `open-toon-solana-channels` one-shot compose service, AFTER the hub is
# healthy — a Solana channel can only be opened through the payer node's own
# operator surface, the repo's only InitializeChannel submitter; see
# scripts/open-solana-channel.py's header).
#
# The hub (relay-connector) is the payer of all four peerings, but only three
# of them settle here (relay-store, relay-gas, relay-provider): it opens each channel against the counterparty's Solana
# settlement key and deposits 100 USDC of its own collateral (its ATA holds
# 1000, seeded by seed-toon-solana). THE THIRD PEERING, relay-anytoon, SETTLES
# ANYONE ON ANVIL since the cross-asset flip and is opened by
# scripts/seed-toon-evm.sh with two ordinary contract calls — see that file's
# header for why the EVM half needs no operator surface at all. The channel accounts are the PDAs the committed
# conf/connector-*.toml files name — open-solana-channel.py refuses to
# report success unless the node derives exactly those, and re-reads the
# program's own account for participants/mint/status/deposit.
#
# IDEMPOTENT: an already-open channel is left alone (and still asserted);
# the deposit is a top-up to the figure, so a re-run moves nothing.
set -eu

RPC="${RPC_URL:-http://solana-validator:8899}"
HUB="${HUB_OPERATOR_URL:-http://relay-connector:3000}"
KEYS="${KEYS_DIR:-/keys}"
PROGRAM=HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR
MINT=H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H
HUB_SOL=9gXKH3AtUErhsAVaLmBkiJxdtUmUE29MjaRLFKxCqfAx
STORE_SOL=8VQznfuCBp9aDTwdHaXYneqgfckmVezE1MXrNW8hhUMe
GAS_SOL=5tci9czy3L2StZ6cNu3f85HcnnJqmHPYt8YSbGMWUE9q
PROVIDER_SOL=6dbRwZDF34CCWGvUm36VRRsEb7TTySQ1uLrYFEMumtgA
CH_RELAY_STORE=4yUyXpi3c23g1sxGWWUpANVoGKzt8i4iMc2xjdC3njR7
CH_RELAY_GAS=4oUEsaokTBie41Xtb7PDkeMK8vDoqvzeWecwk98Abc3T
CH_RELAY_PROVIDER=87EGu9qGRB3G88jTdwz51uJscLQDHgzJfje7eXWfuEkn
DEPOSIT=100000000 # 100 USDC (6dp) of the hub's own collateral per peering

open() { # open <label> <channel-account> <payee-pubkey>
  echo "== $1: channel $2"
  python3 /seed/open-solana-channel.py \
    --rpc-url "$RPC" \
    --operator-url "$HUB" \
    --operator-key "$KEYS/relay-connector/operator-send.key" \
    --program-id "$PROGRAM" \
    --token-mint "$MINT" \
    --channel-account "$2" \
    --payer "$HUB_SOL" \
    --payee "$3" \
    --settlement-timeout-seconds 3600 \
    --deposit-base-units "$DEPOSIT"
}

open relay-store "$CH_RELAY_STORE" "$STORE_SOL"
open relay-gas "$CH_RELAY_GAS" "$GAS_SOL"
open relay-provider "$CH_RELAY_PROVIDER" "$PROVIDER_SOL"

echo "[open-toon-solana-channels] done."
