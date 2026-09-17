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
//   5. fund THE BUYER — the smoke test's own Solana identity — and THE
//      DIRECTORY PUBLISHER, the compute provider's payer for relay writes,
//      which needs the same SOL + ATA for the same reason. New with the
//      cross-asset flip: the client leg used to settle on anvil, where a payer
//      needs nothing seeded (mock USDC is mintable and anvil hands out ETH),
//      but a Solana channel needs its payer to already hold SOL *and* an ATA
//      of the right mint. @toon-protocol/client opens the channel and will not
//      create either: `assertOpenFunding` refuses below 4179040 lamports or
//      without an ATA holding the deposit, which would strand the smoke at
//      step 1 with a ChannelFundingError.
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
const NODES = ['relay-connector', 'store-connector', 'gas-connector', 'anytoon-connector',
  'provider-connector', 'provider2-connector',
  // The HIDDEN provider's connector (TOON_Network #43, the `hs` profile). It
  // is seeded on every profile, like every other node here: a chain is seeded
  // once and cold, and `make up-hs` must not need a re-seed to work.
  'provider-hs-connector'];
const NODE_USDC = 1_000_000_000n; // 1000 USDC at 6dp per connector node
const TREASURY_USDC = 100_000_000_000_000n; // 100M USDC to the authority
// THE BUYER. Deterministic: SLIP-0010 m/44'/501'/0'/0' of anvil's published
// test mnemonic ("test test ... junk"), which is what
// `ToonClient.create({ mnemonic, chain: 'solana' })` derives at index 0 —
// scripts/smoke-toon.mjs asserts the client agrees with this address before it
// opens anything, so a client-library change to the derivation path fails by
// name here rather than as an unfunded-wallet mystery.
const BUYER = address('oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96');
const BUYER_USDC = 1_000_000_000n; // 1000 USDC — the smoke deposits 10 of it
// THE DIRECTORY PUBLISHER — the compute provider's own payer for relay writes
// (the `directory-publisher` service; provider/tools/publisher). Account
// index 1 of the SAME phrase, so it is deterministic like the buyer but holds
// its OWN wallet and its OWN channel: two processes sharing one channel share
// one nonce watermark, and the loser of that race has every later claim
// refused. Derived by `deriveFullIdentity(mnemonic, { accountIndex: 1 })`.
const PUBLISHER = address('AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD');
const PUBLISHER_USDC = 1_000_000_000n; // 1000 USDC — it deposits 10 of it
// THE SECOND PROVIDER'S PUBLISHER (`directory-publisher2`, TOON_Network #34),
// on account index 2 of the same phrase. It is a second wallet for the same
// reason index 1 is a first one: one channel, one nonce watermark, one payer.
const PUBLISHER2 = address('CqMbRgMuEhQi9BUS8xP44Wk5nENm48FqJnfjEi4eNb1k');
// THE HIDDEN PROVIDER'S PUBLISHER (`directory-publisher-hs`, TOON_Network #43,
// the `hs` profile), on account index 3. A third wallet for the reason the
// second one exists: one channel, one nonce watermark, one payer.
const PUBLISHER3 = address('9Tj3srBSxH7RFRCm8uharreY7ZBS49XSfpwCeYa7Xaqp');

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
    // EVERY node's ATA is checked, and the BUYER's: a chain seeded by an
    // older revision of this script has the mint and the connectors it knew
    // about, but not a node added since (the provider-connector was) and not
    // necessarily the buyer — and a connector whose settlement key holds no
    // SOL refuses to boot, so skipping on the relay alone would leave a new
    // node unbootable on a stack that looks seeded.
    const funded = async (owner) => {
      const bal = await rpc.getTokenAccountBalance(await ata(owner)).send().catch(() => null);
      return bal !== null && BigInt(bal.value.amount) > 0n;
    };
    const allFunded = (await Promise.all(
      [...NODES.map((n) => nodeSigners[n].address), BUYER, PUBLISHER, PUBLISHER2, PUBLISHER3].map(funded),
    )).every(Boolean);
    if (allFunded) {
      console.log('[seed-toon-solana] mint + funded connector/buyer/publisher ATAs already exist — nothing to do.');
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
  ['buyer (the smoke test)', BUYER],
  ['directory-publisher (the provider’s relay-write payer)', PUBLISHER],
  ['directory-publisher2 (the second provider’s)', PUBLISHER2],
  ['directory-publisher-hs (the hidden provider’s)', PUBLISHER3],
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

// ── 4. the buyer's own ATA ────────────────────────────────────────────────
// The connectors' ATAs above are created by the connector itself at startup
// too; the buyer has no such startup. `@toon-protocol/client` reads this ATA
// to check it can cover the deposit and then spends out of it into the
// channel — it never creates it — so this is the difference between a smoke
// that opens a Solana channel and one that raises ChannelFundingError.
{
  const buyerAta = await ata(BUYER);
  await sendIxs(authority, [createAtaIx(buyerAta, BUYER), mintToIx(buyerAta, BUYER_USDC)],
    `buyer: ATA + 1000 USDC (${BUYER})`);
}

// ── 5. the directory publisher's own ATA ──────────────────────────────────
// Same story as the buyer, for a different wallet: the compute provider's
// relay writes are PAID packets (TOON_Network ADR 0007), and the process that
// pays them opens its own Solana channel against the hub at startup.
{
  const publisherAta = await ata(PUBLISHER);
  await sendIxs(authority, [createAtaIx(publisherAta, PUBLISHER), mintToIx(publisherAta, PUBLISHER_USDC)],
    `directory-publisher: ATA + 1000 USDC (${PUBLISHER})`);
}

// ── 6. the SECOND provider's publisher ────────────────────────────────────
// Its own wallet, its own ATA, its own channel: two publishers on one account
// would share one nonce watermark and the loser would have every later claim
// refused (see docker-compose.yml, `directory-publisher2`).
{
  const publisher2Ata = await ata(PUBLISHER2);
  await sendIxs(authority, [createAtaIx(publisher2Ata, PUBLISHER2), mintToIx(publisher2Ata, PUBLISHER_USDC)],
    `directory-publisher2: ATA + 1000 USDC (${PUBLISHER2})`);
}

// ── 7. the HIDDEN provider's publisher ────────────────────────────────────
// Its own wallet, its own ATA, its own channel — see section 6. Funded on
// every profile even though only `hs` runs it: re-seeding a live chain to add
// a wallet is the thing this avoids.
{
  const publisher3Ata = await ata(PUBLISHER3);
  await sendIxs(authority, [createAtaIx(publisher3Ata, PUBLISHER3), mintToIx(publisher3Ata, PUBLISHER_USDC)],
    `directory-publisher-hs: ATA + 1000 USDC (${PUBLISHER3})`);
}

console.log('\n[seed-toon-solana] done.');
process.exit(0);
