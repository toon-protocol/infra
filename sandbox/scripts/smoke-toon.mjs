// TOON-layer smoke test: proves the payment layer + the TOON apps in one run
// (run from sandbox/ on the host after `make up`; second half of `make smoke`).
//
// TOON_SMOKE_PAYMENTS_ONLY=1 (what `make smoke-payments` sets, after
// `make up-payments`) runs the PAYMENT LAYER HALF ONLY — steps 0, 0b, 1, 1b, 2
// and a client-leg-only version of step 5. The store, the gas station and
// their two connectors are not running under the `payments` compose profile,
// so steps 3/3b/4/4b and their peering legs are skipped rather than
// duplicated into a second script.
//
// EVERY CHANNEL IS AN x402 batch-settlement CHANNEL (connector ADR 0075,
// infra#39), and every claim a book holds is a VOUCHER on one: this file reads
// no `toon-channel` claim anywhere.
//
//   0. payment infrastructure is live:
//        - x402BatchSettlement has code on anvil and the FiatToken USDC
//          answers version "2"; no TOON contract is left there
//        - payment-channels is an EXECUTABLE program on the validator, and
//          TOON's own payment_channel program is not
//        - every connector edge answers GET /ilp, and PUBLISHES THE TERMS a
//          client opens a channel on: an EVM batchSettlements entry naming the
//          FiatToken and the Onboarder as its facilitator, a Solana one with a
//          sponsor endpoint and a 1 USDC minDeposit
//   0b. every peering this profile runs is open on chain: the hub's x402
//      channel toward each payee (the open-peerings job's), read back off the
//      validator — paid by the hub, payable to the payee, collateralised
//   1. a real client (@toon-protocol/client 4.x) opens an x402 channel in
//      mock USDC ON SOLANA against the hub, through the hub's sponsor endpoint
//   1b. RECOVERY: a directory publisher's channel store is WIPED — its
//      watermark gone, its channel binding kept — and its next paid relay
//      write still lands, on the same channel, above the old watermark. The
//      client adopts the watermark the hub names or asks `POST
//      /ilp/claim-state`; that is what replaced the channel-state preflight
//      every relay-writing smoke used to run first
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
//      packet's answer cannot tell you it was paid for: the hub's watermark
//      on the buyer's channel, and each payee's watermark on the hub's
//      channel toward it — the peering leg, at par (same token, same scale)
//
// The ANYONE credentials purchase this file used to make is PARKED until
// infra#42: the hub settles USDC on EVM now and cannot deal ANYONE (a node
// holds one token per chain), and #42 moves the flip into a Dealer node
// (infra ADR 0003) with a smoke of its own.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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

