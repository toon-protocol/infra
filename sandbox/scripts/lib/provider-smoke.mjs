// Shared pieces of the compute-provider smokes (TOON_Network Milestone 1):
// scripts/smoke-provider.mjs, smoke-directory.mjs, smoke-eviction.mjs and
// smoke-milestone1.mjs — and, with a provider argument and the Standby Set
// pieces, smoke-milestone3.mjs. Everything here is what those scripts used to carry
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
export const PROVIDER2_EDGE = process.env.PROVIDER2_EDGE_URL ?? 'http://localhost:3250';
export const STORE_EDGE = process.env.STORE_EDGE_URL ?? 'http://localhost:3210';
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
// The SECOND provider's peering (TOON_Network #34): its own settlement key and
// its own PDA, named by conf/connector-provider2.toml and the hub's own toml.
export const PROVIDER2_SOL = 'CUCCqWMWMhwcHrZnxouDdwgRuUCd4MoSXx11zkfpLN4a';
export const PROVIDER2_CHANNEL = 'Fx5gAB3vJy3fqeEoc5NWMmVdCVa2KTPbhge5h3eQicoF';
// The relay-store peering channel: the PDA conf/connector-store.toml's
// [[peer_channels]] row names, where the store connector books what the hub
// has paid it for g.toon.store uploads.
export const STORE_CHANNEL = '4yUyXpi3c23g1sxGWWUpANVoGKzt8i4iMc2xjdC3njR7';
export const HUB_CHANNEL_DEPOSIT = 100_000_000n;
// conf/connector-relay.toml's relay-provider [[peers]] row: the hub's own cut
// on top of the provider's price, charged on every route it forwards,
// including the free ones (100 - 100 == 0 arrives at the provider).
export const HUB_FEE = 100n;
// The provider's expiry sweep cadence (its cleanup.rs SWEEP_INTERVAL_SECS):
// the longest a lease can outlive its expires_at before the workload is gone.
export const SWEEP_S = 30;
// The standby watchdog's step (its watchdog.rs WATCHDOG_INTERVAL_SECS): how
// late, past the cadence arithmetic, a Takeover can be announced or settled.
export const WATCHDOG_S = 10;

// Mirrored from the provider's src/nostr/kinds.rs — the allocation in spec
// §3.1 (ADR 0012: one block per NIP-01 class, `432` suffix). What is
// normative is the class, which is why the smokes talk about replacement
// rather than about the numbers.
export const K_LEASE_REQUEST = 4432; // regular, never published
export const K_EVICTION = 4433; // regular
export const K_PROFILE = 10432; // replaceable
export const K_LIVENESS = 10433; // replaceable
export const K_LISTING = 30432; // addressable
export const K_IMAGE = 30434; // addressable: Image Registry entry (Milestone 2)
export const K_BLOB = 30435; // addressable: Blob Record (Milestone 2)
export const K_TEMPLATE = 30436; // addressable: Template (Milestone 2)
export const K_TAKEOVER = 30433; // addressable: a Warm Standby's Takeover claim (Milestone 3, spec §7.1)
export const TOON_LABEL = 'toon.network';


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

// ── the providers, each its own config file ───────────────────────────────
// The sandbox runs TWO compute providers (TOON_Network #34): `provider` behind
// provider-connector on :3240, and `provider2` behind provider2-connector on
// :3250, each with its own Nostr identity, its own peering channel and its own
// directory publisher. So every lookup a smoke makes about "the provider" —
// its client edge, its channel, its pubkey, its prices, its route names — is a
// question about WHICH ONE, and every helper below takes a provider.
//
// It is an ARGUMENT WITH A DEFAULT, not a new required parameter: the default
// is the first provider, so everything Milestone 1 and 2 wrote keeps reading
// (and meaning) exactly what it did. `PROVIDERS.provider2`, or the string
// 'provider2', asks the same question of the second one.
/** The first `key = value` scalar in `text` (a bare or quoted value, up to whitespace or a comment), or null. */
const tomlScalar = (text, key) =>
  text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\s#]+)"?`, 'm'))?.[1] ?? null;

