# EVM bytecode artifacts

Hex blobs the sandbox places on its own anvil. They are here for the same
reason the `.so` files next door are: so a fresh clone needs no network dumps.
`../../scripts/fetch-artifacts.sh` regenerates all of them. The first three are
the ANYONE asset layer, consumed by `../../scripts/seed-toon-evm-amm.sh`; the
rest are the x402 layer, consumed by `../../scripts/seed-x402.sh` (see
"The x402 layer" below).

Every one of them is **the real deployed contract**, not a reimplementation.
That is the whole point: the connector's TWAP rate source
(`crates/connector-rate-source-evm`) reads `observe()` off a Uniswap v3 core
pool, and a sandbox that read it off a mock would be rehearsing the mock.

| file | what it is | where it comes from |
|---|---|---|
| `AnyoneProtocolToken.runtime.hex` | RUNTIME bytecode of ANYONE, the Anyone Protocol ERC-20 | `eth_getCode` at `0xFeAc2Eae96899709a43E252B6B92971D32F9C0F9` on Ethereum mainnet |
| `WETH9.runtime.hex` | RUNTIME bytecode of WETH9 | `eth_getCode` at `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` on Ethereum mainnet |
| `UniswapV3Factory.creation.hex` | CREATION bytecode of `UniswapV3Factory` | the published `@uniswap/v3-core@1.0.1` npm package, `artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json` → `.bytecode` |

## Why two of them are runtime code and one is creation code

**Runtime** code can be dropped straight onto a chain with `anvil_setCode`,
which puts a contract at *its own mainnet address* — so this sandbox's ANYONE is
at `0xFeAc2Eae…` and its WETH at `0xC02aaA39…`, exactly where they are in
production. What `setCode` does **not** copy is storage, and a constructor is
the thing that writes it, so the seed script writes the constructor's words by
hand. For WETH9 that is three metadata words and nothing else (balances come
from `deposit()`, which is payable and mints against real anvil ETH). For
ANYONE it is four, and one of them is not obvious: the contract has a
`launched` flag packed into the same slot as `_owner`, and without it **every
`transfer` reverts `AnyoneProtocolToken: Not launched.`** The seed script sets
it and the layout is documented there.

**Creation** code has to be deployed normally, and the factory has to be,
because `createPool` depends on constructor state (the fee-tier table) — a
`setCode`d factory would refuse every pool. Deploying it also gets the pools
right for free: `UniswapV3Pool`'s creation code is embedded in the factory's own
runtime, so every pool the factory creates is genuine v3-core, at the CREATE2
address Uniswap's own `PoolAddress` library predicts.

## Provenance you can check

The npm factory artifact is byte-identical to mainnet's deployed factory apart
from one 20-byte immutable — `NoDelegateCall`'s `original`, which is the
factory's own address and therefore differs by construction on any chain:

```sh
diff <(cast code 0x1F98431c8aD98523631AE4a59f267346ea31F984 --rpc-url "$MAINNET_RPC") \
     <(node -p "require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json').deployedBytecode")
```

A stronger check, and the one the sandbox actually leans on: the pool
`initCodeHash` computed from that package is
`0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54`, the
canonical Uniswap v3 `POOL_INIT_CODE_HASH`. The committed pool addresses in
`../../conf/amm-topology.conf` are CREATE2 derivations from it, and
`seed-toon-evm-amm.sh` refuses to report success if the factory hands back a
different address — so a substituted factory fails the bring-up by name.

## Refreshing

```sh
../../scripts/fetch-artifacts.sh --force     # re-dumps these too
```

They should not need refreshing. Mainnet bytecode at a fixed address does not
change, and the Uniswap version is pinned. If you *do* refresh and an address in
`../../conf/amm-topology.conf` moves, the seed script will say so.

## The x402 layer (toon-protocol/infra#23)

Copied from **Base Sepolia**, because the published `@x402/evm` package
hardcodes the addresses x402 deploys its batch-settlement stack to, and a
stock facilitator only works where the contracts are exactly there. Every
runtime blob below is placed at its Base Sepolia address with `anvil_setCode`;
none needs storage, and `seed-x402.sh` says why for each.

| file | what it is | where it comes from |
|---|---|---|
| `x402BatchSettlement.runtime.hex` | RUNTIME bytecode of x402's channel contract | `eth_getCode` at `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` on Base Sepolia |
| `ERC3009DepositCollector.runtime.hex` | RUNTIME bytecode of the ERC-3009 deposit collector | `eth_getCode` at `0x4020806089470a89826cB9fB1f4059150b550004` on Base Sepolia |
| `Permit2DepositCollector.runtime.hex` | RUNTIME bytecode of the Permit2 deposit collector | `eth_getCode` at `0x4020425FAf3B746C082C2f942b4E5159887B0005` on Base Sepolia |
| `Permit2.runtime.hex` | RUNTIME bytecode of Uniswap's Permit2 | `eth_getCode` at `0x000000000022D473030F116dDEE9F6B43aC78BA3` on Base Sepolia |
| `Multicall3.runtime.hex` | RUNTIME bytecode of Multicall3 | `eth_getCode` at `0xcA11bde05977b3631167028862bE2a173976CA11` on Base Sepolia |
| `SignatureChecker.runtime.hex` | RUNTIME bytecode of Circle's `SignatureChecker` library, which FiatToken v2.2 links | `eth_getCode` at `0xbA3b60c21e28C41df4bABd90f228e1D368627DA6` on Base Sepolia |
| `FiatTokenV2_2.creation.hex` | CREATION bytecode of Circle's FiatToken v2.2 implementation | the input of Base Sepolia tx `0x6dbb9d75…52fe1`, which deployed the implementation behind Base Sepolia USDC |
| `FiatTokenProxy.creation.hex` | CREATION bytecode of Circle's `FiatTokenProxy`, with its one constructor argument stripped | the input of Base Sepolia tx `0xd835c0ab…9f3`, which deployed Base Sepolia USDC (`0x036CbD53…CF7e`) |

The FiatToken is creation code for the same reason the Uniswap factory is: its
initialisers write the state that makes it work, so it is deployed and
initialised rather than placed. The library it links is baked into its creation
code at `0xbA3b…7DA6`, which is why that one address has to match.

A provenance check you can run: `cast code <address> --rpc-url https://sepolia.base.org`
against any runtime file above is byte-identical, and `x402BatchSettlement`'s
`VOUCHER_TYPEHASH()` on the sandbox answers
`0x1e1bd6ff84c3e0d9029a292b212e039c0ca97ec497c55191a4a5874294609a69`, the
keccak of `Voucher(bytes32 channelId,uint128 maxClaimableAmount)` — `seed-x402.sh`
refuses to report success otherwise.
