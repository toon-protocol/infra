#!/usr/bin/env node
//
// smoke-hs — the HIDDEN-SERVICE rehearsal. `make up-hs` first.
//
// WHAT IS BEING PROVED. The rest of this sandbox reaches every node at a
// published clearnet port. The anytoon credentials issuer does not deploy that
// way: its connector publishes no port at all and the circuit is the only way
// in. This script is a buyer of that shape —
//
//     node  ──►  anon-client (SOCKS5h, 127.0.0.1:19050)
//                     │
//                     ├── the packets:   http://<addr>.anyone/ilp
//                     └── the chain RPC: http://<addr>.anyone:8545
//
// — and it buys one real bundle of blind signatures from the issuer, paying at
// the anytoon node's own client edge, over the circuit, settling on the
// sandbox's anvil reached through the SAME proxy. Nothing it needs is dialled
// on clearnet: not the packets, not the channel open, not the deposit, not even
// the ANYONE it funds itself with.
//
// THE CHAIN RPC IS NOT AN AFTERTHOUGHT. @toon-protocol/client sends JSON-RPC
// through `socksProxy` by DEFAULT (`proxyRpc`), because reaching a connector
// inside the overlay while reading chain state on clearnet would broadcast the
// payer's settlement address, from the payer's own IP, timed either side of
// every paid request (toon-client ADR 0002). So this script never sets
// `proxyRpc`, in either direction, and conf/anonrc publishes anvil on virtual
// port 8545 of the SAME address so that default can hold. `proxyRpc: false` is
// the thing being avoided here, not a fallback.
//
// ITS OWN BUYER, AND WHY. accountIndex 5, not 0. `make smoke` opens a
// ZERO-DEPOSIT channel between account 0 and this same node — deliberately: it
// is how step 4c proves an unpaid request is refused. A client that reuses
// account 0 ADOPTS that channel (openOrAdopt takes an existing on-chain channel
// as it finds it, deposit and all) and can never pay from it; collateralising
// it instead would silently break the assertion `make smoke` makes. Two buyers,
// two channels, no interference in either direction.
//
// A REHEARSAL, NOT A GATE. `anon` bootstraps against the REAL Anyone network;
// there is no local directory authority and no private relay set. So this can
// fail because a third-party network had a bad day, and that is not the same
// event as a sandbox that is misconfigured. Every failure below is reported as
// one or the other, with the evidence that decided it:
//
//   exit 1   SANDBOX-SIDE — something here is wrong. Fix it.
//   exit 75  NETWORK-SIDE (EX_TEMPFAIL) — the daemons are healthy, the address
//            is published and the connector advertises it, and the circuit
//            still would not carry. Try again later; do not go looking for a
//            bug in this repo until it fails twice on a day the network is fine.
//
// The overlay phase is retried (SMOKE_HS_ATTEMPTS, default 3) before that
// verdict is reached.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToonClient } from '@toon-protocol/client';
import { createHiddenServiceTransport } from '@toon-protocol/client/hidden-service';
import { HDNodeWallet, Interface, Wallet as EthersWallet, randomBytes } from 'ethers';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
const RENDERED = join(ROOT, 'conf', '.rendered', 'connector-anytoon.toml');
const SOCKS_PORT = Number(process.env.ANON_SOCKS_PORT ?? 19050);
const SOCKS_PROXY = process.env.TOON_SOCKS_PROXY ?? `socks5h://127.0.0.1:${SOCKS_PORT}`;
// The anytoon node's CLEARNET edge. Used for exactly two things, both of them
// out-of-band checks a buyer would never make: reading what the node publishes
// (to prove `make up-hs` really gave it the rendered config) and reading its
// operator claim book afterwards. Not one byte of the purchase goes here.
const ANYTOON_EDGE = process.env.ANYTOON_EDGE_URL ?? 'http://localhost:3230';
const ATTEMPTS = Number(process.env.SMOKE_HS_ATTEMPTS ?? 3);
// anvil's own published test mnemonic. Account 5 is the BUYER (see the header);
// anvil funds the first ten accounts with 10000 ETH each, so it has gas.
const MNEMONIC = 'test test test test test test test test test test test junk';
const ACCOUNT_INDEX = 5;
const EVM_CHAIN_ID = 31337;
// THIS BUYER PAYS ANYONE, not mock USDC, and that is the one thing the
// cross-asset flip changed about this file: the anytoon node's
// `[settlement.evm]` token is the real mainnet ANYONE ERC-20 (18 decimals), so
// its client edge is an ANYONE edge and every figure here is in ANYONE base
// units. There is no hub in this path and therefore no conversion — the buyer
// simply holds the money the node charges in.
const DEPOSIT = 1_000_000_000_000_000_000n; // 1 ANYONE — 25 bundles at 0.04
const ANYONE_DECIMALS = 18;
// anvil account 0 — the sandbox's faucet. ANYONE is the REAL contract with a
// fixed 100M supply and no `mint()`, so a buyer cannot conjure its own the way
// it could with the mock USDC: the faucet has to send it some. Public test key,
// local chain only.
const FAUCET_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// ── output ────────────────────────────────────────────────────────────────
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const info = (msg) => console.log(`       ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The two verdicts, and the only two ways this script ends badly.
class SandboxFault extends Error {}   // exit 1  — something HERE is wrong
class NetworkFault extends Error {}   // exit 75 — the overlay would not carry

// Which one is it? Only ever asked about an error raised while dialling the
// overlay — everything before that is sandbox-side by construction, and
// anything the connector or the issuer answered IN PROTOCOL is sandbox-side
// too (a refusal means a circuit carried the packet and something here said no).
const CARRIAGE = /socks|proxy|host unreachable|hostunreachable|connection refused|econnrefused|etimedout|timed ?out|timeout|econnreset|socket hang up|fetch failed|und_err|network|circuit|dns|other than a valid|http 5/i;
function classify(err, whileDialing) {
  if (err instanceof SandboxFault || err instanceof NetworkFault) return err;
  const message = `${err?.message ?? err}${err?.cause ? ` (cause: ${err.cause})` : ''}`;
  if (whileDialing && CARRIAGE.test(message)) return new NetworkFault(message);
  return new SandboxFault(message);
}

// ── docker, for the daemons' own account of themselves ────────────────────
function compose(...args) {
  return execFileSync('docker', ['compose', '--profile', 'hs', ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function containerId(service) {
  try { return compose('ps', '-q', service); } catch { return ''; }
}
function health(service) {
  const id = containerId(service);
  if (!id) return 'absent';
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id],
      { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}
function lastWords(service) {
  const id = containerId(service);
  if (!id) return '(no container)';
  try {
    const log = execFileSync('docker', ['logs', '--tail', '400', id],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = log.split('\n').filter((l) => /Bootstrapped|warn|err/i.test(l));
    return lines.slice(-6).join('\n                 ') || '(nothing notable in the last 400 lines)';
  } catch { return '(could not read the log)'; }
}
function socksPortOpen(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

// ── the price, from the one place it is written ───────────────────────────
// conf/anytoon.conf is the env_file of BOTH the issuer and the claim minter, so
// their two BUNDLE_PRICEs are one value; the connector's route price is that
// decimal in base units. Re-derived here for the same reason smoke-toon.mjs
// re-derives it: a drift otherwise surfaces as an unexplained 402.
function bundlePriceUnits() {
  const conf = readFileSync(join(ROOT, 'conf', 'anytoon.conf'), 'utf8');
  const m = conf.match(/^\s*BUNDLE_PRICE\s*=\s*(\S+)\s*$/m);
  if (!m) throw new SandboxFault('conf/anytoon.conf has no BUNDLE_PRICE line');
  const [whole, frac = ''] = m[1].trim().split('.');
  return BigInt(whole) * 10n ** BigInt(ANYONE_DECIMALS) + BigInt(frac.padEnd(ANYONE_DECIMALS, '0') || '0');
}

// ── 0. preflight: everything that is this sandbox's own doing ─────────────
// Deliberately all of it, and before a single byte goes near the overlay. A
// misconfiguration found here is found for free; found later it is
// indistinguishable from a network that would not carry.
async function preflight() {
  step('0. preflight — this sandbox\'s own configuration (nothing dialled yet)');

  if (!existsSync(RENDERED)) {
    throw new SandboxFault(
      `${RENDERED} does not exist, so no hidden-service address has been rendered.\n` +
      '  Run `make up-hs`: it starts the daemon, waits for a circuit, renders that\n' +
      '  file and recreates the anytoon-connector against it.');
  }
  const address = (readFileSync(RENDERED, 'utf8').match(/[a-z2-7]{56}\.anyone/) ?? [])[0];
  if (!address) throw new SandboxFault(`${RENDERED} contains no <56-base32>.anyone address.`);
  ok(`this sandbox's hidden-service address: ${address}`);

  const anon = health('anon');
  if (anon !== 'healthy') {
    throw new SandboxFault(
      `the \`anon\` daemon is ${anon}, so nothing is publishing that address.\n` +
      '  Its healthcheck is "hostname file exists AND Bootstrapped 100%":\n' +
      `                 ${lastWords('anon')}\n` +
      '  `make up-hs` waits for this. If it never goes healthy that is the Anyone\n' +
      '  network far more often than it is this repo — but a container that EXITED\n' +
      '  at once is a config fault (conf/anonrc: AgreeToTerms 1, explicit Nickname).');
  }
  ok('the `anon` daemon is healthy — it holds the address AND says Bootstrapped 100%');

  const buyerProxy = health('anon-client');
  if (buyerProxy !== 'healthy') {
    throw new SandboxFault(
      `the buyer's \`anon-client\` proxy is ${buyerProxy}:\n                 ${lastWords('anon-client')}`);
  }
  if (!(await socksPortOpen(SOCKS_PORT))) {
    throw new SandboxFault(
      `nothing is listening on 127.0.0.1:${SOCKS_PORT}, so the buyer has no way onto the\n` +
      '  network. `docker compose --profile hs ps anon-client`, and check ANON_SOCKS_PORT\n' +
      '  if you overrode it.');
  }
  ok(`the buyer's proxy is bootstrapped and listening on ${SOCKS_PROXY}`);

  // THE CHECK THAT CATCHES THE INTERESTING MISTAKE. A client dials the endpoint
  // a node PUBLISHES, not the URL the caller typed. If `make up-hs` had not
  // recreated this connector against the rendered config it would still be
  // advertising http://127.0.0.1:3230/ilp, and every packet below would be sent
  // at the buyer's own loopback through the proxy — a failure that looks exactly
  // like a network fault and is not one.
  let described;
  try {
    const res = await fetch(`${ANYTOON_EDGE}/ilp`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GET ${ANYTOON_EDGE}/ilp -> ${res.status}`);
    described = await res.json();
  } catch (e) {
    throw new SandboxFault(
      `could not read the anytoon node's self-description on its clearnet edge: ${e.message}\n` +
      '  (that edge is no part of the purchase; it is read here to prove the node is\n' +
      '  publishing the hidden-service endpoint). Is the full stack up?');
  }
  const published = String(described.httpEndpoint ?? '');
  if (published !== `http://${address}/ilp`) {
    throw new SandboxFault(
      `the anytoon node publishes ${JSON.stringify(published)}, not "http://${address}/ilp".\n` +
      '  A client dials what a node publishes, so this buyer would never reach the hidden\n' +
      '  service. Re-run `make up-hs` — it renders conf/.rendered/connector-anytoon.toml\n' +
      '  and recreates the connector with ANYTOON_CONNECTOR_CONF pointed at it.');
  }
  ok(`the anytoon node publishes the hidden service as its OWN endpoint (${published})`);

  const price = BigInt(described.routes?.find((r) => r.prefix === 'g.anyone.credentials')?.price ?? -1);
  const expected = bundlePriceUnits();
  if (price !== expected) {
    throw new SandboxFault(
      `the node prices g.anyone.credentials at ${price}, but conf/anytoon.conf's BUNDLE_PRICE\n` +
      `  is ${expected} base units. Those two must agree or every paid request answers 402.`);
  }
  ok(`and prices g.anyone.credentials at ${price} base units (= conf/anytoon.conf BUNDLE_PRICE)`);

  // The token the node settles in — ANYONE — taken from the node's own
  // description rather than hardcoded, because the buyer has to hold that token
  // and not merely believe it does.
  const evm = (described.settlements ?? []).find((s) => s.chain === `evm:${EVM_CHAIN_ID}`);
  if (!evm?.tokenAddress) {
    throw new SandboxFault(`the node publishes no evm:${EVM_CHAIN_ID} settlement for this buyer to pay on.`);
  }
  ok(`it settles on evm:${EVM_CHAIN_ID} in ${evm.tokenAddress}`);

  return { address, price, token: evm.tokenAddress };
}

