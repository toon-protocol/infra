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
//   2. every LISTING is on the relay — one per [[listings]] entry in
//      conf/provider.toml, addressable with d = the listing name — and the
//      first one (`basic`) is checked field by field: it points at the
//      Profile with an `a` tag and is FILTERABLE BY THE RELAY: #l
//      isolation:shared-kernel and #l arch:amd64 each return it, and a
//      wrong-arch filter returns nothing. Numbers are in content, not tags
//      (ADR 0002 — NIP-01 filters never match inside content)
//   3. LIVENESS is on the relay with expiration = created_at + 5 x cadence
//      (ADR 0007) and available.basic = capacity - live leases. The count is
//      THE PROVIDER'S OWN: nothing here spawns, and every other smoke ends
//      its lease through the provider (terminate, eviction, or waiting out
//      the expiry), so Liveness must say the full capacity — this smoke
//      waits up to one interval + sweep + cadence for a lease left behind
//      by TOON_SMOKE_KEEP_WORKLOAD=1 or an aborted run to expire, and says
//      so, rather than counting containers behind the provider's back
//   4. a cadence later Liveness was REPLACED, not accumulated: still exactly
//      one event from this provider, with a newer created_at and a newer id
//   5. the writes were PAID, on g.toon.relay and not on the free
//      g.toon.relay.ephemeral lane. Proven from the hub's own claim book:
//      the publisher's channel advanced by exactly one unit per event
//      observed in step 4's window (conf/connector-relay.toml prices
//      g.toon.relay at 1 and the ephemeral lane at 0, so an ephemeral write
//      would leave NO claim at all), and the hub's routing table still prices
//      the ephemeral lane at 0 — it is configured, and nothing used it.
import {
  HUB, PROVIDER_EDGE, RELAY_WS,
  K_PROFILE, K_LIVENESS, K_LISTING, TOON_LABEL,
  confValue, providerConf, listings, PROVIDER_PUBKEY, SWEEP_S,
  reporter, sleep, waitFor,
  claims, clientBookByChannel,
  relayRead, relayReadUntil, directoryFilter, tagValues, hasTag,
  composeNotRunning,
} from './lib/provider-smoke.mjs';

const { step, ok, bad, assert, fatal, done } = reporter('DIRECTORY SMOKE');

// conf/connector-relay.toml: the PAID relay route and the free lane beside it.
const RELAY_ROUTE = 'g.toon.relay';
const EPHEMERAL_ROUTE = 'g.toon.relay.ephemeral';

// ── conf/provider.toml, the source of truth for everything published ──────
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
const LISTINGS = listings();
const [L] = LISTINGS; // `basic`, checked field by field; the others by name only
const totalOf = (per) => [...per.values()].reduce((s, a) => s + a, 0n);

// ── 0. the provider, its publisher and the publisher's channel ────────────
step('0. the provider, the directory publisher and the paid relay route');

