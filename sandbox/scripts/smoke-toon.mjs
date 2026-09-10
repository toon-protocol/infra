// TOON-layer smoke test: proves the payment layer + the three TOON apps in
// one run (run from sandbox/ on the host after `make up`; second half of
// `make smoke`).
//
//   0. payment infrastructure is live:
//        - TokenNetworkRegistry has code on anvil (the forge deploy landed)
//        - payment_channel is an EXECUTABLE account on the validator
//        - all three connector edges answer GET /ilp
//   1. a real client (@toon-protocol/client — the proven payer from the
//      connector repo's local/anyone and the pokerogue devnet) opens a
//      payment channel on anvil against the relay-connector hub
//   2. a PAID Nostr write to g.toon.relay reaches the relay through the hub,
//      and a FREE NIP-01 read at :7100 returns the byte-identical event
//   3. a PAID kind:5094 blob-store job addressed to g.toon.store, handed to
//      the HUB's edge, routes over the relay-store peering to the store,
//      which uploads via the LOCAL Turbo path and answers a real tx id —
//      then the local AR.IO gateway serves the blob at /raw/<txId>
//   3b. the BROKERED ArNS buy (kind:5095), the three-party flagship: an
//      owner keypair that never holds SOL spawns an ANT (store composes the
//      transaction via PAID op=prepare, the client signs it, the gas station
//      pays rent + fees and broadcasts it via PAID kind:5096 quote/execute),
//      then a PAID op=buy makes the store's DVM wallet purchase a fresh ArNS
//      name on the LOCAL validator, associated with that client-owned ANT —
//      and the LOCAL gateway resolves the name afterwards
//   4. a PAID kind:5096 gas job (quote phase) addressed to g.toon.gastation
//      routes over the relay-gas peering to the gas station, which answers
//      its Solana fee payer
//   4b. the EVM leg of the gas station (kind:5098): /describe advertises the
//      kind with chains ["evm:31337"]; a PAID quote returns the forwarder +
//      target + nonce; an UNFUNDED throwaway wallet EIP-712-signs an
//      ERC-2771 ForwardRequest, a PAID execute relays it, the relayer pays
//      the gas, and the probe target's recorded _msgSender() on anvil is the
//      CLIENT's address (the ERC-2771 property, read back on-chain)
//   5. the money is asserted from the connectors' own books, because a
//      packet's answer cannot tell you it was paid for — and PER SETTLEMENT
//      LEG, because this sandbox's topology is cross-chain same-asset:
//        - the client leg settles on an EVM channel on anvil (the hub's
//          client-book claims ride the 0x… channel opened in step 1)
//        - both peer legs settle on SOLANA payment_channel accounts
//          (asserted live on the validator first — owner, participants,
//          mint, Opened, the hub's collateral — then the payees' watermarks
//          on exactly those channel accounts)
//      Amounts are the same 6-decimal mock-USDC unit end to end; there is
//      no conversion anywhere (FX is explicitly unsupported).
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ToonClient, sendJob, buildJobEvent,
  buyArnsNameWithNewAnt, generateSolanaKeypair,
} from '@toon-protocol/client';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  Contract as EthersContract,
  Interface as EthersInterface,
  JsonRpcProvider,
  Wallet as EthersWallet,
  hexlify,
  randomBytes,
} from 'ethers';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
const STORE_EDGE = process.env.STORE_EDGE_URL ?? 'http://localhost:3210';
const GAS_EDGE = process.env.GAS_EDGE_URL ?? 'http://localhost:3220';
const RELAY_WS = process.env.RELAY_WS ?? 'ws://localhost:7100';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const ANVIL_URL = process.env.ANVIL_URL ?? 'http://localhost:8545';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
// anvil's own published test mnemonic; account 0 = the deployer, holding ETH
// and mintable mock USDC. Public knowledge, local chain only.
const MNEMONIC = 'test test test test test test test test test test test junk';
const GAS_BLS = process.env.GAS_BLS_URL ?? 'http://localhost:3400'; // gas station's free /describe surface
const PAYMENT_CHANNEL_PROGRAM = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const REGISTRY = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
// kind:5098 contracts (deterministic outputs of contracts/DeploySandboxExtras.s.sol:
// OZ v5.5.0 ERC2771Forwarder + the ERC-2771 probe target, anvil acct 9 nonces 0/1).
const FORWARDER = '0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35';
const PROBE = '0xA15BB66138824a1c7167f5E85b957d04Dd34E468';
const USDC_MINT = 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H';
const HUB_SOL = '9gXKH3AtUErhsAVaLmBkiJxdtUmUE29MjaRLFKxCqfAx';
// The two SOLANA peering channels (PDAs the committed connector tomls name;
// opened post-boot by the open-toon-solana-channels init job).
const SOLANA_CHANNELS = {
  'relay-store': { account: '4yUyXpi3c23g1sxGWWUpANVoGKzt8i4iMc2xjdC3njR7', peer: '8VQznfuCBp9aDTwdHaXYneqgfckmVezE1MXrNW8hhUMe' },
  'relay-gas': { account: '4oUEsaokTBie41Xtb7PDkeMK8vDoqvzeWecwk98Abc3T', peer: '5tci9czy3L2StZ6cNu3f85HcnnJqmHPYt8YSbGMWUE9q' },
};
const HUB_CHANNEL_DEPOSIT = 100_000_000n; // what the open job puts behind each peering

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
let failures = 0;
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const fatal = (msg) => { console.error(`\nTOON SMOKE FAILED: ${msg}`); process.exit(1); };

