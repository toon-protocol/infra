// MILESTONE 1 ACCEPTANCE TEST (TOON_Network #1, ticket #9; spec Appendix A):
// the whole lease lifecycle against the real sandbox — provider behind its
// connector, directory on the relay, money on the connectors' books — run
// TWICE with the same tenant ceremony: once paying THROUGH THE HUB (a channel
// against the hub, packets sealed to the provider connector, forwarded over
// the relay-provider peering) and once paying the PROVIDER CONNECTOR
// DIRECTLY (a channel against its own client edge at :3240, no hub, no fee).
// The provider must behave identically in both: the same answer shapes and
// the same lease lifecycle. Run from sandbox/ on the host after
// `make up-payments` (or `make up`); `make smoke-m1`.
//
// Per variant:
//   1.  DIRECTORY READ-BACK on ws://localhost:7100, by the provider's pubkey
//       and #L = toon.network: exactly one Profile, one Listing per
//       [[listings]] entry in conf/provider.toml, and an UNEXPIRED Liveness
//       whose available.<listing> = capacity - live leases. Nothing has been
//       spawned yet, so the count the provider agrees with is "none": the
//       smoke waits for Liveness to say capacity (a lease left behind by an
//       aborted run expires within two intervals + the sweep) rather than
//       counting containers behind the provider's back
//   2.  AVAILABILITY, the free g.toon.provider.availability route, end to
//       end: { would_run: true } for the listing and the smoke image, 0
//       arrives at the provider (via the hub the client pays exactly the
//       hub's fee; direct it pays nothing and spends no claim), and the
//       provider's own book does not move
//   3.  SPAWN, paid: a tenant-signed Lease Request buys
//       g.toon.provider.<listing>.v1.spawn; the answer names the workload id,
//       role standalone, expires_at = now + lease_interval_s and the access
//       block; the workload is RUNNING on the host daemon as a toon-<id>
//       container by reference@digest
//   4.  EXTEND, paid, with { workload_id } and no signature: expires_at grew
//       by EXACTLY lease_interval_s; SSH with the tenant's key opens the
//       workload; the free, tenant-signed STATUS reports `running`, the new
//       expiry and the same access; and the next Liveness counts the lease
//       (available = capacity - 1)
//   5.  EXPIRY: once expires_at passes and the sweep (<= 30 s) has run, the
//       workload is GONE from the host daemon, status reports
//       { "ended": "expiry" } with no access, and the next Liveness has the
//       capacity back
//   6.  CLAIM BOOKS, per leg, exactly:
//         via hub — the hub's CLIENT book on the tenant's Solana channel grew
//                   by (spawn + extend) x (price + fee) PLUS ONE FEE PER FREE
//                   CALL — the hub charges its fee on every packet it
//                   forwards, free ones included (conf/connector-relay.toml
//                   says why: 100 - 100 == 0 arrives) — and the provider
//                   connector's PEER-book watermark on the committed peering
//                   channel grew by spawn + extend at the listing price: the
//                   free routes added nothing there
//         direct  — the provider connector's CLIENT book on the tenant's own
//                   channel grew by spawn + extend at the listing price, and
//                   nothing else: the free routes added nothing at all
// Then: the two variants' answers are compared — the same fields, the same
// role, state and would_run values (everything that is not per-run: workload
// id, expiry, port) — and the same lease lifecycle.
//
// THE LISTING: `smoke` (conf/provider.toml), a sandbox-only tier with a 30 s
// Lease Interval so "spawn + one extend + sweep" is about 90 s and the two
// variants together run in three to four minutes. Everything else about it —
// price, resources, code path — is `basic`'s; TOON_M1_LISTING=basic runs the
// same test on the three-minute tier (then budget ~15 minutes).
//
// Every free call through the hub costs the hub's fee (100), and every free
// call is counted so the hub's book can be asserted to the unit; nothing here
// polls a paid or fee-bearing route — expiry is watched on the host daemon
// and confirmed with ONE status call.
import {
  HUB, PROVIDER_EDGE, PROVIDER_CHANNEL, HUB_FEE, BUYER_SOL,
  K_PROFILE, K_LISTING, K_LIVENESS, TOON_LABEL,
  AVAILABILITY_ROUTE, STATUS_ROUTE, spawnRoute, extendRoute, IMAGE, SSH_USER,
  confValue, listings, listing, PROVIDER_PUBKEY, SWEEP_S,
  reporter, sleep, jstr, nowSec, waitFor,
  claims, clientBookOnChannel, peerBookTotal,
  relayRead, relayReadUntil, directoryFilter, tagValues, hasTag,
  docker, composeNotRunning, findWorkload, workloadGone,
  newTenant, leaseRequest, newWorkloadId, spawnContent, openChannel, sshInto,
} from './lib/provider-smoke.mjs';

