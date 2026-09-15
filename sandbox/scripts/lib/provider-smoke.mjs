// Shared pieces of the compute-provider smokes (TOON_Network Milestone 1):
// scripts/smoke-provider.mjs, smoke-directory.mjs, smoke-eviction.mjs and
// smoke-milestone1.mjs. Everything here is what those scripts used to carry
// four times over — the sandbox's committed addresses, the provider's config
// as the source of truth for prices and keys, the ok/FAIL reporter, the
// connectors' claim-book readers (the same ones scripts/smoke-toon.mjs uses),
// a NIP-01 reader for the relay, and the tenant ceremony: a fresh Nostr key,
// a fresh SSH key, a signed Lease Request, the spawn body the sandbox's sshd
// image needs, and SSH into the workload it produces.
//
// Nothing here asserts anything by itself; every function returns what it
// found and the calling smoke decides what that proves.
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ToonClient } from '@toon-protocol/client';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // sandbox/
export const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
export const PROVIDER_EDGE = process.env.PROVIDER_EDGE_URL ?? 'http://localhost:3240';
export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
export const RELAY_WS = process.env.RELAY_WS ?? 'ws://localhost:7100';
// anvil's own published test mnemonic; the smokes' payer is its Solana
// derivation at account index 0 (scripts/seed-toon-solana.mjs funds it).
export const MNEMONIC = 'test test test test test test test test test test test junk';

export const PAYMENT_CHANNEL_PROGRAM = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
export const USDC_MINT = 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H';
export const HUB_SOL = '9gXKH3AtUErhsAVaLmBkiJxdtUmUE29MjaRLFKxCqfAx';
export const BUYER_SOL = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96';
// The relay-provider peering channel: the PDA both committed tomls name,
// opened by the open-toon-solana-channels job.
export const PROVIDER_SOL = '6dbRwZDF34CCWGvUm36VRRsEb7TTySQ1uLrYFEMumtgA';
export const PROVIDER_CHANNEL = '87EGu9qGRB3G88jTdwz51uJscLQDHgzJfje7eXWfuEkn';
export const HUB_CHANNEL_DEPOSIT = 100_000_000n;
// conf/connector-relay.toml's relay-provider [[peers]] row: the hub's own cut
// on top of the provider's price, charged on every route it forwards,
// including the free ones (100 - 100 == 0 arrives at the provider).
export const HUB_FEE = 100n;
// The provider's expiry sweep cadence (its cleanup.rs SWEEP_INTERVAL_SECS):
// the longest a lease can outlive its expires_at before the workload is gone.
export const SWEEP_S = 30;

// Mirrored from the provider's src/nostr/kinds.rs. EVERY NUMBER IS A
// PLACEHOLDER until kinds are allocated (spec §11); what is normative is the
// NIP-01 class, which is why the smokes talk about replacement rather than
// about the numbers.
export const K_LEASE_REQUEST = 4432; // regular, never published
export const K_EVICTION = 4433; // regular
export const K_PROFILE = 10432; // replaceable
export const K_LIVENESS = 10433; // replaceable
export const K_LISTING = 30432; // addressable
export const TOON_LABEL = 'toon.network';

// The free provider-wide routes and the paid per-listing-version ones.
export const AVAILABILITY_ROUTE = 'g.toon.provider.availability';
export const STATUS_ROUTE = 'g.toon.provider.status';
export const TERMINATE_ROUTE = 'g.toon.provider.terminate';
export const spawnRoute = (listing, version) => `g.toon.provider.${listing}.v${version}.spawn`;
export const extendRoute = (listing, version) => `g.toon.provider.${listing}.v${version}.extend`;

