// Compute-provider smoke test (TOON_Network Milestone 1, ticket #3): one paid
// spawn through the hub, end to end. Run from sandbox/ on the host after
// `make up-payments` (or `make up`); `make smoke-provider`.
//
//   0.  both edges answer GET /ilp and agree on the prices: the provider
//       connector terminates g.toon.provider.basic.v1.spawn at the listing
//       price, the hub forwards it at listing price + its 100 uUSDC fee, and
//       the three free provider routes are 0 at the provider
//   0b. the relay-provider Solana channel is open and collateralised on chain
//   1.  a real client (@toon-protocol/client) opens a SOLANA mock-USDC channel
//       against the hub — the same buyer, mnemonic and channel store as
//       scripts/smoke-toon.mjs, so both smokes share one channel
//   2.  a TENANT signs a Lease Request with a fresh Nostr key: kind
//       K_LEASE_REQUEST, tags p = the provider's pubkey, op = spawn,
//       expiration; content names the image by reference + digest, an
//       ed25519 SSH public key made just now, and the env/entrypoint that
//       make the image's sshd install that key
//   3.  the client PAYS g.toon.provider.basic.v1.spawn through the hub,
//       sealed to the provider connector's edge, and the answer carries the
//       workload_id it chose, role standalone, expires_at = now + the
//       listing's lease interval, and access { host, ssh_port, ports }
//   4.  a container is RUNNING on the host daemon, publishing that ssh_port
//   5.  `ssh -i <tenant key> -p <ssh_port> tenant@127.0.0.1` works — the
//       tenant's key, and only that, opens the workload
//   6.  the money, from the connectors' own books: the hub's client book
//       grew by price + fee, the provider connector's peer-book watermark on
//       the committed channel account grew by the price
//   7.  the SAME Lease Request sent again is refused stale_request — and the
//       refusal is BILLED (one route, one price, no refunds: ADR 0003), which
//       the books show as a second increment
//
// The workload is removed at the end (`docker rm -f`) unless
// TOON_SMOKE_KEEP_WORKLOAD=1, in which case the provider's own expiry sweep
// destroys it lease_interval_s after the spawn (conf/provider.toml: 180 s).
// Either way the provider counts the lease against the listing's capacity
// (4) until it expires, so more than four runs inside three minutes answer
// no_capacity — which is the provider being right, not the smoke.
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ToonClient } from '@toon-protocol/client';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
const PROVIDER_EDGE = process.env.PROVIDER_EDGE_URL ?? 'http://localhost:3240';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const MNEMONIC = 'test test test test test test test test test test test junk';
const KEEP_WORKLOAD = /^(1|true|yes)$/i.test(process.env.TOON_SMOKE_KEEP_WORKLOAD ?? '');

const PAYMENT_CHANNEL_PROGRAM = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const USDC_MINT = 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H';
const HUB_SOL = '9gXKH3AtUErhsAVaLmBkiJxdtUmUE29MjaRLFKxCqfAx';
const BUYER_SOL = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96';
// The relay-provider peering channel: the PDA both committed tomls name,
// opened by the open-toon-solana-channels job.
const PROVIDER_SOL = '6dbRwZDF34CCWGvUm36VRRsEb7TTySQ1uLrYFEMumtgA';
const PROVIDER_CHANNEL = '87EGu9qGRB3G88jTdwz51uJscLQDHgzJfje7eXWfuEkn';
const HUB_CHANNEL_DEPOSIT = 100_000_000n;
// conf/connector-relay.toml's relay-provider [[peers]] row.
const HUB_FEE = 100n;

// The Lease Request kind — a PLACEHOLDER until kinds are allocated, mirrored
// from the provider's src/nostr/kinds.rs (K_LEASE_REQUEST). Regular class,
// never published: it travels only inside the spawn body.
const K_LEASE_REQUEST = 4432;

// The one listing conf/provider.toml sells, and its route.
const LISTING = 'basic';
const VERSION = 1;
const SPAWN_ROUTE = `g.toon.provider.${LISTING}.v${VERSION}.spawn`;

// The workload image: a small public sshd, PINNED BY DIGEST — the provider
// pulls `reference@digest`, so the daemon verifies the bytes and picks the
// manifest for its own architecture. linuxserver's sshd reads its key from
// PUBLIC_KEY and listens on 2222 by default; the spawn's entrypoint/args
// bridge the provider's SSH_PUBLIC_KEY to it, and LISTEN_PORT moves it to
// 22, the port the provider's ssh_port forwards to.
const IMAGE = {
  reference: 'lscr.io/linuxserver/openssh-server',
  digest: 'sha256:39ba37d50fdd6be1bf70644c871e5dcb9234ee79ac56424ea03ca08cadf1e7b0',
};
const SSH_USER = 'tenant';

