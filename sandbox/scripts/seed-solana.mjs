// Seeds the local validator so an ArNS buy can work (runs as the
// `seed-solana` one-shot compose service; also runnable from the host with
// RPC_URL/WS_URL pointed at localhost):
//   1. airdrop SOL to the admin (upgrade authority) + treasury owner
//   2. create a local "ARIO" SPL mint (6 decimals, mint authority = admin)
//   3. create the treasury ATA (owner: keys/treasury.json) + admin's buyer ATA
//   4. mint 10M ARIO to the admin's ATA (the buyer wallet), and fund the
//      store's kind:5095 ArNS DVM payer (keys/toon/arns-dvm.json) with SOL +
//      10,000 ARIO so brokered `op=buy` jobs can spend
//   5. ario_arns::initialize (config + demand factor) — signer MUST be the
//      programs' upgrade authority (ProgramData gate), which is why the
//      compose file loads programs with --upgradeable-program <id> <so> <admin>
//   6. ario_core::initialize (ArioConfig) — not strictly needed for buyRecord,
//      done for completeness / SDK reads that touch core
//
// IDEMPOTENT: exits 0 immediately if the ArnsConfig PDA already exists (the
// validator keeps state until its container restarts; it runs --reset, so a
// restart wipes the chain and this seeder must run again — `docker compose
// up -d` does that automatically).
//
// The NameRegistry account is NOT created here — it is preloaded at genesis
// (see gen-genesis.mjs / docker-compose.yml --account).
//
// The ARIO mint is generated fresh each seeding: buyRecord reads
// ArnsConfig.mint/treasury from chain, so nothing needs the mint pinned.
import {
  createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
  generateKeyPairSigner, airdropFactory, lamports, pipe,
  createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, sendAndConfirmTransactionFactory,
  getSignatureFromTransaction, getProgramDerivedAddress, getAddressEncoder,
  AccountRole, address,
} from '@solana/kit';
import { getInitializeInstruction as getArnsInitialize, fetchArnsConfig, fetchDemandFactor } from '@ar.io/solana-contracts/arns';
import { getInitializeInstruction as getCoreInitialize } from '@ar.io/solana-contracts/core';
import { readFileSync } from 'node:fs';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8900';
const KEYS_DIR = process.env.KEYS_DIR ?? new URL('../keys/', import.meta.url).pathname;

// Staging (devnet) ids, reused as the local genesis ids (= SDK DEVNET_PROGRAM_IDS).
const IDS = {
  core: address('8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1'),
  gar: address('7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz'),
  arns: address('6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp'),
  ant: address('DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX'),
};
const SYSTEM = address('11111111111111111111111111111111');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const airdrop = airdropFactory({ rpc, rpcSubscriptions });
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const enc = getAddressEncoder();

const pda = async (programAddress, seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];

// ── idempotency guard: already seeded? ──────────────────────────────────
const arnsConfig = await pda(IDS.arns, ['arns_config']);
{
  const existing = await rpc.getAccountInfo(arnsConfig, { encoding: 'base64' }).send();
  if (existing.value !== null) {
    console.log(`[seed-solana] ArnsConfig ${arnsConfig} already exists — validator is seeded, nothing to do.`);
    process.exit(0);
  }
}

const admin = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`${KEYS_DIR}/admin.json`))));
const treasuryOwner = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`${KEYS_DIR}/treasury.json`))));
console.log('admin (upgrade authority / buyer):', admin.address);
console.log('treasury owner:', treasuryOwner.address);

async function sendIxs(ixs, label) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(admin, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  await sendAndConfirm(tx, { commitment: 'confirmed' });
  const sig = getSignatureFromTransaction(tx);
  console.log(`[tx] ${label}: ${sig}`);
  return sig;
}