const bearer = (node) => readFileSync(join(ROOT, 'keys', 'toon', node, 'operator-bearer.token'), 'utf8').trim();
const edgeOf = { 'relay-connector': HUB, 'store-connector': STORE_EDGE, 'gas-connector': GAS_EDGE };
async function claims(node) {
  const res = await fetch(`${edgeOf[node]}/claims`, { headers: { authorization: `Bearer ${bearer(node)}` } });
  if (!res.ok) throw new Error(`${node} GET /claims -> ${res.status}`);
  return res.json();
}
// Client-book takings on the hub: max cumulative per channel, summed.
function clientBookTotal(rows) {
  const per = new Map();
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > (per.get(r.channel_id) ?? 0n)) per.set(r.channel_id, a);
  }
  return [...per.values()].reduce((s, a) => s + a, 0n);
}
// Peer-book watermark on a payee: what the peering has actually PAID it.
// `onChannel` restricts to one channel id, which is how the per-leg
// settlement assertion is made — a Solana-settled leg's claims are keyed by
// the base58 channel ACCOUNT, an EVM leg's by the 0x…64-hex channel id.
function peerBookTotal(rows, onChannel) {
  const per = new Map();
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book === 'client') continue;
    if (onChannel !== undefined && r.channel_id !== onChannel) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > (per.get(r.channel_id) ?? 0n)) per.set(r.channel_id, a);
  }
  return [...per.values()].reduce((s, a) => s + a, 0n);
}

