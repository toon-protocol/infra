#!/usr/bin/env node
//
// MILESTONE 4 ACCEPTANCE TEST (TOON_Network #12, ticket #44; spec §10, ADR
// 0008): a HIDDEN PROVIDER end to end, on the `hs` profile, against the real
// Anyone network. `make up-hs` first; `make smoke-m4`.
//
// The tenant is an ordinary buyer with a SOCKS proxy — the `anon-client`
// daemon on 127.0.0.1:19050 — and the address the directory gave it. Nothing
// of the hidden provider is published to the host: its connector, its chain
// RPC and every lease it sells are reached over a circuit, or not at all.
//
//     node ──► anon-client (SOCKS5h)
//                  ├── the connector:  http://<provider>.anyone/ilp
//                  ├── the chain RPC:  http://<provider>.anyone:8545
//                  └── the lease:      ssh -p <ssh_port> tenant@<lease>.anyone
//
//   0.  PREFLIGHT, sandbox-side, nothing dialled on the overlay: the `hs`
//       services are up, the three daemons healthy, the buyer's proxy
//       listening; the rendered configs name the address `anon-hs` generated
//       and the connector advertises exactly it (out of band, on the private
//       compose network: a client dials what a node publishes); the routes
//       are priced as conf/provider-hs.toml says; and THE PRIVATE-RPC GATE —
//       the provider's `settlement_rpc_url`, its connector's two settlement
//       RPCs and its publisher's are the sandbox chains (compose service
//       names), never a public URL. The host's own public IP is read here,
//       on clearnet, to compare against in step 5
//   1.  THE DIRECTORY, off the relay: the Profile has `hidden: true`, NO
//       `host`, and a `connector_url` at the `.anyone` address; every Listing
//       carries ["l","hidden:true","toon.network"] and the two public
//       providers' Listings carry no such label (the relay does the search:
//       `#l = hidden:true` returns the hidden provider's alone); an unexpired
//       Liveness says the full capacity
//   2.  THE TENANT, over the circuit: a buyer that has only the address and
//       the proxy reads the connector's self-description, mints its mock USDC
//       and opens an EVM channel — every JSON-RPC call through the same SOCKS
//       proxy (`proxyRpc` is the client's default and nothing here turns it
//       off); the free availability route answers { would_run: true } and
//       spends no claim
//   3.  THE SPAWN, paid on the connector's `.anyone` endpoint: the answer's
//       `access.host` is a PER-LEASE `.anyone` address — not the connector's,
//       not an IP; no IP appears anywhere in the answer; the free, signed
//       status returns the same access. On the host daemon the lease is
//       THREE containers (toon-<id>-egress owning the namespace on the
//       egress network alone, toon-<id> sharing it, toon-<id>-ingress
//       publishing the ports), the id in the hidden provider's own range,
//       the daemon holding the lease's address as a detached service, and
//       the forwarder answering an SSH banner at the host port the address
//       is forwarded to — so if the circuit below fails, this side is proven
//   4.  SSH TO THE PER-LEASE ADDRESS through the proxy (a `nc -X 5`
//       ProxyCommand), with the tenant's key; the lease's published port
//       answers at the same address
//   5.  FROM INSIDE: a public what-is-my-IP service answers an `anon` exit,
//       not this host's address (and not any address this host has); a
//       direct dial fails — `ip route` names nothing but the egress subnet
//       and the gateway, ICMP to a clearnet address is unanswered, and a
//       dial to the host at 172.17.0.1 (`anon.forward_host`: the very
//       address this lease's own ports are forwarded to) is reset with no
//       bytes back. A bare TCP connect proves nothing here, because the
//       transparent proxy completes every handshake itself; the dial has to
//       carry bytes
//   6.  TERMINATE, free and signed: { ended: termination }; the daemon no
//       longer holds the lease's address, the address no longer answers
//       through the proxy, no `toon-<id>*` container exists on the host
//       daemon, and the next Liveness has the capacity back
//   7.  THE BOOK: the hidden connector's client book on the tenant's channel
//       grew by exactly the listing price times the paid packets, read out of
//       band on the private network — there is no hub in this path (spec
//       Appendix A allows a direct client channel; decision on #12)
//
// TWO VERDICTS, as `smoke-hs` (scripts/smoke-hs.mjs) draws them:
//   exit 1   SANDBOX-SIDE — something here is wrong, and the message says what
//   exit 75  NETWORK-SIDE (EX_TEMPFAIL) — preflight passed, this side of every
//            dial was proven, and a circuit still would not carry. Try later.
// The first reach of the connector is retried (SMOKE_HS_ATTEMPTS, default 3);
// between attempts the BUYER'S proxy is restarted, because a buyer that fetched
// the provider's descriptor before `anon-hs` was last recreated keeps a stale
// one and waits 120 s for a circuit that cannot build — a sandbox artefact,
// not the network's. A carriage failure AFTER the spawn is not retried (a
// second spawn is a second lease): the lease is terminated if a circuit still
// carries, and otherwise expires on its own.
//
// THE LISTING: `basic` (conf/provider-hs.toml, 180 s Lease Interval), not the
// 30 s `smoke` tier the other milestones buy — a fresh `.anyone` address needs
// its descriptor published and fetched before the first circuit builds, and
// that is the slow part of this run. TOON_M4_LISTING overrides it. About two
// to three minutes end to end on a good day.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { ToonClient } from '@toon-protocol/client';
import { createHiddenServiceTransport } from '@toon-protocol/client/hidden-service';
import { HDNodeWallet, Interface } from 'ethers';
import {
  ROOT, MNEMONIC, K_PROFILE, K_LISTING, K_LIVENESS, TOON_LABEL, IMAGE, SSH_USER, SWEEP_S,
  providerOf, reporter, sleep, jstr, nowSec, waitFor,
  relayRead, relayReadUntil, directoryFilter, tagValues, hasTag, clientBookOnChannel,
  docker, containerState, newTenant, leaseRequest, newWorkloadId,
} from './lib/provider-smoke.mjs';

const { step, ok, bad, assert, fatal, done, failures } = reporter('MILESTONE 4 SMOKE');
const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;

