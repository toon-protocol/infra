#!/bin/sh
# Seeds the TOON payment layer's EVM side (runs as the `seed-toon-evm`
# one-shot compose service, in the foundry image, after the anvil deploy).
#
#   1. asserts the settlement topology (registry -> TokenNetwork) is deployed
#   2. funds each connector's settlement account: 100 ETH + 1000 mock USDC
#      (MockERC20.mint is deliberately ungated on the from-source deploy)
#   3. gives the hub and the anytoon node ANYONE, and OPENS + COLLATERALISES
#      the one EVM peering channel between them
#
# WHAT LIVES ON WHICH CHAIN, since the cross-asset flip:
#   * the CLIENT leg (smoke test -> hub) settles on SOLANA in mock USDC, and
#     the buyer opens its own channel at smoke time (seed-toon-solana funds it)
#   * the relay-store and relay-gas peerings settle on SOLANA in mock USDC,
#     opened post-boot by the open-toon-solana-channels init job
#   * the relay-anytoon peering settles HERE, in ANYONE, and step 3 below is
#     the only place in this sandbox that opens an EVM payment channel
#
# THE EVM HALF NEEDS NO OPERATOR SURFACE, unlike the Solana half: a
# TokenNetwork's `openChannel` and `setTotalDeposit` are ordinary contract
# calls Foundry can build from a signature string, whereas Solana's
# `InitializeChannel` is a positional account list no chain CLI can build (see
# scripts/open-solana-channel.py's header). `setTotalDeposit` pulls from
# `_msgSender()`, so signing with the hub's own settlement key is what puts the
# hub's own collateral behind the hub's own claims.
#
# IDEMPOTENT enough for a dev chain: re-running adds more funds on a wiped
# chain, is harmless on a live one, and the channel open/deposit are both
# skipped when they are already done (an absolute `setTotalDeposit`, unlike
# Solana's incremental `fund`, is a no-op at the same figure).
set -eu

RPC="${RPC_URL:-http://anvil:8545}"
KEYS="${KEYS_DIR:-/keys}"
TOPOLOGY="${AMM_TOPOLOGY:-/sandbox-conf/amm-topology.conf}"
. "$TOPOLOGY"

REGISTRY=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3
EXPECTED_TOKEN_NETWORK=0xCafac3dD18aC6c6e92c921884f9E4176737C052c
# anvil account 0 — the deployer; public test key, local chain only. It also
# holds ANYONE's entire 100M supply (seed-toon-evm-amm.sh put it there).
FUNDER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# The relay-anytoon peering, exactly as conf/connector-relay.toml and
# conf/connector-anytoon.toml name it. `cast` answers checksum case, so every
# comparison here is lowercased.
EXPECTED_CHANNEL=0x94ab42f98c210488becb8fab3ccb790d8572fe91d1b50f93d70a30f02321f02f
CHANNEL_TIMEOUT=3600
# 100 ANYONE of the hub's own collateral — ~2500 bundle purchases at 0.04 each,
# and well inside the TokenNetwork's 1,000,000-token deposit limit.
CHANNEL_DEPOSIT=100000000000000000000
# What each connector gets to work with (ANYONE is not mintable — it is the
# real mainnet contract with a fixed supply, so this is a transfer out of the
# funder's 100M).
NODE_ANYONE=1000000000000000000000 # 1000 ANYONE
lc() { echo "$1" | tr 'A-F' 'a-f'; }

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
fund anytoon-connector anytoon-connector
fund provider-connector provider-connector
fund provider2-connector provider2-connector