// ── Solana payment-channel account layout ─────────────────────────────────
// Offsets from the connector's packages/solana-program/src/state.rs (see the
// vendored scripts/open-solana-channel.py, which names the source of each).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(buf) {
  let v = 0n;
  for (const b of buf) v = v * 256n + BigInt(b);
  let out = '';
  while (v > 0n) { out = B58[Number(v % 58n)] + out; v /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
async function readSolanaChannel(account) {
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [account, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  const { result } = await res.json();
  if (!result?.value) return null;
  const data = Buffer.from(result.value.data[0], 'base64');
  return {
    owner: result.value.owner,
    discriminator: data.subarray(0, 8).toString('latin1'),
    participantA: b58enc(data.subarray(8, 40)),
    participantB: b58enc(data.subarray(40, 72)),
    mint: b58enc(data.subarray(72, 104)),
    depositA: data.readBigUInt64LE(104),
    depositB: data.readBigUInt64LE(112),
    status: data[160], // 0 = Opened
  };
}

// ── 0. payment infrastructure ────────────────────────────────────────────
step('0. payment infrastructure is live');
{
  const res = await fetch(ANVIL_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [REGISTRY, 'latest'] }),
  }).catch((e) => fatal(`anvil unreachable: ${e.message}`));
  const { result } = await res.json();
  if (!result || result === '0x') fatal(`no code at TokenNetworkRegistry ${REGISTRY} — the forge deploy did not land`);
  ok(`TokenNetworkRegistry has code on anvil (${(result.length - 2) / 2} bytes)`);
}
{
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [PAYMENT_CHANNEL_PROGRAM, { encoding: 'base64' }] }),
  }).catch((e) => fatal(`validator unreachable: ${e.message}`));
  const { result } = await res.json();
  if (!result?.value?.executable) fatal(`payment_channel ${PAYMENT_CHANNEL_PROGRAM} is not an executable account on the validator`);
  ok(`payment_channel is loaded and executable on the validator (owner ${result.value.owner})`);
}
for (const [name, url] of [['relay-connector (hub)', HUB], ['store-connector', STORE_EDGE], ['gas-connector', GAS_EDGE]]) {
  const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
  if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  const routes = (desc.routes ?? []).map((r) => `${r.prefix}@${JSON.stringify(r.price)}`).join(', ');
  ok(`${name}: ${desc.ilpAddresses?.join(',') ?? '(no addresses)'} — routes: ${routes}`);
}

// ── 0b. the SOLANA peering channels are live on chain ────────────────────
// Opened post-boot by the open-toon-solana-channels init job (through the
// hub's operator surface — the only possible InitializeChannel submitter),
// so poll briefly: `make up` returns before the job finishes. Then assert
// the program's own account layout: participants, mint, Opened, and the
// hub's collateral behind its claims. This is the on-chain half of the
// "peer legs settle on Solana" proof; the claim books below are the other.
step('0b. the two SOLANA peering channels are open and collateralised on the validator');
for (const [label, { account, peer }] of Object.entries(SOLANA_CHANNELS)) {
  let ch = null;
  for (let i = 0; i < 45 && !ch; i++) {
    ch = await readSolanaChannel(account);
    if (!ch) await sleep(2000);
  }
  if (!ch) { bad(`${label}: channel account ${account} never appeared on the validator (open-toon-solana-channels job — docker compose logs open-toon-solana-channels)`); continue; }
  assert(ch.owner === PAYMENT_CHANNEL_PROGRAM && ch.discriminator === 'pchannel',
    `${label}: ${account} is a payment_channel program account`);
  const participants = [ch.participantA, ch.participantB].sort();
  assert(participants.join() === [HUB_SOL, peer].sort().join(),
    `${label}: participants are the hub and the peer (${participants.join(', ')})`);
  assert(ch.mint === USDC_MINT, `${label}: settles in the Solana mock USDC mint`);
  assert(ch.status === 0, `${label}: status Opened`);
  const hubDeposit = ch.participantA === HUB_SOL ? ch.depositA : ch.depositB;
  assert(hubDeposit >= HUB_CHANNEL_DEPOSIT,
    `${label}: the hub's own side holds ${hubDeposit} base units of collateral (>= ${HUB_CHANNEL_DEPOSIT})`);
}

