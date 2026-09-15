// Provider Directory smoke test (TOON_Network Milestone 1, ticket #6): the
// provider is DISCOVERABLE. Run from sandbox/ on the host after
// `make up-payments` (or `make up`); `make smoke-directory`.
//
//   0. the provider and its directory publisher are up, and the publisher's
//      Solana mock-USDC channel against the hub is open
//   1. the PROVIDER PROFILE is on the relay: one replaceable event, authored
//      by conf/provider.toml's Nostr key, tagged ["L","toon.network"], and
//      its content carries the ilp address, the connector URL, the connector's
//      SEALING KEY (byte-for-byte what the connector's own /ilp identity
//      reports — ADR 0011), the Relay Set, both settlement legs, isolation,
//      hidden:false, host and the liveness cadence
//   2. every LISTING is on the relay, addressable with d = the listing name,
//      pointing at the Profile with an `a` tag, and FILTERABLE BY THE RELAY:
//      #l isolation:shared-kernel and #l arch:amd64 each return it, and a
//      wrong-arch filter returns nothing. Numbers are in content, not tags
//      (ADR 0002 — NIP-01 filters never match inside content)
//   3. LIVENESS is on the relay with expiration = created_at + 5 x cadence
//      (ADR 0007) and available.basic = capacity - running leases
//   4. a cadence later Liveness was REPLACED, not accumulated: still exactly
//      one event from this provider, with a newer created_at and a newer id
//   5. the writes were PAID, on g.toon.relay and not on the free
//      g.toon.relay.ephemeral lane. Proven from the hub's own claim book:
//      the publisher's channel advanced by exactly one unit per event
//      observed in step 4's window (conf/connector-relay.toml prices
//      g.toon.relay at 1 and the ephemeral lane at 0, so an ephemeral write
//      would leave NO claim at all), and the hub's routing table still prices
//      the ephemeral lane at 0 — it is configured, and nothing used it.
//
// Nothing here spawns a lease. `make smoke-provider` does that; if one of its
// workloads is still running when this runs, step 3 sees availability below
// capacity and says so rather than failing — the provider counting its own
// leases is the point.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getPublicKey } from 'nostr-tools/pure';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
const PROVIDER_EDGE = process.env.PROVIDER_EDGE_URL ?? 'http://localhost:3240';
const RELAY_WS = process.env.RELAY_WS ?? 'ws://localhost:7100';

// Mirrored from the provider's src/nostr/kinds.rs. EVERY NUMBER IS A
// PLACEHOLDER until kinds are allocated (spec §11); what is normative is the
// NIP-01 class, which is why the assertions below talk about replacement
// rather than about the numbers.
const K_PROFILE = 10432; // replaceable
const K_LIVENESS = 10433; // replaceable
const K_LISTING = 30432; // addressable
const TOON_LABEL = 'toon.network';

// conf/connector-relay.toml: the PAID relay route and the free lane beside it.
const RELAY_ROUTE = 'g.toon.relay';
const EPHEMERAL_ROUTE = 'g.toon.relay.ephemeral';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`);
};
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const fatal = (msg) => {
  console.error(`\nDIRECTORY SMOKE FAILED: ${msg}`);
  process.exit(1);
};

// ── conf/provider.toml, the source of truth for everything published ──────
const providerConf = readFileSync(join(ROOT, 'conf', 'provider.toml'), 'utf8');
const confValue = (key) => {
  const m = providerConf.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\s#]+)"?`, 'm'));
  if (!m) throw new Error(`conf/provider.toml has no ${key} line`);
  return m[1];
};
const PROVIDER_PUBKEY = getPublicKey(
  Uint8Array.from(Buffer.from(confValue('nostr_private_key'), 'hex')),
);
const ILP_ADDRESS = confValue('ilp_address');
const CONNECTOR_URL = confValue('connector_url');
const SEAL_KEY = confValue('connector_seal_key');
const ISOLATION = confValue('isolation');
const CADENCE = Number(confValue('liveness_cadence_s'));
const PUBLIC_IP = confValue('public_ip');
const RELAY_SET = JSON.parse(
  providerConf.match(/^\s*relay_set\s*=\s*(\[[^\]]*\])/m)?.[1] ??
    (() => {
      throw new Error('conf/provider.toml has no relay_set line');
    })(),
);
const LISTING = confValue('name');
const LISTING_VERSION = Number(confValue('version'));
const ARCH = confValue('arch');
const PRICE = Number(confValue('price'));
const LEASE_INTERVAL_S = Number(confValue('lease_interval_s'));
const CAPACITY = Number(confValue('capacity'));

