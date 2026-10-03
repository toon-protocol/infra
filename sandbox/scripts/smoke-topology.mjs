// `make smoke-topology`: proof for whatever `make up-topology` started. It
// reads the record that target left (conf/.rendered/topology.json) and
// asserts the selection, not a fixed stack:
//
//   0. ONLY THE SELECTION RUNS — every sandbox container belongs to a service
//      the selection names, and every service it names has one.
//   1. every node publishes x402 terms on exactly the chains it was started
//      on, at the endpoint it should: its compose name, or — a hidden node —
//      its virtual port on the daemon's `.anyone` address.
//   2. each relay node's INFORMATION DOCUMENT (`GET /` on its read port, asked
//      with `Accept: application/nostr+json`) carries a `toon` object saying
//      where a write to it is paid, and it says what that node's connector
//      says: its own write address, the endpoint and seal key the connector
//      publishes, the price it charges for the route, and settlement on
//      exactly the chains the topology was started with. Held to the
//      connector's answer, read where the document sends a client, and never
//      to a literal (scripts/lib/relay-document.mjs). Its `toon_subscription`
//      says where a subscription to its live feed is paid (infra#53): held
//      to the same answer — the node's own subscribe address, terminated,
//      at the route's price — and to the RUNNING relay's env: the broadcast
//      price it sets, and the URL a subscriber dials (its published read
//      port, or its virtual one on the `.anyone` address when hidden).
//   3. EACH RELAY NODE, ON EACH CHAIN IT SETTLES ON, takes a PAID write from a
//      channel this script opens against it; its relay returns the event, and
//      the node's own book holds the voucher. On EVM the payer is a fresh
//      wallet with USDC and no ETH, depositing through the Onboarder; on
//      Solana it is the seeded buyer, the node sponsoring the open. A HIDDEN
//      node is paid over the circuit — packets, sponsor endpoint and chain RPC
//      all through the SOCKS proxy — from a wallet that pays its own EVM gas,
//      because the Onboarder is not published on the hidden service.
//   4. with both relay nodes, a write to the second is paid THROUGH the hub:
//      the second relay returns it, and its book on the hub's peering channel
//      moves by its own price.
//   5. every peering with both ends running is established on the chain the
//      two nodes share, collateralised, and routed at the hub.
//
// What it does NOT prove is the apps behind the other nodes — a stored blob, a
// spawned workload, a bundle of credentials. Those are `make smoke`,
// `smoke-payments` and `smoke-credentials`, against the profiles they name.
//
// Three operator-side checks reach a hidden node on its HOST ports (what it
// publishes, its relay's document, and its claim book): out-of-band reads no
// buyer makes. Every byte of the payment itself goes over the circuit.
//
// EXIT 75 (EX_TEMPFAIL), as `make smoke-hs`: a hidden node's step failed in
// the carriage — the REAL Anyone network did not carry — and not in this
// sandbox. Exit 1 is the sandbox.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { InMemoryChannelStore, ToonClient } from '@toon-protocol/client';
import { Contract, JsonRpcProvider, Wallet, HDNodeWallet } from 'ethers';

import { hostFetch, hostUrl } from './lib/sandbox-endpoints.mjs';
import { RELAY_DOCUMENT_ACCEPT, documentProblems, readEnv, subscriptionProblems } from './lib/relay-document.mjs';
import { NODES, PEERINGS } from './peerings.mjs';
import { peeringChain } from './lib/peering-plan.mjs';
import { NODE_KINDS, hiddenEndpoint, relayUrl } from './lib/topology.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
const RECORD = join(ROOT, 'conf', '.rendered', 'topology.json');
if (!existsSync(RECORD)) {
  console.error('no conf/.rendered/topology.json — `make up-topology NODES="…"` writes it, and this smoke asserts what it says.');
  process.exit(1);
}
const topology = JSON.parse(readFileSync(RECORD, 'utf8'));

