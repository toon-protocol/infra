#!/bin/sh
# =============================================================================
# FUNDS EVERY EVM KEY THE SANDBOX RUNS (infra#39), in ETH and FiatToken USDC.
# =============================================================================
# Runs INSIDE the anvil container, LAST in its entrypoint — after seed-x402.sh
# has deployed the FiatToken — and anvil's healthcheck gates on its last step,
# so a healthy anvil is one whose every connector key is funded. That is what
# the old `seed-toon-evm` one-shot job did, minus the TokenNetwork it checked
# and the channel it opened: every channel is an x402 channel now (connector
# ADR 0075), opened by the nodes themselves (the `open-peerings` job, or a
# client's own deposit), and the MockERC20 it minted is retired.
#
#   * each connector's EVM settlement key: 100 ETH (a node lands its own
#     `claim`/`settle` transactions, and pays its own gas on any outbound
#     channel it opens) + 1000 USDC in the FiatToken
#   * the two directory publishers' wallets (anvil accounts 1 and 2):
#     1000 USDC, for a topology whose hub settles on EVM alone
#   * the two ANYONE nodes (infra#42): anytoon-connector 100 ETH, to land
#     its own claims; the Dealer, dealer-connector, 100 ETH + 100 ANYONE, the
#     float it pays anytoon from (its channel's target is 10; the u64 voucher
#     ceiling caps what one channel can ever carry at ~18.45). ANYONE is the
#     real contract, with no mint: it comes from anvil account 0, which holds
#     the supply seed-toon-evm-amm.sh wrote.
#   * the gas station's dedicated kind:5098 relayer: 100 ETH, the float it
#     pays relayed ERC-2771 forward requests from (conf/gas-station.conf)
#
# IDEMPOTENT enough for a dev chain: re-running adds funds, which every smoke
# tolerates because they assert deltas.
set -eu

RPC="${RPC_URL:-http://localhost:8545}"
KEYS="${KEYS_DIR:-/sandbox-keys}"

# anvil account 0 — genesis ETH; public test key, local chain only.
FUNDER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# The FiatToken and its minter (anvil-mnemonic index 21), from seed-x402.sh.
USDC=0x0A867CA0442383c2A89951244B955AA19b615b58
MINTER_KEY=0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b
NODE_USDC=1000000000 # 1000 USDC at 6dp

say() { echo "[seed-evm-nodes] $*"; }
die() { echo "[seed-evm-nodes] FATAL: $*" >&2; exit 1; }

c="$(cast code "$USDC" --rpc-url "$RPC")"
[ -n "$c" ] && [ "$c" != 0x ] || die "no FiatToken at $USDC — seed-x402.sh must run first"

# Every connector that settles USDC on EVM, whatever profile runs it: the
# chain is seeded once and cold, so `make up-hs` needs no re-seed for its
# hidden provider.
for node in relay-connector relay2-connector store-connector gas-connector provider-connector provider2-connector provider-hs-connector; do
  addr="$(cast wallet address --private-key "0x$(cat "$KEYS/$node/settlement.key")")"
  cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" --value 100ether "$addr" >/dev/null
  cast send --rpc-url "$RPC" --private-key "$MINTER_KEY" "$USDC" 'mint(address,uint256)' "$addr" "$NODE_USDC" >/dev/null
  say "$node: funded $addr with 100 ETH + 1000 USDC"
done

# The two directory publishers' wallets, anvil accounts 1 and 2 — the EVM
# addresses of the account indices they pay from (docker-compose.yml,
# TOON_ACCOUNT_INDEX). They pay on Solana wherever the hub settles there; in a
# topology that leaves Solana out (`make up-topology CHAINS=evm`) they deposit
# this USDC through the Onboarder instead. anvil already gave them ETH.
for addr in 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; do
  cast send --rpc-url "$RPC" --private-key "$MINTER_KEY" "$USDC" 'mint(address,uint256)' "$addr" "$NODE_USDC" >/dev/null
  say "directory publisher $addr: minted 1000 USDC"
done

# The ANYONE nodes: ETH for their own transactions, and the dealer's float.
ANYONE=0xFeAc2Eae96899709a43E252B6B92971D32F9C0F9
DEALER_ANYONE=100000000000000000000 # 100 ANYONE at 18dp
for node in anytoon-connector dealer-connector; do
  addr="$(cast wallet address --private-key "0x$(cat "$KEYS/$node/settlement.key")")"
  cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" --value 100ether "$addr" >/dev/null
  say "$node: funded $addr with 100 ETH"
done
dealer="$(cast wallet address --private-key "0x$(cat "$KEYS/dealer-connector/settlement.key")")"
cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" "$ANYONE" 'transfer(address,uint256)' "$dealer" "$DEALER_ANYONE" >/dev/null \
  || die "could not send the dealer its ANYONE — seed-toon-evm-amm.sh must run first"
say "dealer-connector: sent $dealer 100 ANYONE"

# The kind:5098 relayer. The healthcheck already gates on the forwarder and
# probe DeploySandboxExtras placed; asserted again so a broken extras deploy
# fails HERE, by name, not downstream in the gas station.
for contract in 0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35 0xA15BB66138824a1c7167f5E85b957d04Dd34E468; do
  c="$(cast code "$contract" --rpc-url "$RPC")"
  [ -n "$c" ] && [ "$c" != 0x ] || die "no contract at $contract — DeploySandboxExtras.s.sol did not land"
done
relayer="$(cast wallet address --private-key "0x$(cat "$KEYS/gas-evm-relayer.key")")"
cast send --rpc-url "$RPC" --private-key "$FUNDER_KEY" --value 100ether "$relayer" >/dev/null
say "gas-evm-relayer: funded $relayer with 100 ETH (kind:5098 float)"
say "done."