const bearer = (node) =>
  readFileSync(join(ROOT, 'keys', 'toon', node, 'operator-bearer.token'), 'utf8').trim();
async function claims(node) {
  const res = await fetch(`${HUB}/claims`, {
    headers: { authorization: `Bearer ${bearer(node)}` },
  });
  if (!res.ok) throw new Error(`${node} GET /claims -> ${res.status}`);
  return res.json();
}
/** Inbound client-book takings, per channel — the hub is paid by its clients. */
function clientBookByChannel(rows) {
  const per = new Map();
  for (const r of rows) {
    if (r.direction !== 'inbound' || r.book !== 'client') continue;
    const a = BigInt(r.cumulative_amount ?? 0);
    if (a > (per.get(r.channel_id) ?? 0n)) per.set(r.channel_id, a);
  }
  return per;
}
const totalOf = (per) => [...per.values()].reduce((s, a) => s + a, 0n);

/** One NIP-01 REQ against the relay, resolved at EOSE. */
function read(filter, label = 'directory') {
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

/** Wait until `filter` returns at least one event, or give up. */
async function readUntil(filter, label, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    const events = await read(filter, label).catch(() => []);
    if (events.length > 0) return events;
    await sleep(500);
  }
  return [];
}

const tagValues = (event, name) =>
  event.tags.filter((t) => t[0] === name).map((t) => t.slice(1));
const hasTag = (event, cells) =>
  event.tags.some((t) => t.length >= cells.length && cells.every((c, i) => t[i] === c));

// ── 0. the provider, its publisher and the publisher's channel ────────────
step('0. the provider, the directory publisher and the paid relay route');

const running = execFileSync('docker', ['compose', 'ps', '--format', '{{.Service}} {{.State}}'], {
  cwd: ROOT,
  encoding: 'utf8',
});
for (const service of ['provider', 'directory-publisher', 'relay', 'relay-connector']) {
  if (!new RegExp(`^${service} running`, 'm').test(running)) {
    fatal(`the \`${service}\` service is not running — \`make up-payments\` first`);
  }
}
ok('provider, directory-publisher, relay and relay-connector are up');

const hubDesc = await fetch(`${HUB}/ilp`)
  .then((r) => r.json())
  .catch((e) => fatal(`the hub is unreachable at ${HUB}: ${e.message}`));