import { hostFetch } from './lib/sandbox-endpoints.mjs';
import { NODES, PEERINGS, CHANNEL_TARGET } from './peerings.mjs';
import { PAYMENT_CHANNELS_PROGRAM, USDC_MINT, readSolanaChannel as readChannelAt } from './lib/solana-channel.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
// Set by `make smoke-payments`; see the header. Everything it gates is an
// assertion about a service the profile does not run, never a payment-layer
// one.
const PAYMENTS_ONLY = /^(1|true|yes)$/i.test(process.env.TOON_SMOKE_PAYMENTS_ONLY ?? '');
const STORE_GAS = !PAYMENTS_ONLY;
const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
const STORE_EDGE = process.env.STORE_EDGE_URL ?? 'http://localhost:3210';
const GAS_EDGE = process.env.GAS_EDGE_URL ?? 'http://localhost:3220';
const RELAY_WS = process.env.RELAY_WS ?? 'ws://localhost:7100';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const ANVIL_URL = process.env.ANVIL_URL ?? 'http://localhost:8545';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
// anvil's own published test mnemonic. Public knowledge, local chain only.
const MNEMONIC = 'test test test test test test test test test test test junk';
const GAS_BLS = process.env.GAS_BLS_URL ?? 'http://localhost:3400'; // gas station's free /describe surface
// Every Solana channel lives in solana-foundation's payment-channels
// (PAYMENT_CHANNELS_PROGRAM); TOON's own program is gone (connector ADR 0075).
const RETIRED_PAYMENT_CHANNEL_PROGRAM = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
// x402's batch-settlement contract, at its canonical address (scripts/seed-x402.sh).
const X402_BATCH_SETTLEMENT = '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
// The FiatToken USDC every EVM node settles in, and the Onboarder they name as
// their `facilitator` — by its compose-network name, which is what a node
// publishes.
const FIAT_USDC = '0x0A867CA0442383c2A89951244B955AA19b615b58';
const ONBOARDER = 'http://onboarder:4022';
// The connector's DeployLocal addresses (TokenNetworkRegistry, MockERC20),
// which must be EMPTY now: nothing TOON-shaped is left on the chain.
const RETIRED_EVM = { TokenNetworkRegistry: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', MockERC20: '0x5FbDB2315678afecb367f032d93F642f64180aa3' };
// kind:5098 contracts (deterministic outputs of contracts/DeploySandboxExtras.s.sol:
// OZ v5.5.0 ERC2771Forwarder + the ERC-2771 probe target, anvil acct 9 nonces 0/1).
const FORWARDER = '0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35';
const PROBE = '0xA15BB66138824a1c7167f5E85b957d04Dd34E468';
const MIN_SPONSORED_DEPOSIT = '1000000'; // every node's, 1 USDC
// The buyer's own Solana identity — SLIP-0010 m/44'/501'/0'/0' of the anvil
// mnemonic above, which is what ToonClient derives at index 0. Committed here
// AND in scripts/seed-toon-solana.mjs (which funds it), and asserted against
// what the client actually derives in step 1: if the library's derivation path
// ever moves, this fails by name instead of as an unfunded wallet.
const BUYER_SOL = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96';
// The first provider's directory publisher: its wallet (account index 1) and
// the compose service and volume its channel store lives on (step 1b).
const PUBLISHER = { service: 'directory-publisher', sol: 'AqynRZwvVqUPRwRJXvm6odUb3t93fDjnWe3p6BeuUFxD', volume: `${process.env.COMPOSE_PROJECT_NAME ?? 'toon-sandbox'}_directory-publisher-state` };
const LIVENESS_CADENCE_S = Number(readFileSync(join(ROOT, 'conf', 'provider.toml'), 'utf8').match(/^liveness_cadence_s\s*=\s*(\d+)/m)?.[1] ?? 30);
// The peerings this profile runs: the hub pays each payee over its own channel.
const PROFILE_PEERINGS = PEERINGS.filter((p) => STORE_GAS || !['store-connector', 'gas-connector'].includes(p.payee));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
let failures = 0;
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const fatal = (msg) => { console.error(`\nTOON SMOKE FAILED: ${msg}`); process.exit(1); };

const bearer = (node) => readFileSync(join(ROOT, 'keys', 'toon', node, 'operator-bearer.token'), 'utf8').trim();
// Each node on its HOST port; scripts/peerings.mjs holds the map.
const edgeOf = Object.fromEntries(Object.entries(NODES).map(([node, { port }]) => [node, `http://localhost:${port}`]));
async function operatorRead(node, path) {
  const res = await fetch(`${edgeOf[node]}${path}`, { headers: { authorization: `Bearer ${bearer(node)}` } });
  if (!res.ok) throw new Error(`${node} GET ${path} -> ${res.status}`);
  return res.json();
}
const claims = (node) => operatorRead(node, '/claims');
// A node's watermark on ONE channel, off its own `GET /claims`: every row it
// holds for what it was paid is a voucher, `direction: "inbound"`, keyed
// `solana:<account>` or `evm:0x<id>`. One book — the journal keeps a voucher
// the same whichever role it arrived in — so WHOSE money it is, is the channel.
function watermark(rows, channelKey) {
  let top = 0n;
  for (const r of rows) {
    if (r.direction !== 'inbound' || String(r.channel_id).toLowerCase() !== channelKey.toLowerCase()) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > top) top = a;
  }
  return top;
}
const rpcCall = (url, method, params) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}).then((r) => r.json());