{
  const missing = composeNotRunning(['provider', 'directory-publisher', 'relay', 'relay-connector']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-payments\` first`);
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

const profileFilter = directoryFilter(K_PROFILE);
const profiles = await relayReadUntil(profileFilter, 'profile', 60);
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

const listingEvents = await relayReadUntil(directoryFilter(K_LISTING), 'listings', 60);
const names = listingEvents.map((e) => tagValues(e, 'd')[0]?.[0]).sort();
assert(
  JSON.stringify(names) === JSON.stringify(LISTINGS.map((l) => l.name).sort()),
  `one Listing event per [[listings]] entry, d = the listing NAME (stable across versions): ${names.join(', ')}`,
);
const listing = listingEvents.find((e) => tagValues(e, 'd')[0]?.[0] === L.name);
if (!listing) fatal(`no Listing named ${L.name} on the relay`);
ok(`listing ${listing.id} d=${L.name}`);

assert(
  hasTag(listing, ['a', `${K_PROFILE}:${PROVIDER_PUBKEY}:`]),
  'an `a` tag names its Provider Profile (ADR 0002) — a listing without one is not purchasable',
);
assert(hasTag(listing, ['L', TOON_LABEL]), 'tagged ["L","toon.network"]');
assert(
  hasTag(listing, ['l', `isolation:${ISOLATION}`, TOON_LABEL]),
  `labelled isolation:${ISOLATION}`,
);
assert(hasTag(listing, ['l', `arch:${L.arch}`, TOON_LABEL]), `labelled arch:${L.arch}`);

const l = JSON.parse(listing.content);
assert(l.version === L.version, `content version ${l.version}`);
assert(l.arch === L.arch, `content arch ${l.arch}`);
assert(BigInt(l.price) === L.price, `content price ${l.price} uUSDC per Lease Interval`);
assert(l.lease_interval_s === L.lease_interval_s, `content lease_interval_s ${l.lease_interval_s}`);
assert(
  l.resources && typeof l.resources.cpu_millicores === 'number',
  `content resources ${JSON.stringify(l.resources)} — numbers stay in content, not in tags`,
);

// THE RELAY does the search, not the tenant (ADR 0002).
const byIsolation = await relayRead(
  { kinds: [K_LISTING], '#L': [TOON_LABEL], '#l': [`isolation:${ISOLATION}`] },
  'by-isolation',
);
assert(
  byIsolation.some((e) => e.id === listing.id),
  `#l isolation:${ISOLATION} returns this listing from the relay (${byIsolation.length} match(es))`,
);
const byArch = await relayRead(
  { kinds: [K_LISTING], '#L': [TOON_LABEL], '#l': [`arch:${L.arch}`] },
  'by-arch',
);
assert(
  byArch.some((e) => e.id === listing.id),
  `#l arch:${L.arch} returns it too (${byArch.length} match(es))`,
);
const wrongArch = L.arch === 'amd64' ? 'arm64' : 'amd64';
const byWrongArch = await relayRead(
  { kinds: [K_LISTING], authors: [PROVIDER_PUBKEY], '#L': [TOON_LABEL], '#l': [`arch:${wrongArch}`] },
  'by-wrong-arch',
);
assert(
  byWrongArch.length === 0,
  `#l arch:${wrongArch} returns nothing from this provider — the label is doing real work`,
);

// ── 3. Liveness ───────────────────────────────────────────────────────────
step('3. Liveness says this provider is up and how much it can still sell');

const livenessFilter = directoryFilter(K_LIVENESS);
const first = await relayReadUntil(livenessFilter, 'liveness', 60);
if (first.length === 0) fatal(`no Liveness from ${PROVIDER_PUBKEY} on ${RELAY_WS}`);
assert(first.length === 1, `exactly one Liveness (replaceable): got ${first.length}`);
let liveness = first[0];

const expiration = Number(tagValues(liveness, 'expiration')[0]?.[0]);
assert(
  expiration === liveness.created_at + 5 * CADENCE,
  `expiration ${expiration} = created_at ${liveness.created_at} + 5 x ${CADENCE}s cadence (ADR 0007)`,
);
assert(hasTag(liveness, ['L', TOON_LABEL]), 'tagged ["L","toon.network"]');

// The provider counts its own leases, and this smoke holds none: every other
// smoke ends its lease THROUGH the provider before it exits, so the only way
// Liveness can say less than the capacity is a lease deliberately left to
// expire (smoke-provider's TOON_SMOKE_KEEP_WORKLOAD=1) or an aborted run —
// both gone within one interval plus the sweep, plus a cadence to publish.
const availableOf = (e) => JSON.parse(e.content).available?.[L.name];
if (availableOf(liveness) !== L.capacity) {
  const patience = L.lease_interval_s + SWEEP_S + CADENCE;
  console.log(
    `  available.${L.name} = ${availableOf(liveness)} < capacity ${L.capacity}: a \`${L.name}\` lease is still live ` +
      `(left to expire by another smoke?) — waiting up to ${patience}s for the provider to reap it…`,
  );
  const settled = await waitFor(async () => {
    const found = await relayRead(livenessFilter, 'liveness-settle').catch(() => []);
    if (found.length === 1) liveness = found[0];
    return found.length === 1 && availableOf(found[0]) === L.capacity;
  }, patience, 5000);
  if (!settled) bad(`available.${L.name} never came back to ${L.capacity}: a lease the provider still counts as live`);
}
assert(
  availableOf(liveness) === L.capacity,
  `available.${L.name} = ${availableOf(liveness)} = capacity ${L.capacity} - 0 live leases (the provider's own count: nothing holds a \`${L.name}\` lease)`,
);

// ── 4. replaced, not accumulated ──────────────────────────────────────────
step(`4. one cadence later Liveness is REPLACED (waiting ${CADENCE + 5}s)`);

const hubBefore = clientBookByChannel(await claims('relay-connector'));
await sleep((CADENCE + 5) * 1000);

const second = await relayReadUntil(livenessFilter, 'liveness-2', 20);
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

const profilesAgain = await relayRead(profileFilter, 'profile-2');
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
      'and it was read back out of the relay’s store, which that lane never writes to',
  );
}

// Second, the money: every Liveness published in the window above is one paid
// g.toon.relay packet at 1 uUSDC, on the publisher's own client channel
// against the hub. A free-lane write takes no claim at all.
let hubNow = clientBookByChannel(await claims('relay-connector'));
await waitFor(async () => {
  hubNow = clientBookByChannel(await claims('relay-connector'));
  return totalOf(hubNow) - totalOf(hubBefore) >= 1n;
}, 10);
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

done(
  'the Provider Profile, its Listings and its Liveness are readable ' +
    'on the sandbox relay, the Listing is filterable by its isolation and arch labels, Liveness is ' +
    'replaced on every cadence with an expiration five cadences out, and every write was a paid ' +
    'g.toon.relay packet on the publisher’s own Solana channel — nothing on the ephemeral lane.',
);
