// PROTOTYPE — throwaway. Seeds the localnet so an ArNS buy can work:
//   1. airdrop SOL to the admin (upgrade authority) + treasury owner
//   2. create a local "ARIO" SPL mint (6 decimals, mint authority = admin)
//   3. create the treasury ATA (owner: keys/treasury.json) + admin's buyer ATA
//   4. mint 10M ARIO to the admin's ATA (the buyer wallet)
//   5. ario_arns::initialize (config + demand factor) — signer MUST be the
//      program's upgrade authority (ProgramData gate), which is why the
//      compose file loads programs with --upgradeable-program <id> <so> <admin>
//   6. ario_core::initialize (ArioConfig) — not strictly needed for buyRecord,
//      done for completeness / SDK reads that touch core
// Prints full config + demand factor state at the end.
// The NameRegistry account is NOT created here — it is preloaded at genesis
// (see gen-genesis.mjs / docker-compose.yml --account).
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

const admin = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync('keys/admin.json'))));
const treasuryOwner = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync('keys/treasury.json'))));
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

// ── 5. ario_arns::initialize ────────────────────────────────────────────
const pda = async (programAddress, seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];
const arnsConfig = await pda(IDS.arns, ['arns_config']);
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
  periodZeroStartTimestamp: BigInt(Math.floor(Date.now() / 1000) - 3600),
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
  console.warn('[warn] ario_core::initialize failed (continuing — buyRecord may not need it):', err.message ?? err);
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
console.log('\nSeed complete. Now: node buy-name.mjs');