const hubRoutes = Object.fromEntries((hubDesc.routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
assert(hubRoutes[RELAY_ROUTE] === 1n, `the hub prices ${RELAY_ROUTE} at 1 uUSDC — the PAID relay route`);
assert(
  hubRoutes[EPHEMERAL_ROUTE] === 0n,
  `and ${EPHEMERAL_ROUTE} at 0 — the free lane, which a directory event must never use (ADR 0007)`,
);

// The sealing key the Profile pins must be the connector's own (ADR 0011).
const providerIdentity = await fetch(`${PROVIDER_EDGE}/ilp/identity`)
  .then((r) => r.json())
  .catch((e) => fatal(`the provider connector is unreachable at ${PROVIDER_EDGE}: ${e.message}`));

// ── 1. the Provider Profile ───────────────────────────────────────────────
step('1. the Provider Profile is on the relay');

const profileFilter = { kinds: [K_PROFILE], authors: [PROVIDER_PUBKEY], '#L': [TOON_LABEL] };
const profiles = await readUntil(profileFilter, 'profile', 60);
if (profiles.length === 0) {
  fatal(
    `no Provider Profile from ${PROVIDER_PUBKEY} on ${RELAY_WS}. ` +
      '`docker compose logs directory-publisher provider` says why.',
  );
}
assert(profiles.length === 1, `exactly one Profile (replaceable, one per provider): got ${profiles.length}`);
const profile = profiles[0];
ok(`profile ${profile.id} created_at ${profile.created_at}`);

const p = JSON.parse(profile.content);
assert(p.ilp_address === ILP_ADDRESS, `ilp_address ${p.ilp_address}`);
assert(p.connector_url === CONNECTOR_URL, `connector_url ${p.connector_url}`);
assert(
  p.connector_seal_key === SEAL_KEY && p.connector_seal_key === providerIdentity.publicKey,
  `connector_seal_key is the key provider-connector's own /ilp identity reports (${String(p.connector_seal_key).slice(0, 18)}…) — ADR 0011`,
);
assert(
  JSON.stringify(p.relays) === JSON.stringify(RELAY_SET),
  `relays ${JSON.stringify(p.relays)} is the Relay Set`,
);
assert(
  Array.isArray(p.settlement) &&
    p.settlement.some((s) => s.chain === 'solana' && s.decimals === 6) &&
    p.settlement.some((s) => s.chain.startsWith('evm:') && s.decimals === 6),
  `settlement names both legs: ${p.settlement?.map((s) => `${s.chain}/${s.decimals}dp`).join(', ')}`,
);
assert(p.isolation === ISOLATION, `isolation ${p.isolation}`);
assert(p.hidden === false, 'hidden is false — Milestone 1 has no Hidden Provider');
assert(p.host === PUBLIC_IP, `host ${p.host}`);
assert(p.liveness_cadence_s === CADENCE, `liveness_cadence_s ${p.liveness_cadence_s}`);
assert(hasTag(profile, ['L', TOON_LABEL]), 'tagged ["L","toon.network"], so a directory query selects it');

// ── 2. the Listings, and the relay doing the filtering ────────────────────
step('2. every Listing is on the relay and filterable by its labels');

const listings = await readUntil(
  { kinds: [K_LISTING], authors: [PROVIDER_PUBKEY], '#L': [TOON_LABEL] },
  'listings',
  60,
);
assert(listings.length === 1, `one Listing event per tier: got ${listings.length}`);
const listing = listings[0];
ok(`listing ${listing.id} d=${tagValues(listing, 'd')[0]?.[0]}`);

assert(
  tagValues(listing, 'd')[0]?.[0] === LISTING,
  `d is the listing NAME (${LISTING}), stable across versions`,
);
assert(
  hasTag(listing, ['a', `${K_PROFILE}:${PROVIDER_PUBKEY}:`]),
  'an `a` tag names its Provider Profile (ADR 0002) — a listing without one is not purchasable',
);
assert(hasTag(listing, ['L', TOON_LABEL]), 'tagged ["L","toon.network"]');
assert(
  hasTag(listing, ['l', `isolation:${ISOLATION}`, TOON_LABEL]),
  `labelled isolation:${ISOLATION}`,
);
assert(hasTag(listing, ['l', `arch:${ARCH}`, TOON_LABEL]), `labelled arch:${ARCH}`);

const l = JSON.parse(listing.content);
assert(l.version === LISTING_VERSION, `content version ${l.version}`);
assert(l.arch === ARCH, `content arch ${l.arch}`);
assert(l.price === PRICE, `content price ${l.price} uUSDC per Lease Interval`);
assert(l.lease_interval_s === LEASE_INTERVAL_S, `content lease_interval_s ${l.lease_interval_s}`);
assert(
  l.resources && typeof l.resources.cpu_millicores === 'number',
  `content resources ${JSON.stringify(l.resources)} — numbers stay in content, not in tags`,
);

// THE RELAY does the search, not the tenant (ADR 0002).
const byIsolation = await read(
  { kinds: [K_LISTING], '#L': [TOON_LABEL], '#l': [`isolation:${ISOLATION}`] },
  'by-isolation',
);
assert(
  byIsolation.some((e) => e.id === listing.id),
  `#l isolation:${ISOLATION} returns this listing from the relay (${byIsolation.length} match(es))`,
);
const byArch = await read(
  { kinds: [K_LISTING], '#L': [TOON_LABEL], '#l': [`arch:${ARCH}`] },
  'by-arch',
);
assert(
  byArch.some((e) => e.id === listing.id),
  `#l arch:${ARCH} returns it too (${byArch.length} match(es))`,
);
const wrongArch = ARCH === 'amd64' ? 'arm64' : 'amd64';
const byWrongArch = await read(
  { kinds: [K_LISTING], authors: [PROVIDER_PUBKEY], '#L': [TOON_LABEL], '#l': [`arch:${wrongArch}`] },
  'by-wrong-arch',
);
assert(
  byWrongArch.length === 0,
  `#l arch:${wrongArch} returns nothing from this provider — the label is doing real work`,
);

// ── 3. Liveness ───────────────────────────────────────────────────────────
step('3. Liveness says this provider is up and how much it can still sell');

const livenessFilter = { kinds: [K_LIVENESS], authors: [PROVIDER_PUBKEY], '#L': [TOON_LABEL] };
const first = await readUntil(livenessFilter, 'liveness', 60);
if (first.length === 0) fatal(`no Liveness from ${PROVIDER_PUBKEY} on ${RELAY_WS}`);
assert(first.length === 1, `exactly one Liveness (replaceable): got ${first.length}`);
const liveness = first[0];

const expiration = Number(tagValues(liveness, 'expiration')[0]?.[0]);
assert(
  expiration === liveness.created_at + 5 * CADENCE,
  `expiration ${expiration} = created_at ${liveness.created_at} + 5 x ${CADENCE}s cadence (ADR 0007)`,
);
assert(hasTag(liveness, ['L', TOON_LABEL]), 'tagged ["L","toon.network"]');

// The provider names every workload `toon-<id>` on the HOST daemon (the
// provider repo's src/docker.rs). The anchored digits matter: this sandbox's
// own compose containers are `toon-sandbox-*` and are not leases.
const runningLeases = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((n) => /^toon-\d+$/.test(n)).length;
const availability = JSON.parse(liveness.content).available;
assert(
  availability?.[LISTING] === CAPACITY - runningLeases,
  `available.${LISTING} = ${availability?.[LISTING]} = capacity ${CAPACITY} - ${runningLeases} running lease(s)`,
);

// ── 4. replaced, not accumulated ──────────────────────────────────────────
step(`4. one cadence later Liveness is REPLACED (waiting ${CADENCE + 5}s)`);

const hubBefore = clientBookByChannel(await claims('relay-connector'));
await sleep((CADENCE + 5) * 1000);

const second = await readUntil(livenessFilter, 'liveness-2', 20);
assert(second.length === 1, `still exactly ONE Liveness event, not a pile: got ${second.length}`);
const later = second[0];
assert(
  later.created_at > liveness.created_at,
  `and it is newer: created_at ${later.created_at} > ${liveness.created_at}`,
);
assert(later.id !== liveness.id, `a different event id (${later.id.slice(0, 12)}… vs ${liveness.id.slice(0, 12)}…)`);
assert(
  Number(tagValues(later, 'expiration')[0]?.[0]) === later.created_at + 5 * CADENCE,
  'the replacement carries its own expiration, five cadences out',
);

const profilesAgain = await read(profileFilter, 'profile-2');
assert(
  profilesAgain.length === 1 && profilesAgain[0].id === profile.id,
  'the Profile was NOT republished on the cadence — it describes the config, not the moment',
);

// ── 5. paid, on the paid route ────────────────────────────────────────────
step('5. the writes were PAID — and nothing touched the ephemeral lane');

// TWO independent proofs, because the money alone does not name the lane and
// the lane alone does not prove payment.
//
// First, structurally: the relay's free lane (POST /write-ephemeral, behind
// g.toon.relay.ephemeral) accepts ONLY ephemeral kinds, 20000 <= kind <
// 30000, and NEVER stores anything. Every event read back above is outside
// that range AND came out of the relay's store, so none of them can have
// travelled the free lane — it would have answered 400 and persisted nothing.
for (const [what, kind] of [
  ['Profile', profile.kind],
  ['Listing', listing.kind],
  ['Liveness', later.kind],
]) {
  assert(
    !(kind >= 20000 && kind < 30000),
    `the ${what} is kind ${kind}, outside the ephemeral range the free lane accepts — ` +
      'and it was read back out of the relay\u2019s store, which that lane never writes to',
  );
}

// Second, the money: every Liveness published in the window above is one paid
// g.toon.relay packet at 1 uUSDC, on the publisher's own client channel
// against the hub. A free-lane write takes no claim at all.
let hubNow = clientBookByChannel(await claims('relay-connector'));
for (let i = 0; i < 20 && totalOf(hubNow) - totalOf(hubBefore) < 1n; i++) {
  await sleep(500);
  hubNow = clientBookByChannel(await claims('relay-connector'));
}
const advanced = totalOf(hubNow) - totalOf(hubBefore);
const publications = Math.max(1, Math.floor((later.created_at - liveness.created_at) / CADENCE));
assert(
  advanced >= BigInt(publications),
  `the hub's client book advanced by ${advanced} uUSDC over ${publications} Liveness publication(s) ` +
    `— one signed claim per paid write; the free lane would have left none`,
);

const payingChannels = [...hubNow.keys()].filter(
  (c) => (hubNow.get(c) ?? 0n) > (hubBefore.get(c) ?? 0n),
);
assert(
  payingChannels.length > 0 && payingChannels.every((c) => /^solana:/.test(c)),
  `paid on a SOLANA mock-USDC channel: ${payingChannels.join(', ') || '(none)'}`,
);

console.log(
  failures === 0
    ? '\n\x1b[32mDIRECTORY SMOKE OK: the Provider Profile, its Listing and its Liveness are readable ' +
        'on the sandbox relay, the Listing is filterable by its isolation and arch labels, Liveness is ' +
        'replaced on every cadence with an expiration five cadences out, and every write was a paid ' +
        'g.toon.relay packet on the publisher’s own Solana channel — nothing on the ephemeral lane.\x1b[0m'
    : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`,
);
process.exit(failures === 0 ? 0 : 1);
