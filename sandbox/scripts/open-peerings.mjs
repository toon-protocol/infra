// The `open-peerings` init job (infra#39): establishes every peering in
// scripts/peerings.mjs the way an operator would, through each node's own
// signed operator writes (connector ADR 0008), and refuses to report success
// unless the chain agrees.
//
// Per peering, in this order (connector ADR 0075, as local/keys.sh in the
// connector repository does it):
//
//   1. POST /peers on the PAYEE, naming the payer. It binds the payer's
//      voucher signer to the peering, so the payer's first voucher already
//      arrives in the peer role, and opens the payee's own channel back
//      toward the payer at the minimum deposit.
//   2. POST /peers on the PAYER, naming the payee. It opens the channel that
//      carries traffic — on Solana by posting a payer-signed `open` to the
//      payee's sponsor endpoint — with the whole target behind it.
//   3. POST /channels/:id/fund on the payer for any shortfall, read off its own
//      GET /channels first (`fund` takes an INCREMENT). The figure there is
//      what the channel can still pay — its deposit less what the payer has
//      already signed away — so the target is HEADROOM, and a re-run refills
//      whatever the hub has spent on the peering since.
//   4. The payer's channel read back off the VALIDATOR: a payment-channels
//      account, Open, paid by the payer, payable to the payee, signed for by
//      the payer, in the mock USDC mint, holding at least the target. Nothing
//      on the packet path checks that, and a peering whose collateral was
//      never deposited would otherwise look exactly as healthy.
//   5. POST /routes/peers on the payer for each forwarding row.
//
// A ONE-SIDED peering (`payeeBinds: false`, the Dealer's to anytoon — infra
// ADR 0003) skips step 1: the payee binds nothing, so the payer's vouchers
// arrive there as a client's. Its channel is on EVM, in ANYONE, and step 4
// reads it back off x402BatchSettlement on anvil instead.
//
// Under `make up-hs` anytoon publishes a `.anyone` endpoint, and a POST /peers
// dials what the other node publishes. So the Makefile runs this job before
// it recreates anytoon against that rendered config, and a re-run afterwards
// leaves an established peering toward a hidden endpoint alone (it still tops
// the channel up) rather than re-reading the document.
//
// IDEMPOTENT, and meant to be re-run: a second `POST /peers` finds the
// channel already open (`"status":"found"`) and opens nothing, a channel is
// topped up only by what has been spent from it since, and a route write is
// an upsert by prefix.
// A peering with a side that is not running (`payments` has no store or gas
// station; a topology runs only what it named) is skipped by name, and a
// sandbox running one node alone has none to open.
//
// A TOPOLOGY CAN LEAVE A CHAIN OUT (`make up-topology CHAINS=evm`). Each
// peering opens on its own `chain` when both nodes publish it and on its
// `fallback` otherwise (scripts/peerings.mjs), read off what the two nodes
// say they settle on rather than off anything this job is told.
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';

import { NODES, PEERINGS } from './peerings.mjs';
import { signWrite } from './lib/operator-write.mjs';
import { binds, peerBody, peeringChain, presentPeerings, targetOf, topUp } from './lib/peering-plan.mjs';
import { PAYMENT_CHANNELS_PROGRAM, USDC_MINT, readSolanaChannel } from './lib/solana-channel.mjs';
import { readEvmChannel } from './lib/evm-channel.mjs';

const KEYS_DIR = process.env.KEYS_DIR ?? new URL('../keys/toon/', import.meta.url).pathname;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://solana-validator:8899';
const EVM_RPC_URL = process.env.EVM_RPC_URL ?? 'http://anvil:8545';

const say = (message) => console.log(`[open-peerings] ${message}`);
function die(message) {
  console.error(`[open-peerings] FATAL: ${message}`);
  process.exit(1);
}

const key = (node, file) => readFileSync(`${KEYS_DIR}/${node}/${file}`, 'utf8').trim();
const origin = (node) => new URL(NODES[node].url).origin;

