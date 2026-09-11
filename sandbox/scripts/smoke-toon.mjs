// TOON-layer smoke test: proves the payment layer + the three TOON apps in
// one run (run from sandbox/ on the host after `make up`; second half of
// `make smoke`).
//
// TOON_SMOKE_PAYMENTS_ONLY=1 (what `make smoke-payments` sets, after
// `make up-payments`) runs the PAYMENT LAYER HALF ONLY — steps 0, 0b, 1, 2 and
// a client-leg-only version of step 5. The store, the gas station and their
// two peering connectors are not running under the `payments` compose profile,
// so steps 3/3b/4/4b and the peer-leg book assertions are skipped rather than
// duplicated into a second script.
//
// TOON_SMOKE_CREDENTIALS_ONLY=1 (what `make smoke-credentials` sets, after
// `make up-credentials`) runs the payment layer PLUS the DENOMINATION
// BOUNDARY — steps 0, 0c, 0d, 0b, 1, 2, 4c, the hub/anytoon halves of step 5
// and all of step 6. And 0d is STRICT there, unlike under payments: the swap
// driver runs on that profile, so a stale ANYONE pair is a failure, not an
// allowance. The store, the gas station, their two peering connectors and the
// whole AR.IO/Turbo half are not running under `credentials`, so steps
// 3/3b/4/4b and the store/gas book assertions are skipped.
//
//   0. payment infrastructure is live:
//        - TokenNetworkRegistry has code on anvil (the forge deploy landed)
//        - payment_channel is an EXECUTABLE account on the validator
//        - all three connector edges answer GET /ilp
//   1. a real client (@toon-protocol/client — the proven payer from the
//      connector repo's local/anyone and the pokerogue devnet) opens a
//      SOLANA payment channel, in mock USDC, against the relay-connector hub
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
//   4c. the ANYONE CREDENTIALS ISSUER, the first app here that refuses to
//      serve at the APP layer (it blind-signs nothing without a signed
//      X-Payment-Claim): the epoch key document is FREE at the issuing node
//      with no channel at all; every escape off that free route toward the
//      issuer's root (`../bundles`, `/v1/bundles`, `%2e%2e/bundles`) is
//      refused by the CONNECTOR, so no free class exists over /v1/bundles;
//      an unpaid request to the paid route is refused; and one PAID request
//      routed hub -> peering -> anytoon buys a real bundle of blind
//      signatures. The price triple (route price, minter BUNDLE_PRICE,
//      issuer BUNDLE_PRICE) is re-derived from conf/anytoon.conf in step 0c
//      and asserted against what the nodes advertise.
//   4b. the EVM leg of the gas station (kind:5098): /describe advertises the
//      kind with chains ["evm:31337"]; a PAID quote returns the forwarder +
//      target + nonce; an UNFUNDED throwaway wallet EIP-712-signs an
//      ERC-2771 ForwardRequest, a PAID execute relays it, the relayer pays
//      the gas, and the probe target's recorded _msgSender() on anvil is the
//      CLIENT's address (the ERC-2771 property, read back on-chain)
//   5. the money is asserted from the connectors' own books, because a
//      packet's answer cannot tell you it was paid for — and PER SETTLEMENT
//      LEG, IN EACH LEG'S OWN UNIT, because this topology is CROSS-ASSET:
//        - the client leg settles mock USDC on a SOLANA payment_channel
//          account (the channel the buyer opens in step 1), 6 decimals
//        - the store and gas peerings settle mock USDC on SOLANA too, at
//          par: same token, same scale, nothing converted
//        - the anytoon peering settles ANYONE on an EVM channel on anvil,
//          18 decimals, and the hub CONVERTS onto it at a live Uniswap v3
//          TWAP. That leg is booked as a CLIENT claim at the anytoon node
//          rather than a peer claim — see conf/connector-anytoon.toml
//      So one number in this file is asserted EXACTLY (what the client paid
//      the hub: a static configured price) and one is asserted with the
//      inequality the design actually guarantees (what the hub paid the
//      anytoon node: at least the downstream price, plus whatever the FX
//      buffer left over).
//   6. the rate is LIVE, not merely floating: GET /rates is polled at the
//      top of the run and again at the bottom, and the ANYONE leg has to
//      have MOVED between them — a frozen TWAP would pass every other
//      assertion in this file.
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
// Set by `make smoke-payments` / `make smoke-credentials`; see the header.
// Everything they gate is an assertion about a service the profile does not
// run, never a payment-layer one.
const PAYMENTS_ONLY = /^(1|true|yes)$/i.test(process.env.TOON_SMOKE_PAYMENTS_ONLY ?? '');
const CREDENTIALS_ONLY = /^(1|true|yes)$/i.test(process.env.TOON_SMOKE_CREDENTIALS_ONLY ?? '');
if (PAYMENTS_ONLY && CREDENTIALS_ONLY) {
  console.error('TOON_SMOKE_PAYMENTS_ONLY and TOON_SMOKE_CREDENTIALS_ONLY are mutually exclusive — pick the one matching the profile you brought up.');
  process.exit(1);
}
// The one distinction that survives past the payments early-exit: does this
// run have the store, the gas station and the permaweb half behind them?
const STORE_GAS = !PAYMENTS_ONLY && !CREDENTIALS_ONLY;
const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
const STORE_EDGE = process.env.STORE_EDGE_URL ?? 'http://localhost:3210';
const GAS_EDGE = process.env.GAS_EDGE_URL ?? 'http://localhost:3220';
const ANYTOON_EDGE = process.env.ANYTOON_EDGE_URL ?? 'http://localhost:3230';
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
// The buyer's own Solana identity — SLIP-0010 m/44'/501'/0'/0' of the anvil
// mnemonic below, which is what ToonClient derives at index 0. Committed here
// AND in scripts/seed-toon-solana.mjs (which funds it), and asserted against
// what the client actually derives in step 1: if the library's derivation path
// ever moves, this fails by name instead of as an unfunded wallet.
const BUYER_SOL = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96';
// The two SOLANA peering channels (PDAs the committed connector tomls name;
// opened post-boot by the open-toon-solana-channels init job). The THIRD
// peering, relay-anytoon, settles ANYONE on anvil — see ANYONE_CHANNEL.
const SOLANA_CHANNELS = {
  'relay-store': { account: '4yUyXpi3c23g1sxGWWUpANVoGKzt8i4iMc2xjdC3njR7', peer: '8VQznfuCBp9aDTwdHaXYneqgfckmVezE1MXrNW8hhUMe' },
  'relay-gas': { account: '4oUEsaokTBie41Xtb7PDkeMK8vDoqvzeWecwk98Abc3T', peer: '5tci9czy3L2StZ6cNu3f85HcnnJqmHPYt8YSbGMWUE9q' },
};
const HUB_CHANNEL_DEPOSIT = 100_000_000n; // what the open job puts behind each Solana peering
// The relay-anytoon peering, on anvil, in ANYONE. keccak256(p1, p2, epoch 0)
// with the participants sorted (ADR 0059); opened + collateralised by
// scripts/seed-toon-evm.sh. The connector books it `evm:<channel_id>`.
const ANYONE_CHANNEL = '0x94ab42f98c210488becb8fab3ccb790d8572fe91d1b50f93d70a30f02321f02f';
const HUB_EVM = '0x61097BA76cD906d2ba4FD106E757f7Eb455fc295';
const ANYTOON_EVM = '0x40Fc963A729c542424cD800349a7E4Ecc4896624';
const ANYONE_CHANNEL_DEPOSIT = 100_000_000_000_000_000_000n; // 100 ANYONE