// The workload image: a small public sshd, PINNED BY DIGEST — the provider
// pulls `reference@digest`, so the daemon verifies the bytes and picks the
// manifest for its own architecture. linuxserver's sshd reads its key from
// PUBLIC_KEY and listens on 2222 by default; the spawn's entrypoint/args
// bridge the provider's SSH_PUBLIC_KEY to it, and LISTEN_PORT moves it to
// 22, the port the provider's ssh_port forwards to.
export const IMAGE = {
  reference: 'lscr.io/linuxserver/openssh-server',
  digest: 'sha256:39ba37d50fdd6be1bf70644c871e5dcb9234ee79ac56424ea03ca08cadf1e7b0',
};
export const SSH_USER = 'tenant';

// ── conf/provider.toml, the source of truth for prices, keys and listings ──
export const providerConf = readFileSync(join(ROOT, 'conf', 'provider.toml'), 'utf8');
/** The first `key = value` scalar in `text` (a bare or quoted value, up to whitespace or a comment), or null. */
const tomlScalar = (text, key) =>
  text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\s#]+)"?`, 'm'))?.[1] ?? null;
/** The first `key = value` line of conf/provider.toml (top-level keys only: listing fields come from `listings()`). */
export function confValue(key) {
  const value = tomlScalar(providerConf, key);
  if (value === null) throw new Error(`conf/provider.toml has no ${key} line`);
  return value;
}
/** Every `[[listings]]` block, in file order, as { name, version, arch, lease_interval_s, price, capacity }. */
export function listings() {
  const blocks = providerConf.split(/^\[\[listings\]\]\s*$/m).slice(1);
  return blocks.map((block) => {
    const field = (key) => {
      const value = tomlScalar(block, key);
      if (value === null) throw new Error(`a [[listings]] block in conf/provider.toml has no ${key}`);
      return value;
    };
    return {
      name: field('name'),
      version: Number(field('version')),
      arch: field('arch'),
      lease_interval_s: Number(field('lease_interval_s')),
      price: BigInt(field('price')),
      capacity: Number(field('capacity')),
    };
  });
}
/** One listing by name, or throw — a smoke buying a listing the provider does not sell is a smoke bug. */
export function listing(name) {
  const l = listings().find((x) => x.name === name);
  if (!l) throw new Error(`conf/provider.toml has no [[listings]] block named ${name}`);
  return l;
}
export const PROVIDER_PUBKEY = getPublicKey(
  Uint8Array.from(Buffer.from(confValue('nostr_private_key'), 'hex')),
);

// ── the reporter: ok / FAIL lines, a tally, and one exit ──────────────────
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
export const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * `reporter('PROVIDER SMOKE')` gives a smoke its step/ok/bad/assert/fatal
 * quartet and a `done(successMessage)` that prints the tally and exits 0 or 1.
 */
export function reporter(label) {
  let failures = 0;
  const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
  const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
  const bad = (msg) => {
    failures += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`);
  };
  const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
  const fatal = (msg) => {
    console.error(`\n${label} FAILED: ${msg}`);
    process.exit(1);
  };
  const done = (successMessage) => {
    console.log(
      failures === 0
        ? `\n\x1b[32m${label} OK: ${successMessage}\x1b[0m`
        : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`,
    );
    process.exit(failures === 0 ? 0 : 1);
  };
  return { step, ok, bad, assert, fatal, done, failures: () => failures };
}

/** Poll `probe` (async, returns a truthy value when satisfied) up to `seconds`; returns its last value. */
export async function waitFor(probe, seconds, everyMs = 500) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  for (;;) {
    last = await probe();
    if (last || Date.now() >= deadline) return last;
    await sleep(everyMs);
  }
}

// ── the connectors' own books (the same readers as scripts/smoke-toon.mjs) ─
export const bearer = (node) =>
  readFileSync(join(ROOT, 'keys', 'toon', node, 'operator-bearer.token'), 'utf8').trim();