async function operator(node, method, path, body) {
  const headers =
    method === 'GET'
      ? { authorization: `Bearer ${key(node, 'operator-bearer.token')}` }
      : { ...signWrite({ key: key(node, 'operator-send.key'), method, path, body }), 'content-type': 'application/json' };
  const res = await fetch(`${origin(node)}${path}`, { method, headers, body: method === 'GET' ? undefined : body });
  const text = await res.text();
  if (!res.ok) {
    die(`${node} answered ${method} ${path} with HTTP ${res.status}: ${text}${body ? `\n  request: ${body}` : ''}\n  'docker compose logs ${node}' has its side of it.`);
  }
  return text ? JSON.parse(text) : null;
}

const selfDescription = (node) => fetch(NODES[node].url).then((res) => res.json());

const chainOf = (network) => (network?.startsWith('eip155:') ? 'evm' : 'solana');

// The chains a node settles on, as it publishes them: one `batchSettlements`
// entry each (connector client-edge-spec §1.4).
const settlesOn = async (node) => new Set(((await selfDescription(node)).batchSettlements ?? []).map((b) => chainOf(b.network)));

// A node's settlement key on `chain`: the `payTo` of its entry there.
async function settlementKey(node, chain) {
  const entry = (await selfDescription(node)).batchSettlements?.find((b) => chainOf(b.network) === chain);
  if (!entry) die(`${node} publishes no ${chain} batchSettlements entry at ${NODES[node].url}`);
  return entry.payTo;
}

const sameKey = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The payer's channel, as the chain holds it. On Solana, a payment-channels
// account (lib/solana-channel.mjs reads the layout); on EVM, the balance
// x402BatchSettlement holds for the channel id, which is a hash of the
// channel's whole config — payer, receiver and token included — so the id the
// payer's own GET /channels names toward this payee is already that check.
async function assertChannel(peering, chain, account, payer, payee) {
  const target = targetOf(peering);
  if (chain === 'evm') {
    const ch = await readEvmChannel(EVM_RPC_URL, account);
    if (ch.balance < target) die(`${peering.id}: x402BatchSettlement holds ${ch.balance} in ${account}, not at least ${target}`);
    say(`${peering.id}: x402BatchSettlement holds ${ch.balance} in ${account}, paid by ${payer} to ${payee}`);
    return;
  }
  const ch = await readSolanaChannel(SOLANA_RPC_URL, account);
  if (!ch) die(`${peering.id}: no account ${account} on the validator`);
  const problems = [];
  if (ch.owner !== PAYMENT_CHANNELS_PROGRAM) problems.push(`owned by ${ch.owner}, not payment-channels`);
  if (ch.size !== 256) problems.push(`${ch.size} bytes, not a payment-channels Channel's 256`);
  else {
    if (ch.status !== 0) problems.push(`status byte ${ch.status}, not Open`);
    const want = { payer: [ch.payer, payer], payee: [ch.payee, payee], authorized_signer: [ch.authorizedSigner, payer], mint: [ch.mint, USDC_MINT] };
    for (const [name, [got, expected]] of Object.entries(want)) if (got !== expected) problems.push(`${name} is ${got}, not ${expected}`);
    if (ch.deposit < target) problems.push(`deposit is ${ch.deposit}, not at least ${target}`);
  }
  if (problems.length > 0) die(`${peering.id}: channel ${account} disagrees with the peering:\n  ${problems.join('\n  ')}`);
  say(`${peering.id}: payment-channels holds ${ch.deposit} in ${account}, paid by ${payer} to ${payee}`);
}

async function present(node) {
  try {
    await lookup(new URL(NODES[node].url).hostname);
    return true;
  } catch {
    return false;
  }
}

// A node fronted by a hidden service publishes a `.anyone` endpoint, which no
// node here can dial (`make up-hs` and `make up-topology HS=…`, see the header).
const publishesHidden = async (node) => /\.anyone$/.test(new URL((await selfDescription(node)).httpEndpoint ?? NODES[node].url).hostname);

