#!/usr/bin/env bash
# Regenerates the committed TOON key material under keys/toon/ (and prints the
# values that must be re-pasted into committed configs when they change).
#
# EVERYTHING under keys/toon/ is a valueless throwaway for the local sandbox,
# committed on purpose so a fresh clone works. The split (following the
# connector repo's local/keys.sh, whose comments carry the reasoning):
#
#   RANDOM (kept if present; nothing committed depends on their values):
#     <node>/signer.key            connector ILP identity, 64 hex
#     <node>/operator-send.key     ed25519 seed for operator writes, 64 hex
#     <node>/operator-bearer.token operator read credential, 64 hex
#   DERIVED from anvil's public test mnemonic (rewritten every run; their
#   ADDRESSES are committed in conf/connector-*.toml as counterparty_key and
#   feed the committed channel ids, so they must be identical everywhere):
#     <node>/settlement.key        EVM secp256k1, indices 24/25/26
#     <node>/settlement-solana.key 32-byte ed25519 SEED as hex, indices 34/35/36
#     gas-evm-relayer.key          EVM secp256k1, index 27 — the gas station's
#                                  DEDICATED kind:5098 relayer; its 0x-prefixed
#                                  value is embedded in conf/gas-station.conf
#                                  (EVM_GAS_STATION_CONFIG_JSON) and its address
#                                  in scripts/seed-toon-evm.sh
#   COPIED from the connector repo (committed there for the same reason):
#     usdc-mint.json usdc-authority.json — the deterministic local mock-USDC
#     mint H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H and its authority
#   GENERATED ONCE, random (their public halves are embedded in conf/*.conf):
#     gas-fee-payer.json store-turbo-signer.json arns-dvm.json — see
#     conf/gas-station.conf and conf/store.conf; regenerate those env values
#     together with these (arns-dvm.json is the store's kind:5095 brokered-buy
#     payer: its hex form is ARNS_DVM_SOLANA_SECRET_KEY in conf/store.conf and
#     scripts/seed-solana.mjs funds its address with SOL + ARIO).
#
# After changing settlement keys: recompute the two channel ids
#   keccak(abi.encodePacked(min(a,b), max(a,b), uint256(0)))
# and update conf/connector-*.toml + scripts/seed-toon-evm.sh; the operator
# allowlists (<node>/operator-write.keys) must be re-derived with
#   docker run --rm -v <dir>:/w:ro ghcr.io/toon-protocol/connector:rust-2026.08.28.1 \
#     send --operator-key /w/operator-send.key --print-keyid
#
# The connector image runs as uid 10001 and mounts these read-only, so files
# must be world-readable. Nothing here is written by root, so a+r suffices
# (chown 10001 is only needed for root-owned files — the fleet's case).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS="$HERE/keys/toon"
MN="test test test test test test test test test test test junk"
CAST="docker run --rm --entrypoint cast ghcr.io/foundry-rs/foundry:v1.8.1"
CONNECTOR_IMAGE=ghcr.io/toon-protocol/connector:rust-2026.08.28.1

i=0
for pair in relay-connector:24:34 store-connector:25:35 gas-connector:26:36; do
  IFS=: read -r node ei si <<<"$pair"
  mkdir -p "$KEYS/$node"
  for k in signer.key operator-send.key operator-bearer.token; do
    [[ -f "$KEYS/$node/$k" ]] || openssl rand -hex 32 >"$KEYS/$node/$k"
  done
  $CAST wallet private-key --mnemonic "$MN" --mnemonic-index "$ei" | sed 's/^0x//' >"$KEYS/$node/settlement.key"
  $CAST wallet private-key --mnemonic "$MN" --mnemonic-index "$si" | sed 's/^0x//' >"$KEYS/$node/settlement-solana.key"
  docker run --rm -v "$KEYS/$node:/w:ro" "$CONNECTOR_IMAGE" \
    send --operator-key /w/operator-send.key --print-keyid \
    | { echo "# The PUBLIC half of operator-send.key. An allowlist entry holds no secret."; cat; } \
    >"$KEYS/$node/operator-write.keys"
  echo "$node: evm $($CAST wallet address --private-key 0x$(cat "$KEYS/$node/settlement.key"))"
done
$CAST wallet private-key --mnemonic "$MN" --mnemonic-index 27 | sed 's/^0x//' >"$KEYS/gas-evm-relayer.key"
echo "gas-evm-relayer: evm $($CAST wallet address --private-key 0x$(cat "$KEYS/gas-evm-relayer.key"))"
chmod -R a+rX "$KEYS"
echo "keys under $KEYS refreshed — re-derive committed addresses/channel ids if settlement keys changed."
