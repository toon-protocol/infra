// MILESTONE 5 ACCEPTANCE TEST (TOON_Network #46, ticket #54; spec §6.5, §12,
// Appendix A), ON MILESTONE 6'S TENANT PATH (#56, #63): the WORKLOAD GATEWAY
// end to end against the real sandbox — relay, hub, both connectors, both
// providers, and the gateway behind its own connector. The milestone's promise
// in one sentence: **a workload has a stable URL that survives a Takeover with
// no tenant online.** That promise is unchanged; what changed underneath it is
// how the tenant chooses the gateway — a sealed Gateway Handover instead of a
// published Gateway Grant — and how a request authenticates: a Continuation
// Token instead of a signature. Run from sandbox/ on the host after
// `make up-gateway` (or `make up-gateway COMPOSE_PROFILE=payments`);
// `make smoke-m5`. What Milestone 6 adds on top of this — the refusals, the
// restart and the relay swept for anything a tenant made — is `make smoke-m6`.
//
//   0.  the stack is up, with the gateway and its own connector; that
//       connector terminates exactly ONE route and it is FREE — the handover
//       door (ADR 0013: a gateway is not a party to a lease, and it sells
//       nothing) — and the gateway answers a hostname it holds no grant for
//       with its OWN 503 `no_grant`, not a provider's
//   1.  a tenant channel against the hub and the providers' books before
//   2.  the SPAWN: one spawn content with a two-member `standby_set`, an HTTP
//       image (`traefik/whoami` on container port 80) and that port PUBLISHED,
//       sent to each member in a REQUEST OF ITS OWN bearing that member's
//       Continuation Token — paid on the primary's `warm.v1.spawn` and
//       reserved on the standby's `warm.v1.standby` (op `standby`) — the
//       `make smoke-m3` shape with ports
//   3.  the HANDOVER, sealed to the gateway's own connector by `node
//       scripts/handover.mjs`: one Gateway Grant DERIVED PER MEMBER from the
//       lease's root secret for one moment, `http_port` 80, both members
//       primary first, and a fresh short name. NOTHING IS PUBLISHED — the
//       relay carries nothing naming this workload — and the gateway admits
//       the handover by asking the members whether the grant works (spec
//       §12.1, ADR 0017)
//   4.  the two URLs answer FROM THE PRIMARY: the canonical hostname (the
//       52-character base32 of the workload id, spec §12.2) and the grant's
//       name, on the plain listener and over TLS, each carrying the workload's
//       own body — whoami's `Hostname:` is the primary's container — and the
//       forwarding headers of spec §12.5 with the tenant's `Host` preserved
//   5.  the primary's container is STOPPED and the standby announces a
//       Takeover on the relay. THE TENANT DOES NOTHING
//   6.  the standby settles, starts the workload in its own id range, and the
//       SAME TWO URLS come back with the STANDBY's container in the body —
//       the same names, a different copy, and no tenant in the loop
//   7.  the primary is STARTED again: it finds the Takeover and stops its own
//       copy, and the URLs still answer from the standby
//   8.  the tenant TERMINATES both leases: both URLs answer `503` with a
//       gateway reason that says nothing is running it, in spec §5's error
//       shape and in the `toon-gateway-reason` header
//   9.  the books: the gateway PAID NOTHING. Each provider's peer book grew by
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
// POLLS rather than curling once. Six to seven minutes, four of them the takeover.
//
// ONE SECOND BETWEEN REQUESTS, still. While the gateway holds no target every
// request re-resolves, and under Milestone 5 two resolutions in the same
// second built the same `status` bytes twice — same `created_at`, same
// content, same member — so the provider refused the second as
// `stale_request` and the tenant was told `member_unreachable` instead of the
// true reason. A Lease Request now carries a RANDOM `request_id` and is what
// the replay set keys on (spec §6.1), so two resolutions a second apart are
// two different requests and that hazard is gone. The spacing is kept anyway,
// because it also keeps this smoke from hammering a gateway that is mid-round
// and because nothing here is in a hurry.
import { verifyEvent } from 'nostr-tools/pure';
import {
  HTTP_CONTAINER_PORT, HTTP_IMAGE, HUB, HUB_FEE, BUYER_SOL, K_TAKEOVER,
  providerOf, WATCHDOG_S,
  reporter, jstr, nowSec, sleep, waitFor,
  claims, clientBookOnChannel, peerBookTotal,
  relayRead, relayReadUntil, takeoverFilter, hasTag,
  docker, composeNotRunning, composeService, composeHealthy, findWorkload, containerState, runningWorkloads,
  continuationFor, gatewaySubFor, newRootSecret, newTenant, newWorkloadId, httpSpawnContent, openChannel, tokenRequest,
} from './lib/provider-smoke.mjs';
import {
  GATEWAY_EDGE, GATEWAY_HTTP_PORT, GATEWAY_HTTPS_PORT,
  canonicalLabel, errorBody, gatewayDomain, gatewayGet, runHandover, whoamiHeader, whoamiHostname,
} from './lib/gateway-smoke.mjs';
import { randomBytes } from 'node:crypto';

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
// The admission round (spec §12.1) already asked the members and kept where
// the workload was running, so the first request is normally a 200; this is
// the budget for the gateway finishing that round, not for finding anything.
const RESOLVE_BUDGET_S = 90;
// After `terminate` every member answers about the lease, so the target is
// withdrawn on the next re-ask: one cadence plus the gateway's own tick.
const WITHDRAW_BUDGET_S = 2 * CADENCE + 30;

