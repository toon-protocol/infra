# VERDICT — local ArNS buy / ANT spawn in Docker

PROTOTYPE — throwaway. Question: *Can we, fully locally in Docker, run a Solana
validator with AR.IO's five Anchor programs + Metaplex Core preloaded, and then
buy an ArNS name and register/spawn an ANT against it using `@ar.io/sdk` v4?*

**YES — proven end-to-end on 2026-09-09, with zero SDK patches and zero program
builds.** Everything below was observed working, not inferred.

## What worked (the whole flow)

Against `ghcr.io/beeman/solana-test-validator` (agave **4.1.1** at the pinned
digest — not the 4.0.3 the research doc recorded), seccomp=unconfined,
ports 8899/8900:

1. `ario.getTokenCost({intent:'Buy-Name', name, type:'lease', years:1})` →
   **240_000_000 mARIO (240 ARIO)** for an 11-char name at demand factor 1.0
   (genesis fee table came out of `ario_arns::initialize` correctly:
   fees[1..5] = 100000/10000/5000/2500/1500 ARIO).
2. `spawnSolanaANT(...)` → mints the MPL Core asset + `ario-ant` PDAs in one tx
   (e.g. processId `8bT4QVCJtJvPPJibCF1AiSeA97xV6NUxFo11ejMPRByW`).
3. `ario.buyRecord({name, type:'lease', years:1, processId})` → confirmed; buyer
   ARIO balance dropped exactly 240 ARIO; `getArNSRecord` returns the record
   (processId, purchasePrice 240000000, lease, endTimestamp +1y).
4. `ario.syncAttributes({name})` → **succeeded** (we are the NFT holder; the
   devnet NotNftHolder failure the store saw was the non-holder case).
5. `ANT.init(...)` reads (`getInfo`, `getRecords`) and a write
   (`setRecord({undername:'@', transactionId, ttlSeconds:900})`) all worked.

The SDK wiring is byte-for-byte the store's proven devnet shape
(`store/src/arns-buy-handler.ts`): `ARIO.init({rpc, rpcSubscriptions, signer,
coreProgramId, garProgramId, arnsProgramId, antProgramId})` — pointed at
`http://127.0.0.1:8899` / `ws://127.0.0.1:8900`.

## Exact program ids (local = staging/devnet ids, on purpose)

The `.so` files were **dumped from devnet** (`solana program dump <id> --url
devnet`, run inside the validator image — no Anchor toolchain needed) and loaded
at genesis under the same ids. These equal `@ar.io/sdk`'s `DEVNET_PROGRAM_IDS`
export exactly, so SDK overrides are just `DEVNET_PROGRAM_IDS`:

| program | id (staging.json = DEVNET_PROGRAM_IDS = local genesis id) |
|---|---|
| ario_core | `8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1` |
| ario_gar | `7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz` |
| ario_arns | `6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp` |
| ario_ant | `DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX` |
| ario_ant_escrow | `bttco5oAnBwCucG63iKokBJCZmNr493f3Ewe9LM3oTx` |
| mpl_core (fixture committed upstream) | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |

The ids MUST be these: the dumped binaries carry `declare_id!` = staging ids
(Anchor verifies it), and reusing them means the gateway's `ARIO_*_PROGRAM_ID`
env and the store's SDK overrides use the same committed values for devnet and
localnet. Dumps must be refreshed when AR.IO redeploys staging (CI redeploys on
merges to `develop`) *if* you also upgrade `@ar.io/sdk`/`@ar.io/solana-contracts`
— the client and program versions must roughly match.

Other fixed local addresses (functions of the committed throwaway keys):

- admin / upgrade authority / buyer: `5ncaUQEykDpzYaWHAxQ16M3Kq49hxzo6xXUWkVXC3TXX` (`keys/admin.json`)
- treasury owner: `DBfssjYmYGbLAexhdrq1sZYFMxVWMnHw7etMBkbFu67b`; treasury ATA `3tNm9FCr5C2jKAJhgHetFHku6m3Xb8w8Cce6xWvArkdt`
- NameRegistry PDA (seed `"name_registry"` under ario_arns): `FPotW9q4i2pRsyADBwzWyiQremEanAGtnrKVbr4Kxn35`
- ArnsConfig PDA (`"arns_config"`): `ARJeiLD3ZaBcn8dx6CU7AuSh1Mun6xNFRtNyJnyL5pAc`; DemandFactor PDA (`"demand_factor"`): `AaAofqJn78WH4YfPS2DxXySfygdJusXvvX7QYFHEokd3`; ArioConfig PDA (core, `"ario_config"`): `3k6MvYGvDwpq3knV7sd1rMZqhLh9i255RBmznG52YEgw`
- local ARIO mint: generated fresh each `seed.mjs` run (printed; the SDK reads it from ArnsConfig on-chain, nothing needs it pinned)

## The three non-obvious seeding requirements (the real findings)

1. **`--upgradeable-program`, not `--bpf-program`.** Every AR.IO `initialize`
   is gated to the **program's upgrade authority** via the BPF
   upgradeable-loader ProgramData PDA (audit H1: `program_data.
   upgrade_authority_address == Some(payer.key())`). Plain `--bpf-program`
   would leave no satisfiable ProgramData, bricking initialization forever.
   `--upgradeable-program <id> <so> <admin-pubkey>` (supported by agave's
   test validator) makes the committed `keys/admin.json` the upgrade
   authority, so it can run `initialize`. This is why AR.IO's own localnet
   needed no equivalent trick under Surfpool tests — their program-test
   harness fakes the ProgramData account; on a real validator this flag is
   the fix.