const SOCKS_PROXY = process.env.TOON_SOCKS_PROXY ?? `socks5h://127.0.0.1:${process.env.ANON_SOCKS_PORT ?? 19050}`;
const ANVIL_URL = process.env.ANVIL_URL ?? 'http://localhost:8545';
const SOLANA_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const ONBOARDER_URL = process.env.ONBOARDER_URL ?? 'http://localhost:4022';
// anvil's own published test mnemonic. Public knowledge, local chain only.
const MNEMONIC = 'test test test test test test test test test test test junk';
// The FiatToken and its minter (anvil-mnemonic index 21), from scripts/seed-x402.sh.
const USDC = '0x0A867CA0442383c2A89951244B955AA19b615b58';
const MINTER_KEY = '0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b';
const DEPOSIT = 5_000_000n; // 5 USDC, above every node's 1 USDC Solana minimum
// The wallet that pays a HIDDEN node on EVM: anvil account 7, which anvil
// funds with ETH (it pays its own deposit gas) and nothing else here uses —
// 0 is `make smoke`'s buyer, 1-4 the publishers' and the handover's, 5 and 6
// smoke-hs's and smoke-m4's.
const HIDDEN_EVM_ACCOUNT = 7;
// How long a relay is given to publish what its connector says. A relay
// starts BEFORE its connector, so its first read of its connector fails and is
// retried five seconds later: a smoke run straight after `make up-topology`
// can arrive inside that window.
const DOCUMENT_WAIT_MS = 30_000;

let failures = 0;
let carriage = 0;
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docker = (...args) => execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edge = (node) => `http://localhost:${NODE_KINDS[node].port}`;
const bearer = (connector) => readFileSync(join(ROOT, 'keys', 'toon', connector, 'operator-bearer.token'), 'utf8').trim();
async function operatorRead(node, path) {
  const res = await fetch(`${edge(node)}${path}`, { headers: { authorization: `Bearer ${bearer(NODE_KINDS[node].connector)}` } });
  if (!res.ok) throw new Error(`${node} GET ${path} -> ${res.status}`);
  return res.json();
}
// A node's watermark on one channel, off its own `GET /claims` (the reading
// scripts/smoke-toon.mjs makes).
function watermark(rows, channelKey) {
  let top = 0n;
  for (const r of rows) {
    if (r.direction !== 'inbound' || String(r.channel_id).toLowerCase() !== channelKey.toLowerCase()) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > top) top = a;
  }
  return top;
}
const chainOf = (network) => (network?.startsWith('eip155:') ? 'evm' : 'solana');
const nodeOf = (connector) => Object.keys(NODE_KINDS).find((n) => NODE_KINDS[n].connector === connector);

// One event off a relay's free read port, by id.
function relayRead(ws, id) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(ws);
    const timer = setTimeout(() => { socket.close(); reject(new Error(`no EVENT from ${ws} in 15s`)); }, 15_000);
    socket.onopen = () => socket.send(JSON.stringify(['REQ', 'smoke', { ids: [id] }]));
    socket.onerror = (e) => { clearTimeout(timer); reject(new Error(`ws error: ${e.message ?? e}`)); };
    socket.onmessage = (m) => {
      const frame = JSON.parse(m.data);
      if (frame[0] === 'EVENT' && frame[1] === 'smoke') { clearTimeout(timer); socket.close(); resolve(frame[2]); }
      if (frame[0] === 'EOSE') { clearTimeout(timer); socket.close(); reject(new Error('EOSE with no EVENT')); }
    };
  });
}

const newEvent = (label) => finalizeEvent({
  kind: 30078,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['d', `toon-sandbox/smoke-topology/${label}`]],
  content: JSON.stringify({ unique: `${label}-${Date.now()}` }),
}, generateSecretKey());

const anvil = new JsonRpcProvider(ANVIL_URL, undefined, { staticNetwork: true });
async function mintUsdc(address, amount) {
  const usdc = new Contract(USDC, ['function mint(address to, uint256 amount) returns (bool)'], new Wallet(MINTER_KEY, anvil));
  await (await usdc.mint(address, amount)).wait();
}