// ── 1. airdrop ──────────────────────────────────────────────────────────
for (const [who, kp] of [['admin', admin], ['treasuryOwner', treasuryOwner]]) {
  await airdrop({ commitment: 'confirmed', lamports: lamports(100_000_000_000n), recipientAddress: kp.address });
  const bal = await rpc.getBalance(kp.address).send();
  console.log(`[airdrop] ${who} balance: ${Number(bal.value) / 1e9} SOL`);
}

// ── 2. ARIO mint ────────────────────────────────────────────────────────
const mint = await generateKeyPairSigner();
const mintRent = await rpc.getMinimumBalanceForRentExemption(82n).send();
const createMintIx = {
  programAddress: SYSTEM,
  accounts: [
    { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin },
    { address: mint.address, role: AccountRole.WRITABLE_SIGNER, signer: mint },
  ],
  data: (() => {
    const b = Buffer.alloc(52);
    b.writeUInt32LE(0, 0); // CreateAccount
    b.writeBigUInt64LE(BigInt(mintRent), 4);
    b.writeBigUInt64LE(82n, 12);
    Buffer.from(enc.encode(TOKEN)).copy(b, 20);
    return new Uint8Array(b);
  })(),
};
const initMintIx = {
  programAddress: TOKEN,
  accounts: [{ address: mint.address, role: AccountRole.WRITABLE }],
  data: (() => {
    const b = Buffer.alloc(35);
    b[0] = 20; // InitializeMint2
    b[1] = 6; // decimals (mARIO)
    Buffer.from(enc.encode(admin.address)).copy(b, 2); // mint authority
    b[34] = 0; // no freeze authority
    return new Uint8Array(b);
  })(),
};
await sendIxs([createMintIx, initMintIx], 'create ARIO mint');
console.log('[mint] local ARIO mint:', mint.address);

// ── 3. ATAs ─────────────────────────────────────────────────────────────
async function ata(owner) {
  const [addr] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [enc.encode(owner), enc.encode(TOKEN), enc.encode(mint.address)],
  });
  return addr;
}
function createAtaIx(ataAddr, owner) {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin },
      { address: ataAddr, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint.address, role: AccountRole.READONLY },
      { address: SYSTEM, role: AccountRole.READONLY },
      { address: TOKEN, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]), // CreateIdempotent
  };
}
const treasuryAta = await ata(treasuryOwner.address);
const buyerAta = await ata(admin.address);
await sendIxs([createAtaIx(treasuryAta, treasuryOwner.address), createAtaIx(buyerAta, admin.address)], 'create treasury + buyer ATAs');
console.log('[ata] treasury ATA:', treasuryAta);
console.log('[ata] buyer   ATA:', buyerAta);

// ── 4. mint ARIO to buyer ───────────────────────────────────────────────
const AMOUNT = 10_000_000_000_000n; // 10M ARIO in mARIO
const mintToIx = {
  programAddress: TOKEN,
  accounts: [
    { address: mint.address, role: AccountRole.WRITABLE },
    { address: buyerAta, role: AccountRole.WRITABLE },
    { address: admin.address, role: AccountRole.READONLY_SIGNER, signer: admin },
  ],
  data: (() => {
    const b = Buffer.alloc(9);
    b[0] = 7; // MintTo
    b.writeBigUInt64LE(AMOUNT, 1);
    return new Uint8Array(b);
  })(),
};
await sendIxs([mintToIx], `mint ${AMOUNT} mARIO to buyer ATA`);

