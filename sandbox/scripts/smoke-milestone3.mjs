// MILESTONE 3 ACCEPTANCE TEST (TOON_Network #11, ticket #35; spec §6, §7,
// Appendix A): Warm Standby end to end against the real sandbox — relay, hub,
// BOTH connectors and BOTH providers. A tenant signs ONE spawn whose content
// names a Standby Set, `standby_set: [<provider>, <provider2>]`, and pays the
// same bytes twice: on the first provider's `warm.v1.spawn` at the full price
// (index 0: the PRIMARY, which runs the workload) and on the second's
// `warm.v1.standby` at `standby_price` (index 1: the WARM STANDBY, which holds
// capacity and runs nothing). Then the primary's container is stopped and the
// standby takes the workload over. Run from sandbox/ on the host after
// `make up-payments` (or `make up`); `make smoke-m3`.
//
//   0.  the stack is up; both connectors terminate the `warm` routes at the
//       committed prices (spawn/extend at `price`, standby/standby.extend at
//       `standby_price`) and the hub forwards each at price + its fee
//   0b. both providers' `warm` Listings on the relay carry `standby_price`
//       (THE GATE: a first provider that sells no `warm` cannot be this
//       set's primary, and the smoke stops there rather than buying
//       something else), and each Liveness has a `warm` slot to sell
//   1.  a tenant channel against the hub, and every book's baseline: the
//       hub's client book, both peer books, and the second provider's
//       directory publisher's own channel, read right after a Liveness
//   2.  the SPAWN, one signed Lease Request with two `p` tags: the primary
//       answers role primary WITH access, its workload runs on the host
//       daemon in the first provider's id range and SSH opens with the
//       tenant's key; the standby answers role standby with NO access and
//       the same expires_at arithmetic (one standby payment, one interval)
//       and starts nothing; status on it says `reserved`; its next Liveness
//       has available.warm one lower — a reservation is a lease
//   3.  the RESERVATION's price: `.standby.extend` adds one interval at
//       standby_price; `.extend` on it is refused 409 not_running — and
//       BILLED, at the running price (one route, one price: ADR 0003)
//   4.  the primary's CONTAINER IS STOPPED (`docker compose stop provider`):
//       its Liveness stops being replaced and expires five cadences after
//       its last publication; one cadence of continuous silence later the
//       standby announces a TAKEOVER — kind 30433, d = the workload id,
//       content { workload_id, primary }, signed by the second provider —
//       to the primary's Relay Set (this one relay), read back here by the
//       provider's own settle filter
//   5.  two cadences after that it settles the race, wins (the only
//       claimant) and starts the workload FROM THE IMAGE in ITS OWN id
//       range: a running toon-11xx container reachable over SSH with the
//       tenant's key; status on the standby says running, role still
//       standby, access present, takeover.winner = its pubkey, expires_at
//       unchanged (winning buys no time)
//   6.  the WINNER's price: `.extend` at the full price adds one interval;
//       `.standby.extend` is refused 409 not_standby — and billed
//   7.  the primary's container is STARTED again: at startup it finds the
//       Takeover on its own Relay Set, stops its container and marks the
//       lease taken over — status says `stopped`, role primary, no access —
//       and EXACTLY ONE copy of the workload is running on the host daemon:
//       the standby's; the primary's container exists, exited
//   8.  the BOOKS, to the unit: the second provider's peer book grew by
//       standby_price x 2 (reservation + its extension) + price (the
//       post-Takeover extension) + the two billed refusals; the first
//       provider's by the full spawn price and nothing else; the hub's client
//       book on the tenant's channel by every packet at the hub's prices; and
//       the second provider's directory publisher paid ONE MORE g.toon.relay
//       unit than its Liveness cadences account for — the Takeover event
//   9.  the tenant ends both leases through the free terminate routes
//
// TIMELINE, at the sandbox's 30 s cadence (conf/provider*.toml): stop → the
// primary's Liveness expires (five cadences after the last publication, so
// four to five after the stop) → one cadence of silence → the announcement,
// within a 10 s watchdog step → two cadences to settle → the workload starts.
// About four minutes from the stop, plus the image start; the whole run is
// budgeted at eight. The `warm` tier's 600 s Lease Interval is what lets the
// reservation outlive that, and `.standby.extend` in step 2 doubles it.
//
// TOON_M3_STANDBY_ONLY=1 runs steps 0–3, 8 and 9 against
// the SECOND PROVIDER ALONE — the same code, with the first provider named in
// the set but never paid — for a sandbox whose first provider does not (yet)
// sell `warm`. It proves the reservation side only and SAYS SO in its verdict;
// it is not a pass of this milestone.
import { verifyEvent } from 'nostr-tools/pure';
import {
  HUB, HUB_FEE, BUYER_SOL, K_LISTING, K_LIVENESS, K_TAKEOVER, TOON_LABEL,
  providerOf, IMAGE, SSH_USER, SWEEP_S, WATCHDOG_S,
  reporter, jstr, nowSec, waitFor,
  claims, clientBookOnChannel, peerBookTotal, publisherChannel,
  relayRead, relayReadUntil, directoryFilter, takeoverFilter, tagValues, hasTag,
  docker, composeNotRunning, composeService, composeHealthy, findWorkload, containerState, runningWorkloads, workloadGone,
  newTenant, leaseRequest, newWorkloadId, spawnContent, openChannel, sshInto,
} from './lib/provider-smoke.mjs';