// A client paying `node` on `chain`, the way that node is reached.
async function payer(node, chain) {
  const hidden = topology.hidden[node];
  const common = { chain, channelStore: new InMemoryChannelStore(), deposit: DEPOSIT, timeoutMs: hidden ? 180_000 : 60_000 };
  if (!hidden) {
    if (chain === 'solana') {
      return ToonClient.create({ ...common, connector: edge(node), mnemonic: MNEMONIC, rpcUrl: SOLANA_URL, fetch: hostFetch() });
    }
    // A fresh wallet, USDC and no ETH: the Onboarder the node names relays
    // its deposit and pays the gas.
    const wallet = Wallet.createRandom();
    await mintUsdc(wallet.address, 2n * DEPOSIT);
    return ToonClient.create({
      ...common, connector: edge(node), evmPrivateKey: wallet.privateKey, rpcUrl: ANVIL_URL,
      facilitatorUrl: ONBOARDER_URL, depositGas: 'facilitator', fetch: hostFetch(),
    });
  }
  // OVER THE CIRCUIT. The connector is the endpoint the node publishes and
  // the chain RPC is the same address's virtual port (conf/anonrc); `proxyRpc`
  // is left at its default, so the RPC rides the proxy with the packets.
  const origin = new URL(hidden).origin;
  const address = new URL(hidden).hostname;
  if (chain === 'solana') {
    return ToonClient.create({ ...common, connector: origin, socksProxy: SOCKS_PROXY, mnemonic: MNEMONIC, rpcUrl: `http://${address}:8899` });
  }
  const wallet = HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${HIDDEN_EVM_ACCOUNT}`);
  await mintUsdc(wallet.address, 2n * DEPOSIT);
  return ToonClient.create({
    ...common, connector: origin, socksProxy: SOCKS_PROXY, mnemonic: MNEMONIC, accountIndex: HIDDEN_EVM_ACCOUNT,
    rpcUrl: `http://${address}:8545`, depositGas: 'self', facilitatorUrl: '',
  });
}

// A failure on a hidden node's path that reads like the overlay, not like
// this sandbox (scripts/smoke-hs.mjs draws the same line, at more length).
const CARRIAGE = /socks|proxy|host unreachable|hostunreachable|econnrefused|etimedout|timed ?out|timeout|econnreset|socket hang up|fetch failed|und_err|circuit|http 5/i;
function failed(node, what, error) {
  const message = `${error?.message ?? error}${error?.cause ? ` (cause: ${error.cause?.message ?? error.cause})` : ''}`;
  if (topology.hidden[node] && CARRIAGE.test(message)) carriage += 1;
  bad(`${what}: ${message}`);
}

console.log(`topology: ${topology.nodes.join(' + ')}, settling on ${topology.chains.join(' and ')}${Object.keys(topology.hidden).length > 0 ? `, ${Object.keys(topology.hidden).join(' and ')} hidden at ${topology.address}` : ''}`);

