#!/bin/sh
# Seeds the TOON payment layer's EVM side (runs as the `seed-toon-evm`
# one-shot compose service, in the foundry image, after the anvil deploy).
#
#   1. asserts the settlement topology (registry -> TokenNetwork) is deployed
#   2. funds each connector's settlement account: 100 ETH + 1000 mock USDC
#      (MockERC20.mint is deliberately ungated on the from-source deploy)
#   3. opens the two peering channels (relay-store, relay-gas) from the
#      relay-connector's settlement key and deposits 100 USDC into each —
#      the exact flow of the connector repo's local/keys.sh EVM leg
#
# The channel ids are keccak(p1, p2, channelEpoch=0) with participants sorted
# (ADR 0059). The committed conf/connector-*.toml files name them; this
# script re-reads the chain after opening and FAILS LOUDLY if the id the
# chain produced is not the committed one, which is what makes committing
# them legitimate.
#
# IDEMPOTENT: funding tops up nothing that matters (ETH/USDC amounts are
# generous, re-running adds more on a wiped chain and is harmless on a live
# one); openChannel is skipped when the channel exists; setTotalDeposit takes
# an absolute total so re-running moves nothing.
set -eu

RPC="${RPC_URL:-http://anvil:8545}"
KEYS="${KEYS_DIR:-/keys}"

REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
EXPECTED_TOKEN_NETWORK=0xCafac3dD18aC6c6e92c921884f9E4176737C052c
# anvil account 0 — the deployer; public test key, local chain only.
FUNDER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
CHANNEL_DEPOSIT=100000000 # 100 USDC (6dp) per peering channel

# Committed ids (conf/connector-relay.toml [[peer_channels]]).
CH_RELAY_STORE=0x0e1011bd4e6aa2e04ace59110f78c810ad1daae882c5826bb7460097cd75c5d2
CH_RELAY_GAS=0xd57686b20c10ed895bc3e2485d935655bf6f480fd9609ff633b6a751a261d64b

if [ "$(cast code "$USDC" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
  echo "FATAL: no contract at $USDC on $RPC — the anvil forge deploy did not land." >&2
  exit 1
fi

TOKEN_NETWORK="$(cast call "$REGISTRY" 'getTokenNetwork(address)(address)' "$USDC" --rpc-url "$RPC")"
if [ "$TOKEN_NETWORK" != "$EXPECTED_TOKEN_NETWORK" ]; then
  echo "FATAL: getTokenNetwork(USDC) = $TOKEN_NETWORK, but the committed configs name $EXPECTED_TOKEN_NETWORK." >&2
  exit 1
fi
echo "TokenNetwork: $TOKEN_NETWORK"

fund() { # fund <label> <keyfile>
  addr="$(cast wallet address --private-key "0x$(cat "$KEYS/$2/settlement.key")")"
  cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" --value 100ether "$addr" >/dev/null
  cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" "$USDC" 'mint(address,uint256)' "$addr" 1000000000 >/dev/null
  echo "$1: funded $addr with 100 ETH + 1000 USDC"
}
fund relay-connector relay-connector
fund store-connector store-connector
fund gas-connector gas-connector

RELAY_KEY="0x$(cat "$KEYS/relay-connector/settlement.key")"
RELAY_ADDR="$(cast wallet address --private-key "$RELAY_KEY")"

open_channel() { # open_channel <label> <payee-keydir> <committed-channel-id>
  payee="$(cast wallet address --private-key "0x$(cat "$KEYS/$2/settlement.key")")"
  state="$(cast call "$TOKEN_NETWORK" 'channels(bytes32)(uint256,uint8,uint256,uint256,address,address)' "$3" --rpc-url "$RPC" | sed -n 2p)"
  if [ "$state" = "0" ]; then
    cast send --rpc-url "$RPC" --private-key "$RELAY_KEY" \
      "$TOKEN_NETWORK" 'openChannel(address,uint256)' "$payee" 3600 >/dev/null
    state="$(cast call "$TOKEN_NETWORK" 'channels(bytes32)(uint256,uint8,uint256,uint256,address,address)' "$3" --rpc-url "$RPC" | sed -n 2p)"
    if [ "$state" = "0" ]; then
      echo "FATAL: opened a channel $RELAY_ADDR <-> $payee but it did NOT land at the committed id $3." >&2
      echo "The id is keccak(p1, p2, channelEpoch) — the committed ids assume epoch 0; a settled" >&2
      echo "channel between this pair advances the epoch. 'make clean && make up' resets it." >&2
      exit 1
    fi
    echo "$1: opened channel $3"
  else
    echo "$1: channel $3 already open"
  fi
  cast send --rpc-url "$RPC" --private-key "$RELAY_KEY" \
    "$USDC" 'approve(address,uint256)' "$TOKEN_NETWORK" "$CHANNEL_DEPOSIT" >/dev/null
  cast send --rpc-url "$RPC" --private-key "$RELAY_KEY" \
    "$TOKEN_NETWORK" 'setTotalDeposit(bytes32,address,uint256)' "$3" "$RELAY_ADDR" "$CHANNEL_DEPOSIT" >/dev/null
  echo "$1: relay-connector deposit stands at $CHANNEL_DEPOSIT (6dp USDC)"
}
open_channel relay-store store-connector "$CH_RELAY_STORE"
open_channel relay-gas gas-connector "$CH_RELAY_GAS"

echo "[seed-toon-evm] done."