const DOMAIN = gatewayDomain();

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
/** A one-line summary of what a hostname answered: the container that served it, the gateway's reason, or why nothing answered at all. */
const summary = (answer) => {
  if (answer.status === 200) return `200 from ${whoamiHostname(answer.body)}`;
  if (answer.status === 0) return `no answer: ${answer.body}`;
  return `${answer.status} ${reasonOf(answer)}`;
};
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
  // that connector terminates exactly ONE route — the door a tenant seals a
  // Gateway Handover or a Gateway Withdrawal to (§12.1, §12.7) — AT PRICE 0.
  // A gateway holds no lease, pays nothing and sells nothing, so the one route
  // it does terminate being free is the whole of what there is to check.
  const res = await fetch(`${GATEWAY_EDGE}/ilp`).catch((e) => fatal(`the gateway's connector is unreachable at ${GATEWAY_EDGE}: ${e.message}`));
  if (!res.ok) fatal(`the gateway's connector GET /ilp -> ${res.status}`);
  const desc = await res.json();
  const routes = desc.routes ?? [];
  const priced = routes.filter((r) => BigInt(r.price ?? 0) !== 0n);
  assert(routes.length === 1 && priced.length === 0,
    `${GATEWAY_EDGE} is ${desc.ilpAddresses?.join(', ')} and terminates ${routes.length} route(s), ${priced.length} of them priced — one free door and nothing to sell (ADR 0013): ${jstr(routes.map((r) => `${r.prefix ?? r.route ?? '?'}@${r.price ?? 0}`))}`);
}
{
  // Spec §12.3's last paragraph: an unknown hostname is answered by the
  // gateway ITSELF and must reach no provider and no workload. `127.0.0.1` is
  // not a label under gw.localhost, so it is exactly such a hostname.
  const answer = await askGateway('127.0.0.1');
  assert(answer.status === 503 && reasonOf(answer) === 'no_grant',
    `the gateway answers a hostname it holds no grant for ${answer.status} \`${reasonOf(answer)}\` — its OWN refusal (spec §12.3), not a provider's`);
  const body = errorBody(answer);
  assert(body !== null && body.error === 'no_grant',
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
step(`2. ONE spawn CONTENT for ${HTTP_IMAGE.reference} with container port ${HTTP_CONTAINER_PORT} published, standby_set [${PRIMARY.service}, ${STANDBY.service}], sent to each member in its own request`);
const tenant = newTenant('m5-tenant');
// The lease's ROOT SECRET: minted here, never sent anywhere, and the only
// thing this tenant holds. Every member's Continuation Token and every Gateway
// Grant below derives from it (spec §6.1.1, §6.5.1).
const rootSecret = newRootSecret();
const workloadId = newWorkloadId();
const content = { ...httpSpawnContent(workloadId, tenant), standby_set: SET.map((P) => P.pubkey) };
const runningBefore = runningWorkloads();
let primaryAccess = null;
let primaryContainer = null;
let primaryHostname = null;
{
  const spawned = await sendTo(PRIMARY, PRIMARY.spawnRoute(L.name, L.version), { request: tokenRequest(rootSecret, 'spawn', content, 300, PRIMARY) });
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
  const inPrimaryRange = PRIMARY.workloadIdRange();
  if (primaryContainer === null || !inPrimaryRange.holds(primaryContainer)) fatal(`no toon-<id> container in ${PRIMARY.service}'s range ${inPrimaryRange.lo}-${inPrimaryRange.hi} publishes ssh_port ${primaryAccess?.ssh_port}`);
  primaryHostname = containerHostname(primaryContainer);
  ok(`the workload runs as ${primaryContainer} in ${PRIMARY.service}'s id range ${inPrimaryRange.lo}-${inPrimaryRange.hi}, serving ${HTTP_CONTAINER_PORT} at ${primaryAccess.host}:${httpPort?.host_port}`);
  // The fact every assertion below rests on: this copy of the image answers
  // with THIS container's name, and the standby's copy will answer with its
  // own. `docker inspect` is read once, here, so that a body read later can be
  // tied to a member without asking the daemon what it is looking at.
  ok(`and reports itself as \`${primaryHostname}\` — the name whoami answers with, so the primary's copy is tellable from any other`);
}
{
  const reserved = await sendTo(STANDBY, STANDBY.standbyRoute(L.name, L.version), { request: tokenRequest(rootSecret, 'standby', content, 300, STANDBY) });
  if (!reserved.fulfilled) fatal(`the standby's spawn was refused short of the app: ${reserved.code} (${reserved.refusedBy}) ${reserved.message ?? ''}`);
  const body = reserved.status === 200 ? reserved.json() : null;
  if (!body) fatal(`${STANDBY.service} answered ${reserved.status}: ${reserved.text().slice(0, 300)}`);
  took(STANDBY, reserved, 'the standby reservation', HUB_STANDBY_PRICE);
  assert(body.workload_id === workloadId && body.role === 'standby' && !('access' in body),
    `the SAME CONTENT on .standby, in its own request under op=standby: role ${body.role}, no access — a Warm Standby holds capacity and runs nothing until a Takeover`);
}

// ── 3. the handover: the tenant's whole side of this milestone ────────────
// A FRESH NAME PER RUN. A readable name is first come, first served across
// every grant still in force on the gateway (spec §12.6), and an earlier run's
// grant outlives its lease, so a fixed name would be the *old* run's and this
// one would be served at the canonical hostname alone.
const NAME = `m5-${randomBytes(4).toString('hex')}`;
step(`3. the tenant SEALS a Gateway Handover to the gateway's own connector — nothing is published — with the name \`${NAME}\``);
const CANONICAL = `${canonicalLabel(workloadId)}.${DOMAIN}`;
const NAMED = `${NAME}.${DOMAIN}`;
// The command a developer runs (README §2), with the root secret in the
// environment and never on the command line. A lease spawned in code has no
// lease file, so the values are flags — which is the script's own by-hand mode.
const handoverArgs = [
  '--workload', workloadId,
  ...SET.flatMap((P) => ['--standby', P.service]),
  '--http-port', String(HTTP_CONTAINER_PORT),
  '--ports', String(HTTP_CONTAINER_PORT),
  '--expires-in', '1h',
  '--name', NAME,
];
console.log(`  TOON_ROOT_SECRET=<the lease's> node scripts/handover.mjs ${handoverArgs.join(' ').replace(workloadId, workloadId.slice(0, 12) + '…')}`);
const handed = runHandover(handoverArgs, { rootSecret });
if (handed.status !== 0 || handed.report === null) {
  fatal(`scripts/handover.mjs exited ${handed.status}: ${(handed.stderr ?? '').trim().split('\n').slice(-6).join('\n')}`);
}
const handover = handed.report.handover;
assert(handed.report.delivered === true,
  `the gateway TOOK the handover: delivered ${handed.report.delivered}${handed.report.failed ? ` (${handed.report.failed})` : ''} — it admitted it by asking the members whether the grant works (spec §12.1)`);
assert(handover?.http_port === HTTP_CONTAINER_PORT && handover?.name === NAME
  && JSON.stringify(handover?.standby_set?.map((m) => m.provider)) === JSON.stringify(SET.map((P) => P.pubkey)),
  `the message names http_port ${handover?.http_port}, the set primary first, name ${handover?.name}, until ${new Date((handover?.expires_at ?? 0) * 1000).toISOString()} — and no gateway: being sealed to that connector is what names one (spec §12.1)`);
{
  // ONE GRANT PER MEMBER, derived under that member's own key — the thing a
  // single shared value would have broken (spec §6.5.1, §7). Re-derived here
  // from the root secret rather than read out of the tool's report, so the
  // sandbox and the tenant tool agreeing is itself the assertion.
  const ours = SET.map((P) => gatewaySubFor(continuationFor(rootSecret, P.pubkey), handover.expires_at));
  const theirs = handover.standby_set.map((m) => m.grant);
  assert(new Set(theirs).size === SET.length && JSON.stringify(theirs) === JSON.stringify(ours),
    `${theirs.length} DIFFERENT grants, one per member, each the gateway_sub of that member's own Continuation Token for ${handover.expires_at} — derived here independently and matching the tool's byte for byte`);
}
assert(handed.report.hostnames?.[0] === CANONICAL && canonicalLabel(workloadId).length === 52 && /^[a-z2-7]{52}$/.test(canonicalLabel(workloadId)),
  `the canonical hostname is ${CANONICAL} — ${canonicalLabel(workloadId).length} characters of lowercase unpadded base32 over the workload id, where its 64 hex characters would not fit a DNS label; derived and never assigned (spec §12.2)`);
{
  // The absence that replaced the read-back Milestone 5 made here. There is no
  // grant event to find, so what is asserted is that the RELAY CARRIES NOTHING
  // NAMING THIS WORKLOAD at all — no tenant-published `workload_id`, which is
  // the join key ADR 0016 removed. `make smoke-m6` makes this over the whole
  // namespace and over every key a tenant of its run held; here it is the one
  // fact this step used to establish, inverted.
  const everything = await relayRead({ limit: 5000 }, 'nothing-published');
  const naming = everything.filter((e) => JSON.stringify(e).includes(workloadId));
  assert(naming.length === 0,
    naming.length === 0
      ? `the relay holds ${everything.length} event(s) and NOT ONE of them names workload ${workloadId.slice(0, 12)}… — the handover went to the gateway's connector as a sealed packet and nowhere else (spec §12.1, ADR 0017)`
      : `${naming.length} event(s) on the relay name this workload: ${naming.map((e) => `kind ${e.kind} by ${e.pubkey.slice(0, 12)}…`).join(', ')}`);
}
ok('and the gateway was told NOTHING else: one sealed packet is the whole ceremony, and the tenant signed nothing to send it (ADR 0016, ADR 0017)');

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
  assert(whoamiHeader(answer.body, 'X-Forwarded-Proto') === 'https',
    `and the workload was told X-Forwarded-Proto: ${whoamiHeader(answer.body, 'X-Forwarded-Proto')} — the scheme the TENANT used, not the gateway's own hop, which was plain HTTP (spec §12.5)`);
}

// ── 5. the Takeover, with no tenant online ────────────────────────────────
step(`5. the primary's container is STOPPED; the standby announces a Takeover within ${TAKEOVER_BUDGET_S}s — the tenant does nothing`);
const inStandbyRange = STANDBY.workloadIdRange();
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
    const fresh = runningWorkloads().filter((n) => !runningBefore.includes(n) && n !== primaryContainer && inStandbyRange.holds(n));
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
ok('the tenant published nothing, signed nothing and was not online for any of it: the one packet it sealed in step 3 is the whole of its part (ADR 0010, ADR 0016, spec §12.7)');

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
step(`8. the tenant terminates both leases; within ${WITHDRAW_BUDGET_S}s both URLs answer 503 with a gateway reason that nothing is running it`);
for (const P of SET) {
  const res = await sendTo(P, P.terminateRoute, { request: tokenRequest(rootSecret, 'terminate', { workload_id: workloadId }, 120, P) });
  if (!res.fulfilled) { bad(`terminate on ${P.service} was refused short of the app: ${res.code} (${res.refusedBy})`); continue; }
  const body = res.status === 200 ? res.json() : null;
  assert(res.status === 200 && body?.workload_id === workloadId && JSON.stringify(body?.state) === JSON.stringify({ ended: 'termination' }),
    `${P.service} answered ${res.status} ${res.text().slice(0, 160)}`);
  took(P, res, `the terminate on ${P.service}`, HUB_FEE);
}
// WHICH of the two reasons is the provider's to decide, not the gateway's, so
// both are a pass and the message says which came back. A provider that still
// knows the lease answers about it and none is running: `no_running_member`.
// One that has forgotten it refuses `unknown_workload`, and a refusal is not an
// answer about the lease — §12.4 step 4 has the gateway count that member with
// the ones it could not reach, which is `member_unreachable`. The sandbox's
// provider does the first; the poll below prefers it and accepts the other.
const NOT_RUNNING = ['no_running_member', 'member_unreachable'];
const refused = [];
for (const hostname of [CANONICAL, NAMED]) {
  const answer = await askUntil(hostname, (a) => a.status === 503 && reasonOf(a) === 'no_running_member', WITHDRAW_BUDGET_S);
  assert(answer.status === 503 && NOT_RUNNING.includes(reasonOf(answer)),
    `http://${hostname}:${GATEWAY_HTTP_PORT}/ -> ${answer.status} \`${reasonOf(answer)}\` — the gateway's own answer, naming the reason in the \`toon-gateway-reason\` header`);
  const body = errorBody(answer);
  assert(body !== null && body.error === reasonOf(answer),
    `in spec §5's error shape, the header and the body agreeing: ${answer.body.slice(0, 200)}`);
  refused.push(reasonOf(answer));
}

// ── 9. the books: the gateway paid nothing ────────────────────────────────
step('9. the books, to the unit: every unit either provider took is one the TENANT paid, so the gateway bought nothing');
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
done(`a tenant spawned an HTTP workload on a two-member Standby Set — one content, one request per member, each bearing that member's own Continuation Token — sealed ONE Gateway Handover to the gateway's connector and stopped there; the gateway admitted it by asking the members, resolved the workload across the set with a free \`status\` presenting the grant it was handed, and served it at ${CANONICAL} and ${NAMED} over HTTP and HTTPS with the tenant's Host preserved. Nothing was published: not one event on the relay names this workload. With the primary stopped, the standby took the workload over and THE SAME TWO URLS came back answered by the copy on the standby — the milestone's promise, with the tenant offline throughout. The restarted primary stood down leaving one copy; terminate left both URLs answering 503 ${[...new Set(refused)].join(' / ')} in the spec's error shape; and neither provider's book grew by a single unit for anything the gateway asked.`);