// ── 0. only the selection runs ───────────────────────────────────────────
step('0. only the selected containers run');
{
  const env = { ...process.env, COMPOSE_PROFILES: topology.profiles.join(',') };
  const wanted = execFileSync('docker', ['compose', 'config', '--services'], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
  const have = docker('compose', '--profile', '*', 'ps', '-a', '--services').split('\n').filter(Boolean);
  const extra = have.filter((s) => !wanted.includes(s));
  const missing = wanted.filter((s) => !have.includes(s));
  assert(extra.length === 0, `no container outside the selection${extra.length > 0 ? ` — but ${extra.join(', ')}` : ''} (${have.length} services)`);
  assert(missing.length === 0, `every selected service has a container${missing.length > 0 ? ` — but not ${missing.join(', ')}` : ''}`);
}

// ── 1. what each node publishes ──────────────────────────────────────────
step('1. every node publishes x402 terms on exactly its chains, at the endpoint it should');
const described = {};
for (const node of topology.nodes) {
  const kind = NODE_KINDS[node];
  try {
    const desc = await fetch(`${edge(node)}/ilp`).then((res) => res.json());
    described[node] = desc;
    const chains = [...new Set((desc.batchSettlements ?? []).map((b) => chainOf(b.network)))].sort();
    assert(chains.join() === [...topology.chainsOf[node]].sort().join(),
      `${node} settles on ${chains.join(' + ') || 'nothing'} (selected: ${topology.chainsOf[node].join(' + ')})`);
    const expected = topology.hidden[node] ?? NODES[kind.connector].url;
    assert(desc.httpEndpoint === expected, `${node} publishes ${desc.httpEndpoint}${desc.httpEndpoint === expected ? '' : `, not ${expected}`}`);
  } catch (e) {
    bad(`${node} did not answer GET ${edge(node)}/ilp: ${e.message}`);
  }
}
for (const [node, endpoint] of Object.entries(topology.hidden)) {
  assert(endpoint === hiddenEndpoint(topology.address, NODE_KINDS[node].hsPort), `${node}'s hidden endpoint is its virtual port ${NODE_KINDS[node].hsPort} on ${topology.address}`);
}

// ── 2. each relay node's information document ────────────────────────────
const relays = topology.nodes.filter((node) => NODE_KINDS[node].relay);
if (relays.length > 0) step('2. each relay node’s information document says where a write and a subscription are paid, as its connector does');
// The env the relay RUNS with — a hidden one reads a rendered copy — and not
// the committed file.
function runningEnv(service) {
  const id = docker('compose', '--profile', '*', 'ps', '-q', service).split('\n')[0];
  if (!id) throw new Error(`no ${service} container`);
  return readEnv(JSON.parse(docker('inspect', '-f', '{{json .Config.Env}}', id)).join('\n'));
}
// One reading: the relay's document, and the self-description of the
// connector it names — which has to be the node's own, at the endpoint that
// connector publishes — read where the document sends a client: for a compose
// name, the host port the sandbox publishes it on. A hidden node's `.anyone`
// endpoint is not rewritten; its connector is read on its host port, as in
// step 1.
async function readDocument(node, env) {
  const { address, subscribe, readPort } = NODE_KINDS[node].relay;
  let document;
  try {
    const res = await fetch(`http://localhost:${readPort}/`, { headers: { accept: RELAY_DOCUMENT_ACCEPT } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    document = await res.json();
  } catch (e) {
    return { problems: [`its relay serves no information document at http://localhost:${readPort}/ (Accept: ${RELAY_DOCUMENT_ACCEPT}) — ${e.message}`] };
  }
  const toon = document?.toon;
  const feed = { address: subscribe, broadcastPrice: env.TOON_BROADCAST_PRICE };
  // With no `toon` there is no connector to hold `toon_subscription` to: a
  // relay publishes one only with the other, so only its absence is said.
  if (typeof toon !== 'object' || toon === null) {
    return { problems: [...documentProblems(document, undefined, address), ...(document?.toon_subscription ? [] : subscriptionProblems(document, undefined, feed))] };
  }
  const own = topology.hidden[node] ?? NODES[NODE_KINDS[node].connector].url;
  if (toon.connector_url !== own) return { problems: [`its document sends a write to the connector ${toon.connector_url}, not to its own at ${own}`] };
  const at = topology.hidden[node] ? `${edge(node)}/ilp` : hostUrl(toon.connector_url);
  try {
    const res = await fetch(at);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const description = await res.json();
    return {
      toon,
      subscription: document.toon_subscription,
      problems: [...documentProblems(document, description, address), ...subscriptionProblems(document, description, feed)],
    };
  } catch (e) {
    return { problems: [`its document names the connector ${toon.connector_url}, which does not answer the host at ${at} — ${e.message}`] };
  }
}
const published = {};
for (const node of relays) {
  const { readPort } = NODE_KINDS[node].relay;
  let env;
  try {
    env = runningEnv(node);
  } catch (e) {
    bad(`${node}: its relay's env cannot be read — ${e.message}`);
    continue;
  }
  const dialled = relayUrl(node, topology.hidden[node] ? topology.address : undefined);
  assert(env.TOON_RELAY_URL === dialled,
    `${node}: its relay is told TOON_RELAY_URL=${env.TOON_RELAY_URL}, the URL a subscriber dials (${dialled})${env.TOON_RELAY_URL === dialled ? '' : ' — a relay told another host refuses every NIP-98 and NIP-42 a subscriber signs'}`);
  const deadline = Date.now() + DOCUMENT_WAIT_MS;
  let reading;
  for (;;) {
    reading = await readDocument(node, env);
    if (reading.problems.length === 0 || Date.now() >= deadline) break;
    await sleep(2000);
  }
  if (reading.problems.length > 0) {
    for (const problem of reading.problems) bad(`${node}: ${problem}`);
    continue;
  }
  const { toon, subscription } = reading;
  published[node] = toon;
  ok(`${node}: its relay (:${readPort}) says a write is paid at ${toon.ilp_address}, ${toon.price} per write, sealed to ${toon.connector_seal_key.slice(0, 18)}… — address, price, seal key and settlement as its connector describes them`);
  ok(`${node}: it is paid at ${toon.connector_url}, ${topology.hidden[node] ? 'its .anyone endpoint' : `its own connector, which the host reaches at ${hostUrl(toon.connector_url)}`}`);
  ok(`${node}: its relay sells its live feed at ${subscription.ilp_address}, ${subscription.price} per subscribe packet and ${subscription.broadcast_price} per live event — the route and price its connector terminates, the broadcast price its env sets`);
  const chains = [...new Set(toon.settlement.map((s) => chainOf(s.network)))].sort();
  assert(chains.join() === [...topology.chainsOf[node]].sort().join(),
    `${node}: it lists settlement on ${chains.join(' + ') || 'nothing'} (selected: ${topology.chainsOf[node].join(' + ')})`);
}
if (Object.keys(published).length === 2) {
  const [a, b] = Object.values(published);
  assert(a.ilp_address !== b.ilp_address && a.connector_url !== b.connector_url && a.connector_seal_key !== b.connector_seal_key,
    `the two relay nodes name different addresses, connectors and seal keys: ${a.ilp_address} at ${a.connector_url}, ${b.ilp_address} at ${b.connector_url}`);
}

// ── 3. each relay node, on each chain ────────────────────────────────────
if (relays.length > 0) step('3. each relay node takes a paid write on each chain it settles on');
let hubClient;
for (const node of relays) {
  const { address, readPort } = NODE_KINDS[node].relay;
  for (const chain of topology.chainsOf[node]) {
    const how = topology.hidden[node] ? 'over the circuit' : chain === 'evm' ? 'gasless, through the Onboarder' : 'sponsored by the node';
    let client;
    try {
      client = await payer(node, chain);
      const opened = (await client.channel.open()).channel;
      const key = `${chain}:${opened.channelId}`;
      const before = watermark(await operatorRead(node, '/claims'), key);
      const price = await client.price(address);
      const event = newEvent(`${node}-${chain}`);
      const written = await client.send(address, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }) });
      assert(written.fulfilled === true && written.status === 200,
        `${node} on ${chain}: a write to ${address} from channel ${opened.channelId} (${how}) is fulfilled${written.fulfilled ? '' : ` — ${written.code} from ${written.refusedBy}: ${written.message}`}`);
      const read = await relayRead(`ws://localhost:${readPort}`, event.id).catch((e) => { bad(`the relay behind ${node}: ${e.message}`); return null; });
      if (read) assert(read.id === event.id && read.sig === event.sig, `the relay behind ${node} (:${readPort}) returns the event`);
      let after = before;
      for (let i = 0; i < 20 && after - before < price; i++) {
        await sleep(500);
        after = watermark(await operatorRead(node, '/claims'), key);
      }
      assert(price !== null && after - before === price, `${node}'s book on that channel rose by its price, ${price} (${before} -> ${after})`);
      // The hub's first client is kept for step 4.
      if (node === 'relay' && !hubClient) { hubClient = client; client = undefined; }
    } catch (e) {
      failed(node, `${node} on ${chain}`, e);
    } finally {
      await client?.close?.().catch(() => {});
    }
  }
}