// ── conf/provider.toml, the source of truth for the price and the key ─────
const providerConf = readFileSync(join(ROOT, 'conf', 'provider.toml'), 'utf8');
const confValue = (key) => {
  const m = providerConf.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\s#]+)"?`, 'm'));
  if (!m) throw new Error(`conf/provider.toml has no ${key} line`);
  return m[1];
};
const PROVIDER_PRICE = BigInt(confValue('price'));
const LEASE_INTERVAL_S = Number(confValue('lease_interval_s'));
const PROVIDER_PUBKEY = getPublicKey(Uint8Array.from(Buffer.from(confValue('nostr_private_key'), 'hex')));
const HUB_PRICE = PROVIDER_PRICE + HUB_FEE;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
let failures = 0;
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const fatal = (msg) => { console.error(`\nPROVIDER SMOKE FAILED: ${msg}`); process.exit(1); };

const bearer = (node) => readFileSync(join(ROOT, 'keys', 'toon', node, 'operator-bearer.token'), 'utf8').trim();
const edgeOf = { 'relay-connector': HUB, 'provider-connector': PROVIDER_EDGE };
async function claims(node) {
  const res = await fetch(`${edgeOf[node]}/claims`, { headers: { authorization: `Bearer ${bearer(node)}` } });
  if (!res.ok) throw new Error(`${node} GET /claims -> ${res.status}`);
  return res.json();
}
// Same book readers as smoke-toon.mjs: client-book takings on the hub, and
// the peer-book watermark on one channel account at the payee.
function clientBookTotal(rows) {
  const per = new Map();
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > (per.get(r.channel_id) ?? 0n)) per.set(r.channel_id, a);
  }
  return [...per.values()].reduce((s, a) => s + a, 0n);
}
function peerBookTotal(rows, onChannel) {
  let top = 0n;
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book === 'client' || r.channel_id !== onChannel) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > top) top = a;
  }
  return top;
}
async function booksAdvanceTo(hubBefore, providerBefore, hubDelta, providerDelta) {
  let hubNow = hubBefore, providerNow = providerBefore;
  for (let i = 0; i < 20 && (hubNow - hubBefore < hubDelta || providerNow - providerBefore < providerDelta); i++) {
    await sleep(500);
    hubNow = clientBookTotal(await claims('relay-connector'));
    providerNow = peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL);
  }
  return { hub: hubNow - hubBefore, provider: providerNow - providerBefore };
}

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
    status: data[160],
  };
}

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });

// ── 0. the edges and their prices ────────────────────────────────────────
step('0. both edges are live and price the spawn route consistently');
const advertised = {};
for (const [name, url] of [['relay-connector (hub)', HUB], ['provider-connector', PROVIDER_EDGE]]) {
  const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
  if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  advertised[name] = Object.fromEntries((desc.routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
  ok(`${name}: ${desc.ilpAddresses?.join(',')} — ${(desc.routes ?? []).filter((r) => r.prefix.startsWith('g.toon.provider')).map((r) => `${r.prefix}@${r.price}`).join(', ')}`);
}
assert(advertised['provider-connector'][SPAWN_ROUTE] === PROVIDER_PRICE,
  `the provider connector terminates ${SPAWN_ROUTE} at ${PROVIDER_PRICE} uUSDC — conf/provider.toml's listing price, via \`toon-provider routes\``);
assert(advertised['provider-connector'][`g.toon.provider.${LISTING}.v${VERSION}.extend`] === PROVIDER_PRICE,
  'and the extend route at the same price (one interval, one price)');
for (const free of ['availability', 'status', 'terminate']) {
  assert(advertised['provider-connector'][`g.toon.provider.${free}`] === 0n, `g.toon.provider.${free} is free at the provider`);
  assert(advertised['relay-connector (hub)'][`g.toon.provider.${free}`] === HUB_FEE,
    `the hub forwards g.toon.provider.${free} at exactly its fee (${HUB_FEE}): 0 arrives`);
}
assert(advertised['relay-connector (hub)'][SPAWN_ROUTE] === HUB_PRICE,
  `the hub forwards ${SPAWN_ROUTE} at ${HUB_PRICE} = provider price + fee ${HUB_FEE}`);

// ── 0b. the peering channel on chain ─────────────────────────────────────
step('0b. the relay-provider peering channel is open and collateralised on SOLANA');
{
  let ch = null;
  for (let i = 0; i < 45 && !ch; i++) {
    ch = await readSolanaChannel(PROVIDER_CHANNEL);
    if (!ch) await sleep(2000);
  }
  if (!ch) {
    bad(`channel account ${PROVIDER_CHANNEL} never appeared on the validator (docker compose logs open-toon-solana-channels)`);
  } else {
    assert(ch.owner === PAYMENT_CHANNEL_PROGRAM && ch.discriminator === 'pchannel', `${PROVIDER_CHANNEL} is a payment_channel program account`);
    const participants = [ch.participantA, ch.participantB].sort();
    assert(participants.join() === [HUB_SOL, PROVIDER_SOL].sort().join(), `participants are the hub and the provider connector (${participants.join(', ')})`);
    assert(ch.mint === USDC_MINT, 'settles in the Solana mock USDC mint');
    assert(ch.status === 0, 'status Opened');
    const hubDeposit = ch.participantA === HUB_SOL ? ch.depositA : ch.depositB;
    assert(hubDeposit >= HUB_CHANNEL_DEPOSIT, `the hub's own side holds ${hubDeposit} base units of collateral (>= ${HUB_CHANNEL_DEPOSIT})`);
  }
}

// ── 1. a channel against the hub ─────────────────────────────────────────
step('1. a mock-USDC payment channel ON SOLANA against the hub');
mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
const client = await ToonClient.create({
  connector: HUB,
  mnemonic: MNEMONIC,
  chain: 'solana',
  rpcUrl: RPC_URL,
  channelStore: join(ROOT, '.toon-client', 'channels.json'),
  deposit: 10_000_000n,
  timeoutMs: 60_000,
});
assert(client.identity?.solanaPublicKey === BUYER_SOL, `the buyer is ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded`);
const opened = await client.channel.open({ deposit: 10_000_000n });
ok(`channel ${opened.channelId ?? '(id unreported)'} status=${opened.status ?? 'open'}`);
const hubBefore = clientBookTotal(await claims('relay-connector'));
const providerBefore = peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL);
console.log(`  books before: hub client=${hubBefore}, provider peer=${providerBefore}`);

// ── 2. the tenant, its key, its Lease Request ────────────────────────────
step('2. a tenant signs a Lease Request with a fresh Nostr key and a fresh SSH key');
const tenantSecret = generateSecretKey();
const tenantPubkey = getPublicKey(tenantSecret);
const keyPath = join(ROOT, '.toon-client', 'tenant_ed25519');
for (const f of [keyPath, `${keyPath}.pub`]) if (existsSync(f)) rmSync(f);
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'toon-sandbox-tenant', '-f', keyPath]);
const sshPublicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
const workloadId = randomBytes(32).toString('hex');
const now = Math.floor(Date.now() / 1000);
const content = {
  workload_id: workloadId,
  image: IMAGE,
  // The image's own knobs: its sshd on 22 (where the provider's ssh_port
  // forwards), the login user, and the key bridged from SSH_PUBLIC_KEY.
  env: { LISTEN_PORT: '22', USER_NAME: SSH_USER },
  ports: [],
  ssh_public_key: sshPublicKey,
  entrypoint: ['/bin/sh'],
  args: ['-c', 'PUBLIC_KEY="$SSH_PUBLIC_KEY" exec /init'],
};
const request = finalizeEvent({
  kind: K_LEASE_REQUEST,
  created_at: now,
  tags: [['p', PROVIDER_PUBKEY], ['op', 'spawn'], ['expiration', String(now + 120)]],
  content: JSON.stringify(content),
}, tenantSecret);
ok(`tenant ${tenantPubkey} signed request ${request.id} for workload ${workloadId} (p = ${PROVIDER_PUBKEY})`);

