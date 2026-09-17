// MILESTONE 5 ACCEPTANCE TEST (TOON_Network #46, ticket #54; spec §3.1.3,
// §6.5, §12, Appendix A): the WORKLOAD GATEWAY end to end against the real
// sandbox — relay, hub, both connectors, both providers, and the gateway
// behind its own connector. The milestone's promise in one sentence: **a
// workload has a stable URL that survives a Takeover with no tenant online.**
// Run from sandbox/ on the host after `make up-gateway` (or `make up-gateway
// COMPOSE_PROFILE=payments`); `make smoke-m5`.
//
//   0.  the stack is up, with the gateway and its own connector; that
//       connector terminates NO PAID ROUTE (ADR 0013: a gateway is not a
//       party to a lease) and the gateway answers a hostname it holds no
//       grant for with its own 503 `no_grant` — reaching no provider
//   1.  a tenant channel against the hub and the providers' books before
//   2.  the SPAWN: one signed Lease Request with a two-member `standby_set`,
//       an HTTP image (`traefik/whoami` on container port 80) and that port
//       PUBLISHED, paid on the primary's `warm.v1.spawn` and reserved on the
//       standby's `warm.v1.standby` — the `make smoke-m3` shape with ports
//   3.  the GRANT, published by the tenant with `node scripts/grant.mjs`:
//       kind 30438 on the relay, naming THE SANDBOX GATEWAY, this workload,
//       `http_port` 80, both members primary first, an expiry and a fresh
//       short name. NOTHING is told to the gateway out of band — publishing
//       the grant is the whole ceremony (spec §12.1)
//   4.  the two URLs answer FROM THE PRIMARY: the canonical hostname (the
//       52-character base32 of the workload id, spec §12.2) and the grant's
//       name, on the plain listener and over TLS, each carrying the workload's
//       own body — whoami's `Hostname:` is the primary's container — and the
//       forwarding headers of spec §12.5 with the tenant's `Host` preserved
//   5.  the primary's container is STOPPED: the standby announces a Takeover
//       on the relay, settles, and starts the workload in its own id range.
//       THE TENANT DOES NOTHING. The same two URLs come back with the
//       STANDBY's container in the body — the same names, a different copy
//   6.  the primary is STARTED again: it finds the Takeover and stops its own
//       copy, and the URLs still answer from the standby
//   7.  the tenant TERMINATES both leases: both URLs answer `503` with the
//       gateway's own reason (`no_running_member`), in spec §5's error shape
//       and in the `toon-gateway-reason` header
//   8.  the books: the gateway PAID NOTHING. Each provider's peer book grew by
//       exactly the lease prices the tenant paid and not one unit more, though
//       the gateway asked `status` of both members throughout
//
// TIMELINE, at the sandbox's 30 s cadence (conf/provider*.toml). The Takeover
// is `make smoke-m3`'s: the primary's Liveness expires up to five cadences
// after the stop, the standby announces one cadence of silence later, and
// settles two cadences after that. The GATEWAY's own settle window is the
// same two cadences, measured from the claim's `created_at` (spec §12.7), so
// it re-resolves at about the moment the standby starts the workload — and a
// brief `503` either side of that is expected, which is why every check here
// POLLS rather than curling once. About six minutes, four of them the takeover.
//
// ONE SECOND BETWEEN REQUESTS, deliberately. While the gateway holds no target
// every request re-resolves, and two resolutions in the same second sign the
// same `status` bytes twice — same `created_at`, same content, same member —
// so the provider refuses the second as `stale_request` (its replay book,
// spec §6.1) and the tenant is told `member_unreachable` instead of the true
// reason. `askGateway` below spaces its requests so that what this smoke reads
// is the answer and not that artefact.
import { verifyEvent } from 'nostr-tools/pure';
import {
  HTTP_CONTAINER_PORT, HTTP_IMAGE, HUB, HUB_FEE, BUYER_SOL, K_TAKEOVER, TOON_LABEL,
  providerOf, WATCHDOG_S,
  reporter, jstr, nowSec, sleep, waitFor,
  claims, clientBookOnChannel, peerBookTotal,
  relayReadUntil, takeoverFilter, hasTag,
  docker, composeNotRunning, composeService, composeHealthy, findWorkload, containerState, runningWorkloads,
  newTenant, leaseRequest, newWorkloadId, httpSpawnContent, openChannel, ROOT,
} from './lib/provider-smoke.mjs';
import {
  GATEWAY_EDGE, GATEWAY_HTTP_PORT, GATEWAY_HTTPS_PORT, K_GATEWAY_GRANT,
  canonicalLabel, gatewayDomain, gatewayGet, gatewayPubkey, whoamiHeader, whoamiHostname,
} from './lib/gateway-smoke.mjs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const { step, ok, bad, assert, fatal, done } = reporter('MILESTONE 5 SMOKE');
const startedAt = Date.now();