// ── THE PRICES, re-derived from their single sources of truth ─────────────
// There used to be a PRICE TRIPLE here, checkable by one multiplication: the
// anytoon route price, the minter's BUNDLE_PRICE and the issuer's, all one
// number in one unit, with the hub's forwarded price a fourth site equal to
// the third plus a flat fee.
//
// THE CROSS-ASSET FLIP BROKE THE FOURTH SITE AND ONLY THE FOURTH. The anytoon
// node is paid in ANYONE on anvil and its three-way coupling is untouched —
// still one decimal in conf/anytoon.conf, still multiplied by 10^18, still
// asserted below against what that node ADVERTISES. What cannot be a committed
// derivation any more is the HUB's price: it charges its client uUSDC on a
// Solana channel and pays anytoon in ANYONE, converting at a live Uniswap v3
// TWAP that no file can know. So the hub quotes a STATIC price with an FX
// buffer, and what this test asserts about it is the inequality the design
// actually guarantees — read below, off GET /rates, at the live rate:
//
//     floor(hubPrice x liveRate) - peeringFee  >=  BUNDLE_PRICE x 10^18
//
// which is exactly the condition for a purchase to clear. It is checked at the
// top of the run and would fail the same way whether the rate moved, the
// spread changed, the fee changed or someone edited a price — which is the
// point of asserting the inequality rather than any one of its terms.
const ANYONE_DECIMALS = 18;
// conf/connector-relay.toml's relay-anytoon [[peers]] row. In ANYONE base
// units, because a fee is charged in the unit of the leg it buys carriage on,
// and this one buys carriage on an 18-decimal one. (The store and gas peerings
// still charge a flat 100 uUSDC; nothing here has to know that, because those
// legs are at par and their figures are asserted as they arrive.)
const ANYONE_PEER_FEE = 400_000_000_000_000n; // 0.0004 ANYONE
// conf/connector-relay.toml's two forwarded ANYONE routes, in uUSDC. Static,
// and deliberately generous: see that file for the headroom arithmetic.
const HUB_CREDENTIALS_PRICE = 11_000n;
const HUB_KEYS_PRICE = 110n;
// conf/connector-relay.toml [rate_guards]
const SPREAD_NUM = 30n, SPREAD_DEN = 10_000n;
function decimalToBaseUnits(decimal, decimals) {
  const [whole, frac = ''] = String(decimal).trim().split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) throw new Error(`not a decimal: ${decimal}`);
  if (frac.length > decimals) throw new Error(`${decimal} has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}
function confValue(file, key) {
  const conf = readFileSync(join(ROOT, 'conf', file), 'utf8');
  const m = conf.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'm'));
  if (!m) throw new Error(`conf/${file} has no ${key} line`);
  return m[1];
}
const BUNDLE_PRICE_DECIMAL = confValue('anytoon.conf', 'BUNDLE_PRICE');
const BUNDLE_PRICE_UNITS = decimalToBaseUnits(BUNDLE_PRICE_DECIMAL, ANYONE_DECIMALS);
// conf/amm-topology.conf — the same file the seed script and the swap driver
// build the market from, so the pools this test reasons about are the pools
// the connector quotes.
const AMM = Object.fromEntries(
  ['ANYONE_TOKEN', 'WETH_TOKEN', 'USDC_TOKEN', 'ANYONE_TOKEN_NETWORK', 'POOL_ANYONE_WETH',
   'POOL_WETH_USDC', 'SANDBOX_AMM', 'TWAP_WINDOW_SECS', 'OBSERVATION_CARDINALITY',
   'ANYONE_TARGET_TICK', 'ANYONE_BAND_TICKS', 'SWAP_INTERVAL_SECS']
    .map((k) => [k, confValue('amm-topology.conf', k)]),
);
// GET /rates spells every asset lowercased and chain-namespaced.
const ASSET_ANYONE = `evm:${AMM.ANYONE_TOKEN.toLowerCase()}`;
const ASSET_USDC_EVM = `evm:${AMM.USDC_TOKEN.toLowerCase()}`;
const ASSET_USDC_SOL = `solana:${USDC_MINT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
let failures = 0;
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const fatal = (msg) => { console.error(`\nTOON SMOKE FAILED: ${msg}`); process.exit(1); };

const bearer = (node) => readFileSync(join(ROOT, 'keys', 'toon', node, 'operator-bearer.token'), 'utf8').trim();
const edgeOf = {
  'relay-connector': HUB, 'store-connector': STORE_EDGE,
  'gas-connector': GAS_EDGE, 'anytoon-connector': ANYTOON_EDGE,
};
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
// The anytoon node's takings from the hub, which land in its CLIENT book
// rather than its peer book: it declares that channel in [[client_channels]]
// so the delivery carries an X-TOON-Payer for the claim minter (see
// conf/connector-anytoon.toml's header for why that is forced). The client
// book chain-namespaces its channel ids; the peer book does not — and that
// namespace is now the assertion, because this leg moved to EVM: the figures
// on it are ANYONE base units, not uUSDC.
function clientBookOnChannel(rows, channelKey) {
  let top = 0n;
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    if (String(r.channel_id).toLowerCase() !== channelKey.toLowerCase()) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > top) top = a;
  }
  return top;
}