// ── 4. the second relay, through the hub ─────────────────────────────────
const TO_RELAY2 = PEERINGS.find((p) => p.id === 'relay-relay2');
if (relays.length === 2 && hubClient) {
  step('4. a write to the second relay is paid through the hub');
  try {
    const { address, readPort } = NODE_KINDS.relay2.relay;
    const hubKey = described.relay2?.batchSettlements?.map((b) => b.payTo.toLowerCase()) ?? [];
    const channel = (await operatorRead('relay', '/channels'))
      .find((row) => row.direction === 'outbound' && row.status === 'open' && hubKey.includes(String(row.counterparty).toLowerCase()));
    if (!channel) throw new Error('the hub lists no open outbound channel toward relay2');
    const key = `${channel.chain}:${channel.id}`;
    const before = watermark(await operatorRead('relay2', '/claims'), key);
    const price = await hubClient.price(address);
    const hubPrice = BigInt(TO_RELAY2.routes.find((r) => r.prefix === address).price);
    assert(price === hubPrice, `the hub prices ${address} at ${hubPrice}: relay2's own price and the hop's fee (${price})`);
    const event = newEvent('relay2-via-hub');
    // Sealed to the node that TERMINATES the route — no hop may name that key
    // on its behalf — by the key relay2 itself publishes.
    const sealTo = Uint8Array.from(Buffer.from(described.relay2.edgeIdentity.publicKey.replace(/^0x/, ''), 'hex'));
    const written = await hubClient.send(address, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }) }, { sealTo });
    assert(written.fulfilled === true && written.status === 200,
      `a write to ${address} paid at the hub, sealed to relay2, is fulfilled${written.fulfilled ? '' : ` — ${written.code} from ${written.refusedBy}: ${written.message}`}`);
    const read = await relayRead(`ws://localhost:${readPort}`, event.id).catch((e) => { bad(`the second relay: ${e.message}`); return null; });
    if (read) assert(read.id === event.id, `the SECOND relay (:${readPort}) returns it`);
    const own = hubPrice - BigInt(TO_RELAY2.fee);
    let after = before;
    for (let i = 0; i < 20 && after - before < own; i++) {
      await sleep(500);
      after = watermark(await operatorRead('relay2', '/claims'), key);
    }
    assert(after - before === own, `relay2's book on the hub's ${channel.chain} peering channel rose by ${own} (${before} -> ${after})`);
  } catch (e) {
    failed('relay', 'through the hub', e);
  }
}
await hubClient?.close?.().catch(() => {});