// THE SET, as Milestone 3 buys it: index 0 the primary that runs the workload,
// index 1 the Warm Standby that holds capacity — and, in a grant, the order
// `standby_set` is read in (spec §12.4 step 3).
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

// The budgets. The first three are `make smoke-m3`'s, because the Takeover
// under this URL is the same Takeover; the gateway's are its own.
const TAKEOVER_BUDGET_S = 7 * CADENCE + 2 * WATCHDOG_S + 15;
const SETTLE_BUDGET_S = 2 * CADENCE + 2 * WATCHDOG_S + 60; // + the image start
// The gateway re-resolves at the claim's `created_at` + 2 cadences (spec
// §12.7) — about when the standby starts the workload — and drops a target
// that answered nothing, after which every request resolves again. So the
// URL is back within a cadence or two of the standby's start, plus the image.
const GATEWAY_FOLLOW_BUDGET_S = SETTLE_BUDGET_S + 2 * CADENCE;
// A grant reaches the gateway on the relay it watches, which is one hop.
const RESOLVE_BUDGET_S = 90;
// After `terminate` every member answers about the lease, so the target is
// withdrawn on the next re-ask: one cadence plus the gateway's own tick.
const WITHDRAW_BUDGET_S = 2 * CADENCE + 30;

const DOMAIN = gatewayDomain();
const GATEWAY = gatewayPubkey();

// ── asking the gateway ────────────────────────────────────────────────────
let lastAsked = 0;
/**
 * One request to the gateway at `hostname`, never less than a second after the
 * last one (the header comment says why).
 */
async function askGateway(hostname, options = {}) {
  const since = Date.now() - lastAsked;
  if (since < 1100) await sleep(1100 - since);
  lastAsked = Date.now();
  return gatewayGet(hostname, options);
}
/** The gateway's refusal reason for an answer, from its header (spec §12.3); null for a 200. */
const reasonOf = (answer) => answer.headers['toon-gateway-reason'] ?? null;
/** A one-line summary of what a hostname answered: the status and either the container that served it or the reason. */
const summary = (answer) => `${answer.status} ${answer.status === 200 ? `from ${whoamiHostname(answer.body)}` : reasonOf(answer)}`;
/**
 * Poll one hostname until `satisfied(answer)`, up to `seconds`. Returns the
 * last answer either way, so a failure reports what the tenant actually saw.
 */
async function askUntil(hostname, satisfied, seconds, options = {}) {
  let last = null;
  await waitFor(async () => {
    last = await askGateway(hostname, options).catch((e) => ({ status: 0, headers: {}, body: String(e.message) }));
    return satisfied(last) ? last : null;
  }, seconds, 1500);
  return last;
}
/** The container hostname docker gave `name` — what whoami running in it reports as its own. */
const containerHostname = (name) => docker('inspect', '-f', '{{.Config.Hostname}}', name).trim();
/** True when `toon-<id>` falls in provider `P`'s committed workload id range. */
function inRangeOf(P) {
  const [lo, hi] = [Number(P.confValue('workload_id_range_start')), Number(P.confValue('workload_id_range_end'))];
  return Object.assign((name) => { const id = Number(name.slice('toon-'.length)); return id >= lo && id <= hi; }, { lo, hi });
}

