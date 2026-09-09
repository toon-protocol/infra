#!/bin/sh
# Seeds the TOON payment layer's EVM side (runs as the `seed-toon-evm`
# one-shot compose service, in the foundry image, after the anvil deploy).
#
#   1. asserts the settlement topology (registry -> TokenNetwork) is deployed
#   2. funds each connector's settlement account: 100 ETH + 1000 mock USDC
#      (MockERC20.mint is deliberately ungated on the from-source deploy)
#
# The CLIENT leg (smoke test -> hub) settles here on anvil: the payer opens
# its own channel against the hub's EVM settlement address at smoke time.
# The two PEERING channels do NOT live here any more — they settle on the
# local validator via the payment_channel program, opened post-boot by the
# open-toon-solana-channels init job (see scripts/open-solana-channel.py).
#
# IDEMPOTENT enough for a dev chain: re-running adds more funds on a wiped
# chain and is harmless on a live one.
set -eu

RPC="${RPC_URL:-http://anvil:8545}"
KEYS="${KEYS_DIR:-/keys}"

REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
EXPECTED_TOKEN_NETWORK=0xCafac3dD18aC6c6e92c921884f9E4176737C052c
# anvil account 0 — the deployer; public test key, local chain only.
FUNDER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

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

fund() { # fund <label> <keydir>
  addr="$(cast wallet address --private-key "0x$(cat "$KEYS/$2/settlement.key")")"
  cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" --value 100ether "$addr" >/dev/null
  cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" "$USDC" 'mint(address,uint256)' "$addr" 1000000000 >/dev/null
  echo "$1: funded $addr with 100 ETH + 1000 USDC"
}
fund relay-connector relay-connector
fund store-connector store-connector
fund gas-connector gas-connector

echo "[seed-toon-evm] done."