2. **The NameRegistry account must pre-exist and is 2,000,048 bytes.** It is a
   zero-copy PDA (seed `"name_registry"`, 48-byte header + 50,000 × 40-byte
   slots). On-chain creation (`create_name_registry`) grows it ≤10KB per tx →
   ~200 transactions. Instead we replicate the upstream test harness's
   `add_account` trick at genesis: `--account <pda> genesis/name-registry.json`
   with data = 8-byte Anchor discriminator (`sha256("account:NameRegistry")[..8]`)
   + zeros, owner = ario_arns, 15 SOL (rent-exempt min ≈ 13.93 SOL). Verified:
   `buy_name` appends to it happily with a zeroed authority header.

3. **The ARIO mint is NOT hardcoded anywhere that matters.** `buyRecord` reads
   `ArnsConfig.mint`/`ArnsConfig.treasury` from chain and derives the buyer's
   ATA from that mint — so a locally created SPL mint (6 decimals, any
   authority) works, and "funding the buyer with ARIO" is a plain `mint_to`
   into the buyer's ATA. No migration tooling needed. (The SDK's
   `ARIO_TOKEN_MINT_ADDRESS`/`DEVNET_ARIO_MINT` constants never came into play
   for this flow.)

Full seeding order (all in `seed.mjs`, one run, ~10s):
airdrop SOL → create mint (6 dp) → create treasury + buyer ATAs → `mint_to`
buyer → `ario_arns::initialize` (signer = upgrade authority; params: authority,
mint, treasury ATA, `period_zero_start_timestamp` = now−1h — must be ≥
2020-01-01 and ≤ chain time — migration authority, `initial_demand_factor` =
1_000_000 = 1.0) → `ario_core::initialize` (optional for the buy path, done for
completeness; ArioConfig PDA verified created). `ario_gar` was **not**
initialized and nothing in the buy/spawn flow needed it.

The instruction builders came from npm `@ar.io/solana-contracts@1.2.0`
(codama-generated). Gotcha: its default PDAs/program ids are the **mainnet**
ids baked into the package, so every call must pass explicit `programAddress`
+ pre-derived `config`/`demandFactor`/`programData` accounts for the staging
ids (`getInitializeInstruction(input, { programAddress })`).

## Failure signatures hit (and fixes)

- `--bind-address 0.0.0.0` → agave 4.1.1 panics at
  `gossip/src/node.rs:359` `UnspecifiedIpAddr(0.0.0.0)` during init (container
  exits 1 with only "Initializing..." on stdout; real error in
  `test-ledger/validator.log`). Fix: drop the flag — RPC listens on all
  interfaces anyway.
- Mounting `./genesis` *inside* a read-only mount (`/data/genesis` under
  `/data:ro`) → runc `mkdirat ... read-only file system`. Fix: sibling mount
  point `/genesis`.
- npm: `@ar.io/sdk@4.3.0` pins `@solana/kit@^6` while current
  `@solana-program/*` helpers want kit ^8 → ERESOLVE. Fix: skip the helper
  packages; hand-roll the four SPL-token/ATA instructions (~40 lines).
- No feature-gate problems materialized: mainnet-dumped `mpl_core.so` and the
  devnet-dumped AR.IO programs all executed fine on plain
  `solana-test-validator` (feature-set 3345198602). **Surfpool was never
  needed** — risk 1's spike question is answered for this flow.

## Implications for the real infra compose

- One validator service can carry TOON's `payment_channel.so` (`--bpf-program`,
  as connector does) **plus** the five AR.IO programs (`--upgradeable-program`
  with a committed local admin key) + `mpl_core.so` + the NameRegistry
  `--account` preload. Clean-run boot to RPC-up measured at ~6-10s even with
  the 2MB account preload; keep healthcheck `start_period` around 30s.
- A one-shot "seeder" container (node:alpine + this repo's seed script) must
  run after the validator is healthy; "healthy" for downstream consumers should
  mean *ArnsConfig exists*, mirroring the connector's "deployed, not just
  RPC-up" healthcheck philosophy.
- The gateway's env would be: `SOLANA_RPC_URL=http://solana-validator:8899`,
  `ARIO_*_PROGRAM_ID` = the staging ids above.
- The store needs only its existing devnet override path pointed at the local
  RPC; the ANT-holder `syncAttributes` restriction disappears locally when the
  buyer is the holder.
- Keep an eye on the frozen beeman image (agave 4.1.1, nightly builds stopped
  2026-07-06); fallback remains a tiny Dockerfile over Anza release binaries.

## Not covered (out of scope, unknowns)

- `ario_gar` (gateway registry/epochs) seeding — untested; a local AR.IO
  gateway's observer/epoch features may want it initialized.
- Buys funded from stakes/withdrawals (`fundFrom` variants), returned-name
  auctions, primary names — untested.
- Long-run validator stability with the 2MB account and ledger growth —
  untested beyond ~15 minutes.