// ── the hub's rate table, as the hub itself reports it ────────────────────
// GET /rates (bearer-gated, ADR 0071 / connector#1297) is the only surface in
// the connector that MOVES with a live rate. GET /ilp does not and structurally
// cannot: a route price is config, read straight out of the route table with
// the rate table never consulted. So every floating assertion in this file goes
// through here.
//
// Rows are ORDERED PAIRS, and only DECLARED ones: the static
// solana-USDC -> evm-USDC row and the quoted ANYONE -> numeraire row. The pair
// the packets actually convert, solana-USDC -> ANYONE, is COMPOSED at lookup
// and appears nowhere — a composition is derived, and a refusal is not. So this
// test composes it the same way the connector does (crates/connector-domain
// rate_table.rs `lookup`): the `to` leg is read BACKWARDS and the spread is
// applied ONCE, on top, from the composed pair's own guards.
async function rates(node = 'relay-connector') {
  const res = await fetch(`${edgeOf[node]}/rates`, { headers: { authorization: `Bearer ${bearer(node)}` } });
  if (!res.ok) throw new Error(`${node} GET /rates -> ${res.status}`);
  return res.json();
}
// Both sides lowercased: the connector canonicalises EVM addresses to lower
// case but leaves base58 Solana mints alone (base58 is case-SIGNIFICANT), so a
// one-sided comparison silently misses the Solana row.
const rateRow = (rows, from, to) =>
  rows.find((r) => String(r.from).toLowerCase() === from.toLowerCase()
    && String(r.to).toLowerCase() === to.toLowerCase());
// The rate the hub would actually deal `solana USDC -> ANYONE` at right now, as
// an exact fraction: (par leg) x (ANYONE leg inverted) x (1 - spread).
function dealtUsdcToAnyone(rows) {
  const par = rateRow(rows, ASSET_USDC_SOL, ASSET_USDC_EVM);
  const anyone = rateRow(rows, ASSET_ANYONE, ASSET_USDC_EVM);
  if (!par?.rate || !anyone?.rate) return null;
  // par: uUSDC(solana) -> uUSDC(evm);  anyone: ANYONE base -> uUSDC, so inverted
  const num = BigInt(par.rate.numerator) * BigInt(anyone.rate.denominator) * (SPREAD_DEN - SPREAD_NUM);
  const den = BigInt(par.rate.denominator) * BigInt(anyone.rate.numerator) * SPREAD_DEN;
  return { num, den, anyone, par };
}
// What `floor(amount x rate) - fee` would forward onto the ANYONE peering.
const forwardedAnyone = (uusdc, r) => (uusdc * r.num) / r.den - ANYONE_PEER_FEE;

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
const advertised = {}; // node -> { prefix: BigInt(price) }, from each node's own GET /ilp
const EDGES = PAYMENTS_ONLY
  ? [['relay-connector (hub)', HUB]] // the peer edges are not running
  : CREDENTIALS_ONLY
    ? [['relay-connector (hub)', HUB], ['anytoon-connector', ANYTOON_EDGE]] // the store/gas edges are not running
    : [['relay-connector (hub)', HUB], ['store-connector', STORE_EDGE], ['gas-connector', GAS_EDGE], ['anytoon-connector', ANYTOON_EDGE]];
