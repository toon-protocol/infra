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
// IDEMPOTENT, and meant to be re-run: a second `POST /peers` finds the
// channel already open (`"status":"found"`) and opens nothing, a channel is
// topped up only by what has been spent from it since, and a route write is
// an upsert by prefix.
// A peering whose far side this compose profile does not run (`payments` has
// no store or gas station) is skipped by name.
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';

import { NODES, PEERINGS, CHANNEL_TARGET } from './peerings.mjs';
import { signWrite } from './lib/operator-write.mjs';
import { peerBody, presentPeerings, topUp } from './lib/peering-plan.mjs';
import { PAYMENT_CHANNELS_PROGRAM, USDC_MINT, readSolanaChannel } from './lib/solana-channel.mjs';

const KEYS_DIR = process.env.KEYS_DIR ?? new URL('../keys/toon/', import.meta.url).pathname;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? 'http://solana-validator:8899';

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

// A node's Solana settlement key, as it publishes it: the `payTo` of its
// Solana `batchSettlements` entry (connector client-edge-spec §1.4).
async function solanaKey(node) {
  const self = await fetch(NODES[node].url).then((res) => res.json());
  const entry = self.batchSettlements?.find((b) => b.network?.startsWith('solana:'));
  if (!entry) die(`${node} publishes no Solana batchSettlements entry at ${NODES[node].url}`);
  return entry.payTo;
}

// The payer's channel, as the validator holds it (lib/solana-channel.mjs reads
// the payment-channels layout).
async function assertChannel(label, account, payer, payee) {
  const ch = await readSolanaChannel(SOLANA_RPC_URL, account);
  if (!ch) die(`${label}: no account ${account} on the validator`);
  const problems = [];
  if (ch.owner !== PAYMENT_CHANNELS_PROGRAM) problems.push(`owned by ${ch.owner}, not payment-channels`);
  if (ch.size !== 256) problems.push(`${ch.size} bytes, not a payment-channels Channel's 256`);
  else {
    if (ch.status !== 0) problems.push(`status byte ${ch.status}, not Open`);
    const want = { payer: [ch.payer, payer], payee: [ch.payee, payee], authorized_signer: [ch.authorizedSigner, payer], mint: [ch.mint, USDC_MINT] };
    for (const [name, [got, expected]] of Object.entries(want)) if (got !== expected) problems.push(`${name} is ${got}, not ${expected}`);
    if (ch.deposit < CHANNEL_TARGET) problems.push(`deposit is ${ch.deposit}, not at least ${CHANNEL_TARGET}`);
  }
  if (problems.length > 0) die(`${label}: channel ${account} disagrees with the peering:\n  ${problems.join('\n  ')}`);
  say(`${label}: payment-channels holds ${ch.deposit} in ${account}, paid by ${payer} to ${payee}`);
}

async function present(node) {
  try {
    await lookup(new URL(NODES[node].url).hostname);
    return true;
  } catch {
    return false;
  }
}

const running = new Set();
for (const node of Object.keys(NODES)) if (await present(node)) running.add(node);
const { run, skipped } = presentPeerings(PEERINGS, running);
for (const { id, payee } of skipped) say(`${id}: skipped — this profile runs no ${payee}`);
if (!running.has('relay-connector')) die('the hub (relay-connector) is not on this network');

for (const peering of run) {
  const { id, payer, payee } = peering;

  const back = await operator(payee, 'POST', '/peers', peerBody(peering, 'payee', NODES));
  say(`${id}: ${payee} bound ${payer}, its own channel back ${back.channel?.id} (${back.channel?.status})`);

  const established = await operator(payer, 'POST', '/peers', peerBody(peering, 'payer', NODES));
  const channel = established.channel?.id;
  if (!channel || established.channel.chain !== peering.chain) {
    die(`${payer}'s POST /peers for ${id} answered without a ${peering.chain} channel: ${JSON.stringify(established)}`);
  }
  say(`${id}: ${payer} -> ${payee}, channel ${channel} (${established.channel.status})`);

  const [payerKey, payeeKey] = await Promise.all([solanaKey(payer), solanaKey(payee)]);
  const view = (await operator(payer, 'GET', '/channels')).find((row) => row.id === channel && row.scheme === 'batch-settlement');
  if (!view) die(`${payer}'s GET /channels does not list ${channel}, the channel its POST /peers answered`);
  if (view.direction !== 'outbound' || view.counterparty !== payeeKey) {
    die(`${id}: ${payer}'s ${channel} is not outbound to ${payee} (${payeeKey}): ${JSON.stringify(view)}`);
  }
  if (!/^\d+$/.test(String(view.collateral ?? ''))) die(`${id}: ${payer} reports no collateral for ${channel}: ${JSON.stringify(view)}`);
  const shortfall = topUp(BigInt(view.collateral), CHANNEL_TARGET);
  if (shortfall > 0n) {
    await operator(payer, 'POST', `/channels/${channel}/fund`, JSON.stringify({ amount: Number(shortfall) }));
    say(`${id}: topped ${channel} up by ${shortfall} to ${CHANNEL_TARGET}`);
  }
  await assertChannel(id, channel, payerKey, payeeKey);

  for (const route of peering.routes) {
    await operator(payer, 'POST', '/routes/peers', JSON.stringify({ prefix: route.prefix, peer_id: id, price: route.price }));
  }
  say(`${id}: ${payer} routes ${peering.routes.length} prefix(es) over it`);
}

say(`done: ${run.length} peering(s) established, ${skipped.length} skipped.`);