const P = providerOf('provider-hs');
const L = P.listing(process.env.TOON_M4_LISTING ?? 'basic');
const SPAWN_ROUTE = P.spawnRoute(L.name, L.version);
const CADENCE = Number(P.confValue('liveness_cadence_s'));
const ID_RANGE = [Number(P.confValue('workload_id_range_start')), Number(P.confValue('workload_id_range_end'))];
const FORWARD_HOST = P.confValue('forward_host'); // where the daemon forwards a lease's address to: this host
const SOCKS_PORT = Number(process.env.ANON_SOCKS_PORT ?? 19050);
const SOCKS_PROXY = process.env.TOON_SOCKS_PROXY ?? `socks5h://127.0.0.1:${SOCKS_PORT}`;
const ATTEMPTS = Number(process.env.SMOKE_HS_ATTEMPTS ?? 3);
const RENDERED = join(ROOT, 'conf', '.rendered');
// The buyer: anvil's test mnemonic at ACCOUNT INDEX 6 — the one README §2
// leaves free (0 is `make smoke`'s, 1-3 the three publishers', 5 `smoke-hs`'s).
// Not seeded by any job: it mints its own mock USDC below, over the circuit.
const ACCOUNT_INDEX = 6;
const EVM_CHAIN_ID = 31337;
const DEPOSIT = 10_000_000n; // 10 mock USDC at 6 dp; a spawn is 1000
const STORE = join(ROOT, '.toon-client', 'm4-hidden-buyer.json');
const ANYONE_ADDRESS = /^[a-z2-7]{56}\.anyone$/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const WHAT_IS_MY_IP = 'https://api.ipify.org';

// ── the two verdicts ─────────────────────────────────────────────────────
class SandboxFault extends Error {}
class NetworkFault extends Error {}
const CARRIAGE = /socks|proxy|host unreachable|hostunreachable|connection refused|econnrefused|etimedout|timed ?out|timeout|econnreset|socket hang up|fetch failed|und_err|network|circuit|dns|other than a valid|http 5|ttl expired|banner exchange|connection closed/i;
function classify(err, whileDialing) {
  if (err instanceof SandboxFault || err instanceof NetworkFault) return err;
  const message = `${err?.message ?? err}${err?.cause ? ` (cause: ${err.cause})` : ''}`;
  if (whileDialing && CARRIAGE.test(message)) return new NetworkFault(message);
  return new SandboxFault(message);
}

// ── docker, with the profiles that make compose see the `hs` services ────
const composeHs = (...args) => docker('compose', '--profile', 'full', '--profile', 'hs', ...args);
function health(service) {
  const id = composeHs('ps', '-q', service).trim();
  if (!id) return 'absent';
  try { return docker('inspect', '-f', '{{.State.Health.Status}}', id).trim(); } catch { return 'unknown'; }
}
function lastWords(service) {
  try {
    const log = composeHs('logs', '--tail', '400', '--no-log-prefix', service);
    return log.split('\n').filter((l) => /Bootstrapped|Giving up|warn|err/i.test(l) && !/anyone_hosts is unsigned/.test(l))
      .slice(-4).join('\n                 ') || '(nothing notable in the last 400 lines)';
  } catch { return '(could not read the log)'; }
}
/** `sh -c <script>` inside a compose service; stdout. */
const execIn = (service, script) => composeHs('exec', '-T', service, 'sh', '-c', script);
/** The `anon-hs` control port, driven from the provider's container with the cookie it mounts (README §6.8). */
function anonControl(...commands) {
  const script = 'C=$(od -An -tx1 -v /var/lib/anon/control/control_auth_cookie | tr -d " \\n"); '
    + `printf "AUTHENTICATE %s\\r\\n${commands.map((c) => `${c}\\r\\n`).join('')}QUIT\\r\\n" "$C" | curl -s --max-time 10 telnet://${P.confValue('addr')}`;
  return execIn('provider-hs', script);
}
/**
 * The service ids the daemon holds as DETACHED onion services — every live
 * lease's address, and nothing else. `250-onions/detached=` on one line when
 * there are none; a `250+` multi-line reply ended by a lone `.` otherwise.
 */
function detachedAddresses() {
  const out = anonControl('GETINFO onions/detached');
  const multi = out.match(/250\+onions\/detached=\r?\n([\s\S]*?)\r?\n\.\r?\n/);
  if (multi) return multi[1].split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return (out.match(/250-onions\/detached=(.*)/)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
}
function socksPortOpen(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const settle = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => settle(true));
    s.once('timeout', () => settle(false));
    s.once('error', () => settle(false));
  });
}
/** The first line a TCP server sends on connect (an SSH banner), or '' — closed, refused or silent for `timeoutMs`. */
function bannerFrom(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let got = '';
    const s = connect({ host, port });
    const settle = () => { s.destroy(); resolve(got.split('\n')[0].trim()); };
    s.setTimeout(timeoutMs, settle);
    s.on('data', (d) => { got += d.toString(); if (got.includes('\n')) settle(); });
    s.once('error', settle);
    s.once('close', settle);
  });
}
/** `bannerFrom`, retried for `seconds`: a fresh sshd answers nothing until it is up. */
const bannerUntil = (host, port, seconds) => waitFor(async () => (await bannerFrom(host, port)) || null, seconds, 2000);
/** A private host: loopback, a private IPv4 range, or a compose service name (which resolves only inside the project). */
function isPrivateHost(url, services) {
  const host = new URL(url).hostname;
  return host === 'localhost' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || services.includes(host);
}