// ── 0. the stack, the gateway, and what it answers before any grant ───────
step('0. the stack is up with the `gateway` profile; the gateway sells nothing and serves nothing it holds no grant for');
{
  const missing = composeNotRunning(['provider', 'provider-connector', 'directory-publisher', 'provider2', 'provider2-connector', 'directory-publisher2', 'relay', 'relay-connector', 'workload-gateway', 'workload-gateway-connector']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-gateway\` first`);
  ok('both providers, both connectors, both directory publishers, the relay, the gateway and its connector are up');
}
if (!(await composeHealthy('workload-gateway', 60))) fatal('workload-gateway never reported healthy — its own healthcheck is the `no_grant` 503 below');
{
  // ADR 0013 and spec §12: a gateway is reached through its own connector, and
  // in this milestone that connector terminates NO PAID ROUTE. Nothing to
  // price, nothing to settle, and no way for a gateway to sell its service yet.
  const res = await fetch(`${GATEWAY_EDGE}/ilp`).catch((e) => fatal(`the gateway's connector is unreachable at ${GATEWAY_EDGE}: ${e.message}`));
  if (!res.ok) fatal(`the gateway's connector GET /ilp -> ${res.status}`);
  const desc = await res.json();
  assert((desc.routes ?? []).length === 0,
    `${GATEWAY_EDGE} is ${desc.ilpAddresses?.join(', ')} and terminates ${(desc.routes ?? []).length} paid route(s) — a gateway holds no lease, pays nothing and sells nothing (ADR 0013)`);
}
{
  // Spec §12.3's last paragraph: an unknown hostname is answered by the
  // gateway ITSELF and must reach no provider and no workload. `127.0.0.1` is
  // not a label under gw.localhost, so it is exactly such a hostname.
  const answer = await askGateway('127.0.0.1');
  assert(answer.status === 503 && reasonOf(answer) === 'no_grant',
    `the gateway answers a hostname it holds no grant for ${answer.status} \`${reasonOf(answer)}\` — its own refusal, dialling nothing (spec §12.3)`);
  let body = null;
  try { body = JSON.parse(answer.body); } catch { /* not JSON */ }
  assert(body !== null && Object.keys(body).sort().join() === 'error,message' && body.error === 'no_grant',
    `in spec §5's error shape, exactly { error, message }: ${answer.body.slice(0, 120)}`);
}

// ── 1. the tenant, its channel, the books before ──────────────────────────
step('1. a tenant with a Solana mock-USDC channel against the hub; the books before');
const { client, opened } = await openChannel(HUB, 'channels.json');
assert(client.identity?.solanaPublicKey === BUYER_SOL, `the tenant pays as ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded`);
ok(`channel ${opened.channelId} against the hub (status ${opened.status ?? 'open'})`);
const channelKey = `solana:${opened.channelId}`;
// Every packet is sealed to the member it is for: two providers, two edges,
// two sealing keys (ADR 0011).
const sendTo = (P, route, body) => client.send(route, { body }, { sealTo: P.edge, timeoutMs: 120_000 });
const paid = { hub: 0n, [PRIMARY.service]: 0n, [STANDBY.service]: 0n };
const took = (P, sent, what, expectedCost) => {
  const cost = BigInt(sent.claim?.amount ?? 0);
  assert(cost === expectedCost, `the tenant paid the hub exactly ${cost} uUSDC for ${what} (${expectedCost})`);
  paid.hub += cost;
  paid[P.service] += cost > HUB_FEE ? cost - HUB_FEE : 0n;
};
// The tenant channel is shared by every smoke; a packet an earlier, aborted
// run left pending is applied on this channel's NEXT packet. One uncounted
// free packet first, so the baseline below holds nothing pending.
await sendTo(STANDBY, STANDBY.availabilityRoute, { listing: L.name, version: L.version, image: HTTP_IMAGE });
const readBooks = async () => ({
  hub: clientBookOnChannel(await claims('relay-connector'), channelKey),
  [PRIMARY.service]: peerBookTotal(await claims(PRIMARY.connectorNode), PRIMARY.channel),
  [STANDBY.service]: peerBookTotal(await claims(STANDBY.connectorNode), STANDBY.channel),
});
const before = await readBooks();
console.log(`  books before: hub client (${channelKey}) = ${before.hub}; ${PRIMARY.connectorNode} peer = ${before[PRIMARY.service]}; ${STANDBY.connectorNode} peer = ${before[STANDBY.service]}`);