// ── 1. a channel against the hub ─────────────────────────────────────────
step('1. a payment channel on anvil against the hub');
// NOT under data/ — that tree is created root-owned by docker bind mounts.
// .toon-client/ is host-owned, gitignored, wiped by `make clean` (its channel
// watermark MUST die with the chain: a stale one refuses every later claim).
mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
const client = await ToonClient.create({
  connector: HUB,
  mnemonic: MNEMONIC,
  chain: 'evm',
  rpcUrl: ANVIL_URL,
  channelStore: join(ROOT, '.toon-client', 'channels.json'),
  deposit: 10_000_000n, // 10 USDC — plenty against ~1100/packet prices
  timeoutMs: 60_000,
});
const opened = await client.channel.open({ deposit: 10_000_000n });
ok(`channel ${opened.channelId ?? '(id unreported)'} status=${opened.status ?? 'open'}`);

const hubBefore = clientBookTotal(await claims('relay-connector'));
const storeBefore = peerBookTotal(await claims('store-connector'), SOLANA_CHANNELS['relay-store'].account);
const gasBefore = peerBookTotal(await claims('gas-connector'), SOLANA_CHANNELS['relay-gas'].account);
console.log(`  books before: hub client=${hubBefore}, store peer=${storeBefore}, gas peer=${gasBefore}`);

// ── 2. paid relay write + free read ──────────────────────────────────────
step('2. a PAID write reaches the relay; a FREE read returns it');
const secretKey = generateSecretKey();
const unique = `toon-sandbox-smoke-${Date.now()}`;
const event = finalizeEvent({
  kind: 30078,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['d', 'toon-sandbox/smoke']],
  content: JSON.stringify({ unique }),
}, secretKey);
console.log(`  event ${event.id} from ${getPublicKey(secretKey)}`);
const relayPrice = await client.price('g.toon.relay');
assert(relayPrice !== null, `the hub prices g.toon.relay (${jstr(relayPrice)})`);
const written = await client.send('g.toon.relay', {
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event }),
});
assert(written.fulfilled === true, 'the relay-write packet FULFILLed');
assert(written.status === 200, `the relay answered ${written.status}`);

const read = await new Promise((resolve, reject) => {
  const socket = new WebSocket(RELAY_WS);
  const timer = setTimeout(() => { socket.close(); reject(new Error(`no EVENT from ${RELAY_WS} in 15s`)); }, 15_000);
  socket.onopen = () => socket.send(JSON.stringify(['REQ', 'smoke', { ids: [event.id] }]));
  socket.onerror = (e) => { clearTimeout(timer); reject(new Error(`ws error: ${e.message ?? e}`)); };
  socket.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    if (frame[0] === 'EVENT' && frame[1] === 'smoke') { clearTimeout(timer); socket.close(); resolve(frame[2]); }
    if (frame[0] === 'EOSE') { clearTimeout(timer); socket.close(); reject(new Error('EOSE with no EVENT')); }
  };
}).catch((e) => { bad(e.message); return null; });
if (read) {
  assert(read.id === event.id && read.sig === event.sig, 'the free read returned the event byte-for-byte');
}

// ── 3. paid store blob THROUGH THE PEERING ───────────────────────────────
step('3. a PAID kind:5094 blob to g.toon.store routes hub -> peering -> store');
const blobText = `hello from the TOON sandbox paid store path\nunique: ${unique}\n`;
const blobEvent = buildBlobStorageRequest(
  { blobData: Buffer.from(blobText), contentType: 'text/plain', bid: '1000000' },
  generateSecretKey(),
);
const storePrice = await client.price('g.toon.store');
assert(storePrice !== null, `the hub prices g.toon.store (${jstr(storePrice)})`);
const storeAnswer = await sendJob(
  { client, destination: 'g.toon.store', sealTo: STORE_EDGE, timeoutMs: 90_000 },
  blobEvent,
);
if (!storeAnswer.accepted) {
  bad(`store job refused/rejected: ${storeAnswer.code ?? ''} ${storeAnswer.message ?? ''} ${JSON.stringify(storeAnswer.refusal ?? {})}`);
} else {
  const txId = storeAnswer.receipt?.txId ?? storeAnswer.receipt?.result?.txId;
  assert(typeof txId === 'string' && txId.length === 43, `the store answered a real Arweave tx id: ${txId}`);
  if (typeof txId === 'string') {
    // The upload went through the LOCAL Turbo path (STORE_TURBO_UPLOAD_URL
    // -> upload-service), so the LOCAL gateway serves it optically.
    let served = false;
    for (let i = 0; i < 15 && !served; i++) {
      const res = await fetch(`${GATEWAY}/raw/${txId}`);
      if (res.status === 200 && (await res.text()).includes(unique)) served = true;
      else await sleep(2000);
    }
    assert(served, `the LOCAL gateway serves the stored blob at ${GATEWAY}/raw/${txId}`);
  }
}