// A payment-channels Channel account, off this sandbox's validator.
const readSolanaChannel = (account) => readChannelAt(RPC_URL, account);

// ── 0. payment infrastructure ────────────────────────────────────────────
step('0. payment infrastructure is live, and every node publishes x402 terms');
{
  const code = async (address) => (await rpcCall(ANVIL_URL, 'eth_getCode', [address, 'latest'])
    .catch((e) => fatal(`anvil unreachable: ${e.message}`))).result;
  const settlement = await code(X402_BATCH_SETTLEMENT);
  assert(settlement && settlement !== '0x', `x402BatchSettlement has code at ${X402_BATCH_SETTLEMENT} (${(settlement.length - 2) / 2} bytes)`);
  const version = await rpcCall(ANVIL_URL, 'eth_call', [{ to: FIAT_USDC, data: '0x54fd4d50' }, 'latest']); // version()
  assert(typeof version.result === 'string' && Buffer.from(version.result.slice(2), 'hex').toString('latin1').includes('2'),
    `the FiatToken USDC at ${FIAT_USDC} is deployed and initialised (version())`);
  for (const [name, address] of Object.entries(RETIRED_EVM)) {
    assert((await code(address)) === '0x', `no ${name} on anvil (${address} is empty): nothing TOON-shaped is left on the chain`);
  }
}
{
  const program = await rpcCall(RPC_URL, 'getAccountInfo', [PAYMENT_CHANNELS_PROGRAM, { encoding: 'base64' }])
    .catch((e) => fatal(`validator unreachable: ${e.message}`));
  if (!program.result?.value?.executable) fatal(`payment-channels ${PAYMENT_CHANNELS_PROGRAM} is not an executable account on the validator`);
  ok('payment-channels is loaded and executable on the validator');
  const retired = await rpcCall(RPC_URL, 'getAccountInfo', [RETIRED_PAYMENT_CHANNEL_PROGRAM, { encoding: 'base64' }]);
  assert(retired.result?.value === null, `TOON's own payment_channel program (${RETIRED_PAYMENT_CHANNEL_PROGRAM}) is not on the validator`);
}
const EDGES = ['relay-connector', ...new Set(PROFILE_PEERINGS.map((p) => p.payee))];
for (const node of EDGES) {
  const res = await fetch(`${edgeOf[node]}/ilp`).catch((e) => fatal(`${node} unreachable at ${edgeOf[node]}: ${e.message}`));
  if (!res.ok) fatal(`${node} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  const routes = (desc.routes ?? []).map((r) => `${r.prefix}@${JSON.stringify(r.price)}`).join(', ');
  ok(`${node}: ${desc.ilpAddresses?.join(',') ?? '(no addresses)'} — routes: ${routes}`);
  const evm = (desc.batchSettlements ?? []).find((b) => b.network === 'eip155:31337');
  const sol = (desc.batchSettlements ?? []).find((b) => String(b.network).startsWith('solana:'));
  assert(evm?.asset?.toLowerCase() === FIAT_USDC.toLowerCase() && evm.facilitator === ONBOARDER
    && evm.assetTransferMethod === 'eip3009' && evm.name === 'USDC' && evm.version === '2',
    `${node} offers EVM channels in the FiatToken, "USDC"/"2" by eip3009, through the Onboarder (${jstr(evm && { asset: evm.asset, facilitator: evm.facilitator })})`);
  assert(sol?.asset === USDC_MINT && sol.minDeposit === MIN_SPONSORED_DEPOSIT && typeof sol.sponsorEndpoint === 'string',
    `${node} offers Solana channels in the mock USDC mint, sponsored at ${sol?.sponsorEndpoint} from ${sol?.minDeposit} base units`);
  assert(desc.httpEndpoint === NODES[node].url,
    `${node} publishes ${desc.httpEndpoint}, the compose-network name its peer dials`);
}

// ── 0b. the peerings are open on chain ───────────────────────────────────
// The open-peerings job runs just after `make up` returns, so wait for it.
// Each peering's traffic-carrying half is the hub's x402 channel toward the
// payee; its account is a fact of the run, found on the hub's own GET
// /channels by the payee's Solana key and read back off the validator — the
// part nothing on the packet path checks.
step('0b. the hub’s x402 channel toward every payee is open and collateralised on SOLANA');
const hubSol = (await (await fetch(`${HUB}/ilp`)).json()).batchSettlements.find((b) => String(b.network).startsWith('solana:')).payTo;
const peeringChannel = {}; // payee node -> `solana:<account>`
for (const peering of PROFILE_PEERINGS) {
  const payeeSol = (await (await fetch(`${edgeOf[peering.payee]}/ilp`)).json())
    .batchSettlements.find((b) => String(b.network).startsWith('solana:')).payTo;
  let row = null;
  for (let i = 0; i < 45 && !row; i++) {
    row = (await operatorRead('relay-connector', '/channels'))
      .find((r) => r.direction === 'outbound' && r.counterparty === payeeSol && r.status === 'open');
    if (!row) await sleep(2000);
  }
  if (!row) { bad(`${peering.id}: the hub holds no open channel toward ${peering.payee} (docker compose logs open-peerings)`); continue; }
  peeringChannel[peering.payee] = `solana:${row.id}`;
  const ch = await readSolanaChannel(row.id);
  assert(ch?.owner === PAYMENT_CHANNELS_PROGRAM && ch.size === 256, `${peering.id}: ${row.id} is a payment-channels Channel account`);
  assert(ch?.payer === hubSol && ch.authorizedSigner === hubSol && ch.payee === payeeSol,
    `${peering.id}: paid and signed for by the hub, payable to ${peering.payee}`);
  assert(ch?.mint === USDC_MINT && ch.status === 0, `${peering.id}: Open, in the mock USDC mint`);
  assert(ch?.deposit >= CHANNEL_TARGET, `${peering.id}: the hub's deposit behind it is ${ch?.deposit} (>= ${CHANNEL_TARGET})`);
}

// ── 1. a channel against the hub ─────────────────────────────────────────
// THE BUYER PAYS USDC ON SOLANA, from its own x402 channel: a payer-signed
// payment-channels `open` the hub co-signs at its sponsor endpoint, so the
// buyer spends no SOL on it. `fetch: hostFetch()` because the hub publishes
// its compose-network name (a peer dials what a node publishes) and a client
// dials what it publishes too — the sponsor endpoint included.
step('1. an x402 channel in mock USDC ON SOLANA against the hub');
// NOT under data/ — that tree is created root-owned by docker bind mounts.
// .toon-client/ is host-owned, gitignored, wiped by `make clean` (its channel
// watermark MUST die with the chain).
mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
const client = await ToonClient.create({
  connector: HUB,
  mnemonic: MNEMONIC,
  chain: 'solana',
  rpcUrl: RPC_URL,
  channelStore: join(ROOT, '.toon-client', 'channels.json'),
  deposit: 10_000_000n, // 10 USDC — plenty against ~1100/packet prices
  timeoutMs: 60_000,
  fetch: hostFetch(),
});
// The client derives this from the mnemonic; scripts/seed-toon-solana.mjs
// funded it from a committed copy of the same string. If the library's
// derivation path ever moves, the failure is HERE and says so, rather than a
// ChannelFundingError about a wallet nobody can find.
assert(client.identity?.solanaPublicKey === BUYER_SOL,
  `the buyer is ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded (${BUYER_SOL})`);
const opened = (await client.channel.open()).channel;
const BUYER_CHANNEL = `solana:${opened.channelId}`;
{
  const ch = await readSolanaChannel(opened.channelId);
  assert(ch?.owner === PAYMENT_CHANNELS_PROGRAM && ch.payer === BUYER_SOL && ch.payee === hubSol && ch.status === 0,
    `channel ${opened.channelId} is an Open payment-channels account the buyer pays the hub from, sponsored by the hub (deposit ${ch?.deposit})`);
}

const hubBefore = watermark(await claims('relay-connector'), BUYER_CHANNEL);
const payeeBefore = {};
for (const [payee, key] of Object.entries(peeringChannel)) payeeBefore[payee] = watermark(await claims(payee), key);
console.log(`  books before: hub on the buyer's channel=${hubBefore}`
  + Object.entries(payeeBefore).map(([payee, v]) => `, ${payee} on the hub's channel=${v}`).join(''));

// ── 1b. a publisher recovers from a wiped channel store ─────────────────
// The drift the retired channel-state preflight guarded against: a payer
// whose LOCAL watermark has fallen behind the connector's. A voucher has no
// nonce and must strictly exceed the connector's watermark, so a publisher
// that forgot its watermark signs one the hub refuses — and client 4.x then
// adopts the watermark the refusal names, or asks `POST /ilp/claim-state`,
// and signs again. So: stop the publisher, delete its watermark store
// (channels.json) and keep its channel binding (channels.peers.json), start
// it, and require its next relay write to land ON THE SAME CHANNEL, above
// where the hub's watermark stood.
step('1b. a directory publisher whose channel store is wiped still gets its next write through');
{
  const docker = (...args) => execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const publisherChannels = async () => (await operatorRead('relay-connector', '/channels'))
    .filter((r) => r.direction === 'inbound' && r.counterparty === PUBLISHER.sol);
  let before = [];
  for (let i = 0; i < 45 && before.length === 0; i++) {
    before = await publisherChannels();
    if (before.length === 0) await sleep(2000);
  }
  if (before.length !== 1) {
    bad(`${PUBLISHER.service} should pay the hub from exactly one channel before the wipe, and holds ${before.length}`);
  } else {
    const channel = before[0].id;
    const key = `solana:${channel}`;
    // The container itself, not `docker compose start`: under a profile flag
    // compose would also try to start every dependency that profile names.
    const container = docker('compose', '--profile', 'payments', 'ps', '-q', PUBLISHER.service).trim();
    docker('stop', container);
    const stopped = watermark(await claims('relay-connector'), key);
    docker('run', '--rm', '-v', `${PUBLISHER.volume}:/s`, 'alpine:3.20', 'rm', '-f', '/s/channels.json');
    const left = docker('run', '--rm', '-v', `${PUBLISHER.volume}:/s:ro`, 'alpine:3.20', 'ls', '/s').trim().split('\n');
    assert(!left.includes('channels.json') && left.includes('channels.peers.json'),
      `${PUBLISHER.service}'s watermark store is gone and its channel binding kept (${left.join(', ')}); the hub stands at ${stopped} on ${channel}`);
    docker('start', container);
    let now = stopped;
    for (let i = 0; i < Math.ceil((3 * LIVENESS_CADENCE_S) / 2) && now <= stopped; i++) {
      await sleep(2000);
      now = watermark(await claims('relay-connector'), key);
    }
    assert(now > stopped,
      `its next relay write landed on the same channel: the hub's watermark on ${channel} rose ${stopped} -> ${now}`);
    const after = await publisherChannels();
    assert(after.length === 1 && after[0].id === channel,
      `and it did not open a second channel to get there (${after.map((r) => r.id).join(', ')})`);
  }
}

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

// The client leg, asserted the same way on every profile: the hub's
// watermark on the buyer's own channel, and every row it holds a voucher.
async function assertClientLeg(expected, what) {
  let rows = [];
  let now = hubBefore;
  for (let i = 0; i < 20 && now - hubBefore < expected; i++) {
    await sleep(500);
    rows = await claims('relay-connector');
    now = watermark(rows, BUYER_CHANNEL);
  }
  assert(now - hubBefore >= expected,
    `the hub's watermark on the buyer's channel ${opened.channelId} advanced by ${now - hubBefore} uUSDC (>= ${expected}, ${what})`);
  const inbound = rows.filter((r) => r.direction === 'inbound');
  assert(inbound.length > 0 && inbound.every((r) => r.scheme === 'batch-settlement' && /^(solana:[1-9A-HJ-NP-Za-km-z]{32,44}|evm:0x[0-9a-f]{64})$/.test(r.channel_id)),
    `every claim the hub holds is a batch-settlement voucher on an x402 channel (${inbound.length} channels)`);
}

// ── the `payments` profile ends here ─────────────────────────────────────
// Everything below needs the store or the gas station behind a peering, and
// the `payments` profile runs neither. g.toon.relay is priced at 1 base unit
// (conf/connector-relay.toml), so one paid write is exactly +1 on the buyer's
// channel — small, but it is a real signed voucher, which is the point.
if (PAYMENTS_ONLY) {
  step('5. the hub’s own book says the write was PAID — client leg, on SOLANA');
  await assertClientLeg(1n, 'the paid relay write');
  console.log(failures === 0
    ? '\n\x1b[32mTOON PAYMENTS SMOKE OK: x402BatchSettlement, the FiatToken and payment-channels live with no TOON contract left, every node publishing x402 terms, the hub’s peering channels open and collateralised on Solana, a publisher recovering from a wiped channel store, a sponsored Solana channel opened against the hub, and a paid write journaled as a voucher on it.\x1b[0m'
    : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── the store and the gas station, over their peerings ──────────────────
if (STORE_GAS) {
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
  //     asset is its x402 channel from step 1
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
  // _msgSender(). The target is the SandboxTokenNetworkProbe, the one target
  // the gas station whitelists for this selector (contracts/
  // DeploySandboxExtras.s.sol says why it is not a real contract), which
  // records what it saw.
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
}

// ── 5. the money, PER LEG ────────────────────────────────────────────────
// Every leg is mock USDC on a Solana x402 channel, 6 decimals, at par: the
// buyer's channel toward the hub, and the hub's channel toward each payee.
// Nothing converts anywhere, so what a payee was paid is exactly what the hub
// was paid for it less the hub's flat fee.
step('5. the connectors’ own books say everything was PAID — per settlement leg');
// Client leg: ten paid packets entered the hub's client edge — relay write
// (1), store blob (>= 1100), the brokered ArNS ceremony's five (kind:5096
// fee-payer quote, kind:5095 op=prepare, kind:5096 quote with draft, kind:5096
// execute, kind:5095 op=buy — >= 1100 each), 5096 quote (1100), 5098 quote
// (1100) and 5098 execute (1100).
await assertClientLeg(1n + 9n * 1100n, 'the ten packets’ prices');
// Peering legs: the payee's watermark on the hub's channel toward it.
const PAYEE_EXPECTED = {
  'store-connector': [3000n, '5094 blob + 5095 prepare + 5095 buy'],
  'gas-connector': [6000n, '5096 fee-payer quote + 5096 draft quote + 5096 execute + 5096 quote + 5098 quote + 5098 execute'],
};
for (const [payee, [expected, what]] of Object.entries(PAYEE_EXPECTED)) {
  const key = peeringChannel[payee];
  if (!key) { bad(`${payee}: no peering channel to read (step 0b)`); continue; }
  let now = payeeBefore[payee];
  for (let i = 0; i < 20 && now - payeeBefore[payee] < expected; i++) {
    await sleep(500);
    now = watermark(await claims(payee), key);
  }
  assert(now - payeeBefore[payee] >= expected,
    `${payee}'s peering leg settles on SOLANA at par: its watermark on the hub's channel ${key} advanced by ${now - payeeBefore[payee]} uUSDC (>= ${expected}: ${what})`);
}

console.log(failures === 0
  ? '\n\x1b[32mTOON SMOKE OK: paid routing through the relay hub to the store and the gas station (blob store, brokered ArNS spawn+buy, Solana quote + EVM ERC-2771 relay) — every channel an x402 channel: the buyer paid mock USDC from a channel the hub sponsored on Solana, each peering leg settled at par on the hub’s own channel toward the payee, and a publisher recovered from a wiped channel store.\x1b[0m'
  : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
