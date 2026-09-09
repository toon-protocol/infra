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
//   4. a PAID kind:5096 gas job (quote phase) addressed to g.toon.gastation
//      routes over the relay-gas peering to the gas station, which answers
//      its Solana fee payer
//   5. the money is asserted from the connectors' own books, because a
//      packet's answer cannot tell you it was paid for:
//        - the hub's client-book claims advanced by at least the prices paid
//        - the two payees' PEER-book claims advanced (the peerings were PAID,
//          not merely traversed)
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToonClient, sendJob, buildJobEvent } from '@toon-protocol/client';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

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
const PAYMENT_CHANNEL_PROGRAM = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const REGISTRY = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

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
function peerBookTotal(rows) {
  const per = new Map();
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book === 'client') continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > (per.get(r.channel_id) ?? 0n)) per.set(r.channel_id, a);
  }
  return [...per.values()].reduce((s, a) => s + a, 0n);
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
const storeBefore = peerBookTotal(await claims('store-connector'));
const gasBefore = peerBookTotal(await claims('gas-connector'));
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
    // The upload went through the LOCAL Turbo path (turbo-tls shim ->
    // upload-service), so the LOCAL gateway serves it optically.
    let served = false;
    for (let i = 0; i < 15 && !served; i++) {
      const res = await fetch(`${GATEWAY}/raw/${txId}`);
      if (res.status === 200 && (await res.text()).includes(unique)) served = true;
      else await sleep(2000);
    }
    assert(served, `the LOCAL gateway serves the stored blob at ${GATEWAY}/raw/${txId}`);
  }
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

// ── 5. the money ─────────────────────────────────────────────────────────
step('5. the connectors’ own books say everything was PAID');
// Claims are journaled on the far side of the same round trip; poll briefly.
let hubAfter = hubBefore, storeAfter = storeBefore, gasAfter = gasBefore;
for (let i = 0; i < 20 && (hubAfter <= hubBefore || storeAfter <= storeBefore || gasAfter <= gasBefore); i++) {
  await sleep(500);
  hubAfter = clientBookTotal(await claims('relay-connector'));
  storeAfter = peerBookTotal(await claims('store-connector'));
  gasAfter = peerBookTotal(await claims('gas-connector'));
}
// Three paid packets entered the hub's client edge: relay write (1), store
// blob (>= 1100), gas quote (1100).
assert(hubAfter - hubBefore >= 1n + 1100n + 1100n,
  `hub client book advanced by ${hubAfter - hubBefore} (>= 2201, the three packets' prices)`);
assert(storeAfter - storeBefore >= 1000n,
  `store-connector PEER book advanced by ${storeAfter - storeBefore} (>= 1000: the peering crossing was PAID)`);
assert(gasAfter - gasBefore >= 1000n,
  `gas-connector PEER book advanced by ${gasAfter - gasBefore} (>= 1000: the peering crossing was PAID)`);

console.log(failures === 0
  ? '\n\x1b[32mTOON SMOKE OK: paid routing through the relay hub to store and gas station, with the peerings provably paid.\x1b[0m'
  : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