export const edgeOf = { 'relay-connector': HUB, 'provider-connector': PROVIDER_EDGE };
export async function claims(node) {
  const res = await fetch(`${edgeOf[node]}/claims`, { headers: { authorization: `Bearer ${bearer(node)}` } });
  if (!res.ok) throw new Error(`${node} GET /claims -> ${res.status}`);
  return res.json();
}
/** Inbound client-book takings, per channel — a connector is paid by its clients. */
export function clientBookByChannel(rows) {
  const per = new Map();
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > (per.get(r.channel_id) ?? 0n)) per.set(r.channel_id, a);
  }
  return per;
}
/** Client-book takings summed over every channel. */
export const clientBookTotal = (rows) => [...clientBookByChannel(rows).values()].reduce((s, a) => s + a, 0n);
/** Client-book watermark on ONE channel; the client book keys a Solana channel `solana:<account>`. */
export function clientBookOnChannel(rows, channelKey) {
  let top = 0n;
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    if (String(r.channel_id).toLowerCase() !== channelKey.toLowerCase()) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > top) top = a;
  }
  return top;
}
/** Peer-book watermark on one channel account at a payee: what the peering has actually PAID it. */
export function peerBookTotal(rows, onChannel) {
  let top = 0n;
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book === 'client' || r.channel_id !== onChannel) continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > top) top = a;
  }
  return top;
}

// ── the relay: one NIP-01 REQ, resolved at EOSE ───────────────────────────
export function relayRead(filter, label = 'directory') {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(RELAY_WS);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no EOSE from ${RELAY_WS} in 15s`));
    }, 15_000);
    socket.onopen = () => socket.send(JSON.stringify(['REQ', label, filter]));
    socket.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${e.message ?? e}`));
    };
    socket.onmessage = (m) => {
      const frame = JSON.parse(m.data);
      if (frame[0] === 'EVENT' && frame[1] === label) events.push(frame[2]);
      if (frame[0] === 'EOSE' && frame[1] === label) {
        clearTimeout(timer);
        socket.close();
        resolve(events);
      }
    };
  });
}
/** Wait until `filter` returns at least one event, or give up with []. */
export async function relayReadUntil(filter, label, seconds) {
  const events = await waitFor(async () => {
    const found = await relayRead(filter, label).catch(() => []);
    return found.length > 0 ? found : null;
  }, seconds);
  return events ?? [];
}
export const tagValues = (event, name) => event.tags.filter((t) => t[0] === name).map((t) => t.slice(1));
export const hasTag = (event, cells) =>
  event.tags.some((t) => t.length >= cells.length && cells.every((c, i) => t[i] === c));
/** The directory filters for this provider: by author and the toon.network label. */
export const directoryFilter = (kind) => ({ kinds: [kind], authors: [PROVIDER_PUBKEY], '#L': [TOON_LABEL] });