const STANDBY_ONLY = /^(1|true|yes)$/i.test(process.env.TOON_M3_STANDBY_ONLY ?? '');
const { step, ok, bad, assert, fatal, done } = reporter(STANDBY_ONLY ? 'MILESTONE 3 SMOKE (STANDBY-ONLY)' : 'MILESTONE 3 SMOKE');
const startedAt = Date.now();

// THE SET: index 0 the primary, index 1 the standby, in the order the spawn's
// `standby_set` lists them. Every question below is asked of one of the two.
const PRIMARY = providerOf('provider');
const STANDBY = providerOf('provider2');
const SET = [PRIMARY, STANDBY];
const L = STANDBY.listing('warm');
{
  const l1 = PRIMARY.listing('warm');
  if (l1.price !== L.price || l1.standby_price !== L.standby_price || l1.lease_interval_s !== L.lease_interval_s) {
    fatal(`conf/${PRIMARY.confFile} and conf/${STANDBY.confFile} price \`warm\` differently — a Standby Set is one tier bought twice`);
  }
  if (L.standby_price === null) fatal(`conf/${STANDBY.confFile}'s \`warm\` sets no standby_price, so nothing sells a standby`);
}
const CADENCE = Number(STANDBY.confValue('liveness_cadence_s'));
if (Number(PRIMARY.confValue('liveness_cadence_s')) !== CADENCE) fatal('the two providers publish Liveness on different cadences; the timeline below assumes one');
const HUB_PRICE = L.price + HUB_FEE;
const HUB_STANDBY_PRICE = L.standby_price + HUB_FEE;
// The wait budgets, from the provider's rule (README "Watching the primary"):
// a Liveness expires 5 cadences after it was published — so up to 5 after the
// stop — and the standby announces after 1 more cadence of continuous
// silence, within one watchdog step; it settles 2 cadences after announcing.
const TAKEOVER_BUDGET_S = 7 * CADENCE + 2 * WATCHDOG_S + 15;
const SETTLE_BUDGET_S = 2 * CADENCE + 2 * WATCHDOG_S + 60; // + the image start

