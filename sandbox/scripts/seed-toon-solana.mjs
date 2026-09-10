// Seeds the TOON payment layer's Solana side (runs as the `seed-toon-solana`
// one-shot compose service; also runnable from the host with RPC_URL/WS_URL
// pointed at localhost):
//   1. airdrop SOL to the mock-USDC mint authority (fees)
//   2. create the DETERMINISTIC mock USDC mint
//      H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H (6 decimals) from the
//      committed keypairs keys/toon/usdc-mint.json + usdc-authority.json —
//      the same keypairs the connector repo commits
//      (connector/infra/solana/*.json), so every [settlement.solana]
//      token_address in conf/connector-*.toml resolves
//   3. for each connector node: airdrop SOL to its settlement account, create
//      its USDC ATA and mint 1000 USDC into it (the connector's Solana
//      settlement backend submits a real ATA-create + simulated
//      InitializeChannel at startup — an unfunded key is a refuse-to-boot)
//   4. airdrop SOL to the gas station's fee payer (keys/toon/gas-fee-payer.json)
//
// This is the JS equivalent of the connector repo's host-side
// infra/solana/create-usdc-mint.sh + local/keys.sh funding loop, done with
// raw SPL instructions (same pattern as seed-solana.mjs) so no Solana CLI is
// needed in the container.
//
// IDEMPOTENT: exits 0 immediately if the mint exists AND the relay-connector
// ATA already holds USDC. The validator runs --reset, so a restart wipes the
// chain and `docker compose up -d` re-runs this.
import {
  createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes, airdropFactory, lamports, pipe,
  createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, sendAndConfirmTransactionFactory,
  getSignatureFromTransaction, getProgramDerivedAddress, getAddressEncoder,
  AccountRole, address,
} from '@solana/kit';
import { readFileSync } from 'node:fs';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8900';
const KEYS_DIR = process.env.KEYS_DIR ?? new URL('../keys/', import.meta.url).pathname;

const SYSTEM = address('11111111111111111111111111111111');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PAYMENT_CHANNEL_PROGRAM = address('HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR');
const NODES = ['relay-connector', 'store-connector', 'gas-connector', 'anytoon-connector'];
const NODE_USDC = 1_000_000_000n; // 1000 USDC at 6dp per connector node
const TREASURY_USDC = 100_000_000_000_000n; // 100M USDC to the authority

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const airdrop = airdropFactory({ rpc, rpcSubscriptions });
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const enc = getAddressEncoder();

const kp64 = async (file) =>
  createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`${KEYS_DIR}/toon/${file}`))));
const kpSeedHex = async (file) =>
  createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(Buffer.from(readFileSync(`${KEYS_DIR}/toon/${file}`, 'utf8').trim(), 'hex')));

const mintKp = await kp64('usdc-mint.json');
const authority = await kp64('usdc-authority.json');
const gasFeePayer = await kp64('gas-fee-payer.json');
const nodeSigners = Object.fromEntries(await Promise.all(
  NODES.map(async (n) => [n, await kpSeedHex(`${n}/settlement-solana.key`)]),
));

// The payment-channel program must be in genesis or nothing here matters.
{
  const info = await rpc.getAccountInfo(PAYMENT_CHANNEL_PROGRAM, { encoding: 'base64' }).send();
  if (info.value === null || !info.value.executable) {
    console.error(`[seed-toon-solana] FATAL: no executable program at ${PAYMENT_CHANNEL_PROGRAM}.`);
    console.error('The validator must load artifacts/payment_channel.so at genesis (docker-compose.yml).');
    process.exit(1);
  }
  console.log(`[seed-toon-solana] payment_channel program present at ${PAYMENT_CHANNEL_PROGRAM}`);
}

async function ata(owner) {
  const [addr] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [enc.encode(owner), enc.encode(TOKEN), enc.encode(mintKp.address)],
  });
  return addr;
}

// ── idempotency guard ─────────────────────────────────────────────────────
{
  const mintInfo = await rpc.getAccountInfo(mintKp.address, { encoding: 'base64' }).send();
  if (mintInfo.value !== null) {
    const relayAta = await ata(nodeSigners['relay-connector'].address);
    const bal = await rpc.getTokenAccountBalance(relayAta).send().catch(() => null);
    if (bal && BigInt(bal.value.amount) > 0n) {
      console.log('[seed-toon-solana] mint + funded connector ATAs already exist — nothing to do.');
      process.exit(0);
    }
  }
}

async function sendIxs(feePayer, ixs, label) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  await sendAndConfirm(tx, { commitment: 'confirmed' });
  console.log(`[tx] ${label}: ${getSignatureFromTransaction(tx)}`);
}

// ── 1. airdrops ───────────────────────────────────────────────────────────
const airdropTargets = [
  ['usdc-authority', authority.address],
  ['gas-fee-payer', gasFeePayer.address],
  ...NODES.map((n) => [n, nodeSigners[n].address]),
];
for (const [who, addr] of airdropTargets) {
  await airdrop({ commitment: 'confirmed', lamports: lamports(100_000_000_000n), recipientAddress: addr });
  console.log(`[airdrop] 100 SOL -> ${who} (${addr})`);
}

// ── 2. the deterministic mock USDC mint ───────────────────────────────────
{
  const mintInfo = await rpc.getAccountInfo(mintKp.address, { encoding: 'base64' }).send();
  if (mintInfo.value === null) {
    const mintRent = await rpc.getMinimumBalanceForRentExemption(82n).send();
    const createMintIx = {
      programAddress: SYSTEM,
      accounts: [
        { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
        { address: mintKp.address, role: AccountRole.WRITABLE_SIGNER, signer: mintKp },
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
      accounts: [{ address: mintKp.address, role: AccountRole.WRITABLE }],
      data: (() => {
        const b = Buffer.alloc(35);
        b[0] = 20; // InitializeMint2
        b[1] = 6; // decimals (mock USDC standard)
        Buffer.from(enc.encode(authority.address)).copy(b, 2); // mint authority
        b[34] = 0; // no freeze authority
        return new Uint8Array(b);
      })(),
    };
    await sendIxs(authority, [createMintIx, initMintIx], `create USDC mint ${mintKp.address}`);
  } else {
    console.log(`[mint] USDC mint ${mintKp.address} already exists`);
  }
}

function createAtaIx(ataAddr, owner) {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
      { address: ataAddr, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mintKp.address, role: AccountRole.READONLY },
      { address: SYSTEM, role: AccountRole.READONLY },
      { address: TOKEN, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]), // CreateIdempotent
  };
}
function mintToIx(ataAddr, amount) {
  return {
    programAddress: TOKEN,
    accounts: [
      { address: mintKp.address, role: AccountRole.WRITABLE },
      { address: ataAddr, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
    ],
    data: (() => {
      const b = Buffer.alloc(9);
      b[0] = 7; // MintTo
      b.writeBigUInt64LE(amount, 1);
      return new Uint8Array(b);
    })(),
  };
}

// ── 3. treasury + per-node USDC ───────────────────────────────────────────
const treasuryAta = await ata(authority.address);
await sendIxs(authority, [createAtaIx(treasuryAta, authority.address), mintToIx(treasuryAta, TREASURY_USDC)],
  'treasury ATA + 100M USDC');

for (const n of NODES) {
  const nodeAta = await ata(nodeSigners[n].address);
  await sendIxs(authority, [createAtaIx(nodeAta, nodeSigners[n].address), mintToIx(nodeAta, NODE_USDC)],
    `${n}: ATA + 1000 USDC (${nodeSigners[n].address})`);
}

console.log('\n[seed-toon-solana] done.');
process.exit(0);