// ── Solana payment-channel account layout ─────────────────────────────────
// Offsets from the connector's packages/solana-program/src/state.rs (see the
// vendored scripts/open-solana-channel.py, which names the source of each).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58enc(buf) {
  let v = 0n;
  for (const b of buf) v = v * 256n + BigInt(b);
  let out = '';
  while (v > 0n) { out = B58[Number(v % 58n)] + out; v /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
export async function readSolanaChannel(account) {
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

// ── docker: the host daemon the provider's workloads run on ───────────────
export const docker = (...args) => execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8' });
/** Names of every compose service that is not `running`, out of `wanted`. */
export function composeNotRunning(wanted) {
  const running = docker('compose', 'ps', '--format', '{{.Service}} {{.State}}');
  return wanted.filter((service) => !new RegExp(`^${service} running`, 'm').test(running));
}
/** The provider names every workload `toon-<id>` on the host daemon; the sandbox's own containers are `toon-sandbox-*`. */
export const isWorkloadName = (name) => /^toon-\d+$/.test(name);
/** The `toon-<id>` container publishing host port `sshPort` -> 22/tcp, polled for up to `seconds`; null if none appears. */
export async function findWorkload(sshPort, seconds = 10) {
  return waitFor(async () => {
    const lines = docker('ps', '--filter', 'name=toon-', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}')
      .trim().split('\n').filter(Boolean);
    const line = lines.find((l) => isWorkloadName(l.split('\t')[0]) && l.includes(`:${sshPort}->22/tcp`));
    return line ? { name: line.split('\t')[0], line: line.replace(/\t/g, '  ') } : null;
  }, seconds, 1000);
}
/** True once no container of that exact name exists on the daemon (running or not) — the workload is gone — polled for up to `seconds`. */
export async function workloadGone(name, seconds = 10) {
  const gone = await waitFor(
    async () => docker('ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}').trim().length === 0,
    seconds,
  );
  return gone === true;
}

// ── the tenant ────────────────────────────────────────────────────────────
/** A fresh Nostr identity plus a fresh ed25519 SSH key under .toon-client/<keyName>_ed25519. */
export function newTenant(keyName) {
  mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
  const secret = generateSecretKey();
  const keyPath = join(ROOT, '.toon-client', `${keyName}_ed25519`);
  for (const f of [keyPath, `${keyPath}.pub`]) if (existsSync(f)) rmSync(f);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `toon-sandbox-${keyName}`, '-f', keyPath]);
  return {
    secret,
    pubkey: getPublicKey(secret),
    keyPath,
    sshPublicKey: readFileSync(`${keyPath}.pub`, 'utf8').trim(),
  };
}
/** A signed Lease Request: kind K_LEASE_REQUEST, p = the provider, op, an expiration `ttl` seconds out. */
export function leaseRequest(tenant, op, content, ttl = 120) {
  const now = nowSec();
  return finalizeEvent({
    kind: K_LEASE_REQUEST,
    created_at: now,
    tags: [['p', PROVIDER_PUBKEY], ['op', op], ['expiration', String(now + ttl)]],
    content: JSON.stringify(content),
  }, tenant.secret);
}
export const newWorkloadId = () => randomBytes(32).toString('hex');
/** The spawn content the sandbox's sshd image needs: its sshd on 22 (where ssh_port forwards), the login user, the key bridged from SSH_PUBLIC_KEY. */
export const spawnContent = (workloadId, tenant) => ({
  workload_id: workloadId,
  image: IMAGE,
  env: { LISTEN_PORT: '22', USER_NAME: SSH_USER },
  ports: [],
  ssh_public_key: tenant.sshPublicKey,
  entrypoint: ['/bin/sh'],
  args: ['-c', 'PUBLIC_KEY="$SSH_PUBLIC_KEY" exec /init'],
});

/**
 * A real client (@toon-protocol/client) with a SOLANA mock-USDC channel
 * against `connector`. `storeName` picks the channel store under
 * .toon-client/: every smoke that pays the HUB shares `channels.json` (one
 * payer, one channel, one nonce watermark), and a channel against any other
 * node gets its own file.
 */
export async function openChannel(connector, storeName = 'channels.json', deposit = 10_000_000n) {
  mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
  const client = await ToonClient.create({
    connector,
    mnemonic: MNEMONIC,
    chain: 'solana',
    rpcUrl: RPC_URL,
    channelStore: join(ROOT, '.toon-client', storeName),
    deposit,
    timeoutMs: 60_000,
  });
  const opened = await client.channel.open({ deposit });
  return { client, opened };
}

/** `ssh -i <tenant key> -p <ssh_port> tenant@<host> 'echo toon-ssh-ok; id -un'`, retried for a fresh sshd. Returns { out } or { err }. */
export async function sshInto(tenant, access, attempts = 20) {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const out = execFileSync('ssh', [
        '-i', tenant.keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-p', String(access.ssh_port), `${SSH_USER}@${access.host}`, 'echo toon-ssh-ok; id -un',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { out };
    } catch (e) {
      lastErr = String(e.stderr ?? e.message).trim().split('\n').pop();
      await sleep(2000);
    }
  }
  return { err: lastErr };
}