# The kind:5098 relayer (the gas station's DEDICATED EVM wallet — it holds
# native gas only and pays for relayed ERC-2771 forward requests). The anvil
# healthcheck already gates on the forwarder/probe deploy; assert it anyway so
# a broken extras deploy fails HERE with a name, not downstream.
FORWARDER=0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35
PROBE=0xA15BB66138824a1c7167f5E85b957d04Dd34E468
for c in "$FORWARDER" "$PROBE"; do
  if [ "$(cast code "$c" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
    echo "FATAL: no contract at $c on $RPC — DeploySandboxExtras.s.sol did not land." >&2
    exit 1
  fi
done
RELAYER_ADDR="$(cast wallet address --private-key "0x$(cat "$KEYS/gas-evm-relayer.key")")"
cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" --value 100ether "$RELAYER_ADDR" >/dev/null
echo "gas-evm-relayer: funded $RELAYER_ADDR with 100 ETH (kind:5098 float)"

# ── 3. the relay-anytoon peering channel, in ANYONE ─────────────────────────
# seed-toon-evm-amm.sh has already placed the ANYONE contract, registered its
# TokenNetwork and given the funder the whole supply; anvil's own healthcheck
# gates on that, so it cannot be half done by the time this runs.
HUB_KEY="0x$(cat "$KEYS/relay-connector/settlement.key")"
HUB_ADDR="$(cast wallet address --private-key "$HUB_KEY")"
ANYTOON_ADDR="$(cast wallet address --private-key "0x$(cat "$KEYS/anytoon-connector/settlement.key")")"

for pair in "relay-connector:$HUB_ADDR" "anytoon-connector:$ANYTOON_ADDR"; do
  cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" \
    "$ANYONE_TOKEN" 'transfer(address,uint256)' "${pair#*:}" "$NODE_ANYONE" >/dev/null
  echo "${pair%%:*}: funded ${pair#*:} with 1000 ANYONE"
done

# The id is a pure function of the sorted participants and the pair's epoch
# (keccak256(p1, p2, 0) — ADR 0059), which is exactly why both connector TOMLs
# can commit it. Open only if the pair has no live channel.
STATE="$(cast call "$ANYONE_TOKEN_NETWORK" 'channels(bytes32)(uint256,uint8,uint256,uint256,address,address)' \
  "$EXPECTED_CHANNEL" --rpc-url "$RPC" | sed -n 2p | cut -d' ' -f1)"
if [ "$STATE" = "0" ]; then
  cast send --rpc-url "$RPC" --private-key "$HUB_KEY" \
    "$ANYONE_TOKEN_NETWORK" 'openChannel(address,uint256)(bytes32)' "$ANYTOON_ADDR" "$CHANNEL_TIMEOUT" >/dev/null
  echo "relay-anytoon: opened the ANYONE channel"
fi
OPENED="$(cast call "$ANYONE_TOKEN_NETWORK" 'channels(bytes32)(uint256,uint8,uint256,uint256,address,address)' \
  "$EXPECTED_CHANNEL" --rpc-url "$RPC" | sed -n 2p | cut -d' ' -f1)"
if [ "$OPENED" != "1" ]; then
  echo "FATAL: no Opened channel at $EXPECTED_CHANNEL on the ANYONE TokenNetwork $ANYONE_TOKEN_NETWORK." >&2
  echo "The committed conf/connector-relay.toml and conf/connector-anytoon.toml both name it, and a" >&2
  echo "peer claim's verdict never reads the chain — so an unopened channel rehearses green." >&2
  exit 1
fi

# `setTotalDeposit` is ABSOLUTE (Solana's `fund` is incremental), so this is a
# no-op at the same figure and a top-up below it. It pulls from _msgSender(),
# hence the approve from the same key.
cast send --rpc-url "$RPC" --private-key "$HUB_KEY" \
  "$ANYONE_TOKEN" 'approve(address,uint256)' "$ANYONE_TOKEN_NETWORK" "$CHANNEL_DEPOSIT" >/dev/null
cast send --rpc-url "$RPC" --private-key "$HUB_KEY" \
  "$ANYONE_TOKEN_NETWORK" 'setTotalDeposit(bytes32,address,uint256)' \
  "$EXPECTED_CHANNEL" "$HUB_ADDR" "$CHANNEL_DEPOSIT" >/dev/null
HELD="$(cast call "$ANYONE_TOKEN_NETWORK" 'participants(bytes32,address)(uint256,uint256,bytes32)' \
  "$EXPECTED_CHANNEL" "$HUB_ADDR" --rpc-url "$RPC" | sed -n 1p | cut -d' ' -f1)"
echo "relay-anytoon: channel $EXPECTED_CHANNEL Opened, hub side holds $HELD base units of ANYONE"

echo "[seed-toon-evm] done."