for (const [name, url] of EDGES) {
  const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
  if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  const routes = (desc.routes ?? []).map((r) => `${r.prefix}@${JSON.stringify(r.price)}`).join(', ');
  advertised[name] = Object.fromEntries((desc.routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
  ok(`${name}: ${desc.ilpAddresses?.join(',') ?? '(no addresses)'} — routes: ${routes}`);
}

// ── 0c. the price of a bundle, on both sides of the boundary ─────────────
// Two assertions of two different KINDS, and the difference between them is
// the whole of what the cross-asset flip changed.
//
// (i)  THE ANYTOON EDGE IS EXACT. The issuer verifies the amount inside the
//      minter's signed claim against its own BUNDLE_PRICE; both read
//      conf/anytoon.conf, so those two are one number, and the connector's
//      route price is that number in ANYONE base units. Nothing enforces the
//      multiplication, so it is asserted here against what the node SERVES.
// (ii) THE HUB'S PRICE IS AN INEQUALITY. It is quoted in the client's money
//      for a route priced in someone else's, at a rate neither file knows. So
//      what is checked is that the hub's static quote STILL COVERS the live
//      market — computed from the hub's own GET /rates exactly as the
//      forwarding path would compute it.
if (!PAYMENTS_ONLY) {
  step('0c. the bundle price: exact at the anytoon edge, sufficient at the hub');
  console.log(`  conf/anytoon.conf: BUNDLE_PRICE=${BUNDLE_PRICE_DECIMAL} -> ${BUNDLE_PRICE_UNITS} base units at ${ANYONE_DECIMALS}dp (ANYONE)`);
  assert(advertised['anytoon-connector']?.['g.anyone.credentials'] === BUNDLE_PRICE_UNITS,
    `anytoon-connector prices g.anyone.credentials at ${advertised['anytoon-connector']?.['g.anyone.credentials']} = BUNDLE_PRICE x 10^${ANYONE_DECIMALS} (${BUNDLE_PRICE_UNITS})`);
  assert(advertised['anytoon-connector']?.['g.anyone.credentials.keys'] === 0n,
    'anytoon-connector prices the key document at 0 — free at the issuing node');
  assert(advertised['relay-connector (hub)']?.['g.anyone.credentials'] === HUB_CREDENTIALS_PRICE,
    `the hub quotes g.anyone.credentials at ${advertised['relay-connector (hub)']?.['g.anyone.credentials']} uUSDC — a STATIC price in the client's own money (${HUB_CREDENTIALS_PRICE})`);
  assert(advertised['relay-connector (hub)']?.['g.anyone.credentials.keys'] === HUB_KEYS_PRICE,
    `the hub quotes the key document at ${advertised['relay-connector (hub)']?.['g.anyone.credentials.keys']} uUSDC (not 0: a hub that charged nothing would still subtract its ANYONE fee and R01 every request)`);
}

// ── 0d. the rate is LIVE, and the hub's quote covers it ──────────────────
// The first of two polls; step 6 takes the second and requires movement
// between them. Everything here reads the hub's own rate table, which is the
// table the forwarding path converts against — not a second opinion about it.
//
// Runs under the payments profile too, WITH ONE ALLOWANCE. The pools exist
// there (anvil builds them either way — the hub cannot resolve its own ANYONE
// TokenNetwork otherwise) but the swap driver does not, so nothing is trading
// and nothing is mining: two minutes into a payments run the head block stops
// advancing and the pair ages past ttl_secs. That is the correct behaviour and
// the profile's own choice, so a STALE ANYONE pair is tolerated there — but
// only after it has been observed at least once, which is the half of the
// quote path that can actually be broken by a bad pool or a short window.
// The `credentials` profile runs the driver and gets NO allowance: stale is a
// failure there, exactly as under `full` — a purchase would refuse T00.
step('0d. the hub prices ANYONE off a LIVE Uniswap v3 TWAP');
let ratesBefore = [];
let dealtBefore = null;
try {
  ratesBefore = await rates();
  console.log(`  GET /rates: ${ratesBefore.map((r) => `${r.from} -> ${r.to} ${r.state}`).join(' | ')}`);
  const par = rateRow(ratesBefore, ASSET_USDC_SOL, ASSET_USDC_EVM);
  const anyone = rateRow(ratesBefore, ASSET_ANYONE, ASSET_USDC_EVM);
  assert(par?.state === 'live' && par.last_refreshed === null,
    `the two mock USDCs are declared at par (${par?.rate?.numerator}/${par?.rate?.denominator}); a static row carries no last_refreshed and never goes stale`);
  assert(typeof anyone?.last_refreshed === 'string',
    `ANYONE is OBSERVED, not declared: last_refreshed=${anyone?.last_refreshed} (a null there would mean someone typed the rate in)`);
  assert(anyone?.refused_refresh == null,
    'no refresh has been refused by the max_move guard — the swap driver is the only thing trading');
  assert(anyone?.state === 'live' || PAYMENTS_ONLY,
    `the ANYONE pair is live (state=${anyone?.state})`);
  dealtBefore = dealtUsdcToAnyone(ratesBefore);
  if (dealtBefore === null && PAYMENTS_ONLY) {
    ok(`the ANYONE pair is ${anyone?.state} — expected under the payments profile, which runs no swap driver:`
      + ' with nothing trading there are no new blocks, so the observation ages past ttl_secs.'
      + ' Nothing on this profile\'s path converts.');
  } else if (dealtBefore === null) {
    bad('the hub cannot price solana-USDC -> ANYONE: one of the two legs is missing from GET /rates');
  } else {
    // The composed pair is not on /rates; this is it, computed the way the
    // connector computes it. Report it as a human price too.
    const usdcPerAnyone = Number(BigInt(dealtBefore.anyone.rate.numerator) * 10n ** 18n
      / BigInt(dealtBefore.anyone.rate.denominator)) / 1e6;
    console.log(`  composed+spread: 1 uUSDC buys ${Number(dealtBefore.num) / Number(dealtBefore.den)} ANYONE base units`
      + ` (1 ANYONE = ${usdcPerAnyone.toFixed(6)} USDC at the mid)`);
    // THE ASSERTION THE WHOLE PRICING MODEL RESTS ON.
    const wouldForward = forwardedAnyone(HUB_CREDENTIALS_PRICE, dealtBefore);
    assert(wouldForward >= BUNDLE_PRICE_UNITS,
      `the hub's static ${HUB_CREDENTIALS_PRICE} uUSDC still covers the live market:`
      + ` floor(${HUB_CREDENTIALS_PRICE} x rate) - fee ${ANYONE_PEER_FEE} = ${wouldForward} >= ${BUNDLE_PRICE_UNITS}`
      + ` (${(Number(wouldForward - BUNDLE_PRICE_UNITS) / Number(BUNDLE_PRICE_UNITS) * 100).toFixed(2)}% of FX buffer left)`);
    assert(forwardedAnyone(HUB_KEYS_PRICE, dealtBefore) > 0n,
      `and the free key document's ${HUB_KEYS_PRICE} uUSDC still clears the fee (forwards ${forwardedAnyone(HUB_KEYS_PRICE, dealtBefore)} > 0)`);
    // The cap and the ceiling, from the same number rather than from a probe:
    // a client cannot overpay a forwarded route (the edge refuses F03 above
    // `price`), so the only packet that can reach this peering is the priced
    // one, and this is what it weighs in the outgoing unit.
    assert(wouldForward + ANYONE_PEER_FEE <= 1_000_000_000_000_000_000n,
      `the converted packet (${wouldForward + ANYONE_PEER_FEE}) is inside the peering's declared max_packet_amount of 1e18 ANYONE base units — the default 1000000 would have refused it T04`);
    assert(wouldForward + ANYONE_PEER_FEE < 2n ** 64n,
      'and inside the outgoing leg\'s u64 ceiling (~18.4 ANYONE on an 18-decimal leg, ADR 0071)');
  }
} catch (e) {
  bad(`GET /rates on the hub failed: ${e.message}`);
}

// ── 0b. the SOLANA peering channels are live on chain ────────────────────
// Opened post-boot by the open-toon-solana-channels init job (through the
// hub's operator surface — the only possible InitializeChannel submitter),
// so poll briefly: `make up` returns before the job finishes. Then assert
// the program's own account layout: participants, mint, Opened, and the
// hub's collateral behind its claims. This is the on-chain half of the
// "peer legs settle on Solana" proof; the claim books below are the other.
// Asserted under the `payments` profile too: the hub is the sole submitter and
// signs against the peers' committed PUBLIC keys, so the accounts land whether
// or not the counterparty connectors are running.
step('0b. the peering channels are open and collateralised — two on SOLANA, one on ANVIL');
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

// The third peering, on the other chain and in the other token. Same claim as
// the Solana ones make: a peer claim's verdict never reads the chain, so a
// topology whose channel was never opened rehearses exactly as green as one
// whose channel is real. Read the ANYONE TokenNetwork's own storage instead.
{
  const provider = new JsonRpcProvider(ANVIL_URL);
  try {
    const tn = new EthersContract(AMM.ANYONE_TOKEN_NETWORK, [
      'function token() view returns (address)',
      'function channels(bytes32) view returns (uint256 settlementTimeout, uint8 state, uint256 closedAt, uint256 openedAt, address participant1, address participant2)',
      'function participants(bytes32,address) view returns (uint256 deposit, uint256 nonce, uint256 transferredAmount)',
    ], provider);
    const [token, ch, hubSide] = await Promise.all([
      tn.token(), tn.channels(ANYONE_CHANNEL), tn.participants(ANYONE_CHANNEL, HUB_EVM),
    ]);
    assert(token.toLowerCase() === AMM.ANYONE_TOKEN.toLowerCase(),
      `relay-anytoon: the TokenNetwork at ${AMM.ANYONE_TOKEN_NETWORK} settles ANYONE (${token}) — a different contract from the mock-USDC one, because a TokenNetwork is per token`);
    assert(Number(ch.state) === 1, `relay-anytoon: channel ${ANYONE_CHANNEL} is Opened (state ${ch.state})`);
    const parts = [ch.participant1, ch.participant2].map((a) => a.toLowerCase()).sort();
    assert(parts.join() === [HUB_EVM, ANYTOON_EVM].map((a) => a.toLowerCase()).sort().join(),
      `relay-anytoon: participants are the hub and the anytoon node (${parts.join(', ')})`);
    assert(hubSide.deposit >= ANYONE_CHANNEL_DEPOSIT,
      `relay-anytoon: the hub's own side holds ${hubSide.deposit} base units of ANYONE behind its claims (>= ${ANYONE_CHANNEL_DEPOSIT})`);
  } catch (e) {
    bad(`relay-anytoon: could not read the ANYONE channel on anvil: ${e.message}`);
  } finally {
    provider.destroy();
  }
}

// ── 1. a channel against the hub ─────────────────────────────────────────
// THE BUYER PAYS USDC ON SOLANA. It used to pay on anvil, and the one line
// that moved it is `chain: 'solana'` — the client picks its settlement out of
// the node's own GET /ilp `settlements[]` by chain and signs an ed25519
// balance proof over the ADR 0053 message instead of an EIP-712 one. The move
// was forced rather than chosen: the hub's `[settlement.evm]` token is ANYONE
// now, and one token per chain per node means an EVM client channel against
// this hub is an ANYONE channel. USDC on Solana is the only place the buyer's
// money can be.
step('1. a mock-USDC payment channel ON SOLANA against the hub');
// NOT under data/ — that tree is created root-owned by docker bind mounts.
// .toon-client/ is host-owned, gitignored, wiped by `make clean` (its channel
// watermark MUST die with the chain: a stale one refuses every later claim).
mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
const client = await ToonClient.create({
  connector: HUB,
  mnemonic: MNEMONIC,
  chain: 'solana',
  rpcUrl: RPC_URL,
  channelStore: join(ROOT, '.toon-client', 'channels.json'),
  deposit: 10_000_000n, // 10 USDC — plenty against ~1100/packet prices
  timeoutMs: 60_000,
});
// The client derives this from the mnemonic; scripts/seed-toon-solana.mjs
// funded it from a committed copy of the same string. If the library's
// derivation path ever moves, the failure is HERE and says so, rather than a
// ChannelFundingError about a wallet nobody can find.
assert(client.identity?.solanaPublicKey === BUYER_SOL,
  `the buyer is ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded (${BUYER_SOL})`);
const opened = await client.channel.open({ deposit: 10_000_000n });
ok(`channel ${opened.channelId ?? '(id unreported)'} status=${opened.status ?? 'open'}`);

const hubBefore = clientBookTotal(await claims('relay-connector'));
const storeBefore = STORE_GAS
  ? peerBookTotal(await claims('store-connector'), SOLANA_CHANNELS['relay-store'].account) : 0n;
const gasBefore = STORE_GAS
  ? peerBookTotal(await claims('gas-connector'), SOLANA_CHANNELS['relay-gas'].account) : 0n;
const anytoonBefore = PAYMENTS_ONLY ? 0n
  : clientBookOnChannel(await claims('anytoon-connector'), `evm:${ANYONE_CHANNEL}`);
console.log(`  books before: hub client=${hubBefore}`
  + (STORE_GAS ? `, store peer=${storeBefore}, gas peer=${gasBefore}` : '')
  + (PAYMENTS_ONLY ? '' : `, anytoon client=${anytoonBefore}`));

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

// ── the `payments` profile ends here ─────────────────────────────────────
// Everything below needs at least one peer with somebody behind it, and the
// `payments` profile runs none. The money is still asserted, on the one leg
// that profile has: the client's Solana channel against the hub. g.toon.relay
// is priced at 1 base unit (conf/connector-relay.toml), so one paid write is
// exactly +1 on the hub's client book — small, but it is a real signed claim
// on the channel opened in step 1, which is the whole point.
if (PAYMENTS_ONLY) {
  step('5. the hub’s own book says the write was PAID — client leg, on SOLANA');
  let rows = [];
  let hubNow = hubBefore;
  for (let i = 0; i < 20 && hubNow - hubBefore < 1n; i++) {
    await sleep(500);
    rows = await claims('relay-connector');
    hubNow = clientBookTotal(rows);
  }
  assert(hubNow - hubBefore >= 1n,
    `hub client book advanced by ${hubNow - hubBefore} (>= 1, the paid relay write)`);
  const payChannels = [...new Set(rows.filter((r) => r.book === 'client' && r.direction === 'inbound').map((r) => r.channel_id))];
  assert(payChannels.length > 0 && payChannels.every((c) => /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c)),
    `client leg settles on SOLANA: hub client-book channels ${payChannels.join(', ')} are payment_channel accounts, not anvil ids`);
  assert(payChannels.some((c) => c === `solana:${opened.channelId}`),
    `and include the channel the client opened in step 1 (${opened.channelId})`);
  console.log(failures === 0
    ? '\n\x1b[32mTOON PAYMENTS SMOKE OK: contracts + payment_channel live, the ANYONE asset layer deployed and quoting a live TWAP, the hub’s two Solana peering channels and its ANYONE channel on anvil open and collateralised, a Solana USDC channel opened against the hub, a paid write routed through it and journaled as a claim on that channel.\x1b[0m'
    : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── the `credentials` profile skips the permaweb half ────────────────────
// Steps 3/3b/4/4b drive the store and the gas station over their peerings;
// under the `credentials` compose profile neither app runs, nor its
// connector, nor the gateway/bundler stack the store uploads through. The
// boundary steps — 4c, the hub/anytoon halves of 5, and 6 — run on both.
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
}

// ── 4c. the Anyone credentials issuer: routed purchase + route scoping ───
// The first app in this sandbox that REFUSES TO SERVE at the app layer: the
// issuer blind-signs nothing without an Ed25519-signed X-Payment-Claim from
// the claim minter. Four properties, in order:
//   (i)   the key document is FREE at the issuing node — no channel, no claim
//   (ii)  the issuer ROOT is not reachable at price zero: the free route's
//         handler_url is scoped to /v1/keys/, so an escape off it is refused
//         by the CONNECTOR before the issuer is touched
//   (iii) an UNPAID request to the paid route is refused, not served
//   (iv)  a PAID request routed hub -> peering -> anytoon buys a real bundle
step('4c. Anyone credentials: free key document, scoped free route, unpaid refusal, PAID routed purchase');

// A second client with NO CHANNEL AT ALL, pointed straight at the anytoon
// node's own edge. It can only ever exercise free routes — which is exactly
// what makes (i) and (iii) mean something: nothing here can pay.
const freeClient = await ToonClient.create({
  connector: ANYTOON_EDGE,
  mnemonic: MNEMONIC,
  chain: 'evm',
  rpcUrl: ANVIL_URL,
  channelStore: join(ROOT, '.toon-client', 'anytoon-free.json'),
  deposit: 0n,
  timeoutMs: 30_000,
}).catch((e) => { bad(`could not create the channel-less anytoon client: ${e.message}`); return null; });

let epoch = null;
if (freeClient) {
  // (i) FREE: a price-0 route needs no claim, so a client that has never
  //     opened a channel still gets the epoch key. Charging for this would
  //     make the protocol undiscoverable — a buyer needs the key BEFORE it
  //     can blind anything.
  const keys = await freeClient.send('g.anyone.credentials.keys', { method: 'GET', target: 'current' });
  if (!keys.fulfilled) {
    bad(`the free key document was refused: ${keys.code} (refusedBy ${keys.refusedBy})`);
  } else {
    assert(keys.status === 200, `the key document served FREE with no channel and no claim (${keys.status})`);
    assert(keys.claim === undefined, 'and no payment claim was spent on it');
    const doc = keys.status === 200 ? keys.json() : null;
    epoch = doc?.epoch_id ?? null;
    assert(typeof epoch === 'string' && typeof doc?.pubkey === 'string',
      `the issuer published epoch ${epoch} (alg ${doc?.alg})`);
  }

  // (ii) THE SCOPING, which is the whole reason the free route points at
  //      /v1/keys/ and not at the issuer root. A target resolves BENEATH the
  //      handler path, so a root-scoped free route would put POST /v1/bundles
  //      at price zero. Every escape must die at the connector (F00), never
  //      reach the issuer, and cost nothing.
  for (const [label, target] of [
    ['a relative escape (../bundles)', '../bundles'],
    ['an absolute path (/v1/bundles)', '/v1/bundles'],
    ['a percent-encoded escape (%2e%2e/bundles)', '%2e%2e/bundles'],
  ]) {
    const escaped = await freeClient.send('g.anyone.credentials.keys', {
      method: 'POST', target, body: { epoch: epoch ?? '0', blinded_blanks: [] },
    });
    assert(escaped.fulfilled === false,
      `the issuer root is NOT free: ${label} off the free route is refused (${escaped.code ?? `fulfilled ${escaped.status}`})`);
  }

  // (iii) UNPAID on the PAID route: the channel-less client is greeted with a
  //       price, not served.
  const unpaid = await freeClient.send('g.anyone.credentials', {
    method: 'POST', target: 'v1/bundles', body: { epoch: epoch ?? '0', blinded_blanks: [] },
  });
  assert(unpaid.fulfilled === false,
    `an UNPAID request to g.anyone.credentials is refused (${unpaid.code ?? `fulfilled ${unpaid.status}`})`);
}

// (iv) THE ROUTED PURCHASE, AND THE CROSSING. One client, one channel — the
//      SOLANA channel opened against the HUB in step 1 — buying from a node it
//      has no channel with, over a peering that settles a DIFFERENT TOKEN ON A
//      DIFFERENT CHAIN. Sealed to the anytoon node because that is where the
//      envelope is opened; paid at the hub in uUSDC, which converts at the
//      live TWAP and forwards `floor(amount x rate) - fee` in ANYONE. Nothing
//      on the wire says any of that: no packet, header or claim gained an
//      asset field, because a claim was always denominated by the channel it
//      is written against.
const credPrice = await client.price('g.anyone.credentials');
assert(credPrice !== null, `the hub prices g.anyone.credentials (${jstr(credPrice)})`);
if (epoch !== null) {
  // 10 blanks of 256 bytes, the issuer's configured bundle size and blank
  // size. The leading zero byte is load-bearing: RFC 9474 requires a blinded
  // message to be less than the RSA modulus, and a uniformly random 256-byte
  // value exceeds a 2048-bit modulus about half the time. These are
  // structurally valid blinded messages rather than genuinely blinded ones —
  // the issuer signs them either way, and what is being proved here is the
  // PAID PATH, not RSABSSA (which the issuer's own tests cover).
  const blank = () => { const b = Buffer.from(randomBytes(256)); b[0] = 0; return b.toString('base64'); };
  const bought = await client.send('g.anyone.credentials', {
    method: 'POST',
    target: 'v1/bundles',
    headers: { 'idempotency-key': `${unique}-bundle` },
    body: { epoch, blinded_blanks: Array.from({ length: 10 }, blank) },
  }, { sealTo: ANYTOON_EDGE });
  if (!bought.fulfilled) {
    bad(`the credentials purchase was refused: ${bought.code} (refusedBy ${bought.refusedBy}, accumulatedCost ${bought.accumulatedCost})`);
  } else if (bought.status !== 201 && bought.status !== 200) {
    bad(`the credentials purchase was PAID but answered ${bought.status}: ${bought.text().slice(0, 400)}`);
  } else {
    const bundle = bought.json();
    assert(bundle.epoch === epoch, `the issuer signed a bundle under epoch ${bundle.epoch}`);
    assert(Array.isArray(bundle.blind_signatures) && bundle.blind_signatures.length === 10,
      `and returned ${bundle.blind_signatures?.length} blind signatures`);
    // EXACT, and the only number in this flow that can be: the client pays
    // the hub's advertised price, in the client's own money, on the client's
    // own channel. What the hub then pays onward is rate-dependent and is
    // asserted in step 5 with the inequality it actually satisfies.
    assert(BigInt(bought.claim?.amount ?? 0) === HUB_CREDENTIALS_PRICE,
      `the client paid the hub exactly ${bought.claim?.amount} uUSDC for it (the hub's static quote, ${HUB_CREDENTIALS_PRICE})`);
  }
} else {
  bad('no epoch from the key document — skipping the routed purchase');
}

// ── 5. the money, PER LEG, IN EACH LEG'S OWN UNIT ────────────────────────
// Three legs, two chains, two tokens, and the whole point of asserting them
// separately: the client leg is mock USDC on a Solana payment_channel account
// (6 decimals), the store and gas legs are the same token at par on their own
// Solana accounts, and the anytoon leg is ANYONE on an anvil channel (18
// decimals). Nothing on the wire said so — each figure is denominated by the
// channel it was written against and always was.
step('5. the connectors’ own books say everything was PAID — per settlement leg, in each leg’s own unit');
// Claims are journaled on the far side of the same round trip; poll briefly.
let hubRows = [], hubAfter = hubBefore, storeAfter = storeBefore, gasAfter = gasBefore, anytoonAfter = anytoonBefore;
// Under the `credentials` profile only two paid packets entered the hub's
// client edge: the relay write (1) and the bundle (11000, the static
// cross-asset quote). The full run adds the nine store/gas-bound packets
// itemised below.
const HUB_EXPECTED = STORE_GAS
  ? 1n + 9n * 1100n + HUB_CREDENTIALS_PRICE
  : 1n + HUB_CREDENTIALS_PRICE;
for (let i = 0; i < 20 && (hubAfter - hubBefore < HUB_EXPECTED
    || (STORE_GAS && (storeAfter - storeBefore < 3000n || gasAfter - gasBefore < 6000n))
    || anytoonAfter - anytoonBefore < BUNDLE_PRICE_UNITS); i++) {
  await sleep(500);
  hubRows = await claims('relay-connector');
  hubAfter = clientBookTotal(hubRows);
  if (STORE_GAS) {
    storeAfter = peerBookTotal(await claims('store-connector'), SOLANA_CHANNELS['relay-store'].account);
    gasAfter = peerBookTotal(await claims('gas-connector'), SOLANA_CHANNELS['relay-gas'].account);
  }
  anytoonAfter = clientBookOnChannel(await claims('anytoon-connector'), `evm:${ANYONE_CHANNEL}`);
}
// Client leg (SOLANA, uUSDC): eleven paid packets entered the hub's client
// edge — relay write (1), store blob (>= 1100), the brokered ArNS ceremony's
// five (kind:5096 fee-payer quote, kind:5095 op=prepare, kind:5096 quote with
// draft, kind:5096 execute, kind:5095 op=buy — >= 1100 each), 5096 quote
// (1100), 5098 quote (1100), 5098 execute (1100), and the credentials bundle
// (11000, the hub's static cross-asset quote).
assert(hubAfter - hubBefore >= HUB_EXPECTED,
  `hub client book advanced by ${hubAfter - hubBefore} uUSDC (>= ${HUB_EXPECTED}, the ${STORE_GAS ? 'eleven' : 'two'} packets' prices)`);
// The hub's book keys a client channel by chain namespace, and THAT is the
// assertion: a `solana:` key is the buyer paying in mock USDC. An `evm:` key
// here would mean the buyer had opened an ANYONE channel by accident and been
// charged uUSDC prices in a token worth 10^12 times more per base unit.
const clientChannels = [...new Set(hubRows.filter((r) => r.book === 'client' && r.direction === 'inbound').map((r) => r.channel_id))];
assert(clientChannels.length > 0 && clientChannels.every((c) => /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c)),
  `client leg settles on SOLANA: hub client-book channels ${clientChannels.join(', ')} are payment_channel accounts`);
assert(clientChannels.some((c) => c === `solana:${opened.channelId}`),
  `and include the channel the client opened in step 1 (${opened.channelId})`);
// Store and gas legs (SOLANA, uUSDC): at par, so these are the same integers
// that entered the hub less its flat fee — no conversion anywhere on them.
// (Under `credentials` neither peering has anybody behind it and nothing was
// sent down them; the boundary leg below is asserted on both profiles.)
if (STORE_GAS) {
  assert(storeAfter - storeBefore >= 3000n,
    `store peer leg settles on SOLANA at par: watermark on channel ${SOLANA_CHANNELS['relay-store'].account} advanced by ${storeAfter - storeBefore} uUSDC (>= 3000: 5094 blob + 5095 prepare + 5095 buy)`);
  assert(gasAfter - gasBefore >= 6000n,
    `gas peer leg settles on SOLANA at par: watermark on channel ${SOLANA_CHANNELS['relay-gas'].account} advanced by ${gasAfter - gasBefore} uUSDC (>= 6000: 5096 fee-payer quote + 5096 draft quote + 5096 execute + 5096 quote + 5098 quote + 5098 execute)`);
}

// ── the crossing itself ─────────────────────────────────────────────────
// The one purchase, seen from both sides of the boundary. The client paid the
// hub exactly 11000 uUSDC (step 4c, off the claim the client itself holds);
// the hub paid the anytoon node some number of ANYONE base units that no file
// could have predicted. Three things are true of that number and all three are
// checked, because any one of them alone would pass on a broken conversion:
//   * it is ~10^12 times bigger than the uUSDC figure — a hop that forwarded
//     the arriving integer would be wrong by exactly that factor and is the
//     failure this whole assertion exists to catch
//   * it is at least the downstream's own price
//   * it is what the LIVE rate says it should be, within the width of the
//     driver's band — computed from the same GET /rates the hub converts
//     against, not from a constant
const crossed = anytoonAfter - anytoonBefore;
assert(crossed >= BUNDLE_PRICE_UNITS,
  `anytoon leg settles ANYONE ON ANVIL: client book on channel ${ANYONE_CHANNEL} advanced by ${crossed} base units`
  + ` (>= ${BUNDLE_PRICE_UNITS}, the bundle's own price; the surplus is the hub's FX buffer arriving as a gift)`);
assert(crossed > HUB_CREDENTIALS_PRICE * 1_000_000_000n,
  `and it is a CONVERTED figure, not a carried one: ${crossed} against the ${HUB_CREDENTIALS_PRICE} uUSDC that arrived`);
if (dealtBefore !== null) {
  // Bounds rather than an equality: the rate moved while the packet was in
  // flight, on purpose. The driver's band is +/-ANYONE_BAND_TICKS (~2%), so
  // allow 5% either way of what the pre-flight rate predicted.
  const predicted = forwardedAnyone(HUB_CREDENTIALS_PRICE, dealtBefore);
  const lo = predicted * 95n / 100n, hi = predicted * 105n / 100n;
  assert(crossed >= lo && crossed <= hi,
    `and it matches the live rate: ${crossed} is within 5% of the ${predicted} the rate read in step 0d predicted`
    + ' (the hub converted at a price that moved under it while the packet was in flight)');
}

// ── 6. the rate is LIVE ─────────────────────────────────────────────────
// Everything above would pass against a frozen TWAP: a static rate converts
// just as correctly as a moving one. This is the step that says the market is
// real. The hub's poller refreshes every ttl/3 = 40s and the swap driver moves
// the 300-second TWAP continuously, so the run's own duration is normally
// enough; if it was not, wait.
step('6. the ANYONE rate MOVED while this test ran — a live TWAP, not a decorated constant');
{
  const leg = (rows) => rateRow(rows, ASSET_ANYONE, ASSET_USDC_EVM);
  const before = leg(ratesBefore);
  let after = null;
  for (let i = 0; i < 30; i++) {
    after = leg(await rates().catch(() => []));
    if (after?.last_refreshed && after.last_refreshed !== before?.last_refreshed) break;
    await sleep(5000);
  }
  if (!before?.rate || !after?.rate) {
    bad('could not read the ANYONE leg from GET /rates at both ends of the run');
  } else {
    assert(after.state === 'live',
      `the ANYONE pair is still live at the end of the run (state ${after.state}) — the swap driver kept blocks coming, so nothing aged past ttl_secs`);
    assert(after.last_refreshed !== before.last_refreshed,
      `the poller took a new observation: ${before.last_refreshed} -> ${after.last_refreshed}`);
    // Fractions, compared by cross-multiplication: no floats on this path.
    const bn = BigInt(before.rate.numerator), bd = BigInt(before.rate.denominator);
    const an = BigInt(after.rate.numerator), ad = BigInt(after.rate.denominator);
    const moved = bn * ad !== an * bd;
    const ppm = Number((an * bd * 1_000_000n) / (bn * ad)) - 1_000_000;
    assert(moved,
      `and the PRICE moved with it: ${bn}/${bd} -> ${an}/${ad} (${(ppm / 10_000).toFixed(3)}%), which only a pool being traded can do`);
    // Still bounded, which is what lets the hub quote a static price at all.
    const dealtAfter = dealtUsdcToAnyone(await rates().catch(() => []));
    if (dealtAfter) {
      assert(forwardedAnyone(HUB_CREDENTIALS_PRICE, dealtAfter) >= BUNDLE_PRICE_UNITS,
        `and it is still inside the hub's FX buffer: the static ${HUB_CREDENTIALS_PRICE} uUSDC would still forward ${forwardedAnyone(HUB_CREDENTIALS_PRICE, dealtAfter)} >= ${BUNDLE_PRICE_UNITS}`);
    }
  }
}

console.log(failures === 0
  ? (CREDENTIALS_ONLY
    ? '\n\x1b[32mTOON CREDENTIALS SMOKE OK: the payment layer live, a Solana USDC channel opened against the hub, a paid relay write journaled — and the DENOMINATION BOUNDARY end to end: free key document, scoped free route, unpaid refusal, and one PAID hub-routed purchase of a blind-signed bundle, with the buyer\'s uUSDC converted at a live Uniswap v3 TWAP into ANYONE on anvil, both sides\' books agreeing in their own units, and the rate MOVED during the run.\x1b[0m'
    : '\n\x1b[32mTOON SMOKE OK: paid routing through the relay hub to store, gas station and the Anyone credentials issuer (blob store, brokered ArNS spawn+buy, Solana quote + EVM ERC-2771 relay, blind-signed credentials bundle) — buyer paid mock USDC on a SOLANA channel, store and gas legs settled at par on Solana, and the credentials leg CROSSED A DENOMINATION BOUNDARY into ANYONE on anvil at a live Uniswap v3 TWAP.\x1b[0m')
  : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