// ── 3. the PAID spawn, through the hub ───────────────────────────────────
step(`3. a PAID ${SPAWN_ROUTE} routes hub -> peering -> provider connector -> provider`);
const price = await client.price(SPAWN_ROUTE);
assert(price === HUB_PRICE, `the hub prices ${SPAWN_ROUTE} at ${jstr(price)}`);
const t0 = Math.floor(Date.now() / 1000);
const spawned = await client.send(SPAWN_ROUTE, { body: { request } }, { sealTo: PROVIDER_EDGE, timeoutMs: 120_000 });
let access = null;
let containerName = null;
if (!spawned.fulfilled) {
  bad(`the spawn was refused: ${spawned.code} (refusedBy ${spawned.refusedBy}) ${spawned.message}`);
} else {
  const body = spawned.status === 200 ? spawned.json() : null;
  assert(spawned.status === 200, `the provider answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
  assert(BigInt(spawned.claim?.amount ?? 0) === HUB_PRICE, `the client paid the hub exactly ${spawned.claim?.amount} uUSDC (${HUB_PRICE})`);
  if (body) {
    assert(body.workload_id === workloadId, `the answer names the tenant-chosen workload_id`);
    assert(body.role === 'standalone', `role ${body.role}`);
    const t1 = Math.floor(Date.now() / 1000);
    assert(body.expires_at >= t0 + LEASE_INTERVAL_S && body.expires_at <= t1 + LEASE_INTERVAL_S,
      `expires_at ${body.expires_at} = now + lease_interval_s (${LEASE_INTERVAL_S}): one payment, one Lease Interval`);
    access = body.access;
    assert(access?.host === '127.0.0.1' && Number.isInteger(access?.ssh_port) && Array.isArray(access?.ports),
      `access: ssh ${access?.host}:${access?.ssh_port}, ports ${jstr(access?.ports ?? [])}`);
  }
}

// ── 4. the container, on the host daemon ─────────────────────────────────
step('4. the workload is RUNNING on the host daemon and publishes the SSH forward');
if (access) {
  for (let i = 0; i < 10 && !containerName; i++) {
    const lines = docker('ps', '--filter', 'name=toon-', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}').trim().split('\n').filter(Boolean);
    const line = lines.find((l) => l.includes(`:${access.ssh_port}->22/tcp`));
    if (line) {
      containerName = line.split('\t')[0];
      ok(`${line.replace(/\t/g, '  ')}`);
    } else {
      await sleep(1000);
    }
  }
  assert(containerName !== null, `a toon-<id> container publishes host port ${access.ssh_port} -> 22/tcp`);
  if (containerName) {
    const image = docker('inspect', '-f', '{{.Config.Image}}', containerName).trim();
    assert(image === `${IMAGE.reference}@${IMAGE.digest}`, `it runs the image by reference@digest: ${image}`);
  }
}

// ── 5. SSH with the tenant's key ─────────────────────────────────────────
step("5. SSH into the workload with the tenant's key");
if (access) {
  let sshOut = null;
  let lastErr = '';
  for (let i = 0; i < 20 && sshOut === null; i++) {
    try {
      sshOut = execFileSync('ssh', [
        '-i', keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-p', String(access.ssh_port), `${SSH_USER}@${access.host}`, 'echo toon-ssh-ok; id -un',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      lastErr = String(e.stderr ?? e.message).trim().split('\n').pop();
      await sleep(2000);
    }
  }
  assert(sshOut !== null && sshOut.includes('toon-ssh-ok'),
    sshOut !== null ? `ssh -p ${access.ssh_port} ${SSH_USER}@${access.host}: ${sshOut.trim().replace('\n', ', user ')}` : `ssh never succeeded: ${lastErr}`);
}

// ── 6. the money ─────────────────────────────────────────────────────────
step("6. the connectors' own books say the spawn was PAID — hub client leg and provider peer leg");
{
  const d = await booksAdvanceTo(hubBefore, providerBefore, HUB_PRICE, PROVIDER_PRICE);
  assert(d.hub >= HUB_PRICE, `hub client book advanced by ${d.hub} uUSDC (>= ${HUB_PRICE}: listing price + fee)`);
  assert(d.provider >= PROVIDER_PRICE,
    `provider connector's peer-book watermark on channel ${PROVIDER_CHANNEL} advanced by ${d.provider} uUSDC (>= ${PROVIDER_PRICE}, the listing price)`);
}

// ── 7. a replay is refused, and billed ───────────────────────────────────
step('7. the SAME Lease Request again is refused stale_request — and still billed');
{
  const replay = await client.send(SPAWN_ROUTE, { body: { request } }, { sealTo: PROVIDER_EDGE, timeoutMs: 60_000 });
  if (!replay.fulfilled) {
    bad(`the replay was refused short of the app: ${replay.code} (${replay.refusedBy})`);
  } else {
    const err = replay.status !== 200 ? replay.json() : null;
    assert(replay.status === 400 && err?.error === 'stale_request', `the provider answered ${replay.status} ${jstr(err)}`);
    assert(BigInt(replay.claim?.amount ?? 0) === HUB_PRICE, `and the refusal cost ${replay.claim?.amount} uUSDC — a billed error, no refund (ADR 0003)`);
  }
  const d = await booksAdvanceTo(hubBefore, providerBefore, 2n * HUB_PRICE, 2n * PROVIDER_PRICE);
  assert(d.hub >= 2n * HUB_PRICE && d.provider >= 2n * PROVIDER_PRICE,
    `both books show two paid packets: hub +${d.hub}, provider +${d.provider}`);
}

// ── cleanup ──────────────────────────────────────────────────────────────
if (containerName) {
  if (KEEP_WORKLOAD) {
    console.log(`\n  ${containerName} is left running; the provider's expiry sweep destroys it ~${LEASE_INTERVAL_S}s after the spawn.`);
  } else {
    docker('rm', '-f', containerName);
    console.log(`\n  ${containerName} removed (TOON_SMOKE_KEEP_WORKLOAD=1 keeps it for the expiry sweep to reap).`);
  }
}

console.log(failures === 0
  ? '\n\x1b[32mPROVIDER SMOKE OK: a tenant paid one spawn through the hub over a Solana USDC channel, the provider started its workload on the host by reference@digest, SSH opened with the tenant\'s key alone, both connectors booked the prices, and a replay was refused and billed.\x1b[0m'
  : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