// ── 4b. fund the store's kind:5095 ArNS DVM payer ───────────────────────
// The store's brokered-buy wallet (conf/store.conf ARNS_DVM_SOLANA_SECRET_KEY
// = keys/toon/arns-dvm.json): SOL for fees and ample ARIO to buy names on
// clients' behalf (~240 ARIO for an 11-char 1y lease; 10,000 gives headroom).
// Same idempotency story as the rest of this script: the ArnsConfig guard at
// the top means this only runs on a freshly wiped chain, where the mint and
// every balance are re-created together.
const DVM_ARIO = 10_000_000_000n; // 10,000 ARIO in mARIO (6dp)
const dvm = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`${KEYS_DIR}/toon/arns-dvm.json`))));
await airdrop({ commitment: 'confirmed', lamports: lamports(100_000_000_000n), recipientAddress: dvm.address });
console.log(`[airdrop] arns-dvm (store kind:5095 payer): 100 SOL -> ${dvm.address}`);
const dvmAta = await ata(dvm.address);
const dvmMintToIx = {
  programAddress: TOKEN,
  accounts: [
    { address: mint.address, role: AccountRole.WRITABLE },
    { address: dvmAta, role: AccountRole.WRITABLE },
    { address: admin.address, role: AccountRole.READONLY_SIGNER, signer: admin },
  ],
  data: (() => {
    const b = Buffer.alloc(9);
    b[0] = 7; // MintTo
    b.writeBigUInt64LE(DVM_ARIO, 1);
    return new Uint8Array(b);
  })(),
};
await sendIxs([createAtaIx(dvmAta, dvm.address), dvmMintToIx], `arns-dvm: ATA + ${DVM_ARIO} mARIO (${dvm.address})`);

// ── 5. ario_arns::initialize ────────────────────────────────────────────
// NOTE: @ar.io/solana-contracts' codama builders default to the MAINNET
// program ids/PDAs baked into the package, so every call passes explicit
// programAddress + pre-derived accounts for the staging ids.
const demandFactor = await pda(IDS.arns, ['demand_factor']);
const arnsProgramData = await pda(UPGRADEABLE_LOADER, [enc.encode(IDS.arns)]);
const arnsInitIx = getArnsInitialize({
  config: arnsConfig,
  demandFactor,
  authority: admin, // must be the program's upgrade authority
  programData: arnsProgramData,
  authorityArg: admin.address, // protocol authority
  mint: mint.address,
  treasury: treasuryAta,
  periodZeroStartTimestamp: BigInt(Math.floor(Date.now() / 1000) - 3600), // must be >= 2020-01-01 and <= chain time
  migrationAuthority: admin.address,
  initialDemandFactor: 1_000_000n, // DEMAND_FACTOR_SCALE = 1.0
}, { programAddress: IDS.arns });
await sendIxs([arnsInitIx], 'ario_arns::initialize');

// ── 6. ario_core::initialize ────────────────────────────────────────────
const coreConfig = await pda(IDS.core, ['ario_config']);
const coreProgramData = await pda(UPGRADEABLE_LOADER, [enc.encode(IDS.core)]);
try {
  const coreInitIx = getCoreInitialize({
    config: coreConfig,
    mint: mint.address,
    payer: admin,
    programData: coreProgramData,
    authority: admin.address,
    totalSupply: 1_000_000_000_000_000n, // 1B ARIO in mARIO
    arnsProgram: IDS.arns,
    treasury: treasuryAta,
    migrationAuthority: admin.address,
    garProgram: IDS.gar,
  }, { programAddress: IDS.core });
  await sendIxs([coreInitIx], 'ario_core::initialize');
} catch (err) {
  console.warn('[warn] ario_core::initialize failed (continuing — buyRecord does not need it):', err.message ?? err);
}

// ── state dump ──────────────────────────────────────────────────────────
const cfg = await fetchArnsConfig(rpc, arnsConfig);
console.log('\n[state] ArnsConfig @', arnsConfig);
console.dir(cfg.data, { depth: 3 });
const df = await fetchDemandFactor(rpc, demandFactor);
console.log('\n[state] DemandFactor @', demandFactor);
const { fees, trailingPeriodPurchases, trailingPeriodRevenues, ...rest } = df.data;
console.dir({ ...rest, fees: `${fees.length} entries, fees[1..5]=${fees.slice(1, 6)}` }, { depth: 2 });
const bal = await rpc.getTokenAccountBalance(buyerAta).send();
console.log('\n[state] buyer ARIO balance:', bal.value.uiAmountString, 'ARIO');
console.log('\n[seed-solana] done.');
process.exit(0);