function readProvider({ service, connectorNode, confFile, edge, sol, channel }) {
  const conf = readFileSync(join(ROOT, 'conf', confFile), 'utf8');
  const confValue = (key) => {
    const value = tomlScalar(conf, key);
    if (value === null) throw new Error(`conf/${confFile} has no ${key} line`);
    return value;
  };
  const listings = () =>
    conf.split(/^\[\[listings\]\]\s*$/m).slice(1).map((block) => {
      const field = (key) => {
        const value = tomlScalar(block, key);
        if (value === null) throw new Error(`a [[listings]] block in conf/${confFile} has no ${key}`);
        return value;
      };
      // `standby_price` is OPTIONAL by design (spec §7): a tier that prices no
      // Warm Standby has no such line and sells no standby route at all, which
      // is why this one field is read with `?? null` rather than demanded.
      const standby = tomlScalar(block, 'standby_price');
      return {
        name: field('name'),
        version: Number(field('version')),
        arch: field('arch'),
        lease_interval_s: Number(field('lease_interval_s')),
        price: BigInt(field('price')),
        standby_price: standby === null ? null : BigInt(standby),
        capacity: Number(field('capacity')),
      };
    });
  const addr = confValue('ilp_address');
  return {
    service, connectorNode, confFile, conf, edge, sol, channel,
    ilpAddress: addr,
    confValue,
    listings,
    /** One listing by name, or throw — a smoke buying a tier this provider does not sell is a smoke bug. */
    listing: (name) => {
      const l = listings().find((x) => x.name === name);
      if (!l) throw new Error(`conf/${confFile} has no [[listings]] block named ${name}`);
      return l;
    },
    pubkey: getPublicKey(Uint8Array.from(Buffer.from(confValue('nostr_private_key'), 'hex'))),
    // Every route is a suffix of this provider's own ILP address, so the same
    // call names a different route at each provider — which is the point.
    availabilityRoute: `${addr}.availability`,
    statusRoute: `${addr}.status`,
    terminateRoute: `${addr}.terminate`,
    spawnRoute: (listing, version) => `${addr}.${listing}.v${version}.spawn`,
    extendRoute: (listing, version) => `${addr}.${listing}.v${version}.extend`,
    // The two Warm Standby routes (spec §7). They exist only for a tier that
    // sets `standby_price`; the connector terminates neither for one that
    // does not.
    standbyRoute: (listing, version) => `${addr}.${listing}.v${version}.standby`,
    standbyExtendRoute: (listing, version) => `${addr}.${listing}.v${version}.standby.extend`,
  };
}