// ── 3b. the BROKERED ArNS buy: kind:5095 prepare + 5096 gas + 5095 buy ───
// The three-party ceremony end to end, every leg PAID through the hub:
//   - the OWNER keypair below never holds a lamport — the client's only
//     asset is ILP credit on the channel from step 1
//   - the STORE composes the ANT-spawn transaction (op=prepare) and later
//     spends its own ARIO float on the name (op=buy, the DVM wallet funded
//     by seed-solana.mjs)
//   - the GAS STATION pays the spawn's rent + fee out of its Solana float
//     and broadcasts (kind:5096 quote/execute)
// and the name must then resolve through the LOCAL gateway.
step('3b. BROKERED ArNS buy (kind:5095): SOL-less owner -> paid prepare/gas/buy -> name resolves');
const arnsOwner = generateSolanaKeypair(); // never funded, ever
const arnsName = `toon-paid-${Math.random().toString(36).slice(2, 8)}`;
const arnsOutcome = await buyArnsNameWithNewAnt({
  store: { client, destination: 'g.toon.store', sealTo: STORE_EDGE, timeoutMs: 120_000 },
  gas: { client, destination: 'g.toon.gastation', sealTo: GAS_EDGE, timeoutMs: 120_000 },
  owner: arnsOwner,
  name: arnsName,
  type: 'lease',
  years: 1,
});
if (!arnsOutcome.bought) {
  bad(`brokered ArNS buy failed at step ${arnsOutcome.step}: ${arnsOutcome.reason} — ${arnsOutcome.detail}`);
} else {
  const { ant, receipt } = arnsOutcome;
  ok(`ANT spawned by the ceremony: ${ant.processId} (gas fee payer ${ant.feePayer}, tx ${ant.signature})`);
  assert(ant.owner === arnsOwner.address,
    `the ANT owner is the unfunded client keypair ${arnsOwner.address}`);
  assert(receipt.name === arnsName && receipt.processId === ant.processId,
    `op=buy bought "${receipt.name}" for the client's ANT (registry tx ${receipt.registryTxId})`);
  assert(typeof receipt.registryTxId === 'string' && receipt.registryTxId.length > 0,
    `the DVM paid ${receipt.quotedMario} mARIO on the LOCAL validator (network ${receipt.network})`);
  // The proof the name is real: the LOCAL gateway's resolver answers for it
  // (the gateway hydrates its base-name list from the validator; the
  // miss-refresh interval is 5s here, so poll).
  let resolved = null;
  for (let i = 0; i < 30 && !resolved; i++) {
    const res = await fetch(`${GATEWAY}/ar-io/resolver/${arnsName}`);
    if (res.status === 200) resolved = await res.json();
    else await sleep(3000);
  }
  assert(resolved !== null && typeof resolved.txId === 'string',
    `the LOCAL gateway resolves ${arnsName} (${GATEWAY}/ar-io/resolver/${arnsName} -> ${resolved?.txId})`);
}