const { step, ok, bad, assert, fatal, done } = reporter('MILESTONE 1 SMOKE');
const startedAt = Date.now();

const L = listing(process.env.TOON_M1_LISTING ?? 'smoke');
const SPAWN_ROUTE = spawnRoute(L.name, L.version);
const EXTEND_ROUTE = extendRoute(L.name, L.version);
const HUB_PRICE = L.price + HUB_FEE;
const CADENCE = Number(confValue('liveness_cadence_s'));
const CONF_LISTING_NAMES = listings().map((l) => l.name);

// An answer with its per-run values blanked — workload id, expiry, access
// port — so two runs' answers can be compared: the same fields, in the same
// order, with the same role / state / would_run.
const PER_RUN = { workload_id: '<id>', expires_at: '<expiry>' };
function signature(body) {
  if (!body || typeof body !== 'object') return null;
  const out = { ...body, ...Object.fromEntries(Object.keys(PER_RUN).filter((k) => k in body).map((k) => [k, PER_RUN[k]])) };
  if (out.access) out.access = { ...out.access, ssh_port: '<port>' };
  return jstr(out);
}

// ── 0. the stack, and the prices both edges advertise ────────────────────
step('0. the stack is up and both edges price the routes consistently');
{
  const missing = composeNotRunning(['provider', 'provider-connector', 'directory-publisher', 'relay', 'relay-connector']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-payments\` first`);
  ok('provider, provider-connector, directory-publisher, relay and relay-connector are up');
}
const advertised = {};
for (const [name, url] of [['hub', HUB], ['provider-connector', PROVIDER_EDGE]]) {
  const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
  if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  advertised[name] = Object.fromEntries((desc.routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
}
assert(advertised['provider-connector'][SPAWN_ROUTE] === L.price && advertised['provider-connector'][EXTEND_ROUTE] === L.price,
  `the provider connector terminates ${SPAWN_ROUTE} and .extend at ${L.price} uUSDC — conf/provider.toml's \`${L.name}\` price`);
assert(advertised.hub[SPAWN_ROUTE] === HUB_PRICE && advertised.hub[EXTEND_ROUTE] === HUB_PRICE,
  `the hub forwards both at ${HUB_PRICE} = price + its fee ${HUB_FEE}`);
for (const free of ['availability', 'status', 'terminate']) {
  assert(advertised['provider-connector'][`g.toon.provider.${free}`] === 0n && advertised.hub[`g.toon.provider.${free}`] === HUB_FEE,
    `g.toon.provider.${free} is 0 at the provider connector and exactly the fee (${HUB_FEE}) at the hub, so 0 arrives`);
}
console.log(`  listing ${L.name} v${L.version}: lease_interval_s ${L.lease_interval_s}, capacity ${L.capacity}; liveness cadence ${CADENCE}s; sweep <= ${SWEEP_S}s`);

// ── the directory, read back off the relay ───────────────────────────────
async function directoryReadBack(tag) {
  step(`${tag} 1. the directory on the relay: Profile, Listings, an unexpired Liveness`);
  const profiles = await relayReadUntil(directoryFilter(K_PROFILE), 'profile', 60);
  if (profiles.length === 0) fatal(`no Provider Profile from ${PROVIDER_PUBKEY} on the relay — \`docker compose logs directory-publisher provider\``);
  assert(profiles.length === 1 && hasTag(profiles[0], ['L', TOON_LABEL]),
    `exactly one Profile from ${PROVIDER_PUBKEY.slice(0, 12)}…, tagged ["L","${TOON_LABEL}"]`);
  assert(JSON.parse(profiles[0].content).ilp_address === confValue('ilp_address'),
    `it names ilp_address ${confValue('ilp_address')} — the prefix every route below hangs off`);

  const listingEvents = await relayReadUntil(directoryFilter(K_LISTING), 'listings', 60);
  const names = listingEvents.map((e) => tagValues(e, 'd')[0]?.[0]).sort();
  assert(JSON.stringify(names) === JSON.stringify([...CONF_LISTING_NAMES].sort()),
    `one Listing per [[listings]] entry, d = the name: ${names.join(', ')}`);
  const mine = listingEvents.find((e) => tagValues(e, 'd')[0]?.[0] === L.name);
  assert(mine && hasTag(mine, ['a', `${K_PROFILE}:${PROVIDER_PUBKEY}:`]) && hasTag(mine, ['L', TOON_LABEL]),
    `the \`${L.name}\` Listing points at the Profile with an \`a\` tag and carries the label`);
  if (mine) {
    const c = JSON.parse(mine.content);
    assert(c.version === L.version && BigInt(c.price) === L.price && c.lease_interval_s === L.lease_interval_s,
      `its content says v${c.version}, ${c.price} uUSDC per ${c.lease_interval_s}s Lease Interval — what this smoke is about to pay for`);
  }

  // The count the provider agrees with is its own: nothing has been spawned
  // by this run, and every other smoke ends its lease through the provider,
  // so Liveness must say the full capacity — after at most two intervals +
  // the sweep + a cadence, should an aborted run have left a lease behind.
  const patience = 2 * L.lease_interval_s + SWEEP_S + CADENCE;
  let liveness = null;
  const settled = await waitFor(async () => {
    const found = await relayRead(directoryFilter(K_LIVENESS), 'liveness').catch(() => []);
    liveness = found[0] ?? null;
    return found.length === 1 && JSON.parse(found[0].content).available?.[L.name] === L.capacity;
  }, patience, 2000);
  if (!liveness) fatal(`no Liveness from ${PROVIDER_PUBKEY} on the relay`);
  const available = JSON.parse(liveness.content).available;
  const expiration = Number(tagValues(liveness, 'expiration')[0]?.[0]);
  assert(expiration > nowSec() && hasTag(liveness, ['L', TOON_LABEL]),
    `exactly one Liveness, unexpired (expiration ${expiration}, ${expiration - nowSec()}s out), tagged ["L","${TOON_LABEL}"]`);
  assert(settled === true,
    `available.${L.name} = ${available?.[L.name]} = capacity ${L.capacity} - 0 live leases (nothing spawned yet; the provider's own count)`);
}

/** The next Liveness created strictly after `afterSec`, or null within cadence + 10 s. */
async function livenessAfter(afterSec) {
  return waitFor(async () => {
    const found = await relayRead(directoryFilter(K_LIVENESS), 'liveness-next').catch(() => []);
    return found.find((e) => e.created_at > afterSec) ?? null;
  }, CADENCE + 10, 2000);
}

// ── one full run of the lifecycle, paying at `edge` ──────────────────────
// `v` describes the leg: where the tenant's channel is, what one paid packet
// costs the tenant there, what a free packet costs there, and how to read
// the two books that must move (or not).
async function runVariant(v) {
  const tag = `[${v.name}]`;
  await directoryReadBack(tag);

  step(`${tag} a tenant with a Solana mock-USDC channel against ${v.edgeName}`);
  const { client, opened } = await openChannel(v.edge, v.channelStore);
  assert(client.identity?.solanaPublicKey === BUYER_SOL, `the tenant pays as ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded`);
  ok(`channel ${opened.channelId} against ${v.edgeName} (status ${opened.status ?? 'open'})`);
  const channelKey = `solana:${opened.channelId}`;
  const books = await v.books(channelKey);
  let freeCalls = 0;
  let paidCalls = 0;
  const sendOpts = { ...(v.sealTo ? { sealTo: v.sealTo } : {}), timeoutMs: 120_000 };
  const send = (route, body) => client.send(route, { body }, sendOpts);
  // The tenant channel is shared by every run. A packet an earlier, aborted run
  // sent that the hub gave up on (T01) can still be fulfilled and booked later,
  // and the connector applies such a claim on the channel's NEXT packet. One
  // uncounted free packet first, so the baseline below holds nothing pending.
  await send(AVAILABILITY_ROUTE, { listing: L.name, version: L.version, image: IMAGE });
  const before = await books.read();
  console.log(`  books before (after one warm-up packet): ${books.describe(before)}`);
  // What the tenant's claim must look like on this leg, and how many of each
  // kind reached the provider — the books are asserted against these counts.
  const assertFreeClaim = (sent, what) => {
    freeCalls += 1;
    if (v.freeCost === 0n) assert(sent.claim === undefined, `${what} spent no claim at all — free means free at the provider's own edge`);
    else assert(BigInt(sent.claim?.amount ?? 0) === v.freeCost, `${what} cost exactly the hub's fee (${sent.claim?.amount}); 0 arrived at the provider`);
  };
  const assertPaidClaim = (sent, what) => {
    paidCalls += 1;
    assert(BigInt(sent.claim?.amount ?? 0) === v.paidCost, `the tenant paid exactly ${sent.claim?.amount} uUSDC for ${what} (${v.paidCost})`);
  };
  const shapes = {};
  const lifecycle = [];

  // 2. availability
  step(`${tag} 2. the free ${AVAILABILITY_ROUTE} says the listing and image would run`);
  const avail = await send(AVAILABILITY_ROUTE, { listing: L.name, version: L.version, image: IMAGE });
  if (!avail.fulfilled) {
    bad(`availability was refused short of the app: ${avail.code} (${avail.refusedBy}) ${avail.message ?? ''}`);
  } else {
    const body = avail.status === 200 ? avail.json() : null;
    assert(avail.status === 200 && body?.would_run === true, `the provider answered ${avail.status} ${avail.text()}`);
    shapes.availability = signature(body);
    assertFreeClaim(avail, 'the availability call');
    await sleep(2000);
    const after = await books.read();
    assert(after.provider === before.provider,
      `the provider's own book did not move on a free route (${books.describe(after)}; step 6 closes the books to the unit)`);
  }

  // 3. spawn
  step(`${tag} 3. a PAID ${SPAWN_ROUTE}: a tenant-signed Lease Request, a running workload`);
  const tenant = newTenant(`m1-${v.slug}-tenant`);
  const workloadId = newWorkloadId();
  const t0 = nowSec();
  const spawned = await send(SPAWN_ROUTE, { request: leaseRequest(tenant, 'spawn', spawnContent(workloadId, tenant)) });
  const t1 = nowSec();
  if (!spawned.fulfilled) fatal(`the spawn was refused: ${spawned.code} (refusedBy ${spawned.refusedBy}) ${spawned.message ?? ''}`);
  const spawnBody = spawned.status === 200 ? spawned.json() : null;
  assert(spawned.status === 200, `the provider answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
  if (!spawnBody) fatal('no lease to continue with');
  assertPaidClaim(spawned, 'the spawn');
  assert(spawnBody.workload_id === workloadId && spawnBody.role === 'standalone', `workload ${workloadId.slice(0, 12)}…, role ${spawnBody.role}`);
  assert(spawnBody.expires_at >= t0 + L.lease_interval_s && spawnBody.expires_at <= t1 + L.lease_interval_s,
    `expires_at ${spawnBody.expires_at} = now + ${L.lease_interval_s}s: one payment, one Lease Interval`);
  const access = spawnBody.access;
  assert(access?.host === confValue('public_ip') && Number.isInteger(access?.ssh_port) && Array.isArray(access?.ports),
    `access: ssh ${access?.host}:${access?.ssh_port}, ports ${jstr(access?.ports ?? [])}`);
  shapes.spawn = signature(spawnBody);
  lifecycle.push('spawned');
  const workload = access ? await findWorkload(access.ssh_port) : null;
  assert(workload !== null, workload ? `the workload is RUNNING on the host daemon: ${workload.line}` : `no toon-<id> container publishes ${access?.ssh_port} -> 22/tcp`);
  if (workload) {
    const image = docker('inspect', '-f', '{{.Config.Image}}', workload.name).trim();
    assert(image === `${IMAGE.reference}@${IMAGE.digest}`, `it runs the image by reference@digest`);
  }

  // 4. extend, ssh, status, liveness
  step(`${tag} 4. a PAID ${EXTEND_ROUTE} adds exactly one Lease Interval; SSH opens; status agrees; Liveness counts it`);
  const extended = await send(EXTEND_ROUTE, { workload_id: workloadId });
  let expiresAt = spawnBody.expires_at;
  if (!extended.fulfilled) {
    bad(`the extension was refused short of the app: ${extended.code} (${extended.refusedBy}) ${extended.message ?? ''}`);
  } else {
    const body = extended.status === 200 ? extended.json() : null;
    assert(extended.status === 200, `the provider answered ${extended.status}: ${extended.text().slice(0, 300)}`);
    assertPaidClaim(extended, 'the extension');
    if (body) {
      assert(body.workload_id === workloadId && body.expires_at === spawnBody.expires_at + L.lease_interval_s,
        `expires_at ${body.expires_at} = ${spawnBody.expires_at} + ${L.lease_interval_s}: added to the expiry, not to now`);
      expiresAt = body.expires_at;
      shapes.extend = signature(body);
      lifecycle.push('extended');
    }
  }
  if (access) {
    const ssh = await sshInto(tenant, access);
    assert(ssh.ok === true,
      ssh.err ? `ssh never succeeded: ${ssh.err}` : `ssh -p ${access.ssh_port} ${SSH_USER}@${access.host}: toon-ssh-ok, user ${ssh.user}`);
  }
  const status = await send(STATUS_ROUTE, { request: leaseRequest(tenant, 'status', { workload_id: workloadId }) });
  if (!status.fulfilled) {
    bad(`status was refused short of the app: ${status.code} (${status.refusedBy})`);
  } else {
    const body = status.status === 200 ? status.json() : null;
    assert(status.status === 200 && body?.state === 'running' && body.expires_at === expiresAt,
      `status: state ${jstr(body?.state)}, expires_at ${body?.expires_at} (the extended expiry)`);
    assert(body?.workload_id === workloadId && body?.role === 'standalone' && JSON.stringify(body?.access) === JSON.stringify(access),
      `the same workload id, role ${body?.role} and access block the spawn answered`);
    shapes.status = signature(body);
    lifecycle.push(`status:${jstr(body?.state)}`);
    assertFreeClaim(status, 'the status call');
  }
  {
    const live = await livenessAfter(t1);
    const avail = live ? JSON.parse(live.content).available?.[L.name] : undefined;
    assert(live !== null && avail === L.capacity - 1,
      live ? `the Liveness published at ${live.created_at} says available.${L.name} = ${avail} = capacity ${L.capacity} - this one lease`
        : `no Liveness published after the spawn within ${CADENCE + 10}s`);
  }

  // 5. expiry
  step(`${tag} 5. expiry at ${expiresAt}: the sweep destroys the workload, status says ended by expiry, Liveness recovers`);
  // Watched on the host daemon rather than by polling status, so no fee-bearing
  // packet is spent on waiting and the books stay exact.
  const wait = Math.max(0, expiresAt - nowSec());
  console.log(`  waiting ${wait}s for the lease to expire, then up to ${SWEEP_S}s for the sweep…`);
  await sleep(wait * 1000);
  const gone = workload ? await workloadGone(workload.name, SWEEP_S + 15) : false;
  const tGone = nowSec();
  assert(gone, workload ? `${workload.name} is gone ${tGone - expiresAt}s after expires_at — destroyed by the sweep, no grace` : 'no workload to watch');
  const ended = await send(STATUS_ROUTE, { request: leaseRequest(tenant, 'status', { workload_id: workloadId }) });
  if (!ended.fulfilled) {
    bad(`status after expiry was refused short of the app: ${ended.code} (${ended.refusedBy})`);
  } else {
    const body = ended.status === 200 ? ended.json() : null;
    assert(ended.status === 200 && JSON.stringify(body?.state) === JSON.stringify({ ended: 'expiry' }),
      `status: state ${jstr(body?.state)}`);
    assert(body?.workload_id === workloadId && body?.role === 'standalone' && body?.access === undefined && body?.expires_at === expiresAt,
      'the same workload id and role, no access any more, expires_at unchanged');
    shapes.ended = signature(body);
    lifecycle.push(`status:${jstr(body?.state)}`);
    assertFreeClaim(ended, 'the status call');
  }
  {
    const live = await livenessAfter(tGone);
    const avail = live ? JSON.parse(live.content).available?.[L.name] : undefined;
    assert(live !== null && avail === L.capacity,
      live ? `the Liveness published at ${live.created_at} says available.${L.name} = ${avail} — the capacity is back`
        : `no Liveness published after the expiry within ${CADENCE + 10}s`);
  }

  // 6. the books
  step(`${tag} 6. the connectors' own books: ${v.legs}`);
  const expected = books.expect(BigInt(paidCalls), BigInt(freeCalls));
  const after = await waitFor(async () => {
    const now = await books.read();
    return books.reached(now, before, expected) ? now : null;
  }, 15) ?? await books.read();
  books.assertExact(after, before, expected, paidCalls, freeCalls);

  return { shapes, lifecycle };
}

// ── the two legs' books ──────────────────────────────────────────────────
// Via the hub: two books move — the hub's CLIENT book on the tenant's channel
// (every packet, free ones at the fee) and the provider connector's PEER
// book on the peering channel (only the paid ones, at the listing price).
const hubBooks = async (channelKey) => ({
  read: async () => ({
    hub: clientBookOnChannel(await claims('relay-connector'), channelKey),
    provider: peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL),
  }),
  describe: (b) => `hub client (${channelKey}) = ${b.hub}, provider peer (${PROVIDER_CHANNEL}) = ${b.provider}`,
  expect: (paid, free) => ({ hub: paid * HUB_PRICE + free * HUB_FEE, provider: paid * L.price }),
  reached: (now, before, exp) => now.hub - before.hub >= exp.hub && now.provider - before.provider >= exp.provider,
  assertExact: (now, before, exp, paid, free) => {
    assert(now.hub - before.hub === exp.hub,
      `the hub's client book on the tenant's channel grew by ${now.hub - before.hub} = ${paid} x ${HUB_PRICE} (spawn + extend) + ${free} x ${HUB_FEE} (the free calls' fee) = ${exp.hub}`);
    assert(now.provider - before.provider === exp.provider,
      `the provider connector's peer-book watermark on ${PROVIDER_CHANNEL} grew by ${now.provider - before.provider} = ${paid} x ${L.price} (spawn + extend); the ${free} free calls added nothing`);
  },
});
// Direct: one book — the provider connector's CLIENT book on the tenant's
// own channel; only the paid packets, at the listing price, no fee anywhere.
const directBooks = async (channelKey) => ({
  read: async () => ({ provider: clientBookOnChannel(await claims('provider-connector'), channelKey) }),
  describe: (b) => `provider client (${channelKey}) = ${b.provider}`,
  expect: (paid) => ({ provider: paid * L.price }),
  reached: (now, before, exp) => now.provider - before.provider >= exp.provider,
  assertExact: (now, before, exp, paid, free) => {
    assert(now.provider - before.provider === exp.provider,
      `the provider connector's client book on the tenant's channel grew by ${now.provider - before.provider} = ${paid} x ${L.price} (spawn + extend), no fee; the ${free} free calls added nothing`);
  },
});

const viaHub = await runVariant({
  name: 'via hub', slug: 'hub',
  edge: HUB, edgeName: 'the hub (:3200)', channelStore: 'channels.json',
  sealTo: PROVIDER_EDGE,
  paidCost: HUB_PRICE, freeCost: HUB_FEE,
  legs: 'hub client leg and provider peer leg', books: hubBooks,
});
const direct = await runVariant({
  name: 'direct', slug: 'direct',
  edge: PROVIDER_EDGE, edgeName: 'the provider connector (:3240)', channelStore: 'provider-direct.json',
  paidCost: L.price, freeCost: 0n,
  legs: 'the provider connector\'s client leg alone', books: directBooks,
});

// ── the provider cannot tell the two apart ───────────────────────────────
step('7. the provider behaved identically whether paid through the hub or directly');
for (const what of ['availability', 'spawn', 'extend', 'status', 'ended']) {
  assert(viaHub.shapes[what] && viaHub.shapes[what] === direct.shapes[what],
    `${what} answered the same both ways (per-run values blanked): ${viaHub.shapes[what]}`);
}
assert(JSON.stringify(viaHub.lifecycle) === JSON.stringify(direct.lifecycle),
  `the same lease lifecycle both ways: ${viaHub.lifecycle.join(' -> ')}`);

console.log(`\n  total run time ${Math.round((Date.now() - startedAt) / 1000)}s`);
done('the provider\'s Profile, Listings and Liveness read back off the relay, availability answered free, a paid spawn ran a workload reachable over SSH with the tenant\'s key, a paid extension added exactly one Lease Interval, the sweep destroyed the workload at expiry, every claim book grew by exactly the route prices — twice, paying through the hub and paying the provider connector directly, with identical provider behaviour.');