// ── 0. the stack, the prices, the two directories ────────────────────────
step('0. the stack is up and every edge prices the `warm` routes consistently');
{
  const missing = composeNotRunning(['provider', 'provider-connector', 'directory-publisher', 'provider2', 'provider2-connector', 'directory-publisher2', 'relay', 'relay-connector']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-payments\` first`);
  ok('both providers, both connectors, both directory publishers, relay and relay-connector are up');
}
const advertised = {};
for (const [name, url] of [['hub', HUB], [PRIMARY.connectorNode, PRIMARY.edge], [STANDBY.connectorNode, STANDBY.edge]]) {
  const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
  if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  advertised[name] = Object.fromEntries((desc.routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
}
for (const P of SET) {
  const at = advertised[P.connectorNode];
  assert(at[P.spawnRoute(L.name, L.version)] === L.price && at[P.extendRoute(L.name, L.version)] === L.price,
    `${P.connectorNode} terminates ${P.spawnRoute(L.name, L.version)} and .extend at ${L.price} — conf/${P.confFile}'s \`warm\` price`);
  assert(at[P.standbyRoute(L.name, L.version)] === L.standby_price && at[P.standbyExtendRoute(L.name, L.version)] === L.standby_price,
    `and .standby and .standby.extend at ${L.standby_price} — its standby_price, the rows that exist only because it is set`);
  assert(advertised.hub[P.spawnRoute(L.name, L.version)] === HUB_PRICE && advertised.hub[P.standbyRoute(L.name, L.version)] === HUB_STANDBY_PRICE
    && advertised.hub[P.extendRoute(L.name, L.version)] === HUB_PRICE && advertised.hub[P.standbyExtendRoute(L.name, L.version)] === HUB_STANDBY_PRICE,
  `the hub forwards all four at price + its fee ${HUB_FEE} (${HUB_PRICE} / ${HUB_STANDBY_PRICE})`);
}
console.log(`  listing ${L.name} v${L.version}: lease_interval_s ${L.lease_interval_s}, price ${L.price}, standby_price ${L.standby_price}, capacity ${L.capacity}; cadence ${CADENCE}s; watchdog ${WATCHDOG_S}s`);

/** The `warm` Listing a provider publishes, or null. */
async function warmListingOf(P) {
  const events = await relayReadUntil(directoryFilter(K_LISTING, P), `listings-${P.service}`, 30);
  return events.find((e) => tagValues(e, 'd')[0]?.[0] === L.name) ?? null;
}
/** The newest Liveness a provider publishes, or null. */
const livenessOf = async (P) => (await relayRead(directoryFilter(K_LIVENESS, P), `liveness-${P.service}`).catch(() => []))[0] ?? null;
/** The next Liveness from `P` created strictly after `afterSec`, or null within cadence + 10 s. */
async function livenessAfter(P, afterSec) {
  return waitFor(async () => {
    const live = await livenessOf(P);
    return live && live.created_at > afterSec ? live : null;
  }, CADENCE + 10, 2000);
}
const availableOf = (live) => JSON.parse(live.content).available?.[L.name];
/** True when `toon-<id>` falls in provider `P`'s committed workload id range. */
function inRangeOf(P) {
  const [lo, hi] = [Number(P.confValue('workload_id_range_start')), Number(P.confValue('workload_id_range_end'))];
  return Object.assign((name) => { const id = Number(name.slice('toon-'.length)); return id >= lo && id <= hi; }, { lo, hi });
}

step(`0b. the directory: both providers sell \`${L.name}\` with a standby_price, and count nothing reserved`);
// The GATE for the full run: a Standby Set is one tier bought from two
// providers, so the first provider's Listing has to say it sells it. A first
// provider that publishes no `warm` Listing (or one without standby_price)
// cannot be the primary of this set, and this smoke says so rather than
// buying something else and calling it Milestone 3.
for (const P of STANDBY_ONLY ? [STANDBY] : SET) {
  const listing = await warmListingOf(P);
  const content = listing ? JSON.parse(listing.content) : null;
  const sells = content !== null && BigInt(content.standby_price ?? -1) === L.standby_price && BigInt(content.price) === L.price;
  if (!sells && P === PRIMARY) {
    fatal(`${P.service} (${P.pubkey.slice(0, 12)}…) publishes ${listing ? `a \`${L.name}\` Listing without the committed standby_price: ${listing.content}` : `no \`${L.name}\` Listing`}`
      + ` — it is not running conf/${P.confFile}. The full run needs it; TOON_M3_STANDBY_ONLY=1 proves the reservation side alone.`);
  }
  assert(sells, `${P.service}'s \`${L.name}\` Listing on the relay: ${listing ? listing.content : 'MISSING'}`);
  assert(listing && hasTag(listing, ['L', TOON_LABEL]) && listing.pubkey === P.pubkey, `signed by ${P.pubkey.slice(0, 12)}… and labelled ["L","${TOON_LABEL}"]`);
}
if (STANDBY_ONLY) {
  const listing = await warmListingOf(PRIMARY);
  console.log(`  STANDBY-ONLY: ${PRIMARY.service} publishes ${listing ? `\`${L.name}\` (${listing.content})` : `no \`${L.name}\` Listing`}; it is named at index 0 of the set and never paid`);
}
// The count each provider agrees with is its own. It is read as a BASELINE
// rather than waited on to reach capacity: a reservation an aborted run left
// behind holds its slot for up to two 600 s intervals + the sweep, and the
// tier's second slot is there so that this run can still buy one — what
// step 2 asserts is the drop by one from here.
for (const P of STANDBY_ONLY ? [STANDBY] : SET) {
  const found = await relayReadUntil(directoryFilter(K_LIVENESS, P), `liveness-${P.service}`, 60);
  const live = found[0] ?? null;
  if (!live) fatal(`no Liveness from ${P.service} on the relay`);
  const expiration = Number(tagValues(live, 'expiration')[0]?.[0]);
  assert(found.length === 1 && expiration > nowSec(), `exactly one Liveness from ${P.service}, unexpired (${expiration - nowSec()}s out)`);
  if (!(availableOf(live) >= 1)) fatal(`${P.service}'s Liveness says available.${L.name} = ${availableOf(live)}: no slot to buy (a reservation left behind expires within ${2 * L.lease_interval_s + SWEEP_S}s)`);
  ok(`${P.service}'s Liveness says available.${L.name} = ${availableOf(live)} of capacity ${L.capacity}${availableOf(live) < L.capacity ? ' — a lease from an earlier run still counts; this run needs one slot' : ''}`);
}

// ── the tenant, its channel, the books ───────────────────────────────────
step('1. a tenant with a Solana mock-USDC channel against the hub; the four books before');
const { client, opened } = await openChannel(HUB, 'channels.json');
assert(client.identity?.solanaPublicKey === BUYER_SOL, `the tenant pays as ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded`);
ok(`channel ${opened.channelId} against the hub (status ${opened.status ?? 'open'})`);
const channelKey = `solana:${opened.channelId}`;
const RELAY_PAYER = publisherChannel('directory-publisher2');
// Every packet is SEALED TO THE MEMBER IT IS FOR: two providers, two edges,
// two sealing keys (ADR 0011), and a packet sealed to the wrong one is money
// paid to the wrong connector.
const sendTo = (P, route, body) => client.send(route, { body }, { sealTo: P.edge, timeoutMs: 120_000 });
// The counts the books are closed against: what the tenant paid the hub,
// packet by packet, and what reached each provider's connector.
const paid = { hub: 0n, [PRIMARY.service]: 0n, [STANDBY.service]: 0n };
const took = (P, sent, what, expectedCost) => {
  const cost = BigInt(sent.claim?.amount ?? 0);
  assert(cost === expectedCost, `the tenant paid the hub exactly ${cost} uUSDC for ${what} (${expectedCost})`);
  paid.hub += cost;
  paid[P.service] += cost > HUB_FEE ? cost - HUB_FEE : 0n;
};
// The tenant channel is shared by every smoke. A packet an earlier, aborted
// run sent that the hub gave up on can be fulfilled and booked later, and the
// connector applies such a claim on the channel's NEXT packet. One uncounted
// free packet first, so the baseline below holds nothing pending.
await sendTo(STANDBY, STANDBY.availabilityRoute, { listing: L.name, version: L.version, image: IMAGE });
const readBooks = async () => {
  const hub = await claims('relay-connector');
  return {
    hub: clientBookOnChannel(hub, channelKey),
    relay: clientBookOnChannel(hub, RELAY_PAYER),
    [PRIMARY.service]: peerBookTotal(await claims(PRIMARY.connectorNode), PRIMARY.channel),
    [STANDBY.service]: peerBookTotal(await claims(STANDBY.connectorNode), STANDBY.channel),
  };
};
// The relay book is counted from a FRESH Liveness: the standby's publisher
// pays one unit per cadence for its Liveness and one per Takeover, so what it
// paid between two Livenesses is the cadences between them plus the claims.
// Reading the book right after a publication leaves the least room for the
// next one to land between the two reads.
const liveness0 = await livenessAfter(STANDBY, nowSec() - 1);
if (!liveness0) fatal(`no fresh Liveness from ${STANDBY.service} within a cadence`);
const before = await readBooks();
console.log(`  books before: hub client (${channelKey}) = ${before.hub}; ${PRIMARY.connectorNode} peer = ${before[PRIMARY.service]}; ${STANDBY.connectorNode} peer = ${before[STANDBY.service]}; directory-publisher2 (${RELAY_PAYER}) = ${before.relay} as of Liveness ${liveness0.created_at}`);

// ── 2. the spawn: one signed request, two routes, two roles ──────────────
step(`2. ONE signed spawn with standby_set [${PRIMARY.pubkey.slice(0, 8)}…, ${STANDBY.pubkey.slice(0, 8)}…]: ${STANDBY_ONLY ? 'the standby half only' : 'primary on .spawn, standby on .standby'}`);
const tenant = newTenant('m3-tenant');
const workloadId = newWorkloadId();
const request = leaseRequest(tenant, 'spawn', { ...spawnContent(workloadId, tenant), standby_set: SET.map((P) => P.pubkey) }, 300, SET);
assert(tagValues(request, 'p').map((t) => t[0]).join() === SET.map((P) => P.pubkey).join(),
  `request ${request.id.slice(0, 12)}… carries one \`p\` tag per member, in the set's order, and is signed once`);
const runningBefore = runningWorkloads();
const inStandbyRange = inRangeOf(STANDBY);

let primaryAccess = null;
let primaryContainer = null;
let expiresAt = null;
if (!STANDBY_ONLY) {
  const t0 = nowSec();
  const spawned = await sendTo(PRIMARY, PRIMARY.spawnRoute(L.name, L.version), { request });
  const t1 = nowSec();
  if (!spawned.fulfilled) fatal(`the primary's spawn was refused short of the app: ${spawned.code} (${spawned.refusedBy}) ${spawned.message ?? ''}`);
  const body = spawned.status === 200 ? spawned.json() : null;
  assert(spawned.status === 200, `${PRIMARY.service} answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
  if (!body) fatal('no primary lease to continue with');
  took(PRIMARY, spawned, 'the primary spawn', HUB_PRICE);
  assert(body.workload_id === workloadId && body.role === 'primary', `workload ${workloadId.slice(0, 12)}…, role ${body.role}`);
  assert(body.expires_at >= t0 + L.lease_interval_s && body.expires_at <= t1 + L.lease_interval_s,
    `expires_at ${body.expires_at} = now + ${L.lease_interval_s}s: one payment, one Lease Interval`);
  primaryAccess = body.access;
  assert(primaryAccess?.host === PRIMARY.confValue('public_ip') && Number.isInteger(primaryAccess?.ssh_port),
    `WITH access: ssh ${primaryAccess?.host}:${primaryAccess?.ssh_port}, ports ${jstr(primaryAccess?.ports ?? [])}`);
  const workload = primaryAccess ? await findWorkload(primaryAccess.ssh_port) : null;
  primaryContainer = workload?.name ?? null;
  const inPrimaryRange = inRangeOf(PRIMARY);
  assert(workload !== null && inPrimaryRange(workload.name),
    workload ? `the workload RUNS on the host daemon in ${PRIMARY.service}'s id range ${inPrimaryRange.lo}-${inPrimaryRange.hi}: ${workload.line}` : `no toon-<id> container publishes ${primaryAccess?.ssh_port} -> 22/tcp`);
  if (primaryAccess) {
    const ssh = await sshInto(tenant, primaryAccess);
    assert(ssh.ok === true, ssh.err ? `ssh never succeeded: ${ssh.err}` : `ssh -p ${primaryAccess.ssh_port} ${SSH_USER}@${primaryAccess.host}: toon-ssh-ok, user ${ssh.user}`);
  }
}
{
  const t0 = nowSec();
  const reserved = await sendTo(STANDBY, STANDBY.standbyRoute(L.name, L.version), { request });
  const t1 = nowSec();
  if (!reserved.fulfilled) fatal(`the standby's spawn was refused short of the app: ${reserved.code} (${reserved.refusedBy}) ${reserved.message ?? ''}`);
  const body = reserved.status === 200 ? reserved.json() : null;
  assert(reserved.status === 200, `${STANDBY.service} answered ${reserved.status}: ${reserved.text().slice(0, 300)}`);
  if (!body) fatal('no reservation to continue with');
  took(STANDBY, reserved, 'the standby spawn', HUB_STANDBY_PRICE);
  assert(body.workload_id === workloadId && body.role === 'standby', `the SAME bytes on .standby: workload ${workloadId.slice(0, 12)}…, role ${body.role}`);
  assert(body.access === undefined && !('access' in body), 'and NO access: nothing runs until a Takeover');
  assert(body.expires_at >= t0 + L.lease_interval_s && body.expires_at <= t1 + L.lease_interval_s,
    `expires_at ${body.expires_at} = now + ${L.lease_interval_s}s: one standby payment, one Lease Interval`);
  expiresAt = body.expires_at;
  const fresh = runningWorkloads().filter((n) => !runningBefore.includes(n) && inStandbyRange(n));
  assert(fresh.length === 0, `the standby started nothing on the host daemon: no new toon-<id> in its range ${inStandbyRange.lo}-${inStandbyRange.hi}${fresh.length ? ` (${fresh.join(', ')})` : ''}`);
}
const statusOf = async (P, what) => {
  const res = await sendTo(P, P.statusRoute, { request: leaseRequest(tenant, 'status', { workload_id: workloadId }, 120, P) });
  if (!res.fulfilled) { bad(`${what}: status was refused short of the app: ${res.code} (${res.refusedBy})`); return null; }
  took(P, res, `${what} (status, free at the provider)`, HUB_FEE);
  if (res.status !== 200) { bad(`${what}: ${P.service} answered ${res.status} ${res.text().slice(0, 200)}`); return null; }
  return res.json();
};
{
  const t = nowSec();
  const status = await statusOf(STANDBY, 'the reservation');
  assert(status?.state === 'reserved' && status.role === 'standby' && !('access' in status) && status.expires_at === expiresAt,
    `status on ${STANDBY.service}: state ${jstr(status?.state)}, role ${status?.role}, access ${'access' in (status ?? {}) ? 'PRESENT' : 'absent'}, expires_at ${status?.expires_at}`);
  const live = await livenessAfter(STANDBY, t);
  assert(live !== null && availableOf(live) === availableOf(liveness0) - 1,
    live ? `${STANDBY.service}'s next Liveness (${live.created_at}) says available.${L.name} = ${availableOf(live)} = ${availableOf(liveness0)} before - this reservation`
      : `no Liveness from ${STANDBY.service} after the reservation within ${CADENCE + 10}s`);
}

// ── 3. the reservation's price ───────────────────────────────────────────
step(`3. the reservation is paid on .standby.extend at ${L.standby_price}; .extend on it is refused not_running (and billed)`);
{
  const extended = await sendTo(STANDBY, STANDBY.standbyExtendRoute(L.name, L.version), { workload_id: workloadId });
  if (!extended.fulfilled) {
    bad(`.standby.extend was refused short of the app: ${extended.code} (${extended.refusedBy})`);
  } else {
    const body = extended.status === 200 ? extended.json() : null;
    assert(extended.status === 200 && body?.workload_id === workloadId && body.expires_at === expiresAt + L.lease_interval_s,
      `.standby.extend answered ${extended.status}: expires_at ${body?.expires_at} = ${expiresAt} + ${L.lease_interval_s} — added to the expiry; the reservation now outlives the takeover timeline twice over`);
    took(STANDBY, extended, 'the standby extension', HUB_STANDBY_PRICE);
    if (body?.expires_at) expiresAt = body.expires_at;
  }
  const refused = await sendTo(STANDBY, STANDBY.extendRoute(L.name, L.version), { workload_id: workloadId });
  if (!refused.fulfilled) {
    bad(`.extend was refused short of the app: ${refused.code} (${refused.refusedBy})`);
  } else {
    const err = refused.status !== 200 ? refused.json() : null;
    assert(refused.status === 409 && err?.error === 'not_running', `.extend on the reservation answered ${refused.status} ${jstr(err)}`);
    took(STANDBY, refused, 'the refused .extend — one route, one price, no refunds (ADR 0003)', HUB_PRICE);
  }
}

// ── 4–6. the Takeover ────────────────────────────────────────────────────
let standbyAccess = null;
let standbyContainer = null;
let takeover = null;
if (!STANDBY_ONLY) {
  step(`4. the primary's container is STOPPED; the standby announces a Takeover within ${TAKEOVER_BUDGET_S}s`);
  const stoppedAt = nowSec();
  composeService('stop', PRIMARY.service);
  ok(`docker compose stop ${PRIMARY.service} at ${stoppedAt}; its container ${primaryContainer} keeps running on the host daemon — the loudest partition there is`);
  const lastLiveness = await livenessOf(PRIMARY);
  const lastExpiry = lastLiveness ? Number(tagValues(lastLiveness, 'expiration')[0]?.[0]) : NaN;
  console.log(`  ${PRIMARY.service}'s last Liveness ${lastLiveness?.created_at} expires at ${lastExpiry} (${lastExpiry - stoppedAt}s after the stop); waiting for kind ${K_TAKEOVER} d=${workloadId.slice(0, 12)}… from ${STANDBY.pubkey.slice(0, 12)}…`);
  const claimsFound = await relayReadUntil(takeoverFilter(workloadId, SET), 'takeover', TAKEOVER_BUDGET_S);
  takeover = claimsFound.find((e) => e.pubkey === STANDBY.pubkey) ?? null;
  const announcedAt = takeover?.created_at ?? nowSec();
  assert(takeover !== null, takeover
    ? `a Takeover from ${STANDBY.service} on the relay ${announcedAt - stoppedAt}s after the stop (${announcedAt - lastExpiry}s after the primary's Liveness expired)`
    : `no Takeover on d=${workloadId.slice(0, 12)}… from ${STANDBY.service} within ${TAKEOVER_BUDGET_S}s (${claimsFound.length} claim(s) from others)`);
  if (takeover) {
    const content = JSON.parse(takeover.content);
    assert(takeover.kind === K_TAKEOVER && hasTag(takeover, ['d', workloadId]) && hasTag(takeover, ['L', TOON_LABEL]),
      `kind ${takeover.kind}, d = the workload id, labelled ["L","${TOON_LABEL}"]`);
    assert(content.workload_id === workloadId && content.primary === PRIMARY.pubkey,
      `content { workload_id, primary }: primary = ${content.primary?.slice(0, 12)}… (standby_set[0], ${PRIMARY.service})`);
    assert(verifyEvent(takeover), `signed by ${STANDBY.service} (${takeover.pubkey.slice(0, 12)}…): the standby that claims, never the primary`);
    assert(claimsFound.length === 1, `exactly one claim on the workload id from the set (${claimsFound.length})`);
  }

  step(`5. two cadences later the standby settles, wins and RUNS the workload in its own id range (within ${SETTLE_BUDGET_S}s)`);
  const { lo, hi } = inStandbyRange;
  const started = await waitFor(async () => {
    const fresh = runningWorkloads().filter((n) => !runningBefore.includes(n) && n !== primaryContainer && inStandbyRange(n));
    return fresh.length > 0 ? fresh : null;
  }, SETTLE_BUDGET_S, 2000);
  const startedAtSec = nowSec();
  assert(started !== null && started.length === 1,
    started ? `${started.join(', ')} is RUNNING on the host daemon, in ${STANDBY.service}'s id range ${lo}-${hi}, ${startedAtSec - announcedAt}s after the announcement (${startedAtSec - stoppedAt}s after the stop)`
      : `no new toon-<id> container in ${lo}-${hi} within ${SETTLE_BUDGET_S}s of the announcement`);
  standbyContainer = started?.[0] ?? null;
  if (standbyContainer) {
    const image = docker('inspect', '-f', '{{.Config.Image}}', standbyContainer).trim();
    assert(image === `${IMAGE.reference}@${IMAGE.digest}`, 'started FROM THE IMAGE the spawn named, by reference@digest — no state carried over (ADR 0010)');
  }
  const status = await statusOf(STANDBY, 'the winner');
  standbyAccess = status?.access ?? null;
  assert(status?.state === 'running' && status.role === 'standby' && standbyAccess !== null,
    `status on ${STANDBY.service}: state ${jstr(status?.state)}, role ${status?.role} (a position in the set never changes), access ${standbyAccess ? `ssh ${standbyAccess.host}:${standbyAccess.ssh_port}` : 'ABSENT'}`);
  assert(status?.takeover?.winner === STANDBY.pubkey, `takeover.winner = ${status?.takeover?.winner?.slice(0, 12)}… (${STANDBY.service} itself)`);
  assert(status?.expires_at === expiresAt, `expires_at ${status?.expires_at} unchanged: winning buys no time`);
  if (standbyAccess) {
    const byPort = await findWorkload(standbyAccess.ssh_port);
    assert(byPort?.name === standbyContainer, `${standbyContainer} is the container publishing its ssh_port ${standbyAccess.ssh_port}`);
    const ssh = await sshInto(tenant, standbyAccess);
    assert(ssh.ok === true, ssh.err ? `ssh never succeeded: ${ssh.err}` : `ssh -p ${standbyAccess.ssh_port} ${SSH_USER}@${standbyAccess.host}: toon-ssh-ok, user ${ssh.user} — the tenant's key opens the new copy`);
  }

  step(`6. the winner is paid on .extend at ${L.price}; .standby.extend on it is refused not_standby (and billed)`);
  {
    const extended = await sendTo(STANDBY, STANDBY.extendRoute(L.name, L.version), { workload_id: workloadId });
    if (!extended.fulfilled) {
      bad(`.extend was refused short of the app: ${extended.code} (${extended.refusedBy})`);
    } else {
      const body = extended.status === 200 ? extended.json() : null;
      assert(extended.status === 200 && body?.workload_id === workloadId && body.expires_at === expiresAt + L.lease_interval_s,
        `.extend answered ${extended.status}: expires_at ${body?.expires_at} = ${expiresAt} + ${L.lease_interval_s}, at the running price`);
      took(STANDBY, extended, 'the post-Takeover extension', HUB_PRICE);
      if (body?.expires_at) expiresAt = body.expires_at;
    }
    const refused = await sendTo(STANDBY, STANDBY.standbyExtendRoute(L.name, L.version), { workload_id: workloadId });
    if (!refused.fulfilled) {
      bad(`.standby.extend was refused short of the app: ${refused.code} (${refused.refusedBy})`);
    } else {
      const err = refused.status !== 200 ? refused.json() : null;
      assert(refused.status === 409 && err?.error === 'not_standby', `.standby.extend on the winner answered ${refused.status} ${jstr(err)}`);
      took(STANDBY, refused, 'the refused .standby.extend — billed at its own price (ADR 0003)', HUB_STANDBY_PRICE);
    }
  }

  step('7. the primary\'s container is STARTED again: it stands down, and exactly one copy of the workload runs on the host');
  composeService('start', PRIMARY.service);
  const healthy = await composeHealthy(PRIMARY.service, 90);
  assert(healthy, `${PRIMARY.service} is healthy again`);
  // At startup, before it serves anything, the primary asks its own Relay
  // Set for a Takeover on the workload from a member of the set — and stops
  // its container. Watched on the host daemon, then confirmed with ONE
  // status call, so no fee-bearing packet is spent on polling.
  const primaryStopped = await waitFor(async () => (primaryContainer ? containerState(primaryContainer) : null) === 'exited', 60, 2000);
  assert(primaryStopped === true, `${primaryContainer} is ${containerState(primaryContainer)} — the primary stopped its own copy on finding the Takeover`);
  const stood = await statusOf(PRIMARY, 'the stood-down primary');
  assert(stood?.state === 'stopped' && stood.role === 'primary' && !('access' in stood),
    `status on ${PRIMARY.service}: state ${jstr(stood?.state)}, role ${stood?.role}, access ${'access' in (stood ?? {}) ? 'PRESENT' : 'absent'} — the lease stands, stopped, taken over`);
  const copies = runningWorkloads().filter((n) => n === primaryContainer || n === standbyContainer);
  assert(copies.length === 1 && copies[0] === standbyContainer,
    `exactly ONE copy of the workload is running on the host daemon: ${copies.join(', ') || 'none'} (the primary's ${primaryContainer} exists, ${containerState(primaryContainer)})`);
}

// ── 8. the books ─────────────────────────────────────────────────────────
step('8. the books, to the unit: what each packet was charged, and one relay unit for the Takeover');
const liveness1 = await livenessAfter(STANDBY, nowSec() - 1);
if (!liveness1) fatal(`no fresh Liveness from ${STANDBY.service} within a cadence`);
const cadences = Math.round((liveness1.created_at - liveness0.created_at) / CADENCE);
const expectedRelay = BigInt(cadences + (takeover ? 1 : 0));
const after = await waitFor(async () => {
  const now = await readBooks();
  return now.hub - before.hub >= paid.hub && now[STANDBY.service] - before[STANDBY.service] >= paid[STANDBY.service] && now.relay - before.relay >= expectedRelay ? now : null;
}, 15) ?? await readBooks();
assert(after.hub - before.hub === paid.hub,
  `the hub's client book on the tenant's channel grew by ${after.hub - before.hub} = every packet at the hub's prices, free calls at the fee (${paid.hub})`);
{
  const s = L.standby_price;
  const legs = STANDBY_ONLY
    ? `${s} (.standby) + ${s} (.standby.extend) + ${L.price} (the billed not_running refusal)`
    : `${s} (.standby) + ${s} (.standby.extend) + ${L.price} (the billed not_running refusal) + ${L.price} (the post-Takeover .extend) + ${s} (the billed not_standby refusal)`;
  assert(after[STANDBY.service] - before[STANDBY.service] === paid[STANDBY.service],
    `${STANDBY.connectorNode}'s peer-book watermark on ${STANDBY.channel} grew by ${after[STANDBY.service] - before[STANDBY.service]} = ${legs} = ${paid[STANDBY.service]}; the free calls added nothing`);
  assert(after[PRIMARY.service] - before[PRIMARY.service] === paid[PRIMARY.service],
    `${PRIMARY.connectorNode}'s peer-book watermark on ${PRIMARY.channel} grew by ${after[PRIMARY.service] - before[PRIMARY.service]} = ${STANDBY_ONLY ? 'nothing: it was never paid' : `${L.price}, the full spawn price, and nothing else`}`);
}
assert(after.relay - before.relay === expectedRelay,
  `directory-publisher2's channel ${RELAY_PAYER} paid ${after.relay - before.relay} g.toon.relay units between Liveness ${liveness0.created_at} and ${liveness1.created_at} = ${cadences} cadence(s) of Liveness${takeover ? ' + 1 for the Takeover event' : ' and no Takeover'} (${expectedRelay})`);

// ── 9. the tenant ends its leases ────────────────────────────────────────
step('9. the tenant ends the leases through the free terminate routes');
for (const [P, container] of STANDBY_ONLY ? [[STANDBY, null]] : [[STANDBY, standbyContainer], [PRIMARY, primaryContainer]]) {
  const res = await sendTo(P, P.terminateRoute, { request: leaseRequest(tenant, 'terminate', { workload_id: workloadId }, 120, P) });
  if (!res.fulfilled) {
    bad(`terminate on ${P.service} was refused short of the app: ${res.code} (${res.refusedBy})`);
    continue;
  }
  const body = res.status === 200 ? res.json() : null;
  assert(res.status === 200 && body?.workload_id === workloadId && JSON.stringify(body?.state) === JSON.stringify({ ended: 'termination' }),
    `${P.service} answered ${res.status} ${res.text().slice(0, 160)}`);
  assert(BigInt(res.claim?.amount ?? 0) === HUB_FEE, `it cost only the hub's fee (${res.claim?.amount})`);
  if (container) assert(await workloadGone(container, 20), `${container} is gone from the host daemon`);
}

console.log(`\n  total run time ${Math.round((Date.now() - startedAt) / 1000)}s`);
if (STANDBY_ONLY) {
  done('THE RESERVATION SIDE ONLY (TOON_M3_STANDBY_ONLY): a standby-set spawn on the second provider\'s .standby answered role standby with no access, held a slot its Liveness counted, was paid on .standby.extend at standby_price and refused .extend as not_running, closed the books to the unit and was released by terminate. The first provider was never paid and no Takeover ran — this is not a pass of Milestone 3.');
} else {
  done('one signed spawn bought a primary with access and a Warm Standby without; the reservation held capacity, was paid at standby_price and refused .extend; with the primary\'s container stopped the standby announced a Takeover on the relay, won, ran the workload in its own id range reachable with the tenant\'s key, was paid at full price and refused .standby.extend; the restarted primary stood down leaving exactly one running copy; every book grew by exactly the prices and the relay by one unit for the Takeover; the tenant ended both leases.');
}