// ── 2. the spawn: an HTTP workload on a two-member Standby Set ────────────
step(`2. ONE signed spawn of ${HTTP_IMAGE.reference} with container port ${HTTP_CONTAINER_PORT} published, standby_set [${PRIMARY.service}, ${STANDBY.service}]`);
const tenant = newTenant('m5-tenant');
const workloadId = newWorkloadId();
const request = leaseRequest(tenant, 'spawn', { ...httpSpawnContent(workloadId, tenant), standby_set: SET.map((P) => P.pubkey) }, 300, SET);
const runningBefore = runningWorkloads();
let primaryAccess = null;
let primaryContainer = null;
let primaryHostname = null;
{
  const spawned = await sendTo(PRIMARY, PRIMARY.spawnRoute(L.name, L.version), { request });
  if (!spawned.fulfilled) fatal(`the primary's spawn was refused short of the app: ${spawned.code} (${spawned.refusedBy}) ${spawned.message ?? ''}`);
  const body = spawned.status === 200 ? spawned.json() : null;
  if (!body) fatal(`${PRIMARY.service} answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
  took(PRIMARY, spawned, 'the primary spawn', HUB_PRICE);
  assert(body.workload_id === workloadId && body.role === 'primary', `workload ${workloadId.slice(0, 12)}…, role ${body.role} on ${PRIMARY.service}`);
  primaryAccess = body.access;
  const httpPort = primaryAccess?.ports?.find((p) => p.container_port === HTTP_CONTAINER_PORT);
  assert(httpPort !== undefined,
    `access.ports carries the HTTP port: ${jstr(primaryAccess?.ports ?? [])} — the pair a grant's \`http_port\` picks out (spec §12.4 step 5)`);
  const workload = primaryAccess ? await findWorkload(primaryAccess.ssh_port, 20) : null;
  primaryContainer = workload?.name ?? null;
  const inPrimaryRange = inRangeOf(PRIMARY);
  if (primaryContainer === null || !inPrimaryRange(primaryContainer)) fatal(`no toon-<id> container in ${PRIMARY.service}'s range ${inPrimaryRange.lo}-${inPrimaryRange.hi} publishes ssh_port ${primaryAccess?.ssh_port}`);
  primaryHostname = containerHostname(primaryContainer);
  ok(`the workload runs as ${primaryContainer} in ${PRIMARY.service}'s id range ${inPrimaryRange.lo}-${inPrimaryRange.hi}, serving ${HTTP_CONTAINER_PORT} at ${primaryAccess.host}:${httpPort?.host_port}`);
  // The fact every assertion below rests on: this copy of the image answers
  // with THIS container's name, and the standby's copy will answer with its
  // own. `docker inspect` is read once, here, so that a body read later can be
  // tied to a member without asking the daemon what it is looking at.
  ok(`and reports itself as \`${primaryHostname}\` — the name whoami answers with, so the primary's copy is tellable from any other`);
}
{
  const reserved = await sendTo(STANDBY, STANDBY.standbyRoute(L.name, L.version), { request });
  if (!reserved.fulfilled) fatal(`the standby's spawn was refused short of the app: ${reserved.code} (${reserved.refusedBy}) ${reserved.message ?? ''}`);
  const body = reserved.status === 200 ? reserved.json() : null;
  if (!body) fatal(`${STANDBY.service} answered ${reserved.status}: ${reserved.text().slice(0, 300)}`);
  took(STANDBY, reserved, 'the standby reservation', HUB_STANDBY_PRICE);
  assert(body.workload_id === workloadId && body.role === 'standby' && !('access' in body),
    `the SAME bytes on .standby: role ${body.role}, no access — a Warm Standby holds capacity and runs nothing until a Takeover`);
}

// ── 3. the grant: the tenant's whole side of this milestone ───────────────
// A FRESH NAME PER RUN. A readable name is first come, first served across
// every grant still in force on the gateway (spec §12.6), and an earlier run's
// grant outlives its lease, so a fixed name would be the *old* run's and this
// one would be served at the canonical hostname alone.
const NAME = `m5-${randomBytes(4).toString('hex')}`;
step(`3. the tenant publishes a Gateway Grant (kind ${K_GATEWAY_GRANT}) naming the sandbox gateway, with the name \`${NAME}\``);
const grantReport = (() => {
  const args = [
    join(ROOT, 'scripts', 'grant.mjs'),
    '--workload', workloadId,
    '--key', Buffer.from(tenant.secret).toString('hex'),
    '--http-port', String(HTTP_CONTAINER_PORT),
    '--ports', String(HTTP_CONTAINER_PORT),
    ...SET.flatMap((P) => ['--standby', P.service]),
    '--expires-in', '1h',
    '--name', NAME,
  ];
  console.log(`  node scripts/grant.mjs --workload ${workloadId.slice(0, 12)}… --key <the tenant's> --http-port ${HTTP_CONTAINER_PORT} --ports ${HTTP_CONTAINER_PORT} ${SET.map((P) => `--standby ${P.service}`).join(' ')} --expires-in 1h --name ${NAME}`);
  const ran = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  if (ran.status !== 0) {
    fatal(`scripts/grant.mjs exited ${ran.status}: ${(ran.stderr ?? '').trim().split('\n').slice(-6).join('\n')}`);
  }
  try {
    return JSON.parse(ran.stdout);
  } catch {
    return fatal(`scripts/grant.mjs printed no JSON report: ${ran.stdout.slice(0, 400)}`);
  }
})();
const CANONICAL = `${canonicalLabel(workloadId)}.${DOMAIN}`;
const NAMED = `${NAME}.${DOMAIN}`;
assert(grantReport.accepted?.length >= 1, `the relay accepted the grant: ${(grantReport.accepted ?? []).join(', ') || 'NONE'} (${jstr(grantReport.failed ?? {})})`);
assert(grantReport.grant?.gateway === GATEWAY && grantReport.grant?.http_port === HTTP_CONTAINER_PORT
  && JSON.stringify(grantReport.grant?.standby_set) === JSON.stringify(SET.map((P) => P.pubkey)) && grantReport.grant?.name === NAME,
  `its content names gateway ${GATEWAY.slice(0, 12)}… (conf/workload-gateway.conf's key), http_port ${grantReport.grant?.http_port}, the set primary first, name ${grantReport.grant?.name}, until ${new Date((grantReport.grant?.expires_at ?? 0) * 1000).toISOString()}`);
assert(grantReport.hostnames?.[0] === CANONICAL,
  `the canonical hostname is ${CANONICAL} — the lowercase unpadded base32 of the workload id, ${canonicalLabel(workloadId).length} characters, derived and never assigned (spec §12.2)`);
{
  // Read back from the relay rather than trusted from the tool's own report:
  // the grant reaches the gateway the same way, as a signed event on a relay.
  const found = await relayReadUntil({ kinds: [K_GATEWAY_GRANT], '#d': [workloadId] }, 'grant', 30);
  const event = found.find((e) => e.pubkey === tenant.pubkey) ?? null;
  assert(event !== null && verifyEvent(event) && hasTag(event, ['d', workloadId]) && hasTag(event, ['p', GATEWAY]) && hasTag(event, ['L', TOON_LABEL]),
    event ? `on the relay: kind ${event.kind}, d = the workload id, ["p","${GATEWAY.slice(0, 12)}…"] (the one filter a gateway watches, spec §12.1), ["L","${TOON_LABEL}"], signed by the tenant`
      : `no kind ${K_GATEWAY_GRANT} on d=${workloadId.slice(0, 12)}… from the tenant within 30s`);
}
ok('and NOTHING was told to the gateway out of band: publishing the grant is the whole ceremony');

// ── 4. the two URLs, answered by the workload on the primary ──────────────
step(`4. both URLs answer with the workload's own body, served from the primary (${primaryContainer})`);
const servedByPrimary = (a) => a.status === 200 && whoamiHostname(a.body) === primaryHostname;
{
  const answer = await askUntil(CANONICAL, servedByPrimary, RESOLVE_BUDGET_S);
  assert(servedByPrimary(answer),
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${summary(answer)}: the workload's own answer, from the primary's container \`${primaryHostname}\``);
  if (answer.status !== 200) fatal(`the canonical URL never answered from the primary within ${RESOLVE_BUDGET_S}s: ${answer.body.slice(0, 300)}`);
  // Spec §12.5, read out of the body the workload echoed rather than out of
  // the gateway's log: the tenant's own name arrived as `Host`.
  assert(whoamiHeader(answer.body, 'Host') === `${CANONICAL}:${GATEWAY_HTTP_PORT}`,
    `the workload saw Host: ${whoamiHeader(answer.body, 'Host')} — the name the TENANT used, preserved across the hop (spec §12.5)`);
  assert(whoamiHeader(answer.body, 'X-Forwarded-Host') === `${CANONICAL}:${GATEWAY_HTTP_PORT}` && whoamiHeader(answer.body, 'X-Forwarded-Proto') === 'http'
    && whoamiHeader(answer.body, 'X-Forwarded-For') !== null,
    `and X-Forwarded-For ${whoamiHeader(answer.body, 'X-Forwarded-For')}, -Proto ${whoamiHeader(answer.body, 'X-Forwarded-Proto')}, -Host ${whoamiHeader(answer.body, 'X-Forwarded-Host')}`);
}
{
  const answer = await askUntil(NAMED, servedByPrimary, 30);
  assert(servedByPrimary(answer),
    `http://${NAMED}:${GATEWAY_HTTP_PORT}/ -> ${summary(answer)}: the grant's readable name, served beside the canonical one (spec §12.6)`);
}
{
  // TLS for the gateway's own domain, with the gateway's own certificate: the
  // workload is reachable over HTTPS holding no certificate itself (§12.2).
  const answer = await askUntil(CANONICAL, servedByPrimary, 30, { tls: true });
  assert(servedByPrimary(answer),
    `https://${CANONICAL}:${GATEWAY_HTTPS_PORT}/ -> ${summary(answer)}, terminated by the gateway with conf/workload-gateway-tls/`);
  assert(answer.status !== 200 || whoamiHeader(answer.body, 'X-Forwarded-Proto') === 'https',
    `and the workload was told X-Forwarded-Proto: ${whoamiHeader(answer.body, 'X-Forwarded-Proto')} — the scheme the TENANT used, not the gateway's hop (spec §12.5)`);
}

// ── 5. the Takeover, with no tenant online ────────────────────────────────
step(`5. the primary's container is STOPPED; the standby announces a Takeover within ${TAKEOVER_BUDGET_S}s — the tenant does nothing`);
const inStandbyRange = inRangeOf(STANDBY);
let standbyContainer = null;
let standbyHostname = null;
let takeover = null;
{
  const stoppedAt = nowSec();
  composeService('stop', PRIMARY.service);
  ok(`docker compose stop ${PRIMARY.service} at ${stoppedAt}; its container ${primaryContainer} keeps running on the host daemon — the loudest partition there is`);
  const claimsFound = await relayReadUntil(takeoverFilter(workloadId, SET), 'takeover', TAKEOVER_BUDGET_S);
  takeover = claimsFound.find((e) => e.pubkey === STANDBY.pubkey) ?? null;
  if (takeover === null) fatal(`no Takeover (kind ${K_TAKEOVER}) on d=${workloadId.slice(0, 12)}… from ${STANDBY.service} within ${TAKEOVER_BUDGET_S}s — the Milestone 3 timeline did not run, so there is nothing for the gateway to follow`);
  assert(takeover.kind === K_TAKEOVER && hasTag(takeover, ['d', workloadId]) && verifyEvent(takeover),
    `a Takeover from ${STANDBY.service} on the relay ${takeover.created_at - stoppedAt}s after the stop: kind ${takeover.kind}, d = the workload id, signed by ${takeover.pubkey.slice(0, 12)}…`);
  console.log(`  the gateway's settle window is 2 x ${CADENCE}s from created_at ${takeover.created_at} (spec §12.7), so it re-resolves at about ${takeover.created_at + 2 * CADENCE}`);
}

step(`6. the SAME two URLs come back, answered by the workload on the standby, within ${GATEWAY_FOLLOW_BUDGET_S}s`);
{
  const started = await waitFor(async () => {
    const fresh = runningWorkloads().filter((n) => !runningBefore.includes(n) && n !== primaryContainer && inStandbyRange(n));
    return fresh.length > 0 ? fresh : null;
  }, SETTLE_BUDGET_S, 2000);
  if (!started) fatal(`no new toon-<id> container in ${STANDBY.service}'s range ${inStandbyRange.lo}-${inStandbyRange.hi} within ${SETTLE_BUDGET_S}s of the announcement`);
  standbyContainer = started[0];
  standbyHostname = containerHostname(standbyContainer);
  assert(started.length === 1 && standbyHostname !== primaryHostname,
    `${standbyContainer} is RUNNING in ${STANDBY.service}'s id range ${inStandbyRange.lo}-${inStandbyRange.hi}, ${nowSec() - takeover.created_at}s after the claim, and reports itself as \`${standbyHostname}\` — not \`${primaryHostname}\``);
}
const servedByStandby = (a) => a.status === 200 && whoamiHostname(a.body) === standbyHostname;
{
  const answer = await askUntil(CANONICAL, servedByStandby, GATEWAY_FOLLOW_BUDGET_S);
  assert(servedByStandby(answer),
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${summary(answer)}: THE SAME URL, now the standby's copy \`${standbyHostname}\`, ${Math.round((Date.now() - startedAt) / 1000)}s into the run`);
  if (answer.status !== 200) fatal(`the canonical URL never came back within ${GATEWAY_FOLLOW_BUDGET_S}s of the Takeover: ${reasonOf(answer)} ${answer.body.slice(0, 300)}`);
  assert(whoamiHeader(answer.body, 'Host') === `${CANONICAL}:${GATEWAY_HTTP_PORT}`,
    `and the workload on the standby saw the same Host: ${whoamiHeader(answer.body, 'Host')} — the name never moved, only what serves it`);
}
{
  const answer = await askUntil(NAMED, servedByStandby, 2 * CADENCE);
  assert(servedByStandby(answer),
    `http://${NAMED}:${GATEWAY_HTTP_PORT}/ -> ${summary(answer)}: the readable name followed the workload too`);
}
ok('the tenant published nothing, signed nothing and was not online for any of it: the grant it published in step 3 is the whole of its part (ADR 0010, spec §12.7)');

// ── 7. the primary comes back and stands down ─────────────────────────────
step('7. the primary is STARTED again: it finds the Takeover, stops its own copy, and the URLs still answer from the standby');
{
  composeService('start', PRIMARY.service);
  assert(await composeHealthy(PRIMARY.service, 120), `${PRIMARY.service} is healthy again`);
  const primaryStopped = await waitFor(async () => containerState(primaryContainer) === 'exited', 90, 2000);
  assert(primaryStopped === true, `${primaryContainer} is ${containerState(primaryContainer)} — the primary stopped its own copy on finding the Takeover (spec §7.1)`);
  const copies = runningWorkloads().filter((n) => n === primaryContainer || n === standbyContainer);
  assert(copies.length === 1 && copies[0] === standbyContainer, `exactly ONE copy of the workload runs on the host daemon: ${copies.join(', ') || 'none'}`);
  // Polled, not asked once: the primary coming back is a member the gateway
  // could not reach becoming one that answers, so a re-resolution is in flight
  // at about this moment (spec §12.7). What must hold is where it lands.
  const answer = await askUntil(CANONICAL, servedByStandby, CADENCE);
  assert(servedByStandby(answer),
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${summary(answer)}: still the standby's copy, with both members answering again`);
}

// ── 8. the tenant ends the leases; the URLs say why ───────────────────────
step(`8. the tenant terminates both leases; within ${WITHDRAW_BUDGET_S}s both URLs answer 503 with the gateway's reason`);
for (const P of SET) {
  const res = await sendTo(P, P.terminateRoute, { request: leaseRequest(tenant, 'terminate', { workload_id: workloadId }, 120, P) });
  if (!res.fulfilled) { bad(`terminate on ${P.service} was refused short of the app: ${res.code} (${res.refusedBy})`); continue; }
  const body = res.status === 200 ? res.json() : null;
  assert(res.status === 200 && body?.workload_id === workloadId && JSON.stringify(body?.state) === JSON.stringify({ ended: 'termination' }),
    `${P.service} answered ${res.status} ${res.text().slice(0, 160)}`);
  took(P, res, `the terminate on ${P.service}`, HUB_FEE);
}
for (const hostname of [CANONICAL, NAMED]) {
  // `no_running_member` and not `member_unreachable`: every member ANSWERED
  // about the lease and none of them is running it, which is a fact about the
  // lease rather than about this gateway's reach (spec §12.3, §12.4 step 4).
  const answer = await askUntil(hostname, (a) => a.status === 503 && reasonOf(a) === 'no_running_member', WITHDRAW_BUDGET_S);
  assert(answer.status === 503 && reasonOf(answer) === 'no_running_member',
    `http://${hostname}:${GATEWAY_HTTP_PORT}/ -> ${answer.status} \`${reasonOf(answer)}\` — the gateway's own answer, naming the reason in the \`toon-gateway-reason\` header`);
  let body = null;
  try { body = JSON.parse(answer.body); } catch { /* not JSON */ }
  assert(body !== null && Object.keys(body).sort().join() === 'error,message' && body.error === reasonOf(answer),
    `in spec §5's error shape: ${answer.body.slice(0, 200)}`);
}

// ── 9. the books: the gateway paid nothing ────────────────────────────────
step('9. the books, to the unit: the gateway asked `status` of both members throughout and paid for none of it');
{
  const after = await waitFor(async () => {
    const now = await readBooks();
    return now.hub - before.hub >= paid.hub ? now : null;
  }, 20) ?? await readBooks();
  assert(after.hub - before.hub === paid.hub,
    `the hub's client book on the tenant's channel grew by ${after.hub - before.hub} = the spawn, the reservation and two terminates at the hub's prices (${paid.hub})`);
  assert(after[PRIMARY.service] - before[PRIMARY.service] === paid[PRIMARY.service],
    `${PRIMARY.connectorNode}'s peer book grew by ${after[PRIMARY.service] - before[PRIMARY.service]} = ${L.price}, the spawn price, and NOTHING for the gateway's \`status\` calls (${paid[PRIMARY.service]})`);
  assert(after[STANDBY.service] - before[STANDBY.service] === paid[STANDBY.service],
    `${STANDBY.connectorNode}'s peer book grew by ${after[STANDBY.service] - before[STANDBY.service]} = ${L.standby_price}, the standby price, and nothing else (${paid[STANDBY.service]}) — \`status\` is free and a gateway calls no other route (spec §12)`);
}

console.log(`\n  total run time ${Math.round((Date.now() - startedAt) / 1000)}s`);
done(`a tenant spawned an HTTP workload on a two-member Standby Set, published one Gateway Grant and stopped there; the gateway found the grant on the relay by itself, resolved the workload across the set with a \`status\` signed by its own key, and served it at ${CANONICAL} and ${NAMED} over HTTP and HTTPS with the tenant's Host preserved. With the primary stopped, the standby took the workload over and THE SAME TWO URLS came back answered by the copy on the standby — the milestone's promise, with the tenant offline throughout. The restarted primary stood down leaving one copy; terminate left both URLs answering 503 no_running_member in the spec's error shape; and neither provider's book grew by a single unit for anything the gateway asked.`);