// ── 4. paid gas quote THROUGH THE PEERING ────────────────────────────────
step('4. a PAID kind:5096 quote to g.toon.gastation routes hub -> peering -> gas station');
const gasPrice = await client.price('g.toon.gastation');
assert(gasPrice !== null, `the hub prices g.toon.gastation (${jstr(gasPrice)})`);
const gasEvent = buildJobEvent({ kind: 5096, params: { phase: 'quote' } });
const gasAnswer = await sendJob(
  { client, destination: 'g.toon.gastation', sealTo: GAS_EDGE, timeoutMs: 60_000 },
  gasEvent,
);
if (!gasAnswer.accepted) {
  bad(`gas quote refused/rejected: ${gasAnswer.code ?? ''} ${gasAnswer.message ?? ''} ${JSON.stringify(gasAnswer.refusal ?? {})}`);
} else {
  const receipt = gasAnswer.receipt ?? {};
  const feePayer = receipt.feePayer ?? receipt.result?.feePayer;
  assert(typeof feePayer === 'string' && feePayer.length >= 32,
    `the gas station quoted its Solana fee payer: ${feePayer}`);
}

// ── 4b. paid kind:5098 EVM meta-tx relay THROUGH THE PEERING ─────────────
// The whole ERC-2771 ceremony against the sandbox's own forwarder on anvil:
// a throwaway wallet that NEVER holds a wei authors a call, the gas station's
// dedicated relayer pays for it, and the target still sees the author as
// _msgSender(). The target is the SandboxTokenNetworkProbe (the real
// TokenNetwork was deployed forwarder-less, so the sandbox whitelists the
// probe instead — same setTotalDeposit selector, records what it saw).
step('4b. a PAID kind:5098 EVM meta-tx: quote, client-signed ERC-2771 relay, on-chain _msgSender() proof');
{
  // The free /describe surface only advertises 5098 when the EVM env is
  // configured — this is the "gap closed" assertion.
  const describe = await fetch(`${GAS_BLS}/describe`).then((r) => r.json())
    .catch((e) => { bad(`gas station /describe unreachable at ${GAS_BLS}: ${e.message}`); return null; });
  const evmJob = (describe?.jobs ?? []).find((j) => j.kind === 5098);
  assert(evmJob !== undefined, '/describe advertises kind:5098 (evm-gas-station)');
  assert(Array.isArray(evmJob?.chains) && evmJob.chains.includes('evm:31337'),
    `kind:5098 chains include evm:31337 (${JSON.stringify(evmJob?.chains ?? [])})`);
}
// The author of the relayed call — DELIBERATELY unfunded, forever.
const evmAuthor = EthersWallet.createRandom();
let evmQuote = null;
{
  const quoteEvent = buildJobEvent({
    kind: 5098,
    params: { phase: 'quote', chainId: '31337', from: evmAuthor.address },
  });
  const answer = await sendJob(
    { client, destination: 'g.toon.gastation', sealTo: GAS_EDGE, timeoutMs: 60_000 },
    quoteEvent,
  );
  if (!answer.accepted) {
    bad(`5098 quote refused/rejected: ${answer.code ?? ''} ${answer.message ?? ''} ${JSON.stringify(answer.refusal ?? {})}`);
  } else {
    const r = answer.receipt?.quoteId ? answer.receipt : answer.receipt?.result ?? answer.receipt ?? {};
    if (r.status !== 'ok') {
      bad(`5098 quote failed: ${r.reason ?? '?'} — ${r.detail ?? jstr(r)}`);
    } else {
      evmQuote = r;
      ok(`quote ${r.quoteId} for signer ${evmAuthor.address} (relayer ${r.relayer}, nonce ${r.forwarderNonce})`);
      assert(String(r.forwarder).toLowerCase() === FORWARDER.toLowerCase(),
        `the quoted forwarder is the sandbox ERC2771Forwarder ${FORWARDER}`);
      assert(String(r.tokenNetwork).toLowerCase() === PROBE.toLowerCase(),
        `the quoted (whitelisted) target is the ERC-2771 probe ${PROBE}`);
    }
  }
}
if (evmQuote) {
  // Build + EIP-712-sign the ForwardRequest exactly as OZ v5.5.0's
  // ERC2771Forwarder verifies it: domain {name:"ToonSandboxForwarder",
  // version:"1"}, typed struct includes the forwarder nonce; the wire
  // ForwardRequestData carries the signature instead of the nonce.
  const iface = new EthersInterface([
    'function setTotalDeposit(bytes32 channelId, address participant, uint256 totalDeposit)',
  ]);
  const channelId = hexlify(randomBytes(32));
  const totalDeposit = 5098n;
  const data = iface.encodeFunctionData('setTotalDeposit', [channelId, evmAuthor.address, totalDeposit]);
  const req = {
    from: evmAuthor.address,
    to: evmQuote.tokenNetwork,
    value: '0',
    gas: '200000', // well under the station's 300k cap
    deadline: evmQuote.recommendedDeadline,
    data,
  };
  const signature = await evmAuthor.signTypedData(
    { name: 'ToonSandboxForwarder', version: '1', chainId: 31337, verifyingContract: evmQuote.forwarder },
    {
      ForwardRequest: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'gas', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint48' },
        { name: 'data', type: 'bytes' },
      ],
    },
    { ...req, value: 0n, gas: 200000n, nonce: BigInt(evmQuote.forwarderNonce) },
  );
  const executeEvent = buildJobEvent({
    kind: 5098,
    params: {
      phase: 'execute',
      chainId: '31337',
      request: Buffer.from(JSON.stringify({ ...req, signature })).toString('base64'),
      quoteId: evmQuote.quoteId,
      idempotencyKey: `${unique}-5098`,
    },
  });
  const answer = await sendJob(
    { client, destination: 'g.toon.gastation', sealTo: GAS_EDGE, timeoutMs: 90_000 },
    executeEvent,
  );
  if (!answer.accepted) {
    bad(`5098 execute refused/rejected: ${answer.code ?? ''} ${answer.message ?? ''} ${JSON.stringify(answer.refusal ?? {})}`);
  } else {
    const r = answer.receipt?.txHash ? answer.receipt : answer.receipt?.result ?? answer.receipt ?? {};
    if (r.status !== 'ok') {
      bad(`5098 execute failed: ${r.reason ?? '?'} — ${r.detail ?? jstr(r)}`);
    } else {
      assert(/^0x[0-9a-fA-F]{64}$/.test(r.txHash),
        `the relayer landed the forward request: tx ${r.txHash} (block ${r.blockNumber}, gasUsed ${r.gasUsed})`);
      // The point of ERC-2771, read back off the chain itself: the probe
      // resolved _msgSender() through the forwarder to the AUTHOR.
      const provider = new JsonRpcProvider(ANVIL_URL);
      try {
        const probe = new EthersContract(PROBE, [
          'function lastSender() view returns (address)',
          'function lastChannelId() view returns (bytes32)',
          'function lastTotalDeposit() view returns (uint256)',
        ], provider);
        const [lastSender, lastChannelId, lastTotalDeposit, authorBalance, tx] = await Promise.all([
          probe.lastSender(),
          probe.lastChannelId(),
          probe.lastTotalDeposit(),
          provider.getBalance(evmAuthor.address),
          provider.getTransaction(r.txHash),
        ]);
        assert(lastSender.toLowerCase() === evmAuthor.address.toLowerCase(),
          `ERC-2771 PROOF: the target's _msgSender() is the CLIENT author ${lastSender}`);
        assert(lastSender.toLowerCase() !== String(evmQuote.relayer).toLowerCase(),
          `…and NOT the relayer ${evmQuote.relayer}, which merely paid`);
        assert(lastChannelId === channelId && lastTotalDeposit === totalDeposit,
          'the recorded call args are exactly the ones the client signed');
        assert(authorBalance === 0n,
          'the author wallet still holds 0 ETH — the gas was entirely the relayer\'s');
        assert(tx !== null && tx.from.toLowerCase() === String(evmQuote.relayer).toLowerCase()
          && String(tx.to).toLowerCase() === FORWARDER.toLowerCase(),
          `the on-chain tx was sent by the relayer to the forwarder (${tx?.from} -> ${tx?.to})`);
      } finally {
        provider.destroy();
      }
    }
  }
}