export const PROVIDERS = {
  provider: readProvider({
    service: 'provider', connectorNode: 'provider-connector', confFile: 'provider.toml',
    edge: PROVIDER_EDGE, sol: PROVIDER_SOL, channel: PROVIDER_CHANNEL,
  }),
  provider2: readProvider({
    service: 'provider2', connectorNode: 'provider2-connector', confFile: 'provider2.toml',
    edge: PROVIDER2_EDGE, sol: PROVIDER2_SOL, channel: PROVIDER2_CHANNEL,
  }),
};
/** The first provider: what every helper here means by "the provider" unless told otherwise. */
export const PROVIDER = PROVIDERS.provider;
/** A provider from a name ('provider2'), a provider object, or nothing (the first). */
export function providerOf(which = PROVIDER) {
  if (typeof which !== 'string') return which;
  const p = PROVIDERS[which];
  if (!p) throw new Error(`no such provider ${which} — known: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

// ── conf/provider.toml, the source of truth for prices, keys and listings ──
// The first provider's, by default; pass a provider for the second's.
export const providerConf = PROVIDER.conf;
export const confValue = (key, which) => providerOf(which).confValue(key);
/** Every `[[listings]]` block, in file order, as { name, version, arch, lease_interval_s, price, standby_price, capacity }. */
export const listings = (which) => providerOf(which).listings();
export const listing = (name, which) => providerOf(which).listing(name);
export const PROVIDER_PUBKEY = PROVIDER.pubkey;

// The free provider-wide routes and the paid per-listing-version ones.
export const AVAILABILITY_ROUTE = PROVIDER.availabilityRoute;
export const STATUS_ROUTE = PROVIDER.statusRoute;
export const TERMINATE_ROUTE = PROVIDER.terminateRoute;
export const spawnRoute = (listing, version, which) => providerOf(which).spawnRoute(listing, version);
export const extendRoute = (listing, version, which) => providerOf(which).extendRoute(listing, version);
export const standbyRoute = (listing, version, which) => providerOf(which).standbyRoute(listing, version);
export const standbyExtendRoute = (listing, version, which) =>
  providerOf(which).standbyExtendRoute(listing, version);

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
export const edgeOf = {
  'relay-connector': HUB,
  'provider-connector': PROVIDER_EDGE,
  'provider2-connector': PROVIDER2_EDGE,
  'store-connector': STORE_EDGE,
};
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
/**
 * The newest event `filter` matches, or null. An addressable kind is replaced
 * on the relay, but a relay may still hold an older copy (or two publishers
 * may race), so the reader decides rather than trusting the order it got.
 */
export async function newestMatching(filter, label) {
  const events = await relayRead(filter, label);
  if (events.length === 0) return null;
  return events.reduce((newest, e) => (e.created_at > newest.created_at ? e : newest));
}

export const tagValues = (event, name) => event.tags.filter((t) => t[0] === name).map((t) => t.slice(1));
export const hasTag = (event, cells) =>
  event.tags.some((t) => t.length >= cells.length && cells.every((c, i) => t[i] === c));
/** The directory filters for one provider: by author and the toon.network label. */
export const directoryFilter = (kind, which) =>
  ({ kinds: [kind], authors: [providerOf(which).pubkey], '#L': [TOON_LABEL] });
/**
 * The Takeover claims on one workload id from the given claimants — the same
 * filter the provider's own settle step uses (spec §7.1 step 3): the kind,
 * `d` = the workload id, and the AUTHORS restricted to the Standby Set, so a
 * claim from outside the set never even arrives.
 */
export const takeoverFilter = (workloadId, claimants) =>
  ({ kinds: [K_TAKEOVER], '#d': [workloadId], authors: claimants.map((c) => providerOf(c).pubkey) });

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
/** The names of every `toon-<id>` workload container that is RUNNING on the host daemon right now. */
export const runningWorkloads = () =>
  docker('ps', '--filter', 'name=toon-', '--format', '{{.Names}}').trim().split('\n').filter(isWorkloadName);
/** A container's state on the daemon (`running`, `exited`, …), or null when no container of that exact name exists. */
export function containerState(name) {
  const out = docker('ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}').trim();
  return out.length === 0 ? null : out;
}
/**
 * `docker compose stop|start <service>` for one sandbox service. The profile
 * is what lets compose resolve the service at all (every service here carries
 * one); `full` names them all, and stop/start touch only the container named.
 */
export const composeService = (verb, service) => docker('compose', '--profile', 'full', verb, service);
/** True once the compose service's container reports `healthy`, polled for up to `seconds`. */
export async function composeHealthy(service, seconds = 90) {
  const healthy = await waitFor(async () => {
    const out = docker('compose', '--profile', 'full', 'ps', '--format', '{{.Service}} {{.Health}}');
    return new RegExp(`^${service} healthy$`, 'm').test(out);
  }, seconds, 2000);
  return healthy === true;
}
/**
 * The hub client-book channel key (`solana:<account>`) a directory publisher
 * pays its relay writes on, read from the channel store on its own volume.
 * Two publishers hold two channels (docker-compose.yml says why), so the one
 * relay write a smoke is looking for has to be counted on the right one.
 */
export function publisherChannel(service) {
  const store = JSON.parse(docker('compose', '--profile', 'full', 'exec', '-T', service, 'cat', '/var/lib/toon-publisher/channels.json'));
  const ids = Object.keys(store);
  if (ids.length !== 1) throw new Error(`${service} holds ${ids.length} channels, expected exactly one`);
  return `solana:${ids[0]}`;
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
/**
 * A signed Lease Request: kind K_LEASE_REQUEST, p = the provider it is
 * addressed to, op, an expiration `ttl` seconds out. The `p` tag is the whole
 * reason this takes a provider: a provider refuses a request naming another
 * provider's key. `which` may also be an ARRAY of providers — a Standby Set's
 * spawn is signed ONCE, carries one `p` tag per member in the set's order,
 * and the same bytes go to every member (spec §7; only a spawn may name more
 * than one provider, and its content's `standby_set` must list the same keys).
 */
export function leaseRequest(tenant, op, content, ttl = 120, which) {
  const now = nowSec();
  const members = Array.isArray(which) ? which : [which];
  return finalizeEvent({
    kind: K_LEASE_REQUEST,
    created_at: now,
    tags: [...members.map((m) => ['p', providerOf(m).pubkey]), ['op', op], ['expiration', String(now + ttl)]],
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

/**
 * `ssh -i <tenant key> -p <ssh_port> tenant@<host> 'echo toon-ssh-ok; id -un'`, retried for a
 * fresh sshd. Returns { ok, user } — `ok` when the marker came back, `user` the remote
 * account that answered — or { err } with the last stderr line when every attempt failed.
 */
/**
 * `ssh -i <tenant key> -p <ssh_port> tenant@<host> <command>` once sshd answers (`sshInto`
 * first, so a fresh sshd is waited for the same way). Returns { ok: true, out } with the
 * command's stdout, or { ok: false, out, err } with its stderr's last line on a non-zero exit.
 */
export async function sshRun(tenant, access, command) {
  const opened = await sshInto(tenant, access);
  if (opened.ok !== true) return { ok: false, out: '', err: opened.err ?? 'ssh never succeeded' };
  try {
    const out = execFileSync('ssh', [
      '-i', tenant.keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
      '-p', String(access.ssh_port), `${SSH_USER}@${access.host}`, command,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message).trim().split('\n').pop() };
  }
}

export async function sshInto(tenant, access, attempts = 20) {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const out = execFileSync('ssh', [
        '-i', tenant.keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-p', String(access.ssh_port), `${SSH_USER}@${access.host}`, 'echo toon-ssh-ok; id -un',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const [marker, user = ''] = out.trim().split('\n');
      return { ok: marker === 'toon-ssh-ok', user };
    } catch (e) {
      lastErr = String(e.stderr ?? e.message).trim().split('\n').pop();
      await sleep(2000);
    }
  }
  return { err: lastErr };
}