// ── SSH through the proxy ────────────────────────────────────────────────
// OpenBSD nc's `-X 5 -x` speaks SOCKS5 to the proxy and hands it the HOSTNAME
// (it never resolves a non-numeric host itself), which is what `.anyone`
// needs: the daemon resolves it, nothing on this host ever asks a resolver.
const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=90',
  '-o', `ProxyCommand=nc -X 5 -x 127.0.0.1:${SOCKS_PORT} %h %p`,
];
function sshOverSocks(tenant, access, command) {
  try {
    const out = execFileSync('ssh', [...SSH_OPTS, '-i', tenant.keyPath, '-p', String(access.ssh_port), `${SSH_USER}@${access.host}`, command],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message).trim().split('\n').pop() };
  }
}
/** SSH in, retried for `seconds`: a fresh sshd AND a fresh descriptor are both being waited for. */
async function sshOverSocksUntil(tenant, access, seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  let tries = 0;
  do {
    tries += 1;
    last = sshOverSocks(tenant, access, 'echo toon-ssh-ok; id -un');
    if (last.ok) {
      const [marker, user = ''] = last.out.trim().split('\n');
      return { ok: marker === 'toon-ssh-ok', user, tries };
    }
    await sleep(3000);
  } while (Date.now() < deadline);
  return { ok: false, err: last?.err, tries };
}
/** What a TCP server at `host:port` sends on connect through the proxy (an SSH banner), or '' — the proxy refused, or nothing came within `maxTimeS`. */
function bannerOverSocks(host, port, maxTimeS) {
  try {
    return execFileSync('nc', ['-X', '5', '-x', `127.0.0.1:${SOCKS_PORT}`, '-w', String(maxTimeS), host, String(port)],
      { encoding: 'utf8', input: '', timeout: (maxTimeS + 5) * 1000, stdio: ['pipe', 'pipe', 'ignore'] }).split('\n')[0].trim();
  } catch (e) {
    return String(e.stdout ?? '').split('\n')[0].trim();
  }
}
/** One GET through the proxy, `curl --socks5-hostname`; { ok, body } or { ok: false, err }. */
function getOverSocks(url, maxTimeS) {
  try {
    const body = execFileSync('curl', ['-sS', '--max-time', String(maxTimeS), '--socks5-hostname', `127.0.0.1:${SOCKS_PORT}`, url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, body };
  } catch (e) {
    return { ok: false, err: String(e.stderr ?? e.message).trim().split('\n').pop() };
  }
}

// ── the hidden lease on the host daemon ──────────────────────────────────
/** The lease's three containers by the forwarder publishing `sshPort`, polled for up to `seconds`; null if none appears. */
async function findHiddenLease(sshPort, seconds = 15) {
  return waitFor(async () => {
    const lines = docker('ps', '--filter', 'name=toon-', '--format', '{{.Names}}\t{{.Ports}}').trim().split('\n').filter(Boolean);
    const forwarder = lines.find((l) => /^toon-\d+-ingress\t/.test(l) && l.includes(`:${sshPort}->${sshPort}/tcp`));
    if (!forwarder) return null;
    const id = Number(forwarder.match(/^toon-(\d+)-ingress/)[1]);
    return { id, workload: `toon-${id}`, egress: `toon-${id}-egress`, ingress: `toon-${id}-ingress` };
  }, seconds, 1000);
}
const inspect = (name, format) => docker('inspect', '-f', format, name).trim();
/** Every `toon-<id>*` container of this lease still on the daemon, running or not. */
const leaseContainers = (id) => docker('ps', '-a', '--filter', `name=^toon-${id}(-egress|-ingress)?$`, '--format', '{{.Names}}').trim().split('\n').filter(Boolean);

// ── the book, out of band ────────────────────────────────────────────────
// The hidden connector publishes no host port, so its operator endpoint is
// read from inside the provider's container on the private compose network.
// An ASSERTION ABOUT the purchase, not part of it — as smoke-hs reads its
// payee's book on a clearnet edge the buyer never used.
function hiddenClientBook(channelId) {
  const token = readFileSync(join(ROOT, 'keys', 'toon', 'provider-hs-connector', 'operator-bearer.token'), 'utf8').trim();
  const rows = JSON.parse(execIn('provider-hs', `curl -sf -H 'authorization: Bearer ${token}' http://provider-hs-connector:3000/claims`));
  // An EVM channel is keyed `evm:<id>` or bare, by connector version; read both.
  const bare = clientBookOnChannel(rows, channelId);
  const prefixed = clientBookOnChannel(rows, `evm:${channelId}`);
  return bare > prefixed ? bare : prefixed;
}

// ── raw JSON-RPC over the circuit, for the mint that precedes a client ───
function rpcOver(fetchImpl, url) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!res.ok) throw new Error(`chain RPC ${method} -> HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`chain RPC ${method} -> ${body.error.message}`);
    return body.result;
  };
}
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)']);
/** The buyer holds `want` mock USDC: MockERC20.mint is ungated on the sandbox deploy (scripts/seed-toon-evm.sh), so it mints its own, paying gas from anvil's ETH. */
async function fundBuyer(rpc, wallet, token, want) {
  const balanceOf = async () => BigInt(ERC20.decodeFunctionResult('balanceOf',
    await rpc('eth_call', [{ to: token, data: ERC20.encodeFunctionData('balanceOf', [wallet.address]) }, 'latest']))[0]);
  const held = await balanceOf();
  if (held >= want) return { held, minted: 0n };
  const data = ERC20.encodeFunctionData('mint', [wallet.address, want]);
  const [nonce, gasPrice, gasLimit] = await Promise.all([
    rpc('eth_getTransactionCount', [wallet.address, 'pending']), rpc('eth_gasPrice'),
    rpc('eth_estimateGas', [{ from: wallet.address, to: token, data }]),
  ]);
  const raw = await wallet.signTransaction({ type: 0, to: token, data, chainId: EVM_CHAIN_ID, nonce: Number(nonce), gasPrice: BigInt(gasPrice), gasLimit: BigInt(gasLimit) * 2n });
  const hash = await rpc('eth_sendRawTransaction', [raw]);
  let receipt = null;
  for (let i = 0; i < 60 && receipt === null; i++) { receipt = await rpc('eth_getTransactionReceipt', [hash]); if (receipt === null) await sleep(500); }
  if (receipt === null) throw new Error(`the mint ${hash} never got a receipt`);
  if (BigInt(receipt.status) !== 1n) throw new SandboxFault(`the mint ${hash} reverted`);
  return { held: await balanceOf(), minted: want, hash };
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. PREFLIGHT — this sandbox's own doing, nothing dialled on the overlay
// ═══════════════════════════════════════════════════════════════════════════
async function preflight() {
  step('0. preflight — this sandbox\'s own configuration (nothing dialled on the overlay yet)');
  const wanted = ['anon', 'anon-client', 'anon-hs', 'hs-ingress', 'hs-provider-ingress', 'provider-hs', 'provider-hs-connector', 'directory-publisher-hs', 'relay', 'anvil', 'provider', 'provider2'];
  const running = composeHs('ps', '--format', '{{.Service}} {{.State}}');
  const missing = wanted.filter((s) => !new RegExp(`^${s} running`, 'm').test(running));
  if (missing.length > 0) throw new SandboxFault(`not running: ${missing.join(', ')} — \`make up-hs\` first`);
  ok('the hidden provider, its daemon, connector, publisher and forwarders, both other providers, the relay and anvil are up');
  const services = composeHs('ps', '--services', '-a').trim().split('\n');

  for (const daemon of ['anon', 'anon-hs', 'anon-client']) {
    const h = health(daemon);
    if (h !== 'healthy') {
      throw new SandboxFault(`the \`${daemon}\` daemon is ${h}, so no circuit can be expected of it:\n                 ${lastWords(daemon)}\n`
        + '  `make up-hs` waits for all three. A daemon that never goes healthy is the Anyone network far\n'
        + '  more often than this repo; one that EXITED at once is a config fault (conf/anonrc*).');
    }
  }
  ok('all three daemons are healthy: each holds its address and says Bootstrapped 100%');
  if (!(await socksPortOpen(SOCKS_PORT))) throw new SandboxFault(`nothing listens on 127.0.0.1:${SOCKS_PORT}: the buyer has no way onto the network (ANON_SOCKS_PORT?)`);
  ok(`the buyer's proxy is listening on ${SOCKS_PROXY}`);

  // The address, from the daemon that generated it, and the configs that name it.
  const address = execIn('anon-hs', 'cat /var/lib/anon/hidden_service/hostname').trim();
  if (!ANYONE_ADDRESS.test(address)) throw new SandboxFault(`anon-hs holds no usable address: '${address}'`);
  const providerConf = join(RENDERED, 'provider-hs.toml');
  if (!existsSync(providerConf)) throw new SandboxFault(`${providerConf} does not exist: \`make up-hs\` renders it (or \`make hs-address\`)`);
  const rendered = readFileSync(providerConf, 'utf8');
  const connectorUrl = rendered.match(/^connector_url\s*=\s*"([^"]+)"/m)?.[1];
  if (connectorUrl !== `http://${address}/ilp`) throw new SandboxFault(`the rendered provider config names connector_url ${connectorUrl}, not http://${address}/ilp — re-run \`make hs-address\``);
  ok(`the hidden provider's address: ${address} — the daemon's, and the rendered provider config's connector_url`);
  let described;
  try {
    described = JSON.parse(execIn('provider-hs', 'curl -sf http://provider-hs-connector:3000/ilp'));
  } catch (e) {
    throw new SandboxFault(`could not read the hidden connector's self-description on the private network: ${e.message}`);
  }
  if (described.httpEndpoint !== `http://${address}/ilp`) {
    throw new SandboxFault(`provider-hs-connector publishes ${JSON.stringify(described.httpEndpoint)}, not "http://${address}/ilp".\n`
      + '  A client dials what a node publishes. `make up-hs` recreates it against conf/.rendered/connector-provider-hs.toml.');
  }
  ok(`and provider-hs-connector publishes exactly that as its own endpoint (read out of band on the compose network; no port on the host)`);
  const prices = Object.fromEntries((described.routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
  if (prices[SPAWN_ROUTE] !== L.price || prices[P.extendRoute(L.name, L.version)] !== L.price) {
    throw new SandboxFault(`the connector prices ${SPAWN_ROUTE} at ${prices[SPAWN_ROUTE]} and .extend at ${prices[P.extendRoute(L.name, L.version)]}, not conf/${P.confFile}'s ${L.price}`);
  }
  for (const free of ['availability', 'status', 'terminate']) {
    if (prices[`${P.ilpAddress}.${free}`] !== 0n) throw new SandboxFault(`${P.ilpAddress}.${free} is priced ${prices[`${P.ilpAddress}.${free}`]}, not 0`);
  }
  ok(`it terminates ${SPAWN_ROUTE} and .extend at ${L.price} and the three free routes at 0 — no hub in this path, so nothing adds a fee`);
  const evm = (described.settlements ?? []).find((s) => s.chain === `evm:${EVM_CHAIN_ID}`);
  if (!evm?.tokenAddress) throw new SandboxFault(`the connector publishes no evm:${EVM_CHAIN_ID} settlement for this buyer to pay on`);
  ok(`it settles on evm:${EVM_CHAIN_ID} in ${evm.tokenAddress} (mock USDC, ${evm.decimals ?? 6} dp) — the chain its address publishes on virtual port 8545`);

  // THE PRIVATE-RPC GATE (spec §10): every chain read of the hidden provider's
  // stays on this side. Three configs, four URLs, all compose service names.
  const rpcs = [
    ['the provider\'s [anon] settlement_rpc_url', rendered.match(/^settlement_rpc_url\s*=\s*"([^"]+)"/m)?.[1]],
  ];
  const connectorConf = readFileSync(join(RENDERED, 'connector-provider-hs.toml'), 'utf8');
  for (const [chain, block] of [['evm', /\[settlement\.evm\][\s\S]*?rpc_url\s*=\s*"([^"]+)"/], ['solana', /\[settlement\.solana\][\s\S]*?rpc_url\s*=\s*"([^"]+)"/]]) {
    rpcs.push([`provider-hs-connector's [settlement.${chain}] rpc_url`, connectorConf.match(block)?.[1]]);
  }
  const publisherEnv = docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', composeHs('ps', '-q', 'directory-publisher-hs').trim());
  rpcs.push(['directory-publisher-hs\'s TOON_RPC_URL', publisherEnv.match(/^TOON_RPC_URL=(.+)$/m)?.[1]]);
  for (const [what, url] of rpcs) {
    if (!url) throw new SandboxFault(`${what} is not set`);
    if (!isPrivateHost(url, services)) throw new SandboxFault(`${what} is ${url}: not loopback, not a private range, not a compose service — a public RPC links this provider's location to its on-chain identity`);
  }
  ok(`the private-RPC gate holds: ${rpcs.map(([w, u]) => `${w.split("'")[0].trim()} ${u}`).join('; ')} — the sandbox chains, every one`);

  // The host's own public address, on clearnet: what step 5 must NOT see.
  let hostIp;
  try {
    hostIp = (await (await fetch(WHAT_IS_MY_IP, { signal: AbortSignal.timeout(15_000) })).text()).trim();
  } catch (e) {
    throw new SandboxFault(`this host could not ask ${WHAT_IS_MY_IP} for its own public address (${e.message}); step 5 has nothing to compare an exit against`);
  }
  if (!IPV4.test(hostIp)) throw new SandboxFault(`${WHAT_IS_MY_IP} answered '${hostIp}', not an IPv4 address`);
  const localIps = Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4').map((i) => i.address);
  ok(`this host's public address is ${hostIp} (and it holds ${localIps.length} local IPv4 addresses) — what no workload may observe`);

  return { address, described, hostIp, localIps, token: evm.tokenAddress };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE DIRECTORY, off the relay
// ═══════════════════════════════════════════════════════════════════════════
async function directory(address) {
  step('1. the directory on the relay: a Profile with hidden: true and no host, Listings labelled hidden:true, a Liveness at capacity');
  const profiles = await relayReadUntil(directoryFilter(K_PROFILE, P), 'profile', 60);
  if (profiles.length === 0) throw new SandboxFault(`no Provider Profile from ${P.pubkey} on the relay — \`docker compose --profile hs logs directory-publisher-hs provider-hs\``);
  const profile = JSON.parse(profiles[0].content);
  assert(profiles.length === 1 && hasTag(profiles[0], ['L', TOON_LABEL]) && profile.ilp_address === P.ilpAddress,
    `exactly one Profile from ${P.pubkey.slice(0, 12)}…, tagged ["L","${TOON_LABEL}"], ilp_address ${profile.ilp_address}`);
  assert(profile.hidden === true, `it says hidden: ${jstr(profile.hidden)}`);
  assert(!('host' in profile), `it carries no \`host\` at all (keys: ${Object.keys(profile).join(', ')})`);
  assert(profile.connector_url === `http://${address}/ilp`, `its connector_url is the .anyone address: ${profile.connector_url}`);
  assert(!IPV4.test(profiles[0].content), 'no IPv4 address appears anywhere in the Profile');

  const listingEvents = await relayReadUntil(directoryFilter(K_LISTING, P), 'listings', 60);
  const names = listingEvents.map((e) => tagValues(e, 'd')[0]?.[0]).sort();
  const wanted = P.listings().map((l) => l.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(wanted), `one Listing per [[listings]] entry in conf/${P.confFile}: ${names.join(', ')}`);
  assert(listingEvents.length > 0 && listingEvents.every((e) => hasTag(e, ['l', 'hidden:true', TOON_LABEL])),
    `every one of them carries ["l","hidden:true","${TOON_LABEL}"]`);
  const mine = listingEvents.find((e) => tagValues(e, 'd')[0]?.[0] === L.name);
  if (mine) {
    const c = JSON.parse(mine.content);
    assert(c.version === L.version && BigInt(c.price) === L.price && c.lease_interval_s === L.lease_interval_s,
      `the \`${L.name}\` Listing says v${c.version}, ${c.price} uUSDC per ${c.lease_interval_s}s Lease Interval — what this run buys`);
  }
  for (const pub of ['provider', 'provider2']) {
    const events = await relayRead(directoryFilter(K_LISTING, pub), `listings-${pub}`);
    assert(events.length > 0 && events.every((e) => !e.tags.some((t) => t[0] === 'l' && t[1] === 'hidden:true')),
      `${pub}'s ${events.length} Listings carry no hidden label`);
  }
  // The relay does the search: a tenant filtering for hidden compute by tag alone.
  const byLabel = await relayRead({ kinds: [K_LISTING], '#l': ['hidden:true'], '#L': [TOON_LABEL] }, 'by-label');
  assert(byLabel.length === listingEvents.length && byLabel.every((e) => e.pubkey === P.pubkey),
    `#l = hidden:true on the relay returns exactly the hidden provider's ${byLabel.length} Listings and nobody else's`);

  const patience = 2 * L.lease_interval_s + SWEEP_S + CADENCE;
  let liveness = null;
  const settled = await waitFor(async () => {
    const found = await relayRead(directoryFilter(K_LIVENESS, P), 'liveness').catch(() => []);
    liveness = found[0] ?? null;
    return found.length === 1 && JSON.parse(found[0].content).available?.[L.name] === L.capacity;
  }, patience, 2000);
  if (!liveness) throw new SandboxFault(`no Liveness from ${P.pubkey} on the relay`);
  const expiration = Number(tagValues(liveness, 'expiration')[0]?.[0]);
  assert(expiration > nowSec() && hasTag(liveness, ['L', TOON_LABEL]), `exactly one Liveness, unexpired (${expiration - nowSec()}s out)`);
  assert(settled === true, `available.${L.name} = ${JSON.parse(liveness.content).available?.[L.name]} = capacity ${L.capacity} - 0 live leases`);
}
/** The next Liveness created strictly after `afterSec`, or null within cadence + 10 s. */
const livenessAfter = (afterSec) => waitFor(async () => {
  const found = await relayRead(directoryFilter(K_LIVENESS, P), 'liveness-next').catch(() => []);
  return found.find((e) => e.created_at > afterSec) ?? null;
}, CADENCE + 10, 2000);

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE TENANT — a buyer with only the address and the proxy
// ═══════════════════════════════════════════════════════════════════════════
/** The first byte on the overlay: the connector's self-description through the proxy. Retried, with the buyer's proxy restarted in between. */
async function reachConnector(address) {
  step('2. the circuit — the buyer reads the connector through the proxy, then funds itself and opens a channel over the same circuit');
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const t0 = Date.now();
    const got = getOverSocks(`http://${address}/ilp`, 130);
    if (got.ok) {
      const desc = JSON.parse(got.body);
      if (desc.httpEndpoint !== `http://${address}/ilp`) throw new SandboxFault(`over the circuit the connector publishes ${desc.httpEndpoint}`);
      ok(`a circuit reached the hidden connector in ${((Date.now() - t0) / 1000).toFixed(1)}s${attempt > 1 ? ` (attempt ${attempt})` : ''}: it publishes itself at ${desc.httpEndpoint}`);
      return;
    }
    lastErr = got.err;
    console.log(`  \x1b[33mcarriage failed\x1b[0m (attempt ${attempt}/${ATTEMPTS}, ${((Date.now() - t0) / 1000).toFixed(0)}s): ${got.err}`);
    if (attempt < ATTEMPTS) {
      // A buyer that fetched this descriptor before `anon-hs` was last recreated
      // holds a stale one and waits 120 s for a circuit that cannot build. A
      // fresh proxy fetches the current descriptor; ten seconds to bootstrap.
      console.log('  restarting the buyer\'s proxy (anon-client) in case it holds a stale descriptor, then retrying…');
      composeHs('restart', 'anon-client');
      const healthy = await waitFor(async () => health('anon-client') === 'healthy', 120, 3000);
      if (!healthy) throw new SandboxFault('anon-client did not come back healthy within 120s of a restart');
      await sleep(5000);
    }
  }
  throw new NetworkFault(`${ATTEMPTS} attempt(s) to reach http://${address}/ilp through ${SOCKS_PROXY} failed; the last: ${lastErr}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════════
console.log('\x1b[1mTOON sandbox — Milestone 4: the hidden provider, end to end (make up-hs first)\x1b[0m');
console.log('This dials the REAL Anyone network. exit 1 = this sandbox is wrong; exit 75 = the');
console.log('overlay would not carry. Every failure below says which, and on what evidence.');
console.log(`  listing ${L.name} v${L.version}: lease_interval_s ${L.lease_interval_s}, price ${L.price}, capacity ${L.capacity}; ids ${ID_RANGE[0]}-${ID_RANGE[1]}; cadence ${CADENCE}s`);

let target;
try {
  target = await preflight();
  await directory(target.address);
} catch (e) {
  console.error('\n\x1b[31m=== SANDBOX-SIDE FAILURE — nothing was dialled on the overlay ===\x1b[0m\n');
  console.error(`  ${classify(e, false).message}\n`);
  process.exit(1);
}
if (failures() > 0) {
  console.error(`\n\x1b[31m${failures()} directory assertion(s) failed before anything was dialled — sandbox-side.\x1b[0m`);
  process.exit(1);
}

let lease = null; // { tenant, workloadId, access, send } once spawned, for the cleanup below
let networkFault = null;
let client = null;
let transport = null;
try {
  await reachConnector(target.address);

  // ── 2. the buyer: funded and channelled over the circuit ───────────────
  const connector = `http://${target.address}`;
  const rpcUrl = `http://${target.address}:8545`;
  const wallet = HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${ACCOUNT_INDEX}`);
  transport = createHiddenServiceTransport(SOCKS_PROXY);
  const makeClient = () => ToonClient.create({
    connector, socksProxy: SOCKS_PROXY, mnemonic: MNEMONIC, accountIndex: ACCOUNT_INDEX,
    chain: 'evm', rpcUrl, channelStore: STORE, deposit: DEPOSIT, timeoutMs: 180_000,
  });
  const t0 = Date.now();
  const rpc = rpcOver(transport.fetch, rpcUrl);
  const chainId = BigInt(await rpc('eth_chainId'));
  if (chainId !== BigInt(EVM_CHAIN_ID)) throw new SandboxFault(`the chain behind ${rpcUrl} says chainId ${chainId}, not ${EVM_CHAIN_ID}`);
  const funded = await fundBuyer(rpc, wallet, target.token, DEPOSIT);
  ok(`the buyer ${wallet.address} (account index ${ACCOUNT_INDEX}) holds ${funded.held} mock USDC units${funded.minted > 0n ? ` — minted its own over the circuit, tx ${funded.hash}` : ' (already funded)'}; ${((Date.now() - t0) / 1000).toFixed(1)}s of JSON-RPC, none on clearnet`);

  client = await makeClient();
  if (client.identity.evmAddress?.toLowerCase() !== wallet.address.toLowerCase()) throw new SandboxFault(`the client derived ${client.identity.evmAddress}, this script ${wallet.address}`);
  const t1 = Date.now();
  let opened = await client.channel.open({ deposit: DEPOSIT });
  const collateralOf = async () => BigInt((await client.channel.state({ onChain: true })).onChain?.deposit ?? 0);
  if (await collateralOf() < L.price) {
    console.log(`       the chain does not back channel ${opened.channelId} — anvil forgets on restart, a kept channel store does not. Starting fresh.`);
    await client.close?.().catch(() => {});
    // The watermark AND the binding beside it (`<store>.peers.json`): a
    // binding left behind without its watermark refuses to open at all.
    for (const f of [STORE, STORE.replace(/\.json$/, '.peers.json')]) rmSync(f, { force: true });
    client = await makeClient();
    opened = await client.channel.open({ deposit: DEPOSIT });
    if (await collateralOf() < L.price) throw new SandboxFault(`channel ${opened.channelId} holds less than ${L.price} of collateral even after a fresh open`);
  }
  const channelId = opened.channelId;
  ok(`channel ${channelId} against the hidden connector, collateral ${await collateralOf()} read back off the chain — ${((Date.now() - t1) / 1000).toFixed(1)}s, every call through ${SOCKS_PROXY}`);
  const bookBefore = hiddenClientBook(channelId);
  let paidCalls = 0;
  const send = (route, body) => client.send(route, { body }, { timeoutMs: 180_000 });
  const assertFree = (sent, what) => assert(sent.claim === undefined, `${what} spent no claim — free at the provider's own edge`);
  const assertPaid = (sent, what) => { paidCalls += 1; assert(BigInt(sent.claim?.amount ?? 0) === L.price, `the tenant paid exactly ${sent.claim?.amount} for ${what} (${L.price})`); };

  const avail = await send(P.availabilityRoute, { listing: L.name, version: L.version, image: IMAGE });
  if (!avail.fulfilled) throw new SandboxFault(`availability was refused ${avail.code} (${avail.refusedBy}) ${avail.message ?? ''} — a circuit carried it and the sandbox said no`);
  const availBody = avail.status === 200 ? avail.json() : null;
  assert(avail.status === 200 && availBody?.would_run === true, `the free ${P.availabilityRoute} answered ${avail.status} ${avail.text()}`);
  assertFree(avail, 'the availability call');

  // ── 3. the spawn ───────────────────────────────────────────────────────
  step(`3. a PAID ${SPAWN_ROUTE} over the circuit: access.host is a per-lease .anyone address; three containers on the host`);
  const tenant = newTenant('m4-hidden-tenant');
  const workloadId = newWorkloadId();
  const t2 = nowSec();
  const spawned = await send(SPAWN_ROUTE, {
    request: leaseRequest(tenant, 'spawn', {
      workload_id: workloadId, image: IMAGE,
      env: { LISTEN_PORT: '22', USER_NAME: SSH_USER },
      ports: [{ container_port: 8080, protocol: 'tcp' }],
      ssh_public_key: tenant.sshPublicKey,
      entrypoint: ['/bin/sh'], args: ['-c', 'PUBLIC_KEY="$SSH_PUBLIC_KEY" exec /init'],
    }, 120, P),
  });
  const t3 = nowSec();
  if (!spawned.fulfilled) throw new SandboxFault(`the spawn was refused ${spawned.code} (${spawned.refusedBy}) ${spawned.message ?? ''} — a circuit carried it and the sandbox said no`);
  const spawnBody = spawned.status === 200 ? spawned.json() : null;
  assert(spawned.status === 200, `the provider answered ${spawned.status} in ${t3 - t2}s: ${spawned.text().slice(0, 300)}`);
  if (!spawnBody) throw new SandboxFault('no lease to continue with');
  assertPaid(spawned, 'the spawn');
  const access = spawnBody.access;
  lease = { tenant, workloadId, access, send };
  assert(spawnBody.workload_id === workloadId && spawnBody.role === 'standalone', `workload ${workloadId.slice(0, 12)}…, role ${spawnBody.role}`);
  assert(spawnBody.expires_at >= t2 + L.lease_interval_s && spawnBody.expires_at <= t3 + L.lease_interval_s, `expires_at ${spawnBody.expires_at} = now + ${L.lease_interval_s}s`);
  assert(ANYONE_ADDRESS.test(access?.host ?? '') && access.host !== target.address,
    `access.host is a .anyone address of the lease's own, not the connector's: ${access?.host}`);
  assert(Number.isInteger(access?.ssh_port) && access.ssh_port >= Number(P.confValue('ssh_port_start'))
    && access?.ports?.length === 1 && access.ports[0].container_port === 8080 && access.ports[0].host_port >= Number(P.confValue('workload_port_start')),
  `ssh_port ${access?.ssh_port} and ports ${jstr(access?.ports ?? [])} — the usual host ports, on that address`);
  assert(!IPV4.test(spawned.text()), 'no IPv4 address appears anywhere in the answer');

  const status = await send(P.statusRoute, { request: leaseRequest(tenant, 'status', { workload_id: workloadId }, 120, P) });
  if (!status.fulfilled) throw new SandboxFault(`status was refused ${status.code} (${status.refusedBy})`);
  const statusBody = status.status === 200 ? status.json() : null;
  assert(status.status === 200 && statusBody?.state === 'running' && JSON.stringify(statusBody?.access) === JSON.stringify(access),
    `the free, signed status says ${jstr(statusBody?.state)} with the same access block: host ${statusBody?.access?.host}`);
  assertFree(status, 'the status call');

  // The host daemon's side of the lease, all sandbox-side.
  const found = await findHiddenLease(access.ssh_port);
  if (!found) throw new SandboxFault(`no toon-<id>-ingress publishes ${access.ssh_port} on the host daemon`);
  assert(found.id >= ID_RANGE[0] && found.id <= ID_RANGE[1], `the lease is toon-${found.id}, in the hidden provider's own id range ${ID_RANGE[0]}-${ID_RANGE[1]}`);
  const states = [found.egress, found.workload, found.ingress].map((n) => `${n}=${containerState(n)}`);
  assert([found.egress, found.workload, found.ingress].every((n) => containerState(n) === 'running'), `three containers, all running: ${states.join(', ')}`);
  const netMode = inspect(found.workload, '{{.HostConfig.NetworkMode}}');
  assert(netMode === `container:${found.egress}` || netMode === `container:${inspect(found.egress, '{{.Id}}')}`,
    `${found.workload} shares ${found.egress}'s network namespace (${netMode.slice(0, 22)}…)`);
  const egressNets = Object.keys(JSON.parse(inspect(found.egress, '{{json .NetworkSettings.Networks}}')));
  assert(egressNets.length === 1 && egressNets[0] === P.confValue('network'), `${found.egress} is on ${egressNets.join(', ')} and no other network`);
  assert(inspect(found.workload, '{{.Config.Image}}') === `${IMAGE.reference}@${IMAGE.digest}`, 'the workload runs the image by reference@digest');
  const detached = detachedAddresses();
  const serviceId = access.host.replace(/\.anyone$/, '');
  assert(detached.includes(serviceId), `anon-hs holds the lease's address as a detached service (onions/detached: ${detached.length})`);
  // Dialled at the daemon's forward target itself — docker0, a local address of this host.
  const banner = (await bannerUntil(FORWARD_HOST, access.ssh_port, 40)) ?? '';
  assert(/^SSH-2\.0/.test(banner), `the forwarder answers an SSH banner at ${FORWARD_HOST}:${access.ssh_port}, where the address is forwarded to: ${banner || '(nothing)'} — this side is proven before the circuit is tried`);

  // ── 4. SSH through the proxy ───────────────────────────────────────────
  step(`4. ssh -p ${access.ssh_port} ${SSH_USER}@${access.host} through ${SOCKS_PROXY} with the tenant's key`);
  const t4 = Date.now();
  const ssh = await sshOverSocksUntil(tenant, access, 110);
  if (!ssh.ok) throw new NetworkFault(`ssh to ${access.host}:${access.ssh_port} never succeeded in ${ssh.tries} tries over ${((Date.now() - t4) / 1000).toFixed(0)}s (the forwarder answered on the host): ${ssh.err}`);
  ok(`toon-ssh-ok as ${ssh.user}, ${((Date.now() - t4) / 1000).toFixed(1)}s and ${ssh.tries} attempt(s) after the spawn answered — a fresh descriptor, fetched and rendezvoused`);
  // The published port, on the same address: a listener started inside, dialled from here.
  const port = access.ports[0];
  const listener = sshOverSocks(tenant, access,
    `nohup sh -c 'while :; do printf "HTTP/1.0 200 OK\\r\\ncontent-length: 12\\r\\n\\r\\ntoon-port-ok" | nc -l -q 1 ${port.container_port}; done' >/dev/null 2>&1 & sleep 1; echo started`);
  const viaPort = listener.ok ? getOverSocks(`http://${access.host}:${port.host_port}/`, 60) : { ok: false, err: listener.err };
  assert(viaPort.ok && viaPort.body === 'toon-port-ok', `the lease's published port answers at the same address: http://${access.host}:${port.host_port}/ -> ${viaPort.ok ? viaPort.body : viaPort.err}`);

  // ── 5. from inside ─────────────────────────────────────────────────────
  step('5. from inside the workload: an exit\'s address, not this host\'s; a direct dial fails');
  const seen = sshOverSocks(tenant, access, `curl -s --max-time 60 ${WHAT_IS_MY_IP}`);
  const observed = seen.out.trim();
  if (!seen.ok || !IPV4.test(observed)) throw new NetworkFault(`the workload could not ask ${WHAT_IS_MY_IP} through the egress: ${seen.err ?? observed}`);
  assert(observed !== target.hostIp && !target.localIps.includes(observed),
    `${WHAT_IS_MY_IP} sees the workload as ${observed} — an anon exit; this host is ${target.hostIp}`);
  const gateway = P.confValue('gateway');
  const subnet = `${gateway.split('.').slice(0, 3).join('.')}.0/24`;
  const routes = sshOverSocks(tenant, access, 'ip route');
  const routeLines = routes.out.trim().split('\n').filter(Boolean);
  assert(routes.ok && routeLines.length === 2 && routeLines.some((l) => l.startsWith(`default via ${gateway} `)) && routeLines.some((l) => l.startsWith(`${subnet} `)),
    `ip route names nothing but the gateway and the egress subnet: ${routeLines.join(' | ')}`);
  const ping = sshOverSocks(tenant, access, 'ping -c 2 -W 3 1.1.1.1 2>&1 | grep -E "packets transmitted|^ping:"');
  const pingOut = ping.out.trim();
  assert(ping.ok && /2 packets transmitted, 0 (packets )?received/.test(pingOut), `ICMP to 1.1.1.1 is unanswered — the pings were SENT and nothing came back: ${pingOut || '(no output)'}`);
  // The same port that answered a banner from the host, dialled from inside
  // at the address the daemon forwards to. `nc -z` would say "succeeded":
  // the transparent proxy completes the handshake itself, then the daemon
  // refuses the private destination and resets — so the dial reads bytes.
  const direct = sshOverSocks(tenant, access, `nc -w 5 ${FORWARD_HOST} ${access.ssh_port} </dev/null 2>&1 | head -c 60; echo "[eof]"`);
  const directOut = direct.out.trim();
  assert(direct.ok && !/SSH-2\.0/.test(directOut) && directOut === '[eof]',
    `a dial to the host at ${FORWARD_HOST}:${access.ssh_port} — this lease's own forward target, which answered an SSH banner from the host — carries nothing back from inside: ${directOut.replace(/\n/g, ' ')}`);

  // ── 6. terminate ───────────────────────────────────────────────────────
  step('6. terminate: the address is gone from the daemon, no longer answers, and no container of the lease remains');
  const t6 = nowSec();
  const ended = await send(P.terminateRoute, { request: leaseRequest(tenant, 'terminate', { workload_id: workloadId }, 120, P) });
  if (!ended.fulfilled) throw new SandboxFault(`terminate was refused ${ended.code} (${ended.refusedBy})`);
  const endedBody = ended.status === 200 ? ended.json() : null;
  assert(ended.status === 200 && JSON.stringify(endedBody?.state) === JSON.stringify({ ended: 'termination' }) && endedBody?.access === undefined,
    `terminate answered ${ended.status} ${jstr(endedBody?.state)}, no access any more`);
  assertFree(ended, 'the terminate call');
  lease = null;
  const gone = await waitFor(async () => leaseContainers(found.id).length === 0, 30);
  assert(gone === true, gone ? `no toon-${found.id}* container exists on the host daemon` : `still on the daemon: ${leaseContainers(found.id).join(', ')}`);
  const stillDetached = detachedAddresses();
  assert(!stillDetached.includes(serviceId), `anon-hs no longer holds the address (onions/detached: ${stillDetached.length})`);
  const t7 = Date.now();
  const after = getOverSocks(`http://${access.host}:${port.host_port}/`, 45);
  const afterBanner = bannerOverSocks(access.host, access.ssh_port, 45);
  assert(!after.ok && !/SSH-2\.0/.test(afterBanner),
    `${access.host} no longer answers through the proxy (${((Date.now() - t7) / 1000).toFixed(0)}s): port ${port.host_port} -> ${after.ok ? `STILL ANSWERED ${after.body}` : after.err}; ssh ${access.ssh_port} -> ${afterBanner ? `'${afterBanner}'` : 'no banner'}`);
  const live = await livenessAfter(t6);
  const availAfter = live ? JSON.parse(live.content).available?.[L.name] : undefined;
  assert(live !== null && availAfter === L.capacity, live ? `the next Liveness says available.${L.name} = ${availAfter} — the capacity is back` : 'no Liveness after the termination');

  // ── 7. the book ────────────────────────────────────────────────────────
  step('7. the hidden connector\'s own book, read out of band on the private network');
  const expected = BigInt(paidCalls) * L.price;
  const bookAfter = await waitFor(() => { const now = hiddenClientBook(channelId); return now - bookBefore >= expected ? now : null; }, 15) ?? hiddenClientBook(channelId);
  assert(bookAfter - bookBefore === expected,
    `provider-hs-connector's client book on ${channelId} grew by ${bookAfter - bookBefore} = ${paidCalls} x ${L.price} (the spawn); the free calls added nothing, and no hub took a fee`);
} catch (e) {
  const fault = classify(e, true);
  if (lease) {
    // A lease was bought and the run died after it. End it if a circuit still
    // carries; otherwise it expires on its own within the Lease Interval.
    console.log(`\n  ending lease ${lease.workloadId.slice(0, 12)}… (${lease.access?.host}) before reporting…`);
    try {
      const res = await lease.send(P.terminateRoute, { request: leaseRequest(lease.tenant, 'terminate', { workload_id: lease.workloadId }, 120, P) });
      console.log(`  terminate -> ${res.fulfilled ? `${res.status} ${res.text().slice(0, 120)}` : `${res.code} (${res.refusedBy})`}`);
    } catch (e2) {
      console.log(`  terminate did not go through (${e2.message}); the lease expires by itself within ${L.lease_interval_s}s + the sweep`);
    }
  }
  if (fault instanceof NetworkFault) networkFault = fault;
  else {
    console.error('\n\x1b[31m=== SANDBOX-SIDE FAILURE ===\x1b[0m\n');
    console.error(`  ${fault.message}\n`);
    console.error('  A circuit carried bytes for this run, or never had to. This is a fault in the');
    console.error('  sandbox\'s own configuration (or the provider), not in the Anyone network.\n');
    process.exit(1);
  }
}

await client?.close?.().catch(() => {});
await transport?.close().catch(() => {});

console.log(`\n  total run time ${elapsed()}`);
if (networkFault && failures() > 0) {
  // Both kinds at once: the sandbox-side FAIL lines above are the ones to
  // act on, so they decide the verdict — the carriage failure is reported
  // beside them rather than allowed to hide them behind an exit 75.
  console.error(`\n\x1b[31m${failures()} sandbox-side assertion(s) FAILED above, and then the carriage failed too: ${networkFault.message}\x1b[0m`);
  console.error('  Fix the FAIL lines first; the network verdict is moot until they pass.');
  process.exit(1);
}
if (networkFault) {
  console.error('\n\x1b[33m=== NETWORK-SIDE FAILURE (the Anyone network) ===\x1b[0m\n');
  console.error(`  ${networkFault.message}\n`);
  console.error('  What had already been established, on this side:');
  console.error(`    - anon, anon-hs and anon-client are healthy; anon-hs holds ${target.address}`);
  console.error('    - the connector and the Profile publish exactly that address; the private-RPC gate holds');
  console.error('    - whatever the run got to before the carriage failed is marked ok above');
  console.error('  So the configuration on this side is demonstrably right, and what did not happen is a');
  console.error('  circuit. That is a bad day on a third-party network rather than a defect here. Try again');
  console.error('  later; if the buyer keeps waiting 120 s for a circuit after `anon-hs` was recreated,');
  console.error('  `docker compose --profile hs restart anon-client` drops its stale descriptor.\n');
  console.error('  The daemons\' own last words:');
  for (const d of ['anon-hs', 'anon-client']) console.error(`    ${d}: ${lastWords(d)}`);
  process.exit(75);
}
done('the hidden provider\'s Profile says hidden: true with no host and a .anyone connector_url, every Listing carries hidden:true and no public one does; a buyer with only the address and a SOCKS proxy funded itself, opened a channel and paid a spawn over the circuit; the lease answered a per-lease .anyone address and no IP, ran as three containers confined to the anon egress network, took SSH through the proxy with the tenant\'s key, saw an exit\'s address and not this host\'s, and could not dial the host it runs on; terminate destroyed the address and every container; the hidden connector\'s book grew by exactly the listing price on its own private chain.');