// ── 5. the money, PER LEG ────────────────────────────────────────────────
// Cross-chain, same-asset: the client leg settles on the anvil (EVM)
// channel the client opened in step 1; both peer legs settle on the SOLANA
// channel accounts asserted on-chain in step 0b. Amounts are the same
// 6-decimal USDC unit end to end — no conversion anywhere.
step('5. the connectors’ own books say everything was PAID — per settlement leg');
// Claims are journaled on the far side of the same round trip; poll briefly.
let hubRows = [], hubAfter = hubBefore, storeAfter = storeBefore, gasAfter = gasBefore;
for (let i = 0; i < 20 && (hubAfter - hubBefore < 9901n || storeAfter - storeBefore < 3000n || gasAfter - gasBefore < 6000n); i++) {
  await sleep(500);
  hubRows = await claims('relay-connector');
  hubAfter = clientBookTotal(hubRows);
  storeAfter = peerBookTotal(await claims('store-connector'), SOLANA_CHANNELS['relay-store'].account);
  gasAfter = peerBookTotal(await claims('gas-connector'), SOLANA_CHANNELS['relay-gas'].account);
}
// Client leg (EVM): ten paid packets entered the hub's client edge — relay
// write (1), store blob (>= 1100), the brokered ArNS ceremony's five
// (kind:5096 fee-payer quote, kind:5095 op=prepare, kind:5096 quote with
// draft, kind:5096 execute, kind:5095 op=buy — >= 1100 each), 5096 quote
// (1100), 5098 quote (1100), 5098 execute (1100) — and every client-book
// claim rides the EVM channel opened on anvil in step 1.
assert(hubAfter - hubBefore >= 1n + 9n * 1100n,
  `hub client book advanced by ${hubAfter - hubBefore} (>= 9901, the ten packets' prices)`);