// ── 5. the peerings ──────────────────────────────────────────────────────
const peerings = PEERINGS.filter((p) => topology.nodes.includes(nodeOf(p.payer)) && topology.nodes.includes(nodeOf(p.payee)));
if (peerings.length > 0) step('5. every peering with both ends running is open, collateralised and routed');
for (const peering of peerings) {
  const payer = nodeOf(peering.payer);
  const payee = nodeOf(peering.payee);
  try {
    const chain = peeringChain(peering, new Set(topology.chainsOf[payer]), new Set(topology.chainsOf[payee]));
    const known = (await operatorRead(payer, '/peers')).some((p) => p.id === peering.id);
    assert(known, `${peering.id}: ${payer} holds the peering`);
    const payeeKeys = (described[payee]?.batchSettlements ?? []).filter((b) => chainOf(b.network) === chain).map((b) => b.payTo.toLowerCase());
    const channel = (await operatorRead(payer, '/channels'))
      .find((row) => row.direction === 'outbound' && row.status === 'open' && row.chain === chain && payeeKeys.includes(String(row.counterparty).toLowerCase()));
    assert(channel && BigInt(channel.collateral ?? 0) > 0n,
      `${peering.id}: ${payer} pays ${payee} from an open ${chain} channel${channel ? ` holding ${channel.collateral}` : ''}`);
    const routes = await operatorRead(payer, '/routes/peers');
    const missing = peering.routes.filter((r) => !routes.some((row) => row.prefix === r.prefix && row.peer_id === peering.id));
    assert(missing.length === 0, `${peering.id}: ${payer} routes ${peering.routes.length} prefix(es) over it${missing.length > 0 ? ` — but not ${missing.map((r) => r.prefix).join(', ')}` : ''}`);
  } catch (e) {
    bad(`${peering.id}: ${e.message}`);
  }
}

if (failures === 0) {
  console.log(`\n\x1b[32mTOPOLOGY SMOKE OK: ${topology.nodes.join(' + ')} on ${topology.chains.join(' and ')}, and nothing else.\x1b[0m`);
  process.exit(0);
}
if (carriage === failures) {
  console.error(`\nTOPOLOGY SMOKE: ${failures} check(s) failed, every one in the carriage to a hidden node — the Anyone network did not carry (exit 75). Run it again before assuming a fault here.`);
  process.exit(75);
}
console.error(`\nTOPOLOGY SMOKE FAILED: ${failures} check(s).`);
process.exit(1);