const running = new Set();
for (const node of Object.keys(NODES)) if (await present(node)) running.add(node);
const { run, skipped } = presentPeerings(PEERINGS, running);
for (const { id, payer, payee } of skipped) say(`${id}: skipped — ${running.has(payer) ? payee : payer} is not running`);

for (const peering of run) {
  const { id, payer, payee } = peering;
  const chain = peeringChain(peering, await settlesOn(payer), await settlesOn(payee));
  if (!chain) die(`${id}: ${payer} and ${payee} settle on no chain this peering can open on (${[peering.chain, peering.fallback].filter(Boolean).join(', then ')})`);
  if (chain !== peering.chain) say(`${id}: opening on ${chain} — ${peering.chain} is not settled on here`);
  const [payerKey, payeeKey] = await Promise.all([settlementKey(payer, chain), settlementKey(payee, chain)]);

  // Either side: the payee's `POST /peers` dials the payer just as the
  // payer's dials the payee.
  const hiddenSide = (await publishesHidden(payee)) ? payee : (await publishesHidden(payer)) ? payer : null;
  if (hiddenSide) {
    const known = (await operator(payer, 'GET', '/peers')).some((p) => p.id === id);
    if (!known) {
      die(`${hiddenSide} publishes a hidden-service endpoint, which its peer cannot dial, and ${id} was never established toward its compose name.\n  \`make up-hs\` and \`make up-topology\` run this job before they put a node on its hidden endpoint; use them rather than starting it by hand.`);
    }
    say(`${id}: ${hiddenSide} publishes a hidden-service endpoint; ${payer} keeps the peering it already has`);
  } else {
    if (binds(peering, 'payee')) {
      const back = await operator(payee, 'POST', '/peers', peerBody(peering, 'payee', NODES, chain));
      say(`${id}: ${payee} bound ${payer}, its own channel back ${back.channel?.id} (${back.channel?.status})`);
    } else {
      say(`${id}: ${payee} binds nothing — ${payer}'s vouchers arrive there as a client's`);
    }
    const established = await operator(payer, 'POST', '/peers', peerBody(peering, 'payer', NODES, chain));
    if (!established.channel?.id || established.channel.chain !== chain) {
      die(`${payer}'s POST /peers for ${id} answered without a ${chain} channel: ${JSON.stringify(established)}`);
    }
    say(`${id}: ${payer} -> ${payee}, channel ${established.channel.id} (${established.channel.status})`);
  }

  // The payer's outbound channel toward the payee, off its own GET /channels.
  const view = (await operator(payer, 'GET', '/channels'))
    .find((row) => row.scheme === 'batch-settlement' && row.direction === 'outbound' && sameKey(row.counterparty, payeeKey) && row.status === 'open');
  if (!view) die(`${id}: ${payer}'s GET /channels lists no open outbound channel toward ${payee} (${payeeKey})`);
  const channel = view.id;
  if (!/^\d+$/.test(String(view.collateral ?? ''))) die(`${id}: ${payer} reports no collateral for ${channel}: ${JSON.stringify(view)}`);
  const shortfall = topUp(BigInt(view.collateral), targetOf(peering));
  if (shortfall > 0n) {
    // Written out, not JSON.stringify'd: an 18-decimal shortfall is past a
    // double's exact range, and the connector reads the figure as a u128.
    await operator(payer, 'POST', `/channels/${channel}/fund`, `{"amount":${shortfall}}`);
    say(`${id}: topped ${channel} up by ${shortfall} to ${targetOf(peering)}`);
  }
  await assertChannel(peering, chain, channel, payerKey, payeeKey);

  for (const route of peering.routes) {
    await operator(payer, 'POST', '/routes/peers', JSON.stringify({ prefix: route.prefix, peer_id: id, price: route.price }));
  }
  say(`${id}: ${payer} routes ${peering.routes.length} prefix(es) over it`);
}

say(`done: ${run.length} peering(s) established, ${skipped.length} skipped.`);