// The hub's book keys a client channel as `evm:0x<64 hex>` — the chain
// family prefix plus the anvil channel id.
const clientChannels = [...new Set(hubRows.filter((r) => r.book === 'client' && r.direction === 'inbound').map((r) => r.channel_id))];
assert(clientChannels.length > 0 && clientChannels.every((c) => /^(evm:)?0x[0-9a-f]{64}$/i.test(c)),
  `client leg settles on EVM: hub client-book channels ${clientChannels.join(', ')} are anvil channel ids`);
assert(clientChannels.some((c) => c.replace(/^evm:/, '').toLowerCase() === String(opened.channelId).toLowerCase()),
  `and include the channel the client opened in step 1 (${opened.channelId})`);
// Peer legs (SOLANA): the payees' watermarks advanced ON the Solana channel
// accounts — the totals above were already restricted to exactly those ids.
assert(storeAfter - storeBefore >= 3000n,
  `store peer leg settles on SOLANA: watermark on channel ${SOLANA_CHANNELS['relay-store'].account} advanced by ${storeAfter - storeBefore} (>= 3000: 5094 blob + 5095 prepare + 5095 buy)`);
assert(gasAfter - gasBefore >= 6000n,
  `gas peer leg settles on SOLANA: watermark on channel ${SOLANA_CHANNELS['relay-gas'].account} advanced by ${gasAfter - gasBefore} (>= 6000: 5096 fee-payer quote + 5096 draft quote + 5096 execute + 5096 quote + 5098 quote + 5098 execute)`);

console.log(failures === 0
  ? '\n\x1b[32mTOON SMOKE OK: paid routing through the relay hub to store and gas station (blob store, brokered ArNS spawn+buy, Solana quote + EVM ERC-2771 relay) — client leg settled on EVM, both peer legs settled on SOLANA payment channels, same USDC unit throughout.\x1b[0m'
  : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