// ── raw JSON-RPC, over the circuit ────────────────────────────────────────
// The TOON client carries its OWN chain reads and writes over the proxy; this
// is here for the one thing that happens before a client exists — a buyer with
// no ANYONE being sent some by the faucet. Written out by hand rather than handed to a
// provider so that it is unmistakable that every one of these requests leaves
// through the same SOCKS5h proxy the purchase does.
function rpcOver(fetchImpl, url) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`chain RPC ${method} -> HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`chain RPC ${method} -> ${body.error.message}`);
    return body.result;
  };
}

const ERC20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]);

// The buyer arrives holding nothing, which is what a buyer does. It cannot mint
// its way out of that any more: the token is the REAL ANYONE contract with a
// fixed supply, so the sandbox's faucet account sends it some instead — over
// the circuit, like everything else here, signed by the faucet rather than by
// the buyer because that is who has the tokens.
async function fundBuyer(rpc, wallet, token, want) {
  const faucet = new EthersWallet(FAUCET_KEY);
  const read = async (data) => rpc('eth_call', [{ to: token, data }, 'latest']);
  const balanceOf = async (who) => BigInt(
    ERC20.decodeFunctionResult('balanceOf', await read(ERC20.encodeFunctionData('balanceOf', [who])))[0]);

  const held = await balanceOf(wallet.address);
  if (held >= want) return { held, minted: 0n };

  const data = ERC20.encodeFunctionData('transfer', [wallet.address, want]);
  const [nonce, gasPrice, gasLimit] = await Promise.all([
    rpc('eth_getTransactionCount', [faucet.address, 'pending']),
    rpc('eth_gasPrice'),
    rpc('eth_estimateGas', [{ from: faucet.address, to: token, data }]),
  ]);
  const raw = await faucet.signTransaction({
    type: 0, to: token, data, chainId: EVM_CHAIN_ID,
    nonce: Number(nonce), gasPrice: BigInt(gasPrice), gasLimit: BigInt(gasLimit) * 2n,
  });
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  let receipt = null;
  for (let i = 0; i < 60 && receipt === null; i++) {
    receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt === null) await sleep(500);
  }
  if (receipt === null) throw new Error(`the faucet transaction ${hash} never got a receipt`);
  if (BigInt(receipt.status) !== 1n) throw new SandboxFault(`the faucet transaction ${hash} reverted`);
  return { held: await balanceOf(wallet.address), minted: want, hash };
}

// ── the payee's book, read out of band ────────────────────────────────────
// The payee's own record of what it was paid, on the client edge this buyer
// used. Read over the clearnet edge because it is an ASSERTION ABOUT the
// purchase, not part of it.
async function clientBook(channelId) {
  const token = readFileSync(
    join(ROOT, 'keys', 'toon', 'anytoon-connector', 'operator-bearer.token'), 'utf8').trim();
  const res = await fetch(`${ANYTOON_EDGE}/claims`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new SandboxFault(`anytoon-connector GET /claims -> ${res.status}`);
  const rows = await res.json();
  let top = 0n;
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    if (r.channel_id !== channelId && r.channel_id !== `evm:${channelId}`) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > top) top = a;
  }
  return top;
}

// ── 1-4. the overlay phase ────────────────────────────────────────────────
async function purchase({ address, price, token }, attempt) {
  const connector = `http://${address}`;
  const rpcUrl = `http://${address}:8545`;
  mkdirSync(join(ROOT, '.toon-client'), { recursive: true });

  step(`1. the circuit — a buyer that has ONLY the address and the proxy${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
  info(`connector  ${connector}/ilp`);
  info(`chain RPC  ${rpcUrl}          <- the same address, the same circuit`);
  info(`proxy      ${SOCKS_PROXY}`);
  info('`proxyRpc` is left at its default (true). Nothing here turns it off.');

  const wallet = HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${ACCOUNT_INDEX}`);
  const STORE = join(ROOT, '.toon-client', 'hs-buyer.json');
  const makeClient = () => ToonClient.create({
    connector,
    socksProxy: SOCKS_PROXY,
    mnemonic: MNEMONIC,
    accountIndex: ACCOUNT_INDEX,
    chain: 'evm',
    rpcUrl,
    channelStore: STORE,
    deposit: DEPOSIT,
    // Circuits are slow and a cold hidden service is slower; the client's own
    // hidden-service default is already 120s, and every chain read here is a
    // round trip through the overlay as well.
    timeoutMs: 180_000,
  });
  // The transport for the hand-written funding RPC below. The ToonClient builds
  // its own from the same proxy — this one is not shared with it.
  const transport = createHiddenServiceTransport(SOCKS_PROXY);
  let client;
  try {
    client = await makeClient();
  } catch (e) {
    // Construction validates config and probes the proxy port; it dials nothing.
    await transport.close().catch(() => {});
    throw classify(e, false);
  }
  if (client.identity.evmAddress?.toLowerCase() !== wallet.address.toLowerCase()) {
    await transport.close().catch(() => {});
    throw new SandboxFault(
      `the client derived ${client.identity.evmAddress} for accountIndex ${ACCOUNT_INDEX} but this script derived ${wallet.address}.`);
  }

  try {
    // (i) THE FREE KEY DOCUMENT, first, because it is the cheapest possible
    //     proof that a circuit reached the issuer path: a price-0 route needs
    //     no channel and no claim, so nothing has been spent if the overlay is
    //     having a bad day.
    const t0 = Date.now();
    const keys = await client.send('g.anyone.credentials.keys', { method: 'GET', target: 'current' });
    if (!keys.fulfilled) {
      throw new SandboxFault(
        `the free key document was refused ${keys.code} (refusedBy ${keys.refusedBy}) — ` +
        'the circuit carried the packet and the sandbox refused it.');
    }
    const doc = keys.json();
    ok(`a packet reached the issuer path over the circuit in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    ok(`the key document served FREE over the overlay: epoch ${doc.epoch_id} (alg ${doc.alg})`);
    if (keys.claim !== undefined) throw new SandboxFault('a claim was spent on the FREE route');

    // (ii) THE MONEY, also over the circuit. The buyer holds no ANYONE until
    //      the faucet sends it some; that transfer, the reads around it and the
    //      receipt poll all leave through the proxy.
    step('2. the buyer is funded in ANYONE and opens a channel — every JSON-RPC call over the same circuit');
    const rpc = rpcOver(transport.fetch, rpcUrl);
    const chainId = BigInt(await rpc('eth_chainId'));
    if (chainId !== BigInt(EVM_CHAIN_ID)) {
      throw new SandboxFault(`the chain behind ${rpcUrl} says chainId ${chainId}, not ${EVM_CHAIN_ID}.`);
    }
    ok(`the chain RPC answers over the overlay: eth_chainId = ${chainId} (anvil, through the hidden service)`);
    const funded = await fundBuyer(rpc, wallet, token, DEPOSIT);
    ok(`the buyer ${wallet.address} holds ${funded.held} base units of ANYONE` +
       (funded.minted > 0n ? ` (sent ${funded.minted} by the faucet over the circuit, tx ${funded.hash})` : ' (already funded)'));

    // (iii) THE CHANNEL. The registry read, the approve, the openChannel and
    //       the setTotalDeposit are the client's own; every one of them leaves
    //       through the proxy because `proxyRpc` is on. This is the step
    //       `proxyRpc: false` would take off the overlay.
    const t1 = Date.now();
    let opened = await client.channel.open({ deposit: DEPOSIT });

    // IS THE CHANNEL THE STORE NAMES STILL ON THE CHAIN? Two ways it might not
    // be, both routine here and neither the network's doing:
    //   - anvil keeps no state across a restart, so `make down` + `make up-hs`
    //     leaves a fresh chain under a channel store that remembers the old
    //     one. The node then answers F01 "no record of that channel";
    //   - a channel opened by someone else with no collateral is ADOPTED as
    //     found (openOrAdopt takes an open channel deposit and all), and a
    //     claim above the counterparty's on-chain deposit could never be
    //     redeemed, so the node answers F03.
    // Both are cheaper to detect here, in one chain read, than to diagnose from
    // a refusal after a claim has been signed.
    const collateralOf = async () => BigInt((await client.channel.state({ onChain: true })).onChain?.deposit ?? 0);
    if (await collateralOf() < price) {
      info(`the chain does not back channel ${opened.channelId} (on-chain collateral below ${price}) —`);
      info('anvil is wiped by any restart, so a kept channel store can outlive its chain. Starting fresh.');
      await client.close?.().catch(() => {});
      // The watermark AND the binding beside it (`<store>.peers.json`): a
      // binding left behind without its watermark refuses to open at all.
      for (const f of [STORE, STORE.replace(/\.json$/, '.peers.json')]) rmSync(f, { force: true });
      client = await makeClient();
      opened = await client.channel.open({ deposit: DEPOSIT });
      const collateral = await collateralOf();
      if (collateral < price) {
        throw new SandboxFault(
          `channel ${opened.channelId} holds ${collateral} of on-chain collateral, less than the ${price} a bundle costs,\n` +
          '  even after opening a fresh one. A claim above the counterparty deposit could never be redeemed.');
      }
    }
    const channelId = opened.channelId;
    ok(`channel ${channelId} status=${opened.status ?? 'open'}, collateral ${await collateralOf()} (read back off the chain)` +
       ` — ${((Date.now() - t1) / 1000).toFixed(1)}s of JSON-RPC, none of it on clearnet`);
    const before = await clientBook(channelId);

    // (iv) THE PURCHASE. One paid packet, sealed to the node that opens it,
    //      priced by that node, turned into a signed claim by the claim minter
    //      and blind-signed by the issuer.
    step('3. the paid purchase — one real bundle of blind signatures, over the circuit');
    const quoted = await client.price('g.anyone.credentials');
    if (quoted === null) throw new SandboxFault('the node quoted no price for g.anyone.credentials');
    ok(`the node prices g.anyone.credentials at ${quoted} (asked over the overlay)`);

    // 10 blanks of 256 bytes, the issuer's configured bundle size and blank
    // size. The leading zero byte is load-bearing: RFC 9474 requires a blinded
    // message below the RSA modulus, and a uniformly random 256-byte value
    // exceeds a 2048-bit modulus about half the time. Structurally valid rather
    // than genuinely blinded — what is proved here is the PAID PATH over a
    // circuit, not RSABSSA (the issuer's own tests cover that).
    const blank = () => { const b = Buffer.from(randomBytes(256)); b[0] = 0; return b.toString('base64'); };
    const bought = await client.send('g.anyone.credentials', {
      method: 'POST',
      target: 'v1/bundles',
      headers: { 'idempotency-key': `smoke-hs-${Date.now()}-${attempt}` },
      body: { epoch: doc.epoch_id, blinded_blanks: Array.from({ length: 10 }, blank) },
    });
    if (!bought.fulfilled) {
      throw new SandboxFault(
        `the purchase was refused ${bought.code} (refusedBy ${bought.refusedBy}, ` +
        `accumulatedCost ${bought.accumulatedCost}): ${bought.message ?? ''}\n` +
        '  A circuit carried it and the sandbox refused it.');
    }
    if (bought.status !== 200 && bought.status !== 201) {
      throw new SandboxFault(`the purchase was PAID but answered ${bought.status}: ${bought.text().slice(0, 300)}`);
    }
    const bundle = bought.json();
    if (bundle.epoch !== doc.epoch_id) throw new SandboxFault(`bundle epoch ${bundle.epoch} != ${doc.epoch_id}`);
    if (!Array.isArray(bundle.blind_signatures) || bundle.blind_signatures.length !== 10) {
      throw new SandboxFault(`the issuer returned ${bundle.blind_signatures?.length} blind signatures, not 10`);
    }
    ok(`the issuer blind-signed 10 blanks under epoch ${bundle.epoch}`);
    if (BigInt(bought.claim?.amount ?? 0) !== price) {
      throw new SandboxFault(`the claim carried ${bought.claim?.amount}, not the node's price ${price}`);
    }
    ok(`the buyer paid ${bought.claim?.amount} base units for it — the node's own price, no hub in the path`);

    // (v) THE PAYEE'S BOOK, read out of band. Claims are journaled on the far
    //     side of the same round trip, so poll briefly.
    step('4. the payee\'s own book says it was paid — on the channel this buyer opened');
    let after = before;
    for (let i = 0; i < 20 && after - before < price; i++) { await sleep(1000); after = await clientBook(channelId); }
    if (after - before < price) {
      throw new SandboxFault(
        `anytoon-connector's client book on ${channelId} advanced by ${after - before}, not ${price}.`);
    }
    ok(`anytoon-connector's client book on ${channelId} advanced by ${after - before} (>= ${price})`);
    return { address, channelId, paid: after - before };
  } catch (e) {
    throw classify(e, true);
  } finally {
    await client.close?.().catch(() => {});
    await transport.close().catch(() => {});
  }
}

// ── main ──────────────────────────────────────────────────────────────────
console.log('\x1b[1mTOON sandbox — hidden-service rehearsal (make up-hs first)\x1b[0m');
console.log('This dials the REAL Anyone network. There are two ways it can end badly and');
console.log('they are not the same event: exit 1 = this sandbox is wrong; exit 75 = the');
console.log('overlay would not carry. Every failure below says which, and on what evidence.');

let target;
try {
  target = await preflight();
} catch (e) {
  console.error('\n\x1b[31m=== SANDBOX-SIDE FAILURE — nothing was dialled ===\x1b[0m\n');
  console.error(`  ${classify(e, false).message}\n`);
  process.exit(1);
}

let lastNetworkFault = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    const result = await purchase(target, attempt);
    console.log(`\n\x1b[32mSMOKE-HS OK: one paid credentials bundle, bought at ${result.address}\x1b[0m`);
    console.log(`\x1b[32mthrough ${SOCKS_PROXY} with the chain RPC on the same circuit —\x1b[0m`);
    console.log(`\x1b[32msettled on channel ${result.channelId} (${result.paid} base units), and the payee's book agrees.\x1b[0m`);
    process.exit(0);
  } catch (e) {
    if (e instanceof NetworkFault) {
      lastNetworkFault = e;
      console.log(`\n  \x1b[33mcarriage failed\x1b[0m (attempt ${attempt}/${ATTEMPTS}): ${e.message}`);
      if (attempt < ATTEMPTS) {
        console.log('  retrying — a circuit that would not build often builds on the next try.');
        await sleep(10_000);
      }
      continue;
    }
    console.error('\n\x1b[31m=== SANDBOX-SIDE FAILURE ===\x1b[0m\n');
    console.error(`  ${e.message}\n`);
    console.error('  A circuit carried bytes for this run, or never had to. This is a fault in');
    console.error('  the sandbox\'s own configuration, not in the Anyone network.\n');
    process.exit(1);
  }
}

// Every attempt died on the carriage, and preflight had already proved this
// side. Say so plainly, and hand over the daemons' own account of themselves.
console.error('\n\x1b[33m=== NETWORK-SIDE FAILURE (the Anyone network) ===\x1b[0m\n');
console.error(`  ${ATTEMPTS} attempt(s), every one lost on the carriage. The last of them:`);
console.error(`    ${lastNetworkFault?.message}\n`);
console.error('  What preflight had already established, before anything was dialled:');
console.error(`    - the \`anon\` daemon is healthy: it holds ${target.address}`);
console.error('      and its own log says Bootstrapped 100%');
console.error('    - the buyer\'s proxy is bootstrapped and listening');
console.error('    - the anytoon node publishes that exact address as its own endpoint');
console.error('  So the configuration on this side is demonstrably right, and what did not');
console.error('  happen is a circuit to the descriptor. That is a bad day on a third-party');
console.error('  network rather than a defect here. Try again later.\n');
console.error('  The daemons\' own last words:');
console.error(`    anon:        ${lastWords('anon')}`);
console.error(`    anon-client: ${lastWords('anon-client')}\n`);
process.exit(75);
