// MILESTONE 6 ACCEPTANCE TEST (TOON_Network #56, ticket #63; spec §5, §6.1,
// §6.5, §6.6, §7, §12, ADR 0016, ADR 0017): the whole path a tenant walks —
// pay, spawn, poll, delegate, front, withdraw, terminate — against the real
// sandbox, asserting at each step that the thing this milestone removed is
// REALLY GONE rather than merely unused. Run from sandbox/ on the host after
// `make up-gateway` (or `make up-gateway COMPOSE_PROFILE=payments`);
// `make smoke-m6`.
//
// The milestone in one sentence: **a tenant deploys, reads, delegates and ends
// a lease without signing anything and without publishing anything, so no
// party holds transferable proof that a named tenant asked for any of it.**
// A Continuation Token replaced the tenant's signature on a Lease Request; a
// derived Gateway Grant replaced the published one; and kinds `4432` and
// `30438` are back in the free range.
//
//   0.  the stack is up with the gateway and its own connector, which
//       terminates exactly ONE route and it is FREE (ADR 0013), and the
//       gateway answers a hostname it holds no grant for with its own 503
//   1.  a tenant channel against the hub. THE TENANT MINTS A ROOT SECRET and
//       nothing else: its Nostr key is generated beside its SSH key and used
//       for nothing (spec §3) — step 8 goes looking for it
//   2.  THE LEASE PATH. A paid spawn of `traefik/whoami` carrying the
//       Continuation Token derived for this provider starts a workload;
//       `status` bearing the same token answers `running`
//   3.  THE REFUSALS, all four, each naming its own code (spec §6.1.2): a
//       WRONG token is `not_tenant`; an ABSENT one is `not_tenant` too, so
//       that nothing reads as an unauthenticated success; a REPLAYED
//       `request_id` is `stale_request`; and a request addressed to the other
//       provider is `invalid_request` at this one. The lease is untouched
//       after all four
//   4.  THE RESTART, mid-run: the provider's container is stopped — the
//       workload goes on running on the host daemon, which is the point —
//       and started again, and the SAME token still reads and still ends the
//       lease. A provider that forgot the token would have orphaned a paid
//       workload (spec §6.7)
//   5.  THE GATEWAY PATH, with nothing published: `node scripts/handover.mjs`
//       seals a Gateway Handover to the gateway's connector, the workload is
//       served at its canonical hostname, and a `curl` of that hostname
//       reaches the workload's own body. A DELEGATED `status` — the grant as
//       the request's `continuation`, the moment in `gateway_expires_at` —
//       is answered byte for byte what the tenant is answered; a delegated
//       `terminate` is refused BOTH ways it can be sent (§6.5.1). A Gateway
//       Withdrawal takes the workload off, and the same `curl` answers the
//       gateway's own `no_grant`
//   6.  TERMINATE ends the lease with the token alone, and the workload is
//       gone from the host daemon
//   7.  THE STANDBY SET. A spawn forms a set across the sandbox's two
//       providers: ONE content, one request per member, each naming only
//       that member and bearing only that member's token. Then the
//       regression the per-provider derivation exists to prevent — a request
//       bearing the PRIMARY's token is refused at the STANDBY, on `status`
//       and on `terminate`, and the standby's own token still works there
//   8.  THE ASSERTION THAT CLOSES THE MILESTONE, which no other test can
//       make: the relay is read across the whole namespace and NOT ONE event
//       on it is signed by a key this run's tenants held, no event is of
//       kind `4432` or `30438`, no event names a `workload_id` this run
//       chose, and every author in the namespace is a provider or a
//       publisher. It is swept TWICE — once at step 5, right after the
//       handover, which is where Milestone 5 published, and once here at the
//       end — and the same sweep is first run over a FABRICATED relay that
//       carries each of those things, and required to catch every one, so
//       that a sweep which finds nothing is known to be one that would have
//       found something. A workload id a PROVIDER published is not counted:
//       a Takeover and an Eviction Notice carry it by design, and it is the
//       tenant's side of that join #56 removed
//
// TWO LEASES, ONE AT A TIME, both on the 600 s `warm` tier: the first is the
// lease path and the gateway path and is ended before the second is bought,
// because `warm` has a capacity of 2 on the first provider and this way the
// smoke needs one slot rather than two. Two to three minutes, most of it the
// provider restart and the two image starts.
//
// IT STOPS AND STARTS THE FIRST PROVIDER'S CONTAINER, so nothing else should
// be spawning on it meanwhile — and it shares `.toon-client/channels.json`
// with every other smoke, so do not run two at once.
import {
  HTTP_CONTAINER_PORT, HUB, BUYER_SOL,
  K_PROFILE, K_IMAGE, K_BLOB, K_TEMPLATE, TOON_LABEL,
  providerOf,
  reporter, jstr, nowSec, waitFor,
  relayRead,
  composeNotRunning, composeService, composeHealthy, containerState, findWorkload, workloadGone,
  continuationFor, gatewaySubFor, httpSpawnContent, newRootSecret, newTenant, newWorkloadId,
  openChannel, tokenRequest,
} from './lib/provider-smoke.mjs';
import {
  GATEWAY_EDGE, GATEWAY_HTTP_PORT,
  canonicalLabel, gatewayConnector, gatewayDomain, gatewayGet, gatewayReason, gatewayRefused,
  handoverRoute, runHandover, whoamiHostname,
} from './lib/gateway-smoke.mjs';

const { step, ok, assert, fatal, done } = reporter('MILESTONE 6 SMOKE');
const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;

const PRIMARY = providerOf('provider');
const STANDBY = providerOf('provider2');
const SET = [PRIMARY, STANDBY];
const L = PRIMARY.listing('warm');
if (STANDBY.listing('warm').standby_price === null) {
  fatal(`conf/${STANDBY.confFile}'s \`warm\` sets no standby_price, so nothing sells a standby`);
}
const DOMAIN = gatewayDomain();
// How long a request this smoke mints stays valid. The provider refuses one
// valid for more than 300 s from now (spec §6.1, `MAX_REQUEST_WINDOW_SECS`);
// every request here is answered within seconds of being built, so two minutes
// is slack rather than a deadline anything races.
const REQUEST_TTL_S = 120;

// The kinds Milestone 6 REMOVED. Named here and nowhere else in the sandbox,
// because the only thing left to do with them is to assert their absence: a
// Lease Request is a plain JSON object now and a Gateway Grant is a derived
// value, so a relay carrying either number is carrying something this
// protocol no longer has (spec §3.1, ADR 0016, ADR 0017).
const K_REMOVED = { 4432: 'the signed Lease Request', 30438: 'the published Gateway Grant' };
// The kinds a PUBLISHER signs (spec §8), from the one place the sandbox
// mirrors the provider's kinds.rs. An author in the namespace is a PROVIDER if
// it published a Provider Profile (`K_PROFILE`, spec §4.1) and a publisher if
// everything it signed is one of these; anything else is an author this
// milestone cannot account for.
const PUBLISHER_KINDS = new Set([K_IMAGE, K_BLOB, K_TEMPLATE]);

// ── what a run leaves behind, and who could have left it ──────────────────
// The needles for step 8, filled in as the run goes: every Nostr key a tenant
// of this run held, and every workload id it chose. Both are values a relay
// observer would have to see in order to attribute anything, and the whole of
// what this milestone buys is that it sees neither.
const tenantKeys = [];
const workloadIds = [];

/**
 * What a relay is carrying that a TENANT could be behind — the pure function
 * steps 5 and 8 assert on, kept pure so that it can be run over a FABRICATED
 * relay first and SHOWN to catch what it is looking for.
 *
 * Four findings, each its own reason to fail the build:
 *  - `signedByTenant`: an event whose author is a key a tenant of this run
 *    held. After ADR 0016 the tenant's Nostr key is not on the request path at
 *    all, so a regression that put a signature back would sign with exactly
 *    this key and land here;
 *  - `removedKind`: an event of kind `4432` or `30438`, anywhere on the relay;
 *  - `namedByNonProvider`: an event carrying one of this run's workload ids
 *    ANYWHERE in it — tag, content, or a field nobody thought of — whose
 *    author is not a provider. **Not every event naming a workload id is a
 *    leak**: a Takeover (kind `30433`, `d` = the workload id, §7.1) and an
 *    Eviction Notice (kind `4433`, §6.7) are provider-signed and required to
 *    carry it, and #56 leaves them explicitly in place. What ADR 0016 removed
 *    is the TENANT's side of that join, which is what this counts;
 *  - `unaccountedAuthor`: an author in the toon.network namespace that is
 *    neither a provider (it published a Provider Profile) nor a publisher
 *    (everything it signed is one of §8's kinds).
 *
 * WHAT IT CANNOT CATCH, said plainly rather than discovered later: an event
 * signed by some key this run never held, carrying no workload id of this run,
 * outside the namespace. Such an event names nothing of this tenant's and
 * carries no join key, which is why the three nets above are the ones drawn —
 * the claim is about attribution, not about what else a relay may hold.
 *
 * `namedByNonProvider` is the net that does not depend on knowing the tenant's
 * key, and it is the one that closes the gap the others leave: it is computed
 * over EVERY event the relay holds, labelled or not, of any kind.
 *
 * @param {{ all: object[], labelled: object[] }} relay every event the relay holds, and the namespace
 * @param {{ tenantKeys: string[], workloadIds: string[] }} needles
 */
function tenantTraces({ all, labelled }, { tenantKeys: keys, workloadIds: ids }) {
  const kindsByAuthor = new Map();
  for (const e of labelled) {
    if (!kindsByAuthor.has(e.pubkey)) kindsByAuthor.set(e.pubkey, new Set());
    kindsByAuthor.get(e.pubkey).add(e.kind);
  }
  const roleOf = (kinds) => {
    if (kinds.has(K_PROFILE)) return 'provider';
    if ([...kinds].every((k) => PUBLISHER_KINDS.has(k))) return 'publisher';
    return null;
  };
  const authors = [...kindsByAuthor].map(([pubkey, kinds]) => ({ pubkey, kinds: [...kinds].sort((a, b) => a - b), role: roleOf(kinds) }));
  const providers = new Set(authors.filter((a) => a.role === 'provider').map((a) => a.pubkey));
  const naming = all.filter((e) => ids.some((id) => JSON.stringify(e).includes(id)));
  return {
    signedByTenant: all.filter((e) => keys.includes(e.pubkey)),
    removedKind: all.filter((e) => e.kind in K_REMOVED),
    naming,
    namedByNonProvider: naming.filter((e) => !providers.has(e.pubkey)),
    authors,
    unaccountedAuthor: authors.filter((a) => a.role === null),
  };
}
const clean = (t) => t.signedByTenant.length === 0 && t.removedKind.length === 0
  && t.namedByNonProvider.length === 0 && t.unaccountedAuthor.length === 0;

/** Every event the relay holds, and the toon.network namespace within it. */
const readRelay = async (label) => ({
  all: await relayRead({ limit: 5000 }, `${label}-all`),
  labelled: await relayRead({ '#L': [TOON_LABEL], limit: 5000 }, `${label}-namespace`),
});

// ── 0. the stack, and a gateway that sells nothing ────────────────────────
step('0. the stack is up with the `gateway` profile; the gateway terminates one FREE route and serves nothing it holds no grant for');
{
  const missing = composeNotRunning(['provider', 'provider-connector', 'directory-publisher', 'provider2', 'provider2-connector', 'directory-publisher2', 'relay', 'relay-connector', 'workload-gateway', 'workload-gateway-connector']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-gateway\` first`);
  ok('both providers, both connectors, both directory publishers, the relay, the gateway and its connector are up');
}
if (!(await composeHealthy('workload-gateway', 60))) fatal('workload-gateway never reported healthy — its own healthcheck is the `no_grant` 503 below');
{
  const { ilpAddresses, routes, priced } = await gatewayConnector()
    .catch((e) => fatal(`the gateway's connector at ${GATEWAY_EDGE}: ${e.message}`));
  assert(routes.length === 1 && priced.length === 0 && routes[0].prefix === handoverRoute(),
    `${GATEWAY_EDGE} is ${ilpAddresses.join(', ')} and terminates ${routes.length} route(s), ${priced.length} of them priced: ${routes.map((r) => `${r.prefix}@${r.price}`).join(', ')} — the handover door conf/connector-workload-gateway.toml names, free, and nothing to sell (ADR 0013, Appendix A)`);
}
{
  const answer = await gatewayGet('127.0.0.1');
  assert(gatewayRefused(answer, 'no_grant'),
    `a hostname it holds no grant for is answered ${answer.status} \`${gatewayReason(answer)}\` by the GATEWAY ITSELF, header and body agreeing in spec §5's error shape (§12.3)`);
}

// ── 1. the tenant: a secret, not a key ────────────────────────────────────
step('1. a tenant channel against the hub. The tenant mints a ROOT SECRET; its Nostr key is minted beside its SSH key and used for nothing');
const { client, opened } = await openChannel(HUB, 'channels.json');
assert(client.identity?.solanaPublicKey === BUYER_SOL, `the tenant pays as ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded`);
ok(`channel ${opened.channelId} against the hub (status ${opened.status ?? 'open'})`);
const sendTo = (P, route, body) => client.send(route, { body }, { sealTo: P.edge, timeoutMs: 300_000 });
/** How a refusal came back: `{ code, message }` from the app's own error body, or nulls. */
const refusal = (sent) => {
  if (!sent.fulfilled) return { code: null, message: `refused short of the app: ${sent.code} (${sent.refusedBy})` };
  try {
    const body = JSON.parse(sent.text());
    return { code: body.error ?? null, message: body.message ?? '' };
  } catch {
    return { code: null, message: sent.text().slice(0, 200) };
  }
};

const tenant = newTenant('m6-tenant');
tenantKeys.push(tenant.pubkey);
// ONE ROOT SECRET PER LEASE (spec §6.1.1). It never leaves this process; every
// token and every grant below derives from it, and losing it would leave a
// paid workload nobody could read, extend or stop.
const leaseSecret = newRootSecret();
ok(`root secret minted (32 bytes, held here); the token for ${PRIMARY.service} is ${continuationFor(leaseSecret, PRIMARY.pubkey).slice(0, 12)}… — derived under ITS key, so no other provider's token is this one`);
ok(`the tenant's unused Nostr key is ${tenant.pubkey.slice(0, 16)}… — step 8 sweeps the relay for it`);

// ── 2. the lease path: a paid spawn, then status with the token ───────────
step(`2. a PAID ${PRIMARY.spawnRoute(L.name, L.version)} bearing the Continuation Token: a running workload`);
const workloadId = newWorkloadId();
workloadIds.push(workloadId);
const content = httpSpawnContent(workloadId, tenant);
let access = null;
let container = null;
{
  const request = tokenRequest(leaseSecret, 'spawn', content, REQUEST_TTL_S, PRIMARY);
  assert(Object.keys(request).sort().join() === 'content,continuation,expiration,op,provider,request_id'
    && request.provider === PRIMARY.pubkey && request.continuation === continuationFor(leaseSecret, PRIMARY.pubkey),
    `the request is spec §6.1's six keys and nothing else — ${Object.keys(request).sort().join(', ')} — naming ONE provider and bearing this lease's token. No kind, no tags, no signature`);
  const spawned = await sendTo(PRIMARY, PRIMARY.spawnRoute(L.name, L.version), { request });
  if (!spawned.fulfilled) fatal(`the spawn was refused short of the app: ${spawned.code} (${spawned.refusedBy}) ${spawned.message ?? ''}`);
  const body = spawned.status === 200 ? spawned.json() : null;
  if (!body) fatal(`${PRIMARY.service} answered ${spawned.status}: ${spawned.text().slice(0, 300)} — a \`no_capacity\` here is an earlier run's \`warm\` lease still alive (capacity ${L.capacity})`);
  assert(body.workload_id === workloadId && body.role === 'standalone', `workload ${workloadId.slice(0, 12)}…, role ${body.role}, until ${new Date(body.expires_at * 1000).toISOString()}`);
  access = body.access;
  const httpPort = access?.ports?.find((p) => p.container_port === HTTP_CONTAINER_PORT);
  assert(httpPort !== undefined, `access.ports carries the HTTP port: ${jstr(access?.ports ?? [])} — the pair a handover's \`http_port\` picks out (spec §12.1)`);
  const workload = access ? await findWorkload(access.ssh_port, 30) : null;
  container = workload?.name ?? null;
  if (container === null) fatal(`no toon-<id> container publishes ssh_port ${access?.ssh_port} within 30s`);
  ok(`${container} is RUNNING on the host daemon, serving ${HTTP_CONTAINER_PORT} at ${access.host}:${httpPort.host_port} (${elapsed()})`);
}
/** `status` on one provider, however the request is built. Returns the sent packet. */
const statusWith = (P, request) => sendTo(P, P.statusRoute, { request });
/**
 * A Lease Request about THE FIRST LEASE: its own token derived for `P`, the
 * workload id it is always about, and whatever `extra` content the op adds
 * (`gateway_expires_at`, and nothing else in this spec). One builder rather
 * than the same five arguments written out at every call, the way
 * scripts/smoke-milestone3.mjs has `spawnRequestFor`.
 */
const requestFor = (op, P = PRIMARY, extra = {}) =>
  tokenRequest(leaseSecret, op, { workload_id: workloadId, ...extra }, REQUEST_TTL_S, P);
{
  const status = await statusWith(PRIMARY, requestFor('status'));
  const body = status.fulfilled && status.status === 200 ? status.json() : null;
  assert(body?.state === 'running' && JSON.stringify(body.access) === JSON.stringify(access),
    `\`status\` bearing the same token: state ${jstr(body?.state)}, the same access block — the token is sufficient authority and the provider was told nothing else about the tenant`);
}

// ── 3. the four refusals ──────────────────────────────────────────────────
step('3. a wrong token, an absent token, a replay and a request addressed elsewhere — each refused, each with its own code');
{
  // A WRONG token: another lease's root secret, correctly derived for this
  // provider. Nothing about the request is malformed; it simply is not this
  // lease's token, and that is all `not_tenant` is about (spec §6.1.2 step 4).
  const stranger = newRootSecret();
  const sent = await statusWith(PRIMARY, tokenRequest(stranger, 'status', { workload_id: workloadId }, REQUEST_TTL_S, PRIMARY));
  const { code, message } = refusal(sent);
  assert(code === 'not_tenant', `another lease's token is refused \`${code}\`: ${message}`);
  assert(!message.includes(continuationFor(leaseSecret, PRIMARY.pubkey)) && !message.includes(continuationFor(stranger, PRIMARY.pubkey)),
    'and the refusal quotes NO token back — neither the one stored nor the one presented (spec §6.1.1: not to a log, a metric or an error message)');
}
{
  // An ABSENT token. A request that presents nothing asserts no authority,
  // which is exactly what a wrong one does, so the two are one answer on
  // purpose: telling them apart would leave a prober knowing which half of
  // its guess was wrong, and an absent token must never read as a success.
  const request = requestFor('status');
  delete request.continuation;
  const sent = await statusWith(PRIMARY, request);
  const { code, message } = refusal(sent);
  assert(code === 'not_tenant', `a request with NO \`continuation\` at all is refused \`${code}\` — the same answer as a wrong one, never an unauthenticated success: ${message}`);
}
{
  // A REPLAY. The replay set keys on `request_id` exactly as it once keyed on
  // an event id (spec §6.1), so the same bytes a second time are refused
  // whatever they say — a captured `terminate` cannot end a later lease.
  const request = requestFor('status');
  const first = await statusWith(PRIMARY, request);
  assert(first.fulfilled && first.status === 200, `a fresh request_id ${request.request_id.slice(0, 12)}… is answered ${first.status}`);
  const again = await statusWith(PRIMARY, request);
  const { code, message } = refusal(again);
  assert(code === 'stale_request', `the SAME request sent again is refused \`${code}\`: ${message}`);
}
{
  // ADDRESSED ELSEWHERE. `provider` is exactly one key on every op, and a
  // provider refuses a request naming another — which is what makes a Standby
  // Set's one-request-per-member rule enforceable at all (spec §6.1, §7).
  const request = requestFor('status', STANDBY);
  const sent = await statusWith(PRIMARY, request);
  const { code, message } = refusal(sent);
  assert(code === 'invalid_request', `a request naming ${STANDBY.service} is refused \`${code}\` at ${PRIMARY.service}: ${message}`);
}
{
  const status = await statusWith(PRIMARY, requestFor('status'));
  const body = status.fulfilled && status.status === 200 ? status.json() : null;
  assert(body?.state === 'running' && containerState(container) === 'running',
    `and the lease is untouched by all four: ${jstr(body?.state)}, ${container} still ${containerState(container)}`);
}

// ── 4. the restart, mid-run ───────────────────────────────────────────────
step(`4. ${PRIMARY.service} is STOPPED and STARTED mid-run; the workload keeps running and the SAME token still reads the lease`);
{
  composeService('stop', PRIMARY.service);
  assert(containerState(container) === 'running',
    `with ${PRIMARY.service} stopped, ${container} is still ${containerState(container)} on the host daemon — a workload outlives the process that started it`);
  composeService('start', PRIMARY.service);
  assert(await composeHealthy(PRIMARY.service, 120), `${PRIMARY.service} is healthy again (${elapsed()})`);
  // The token was persisted with the lease, or this is `unknown_workload`.
  const status = await waitFor(async () => {
    const sent = await statusWith(PRIMARY, requestFor('status'));
    return sent.fulfilled && sent.status === 200 ? sent : null;
  }, 60, 2000);
  const body = status ? status.json() : null;
  assert(body?.state === 'running' && body.workload_id === workloadId && JSON.stringify(body.access) === JSON.stringify(access),
    body ? `after the restart the same token still answers: state ${jstr(body.state)}, the same access block — the lease and its Continuation Token were persisted (spec §6.7)`
      : 'the restarted provider never answered `status` with the lease\'s own token within 60s — a restart that forgot the token orphans a paid workload');
  assert(containerState(container) === 'running', `and ${container} was never touched: still ${containerState(container)}`);
}

// ── 5. the gateway path, with nothing published ───────────────────────────
const CANONICAL = `${canonicalLabel(workloadId)}.${DOMAIN}`;
step(`5. a Gateway Handover SEALED to the gateway's connector puts the workload on ${CANONICAL}`);
const handoverArgs = [
  '--workload', workloadId,
  '--standby', PRIMARY.service,
  '--http-port', String(HTTP_CONTAINER_PORT),
  '--ports', String(HTTP_CONTAINER_PORT),
  '--expires-in', '1h',
];
/**
 * `scripts/handover.mjs` with this lease's root secret, its command line
 * echoed, and its report — or the run stops here. A script that could not even
 * derive a message prints no JSON, and there is nothing to assert about that
 * except the stderr it did print.
 */
function handoverTool(args) {
  console.log(`  TOON_ROOT_SECRET=<the lease's> node scripts/handover.mjs ${args.join(' ').replace(workloadId, `${workloadId.slice(0, 12)}…`)}`);
  const ran = runHandover(args, { rootSecret: leaseSecret });
  if (ran.status !== 0 || ran.report === null) {
    fatal(`scripts/handover.mjs exited ${ran.status}: ${(ran.stderr ?? '').trim().split('\n').slice(-6).join('\n')}`);
  }
  return ran.report;
}
const handed = handoverTool(handoverArgs);
const handover = handed.handover;
const GRANT = gatewaySubFor(continuationFor(leaseSecret, PRIMARY.pubkey), handover.expires_at);
assert(handed.delivered === true && handed.hostnames?.[0] === CANONICAL,
  `the gateway TOOK it (delivered ${handed.delivered}${handed.failed ? `: ${handed.failed}` : ''}) and the workload is at ${handed.hostnames?.[0]} — admitted by ASKING the member whether the grant works, because being sent something is proof only the lease's holder could have derived it (spec §12.1, ADR 0017)`);
assert(handover.standby_set.length === 1 && handover.standby_set[0].grant === GRANT && handover.standby_set[0].provider === PRIMARY.pubkey,
  `the grant it carries is the \`gateway_sub\` of this member's own Continuation Token for ${handover.expires_at} — re-derived here independently and matching byte for byte (spec §6.5.1)`);
assert(!('gateway' in handover) && !('tenant' in handover),
  `and the message names NO gateway and NO tenant: ${Object.keys(handover).sort().join(', ')} — being sealed to that connector is what chooses a gateway, and there is no tenant to name (ADR 0017)`);
{
  // The `curl` of README §2, from code. The admission round already asked the
  // member and kept where the workload was running, so this is normally a 200
  // first time; a 503 `not_resolved` means asking again.
  const answer = await waitFor(async () => {
    const a = await gatewayGet(CANONICAL).catch((e) => ({ status: 0, headers: {}, body: String(e.message) }));
    return a.status === 200 ? a : null;
  }, 90, 1500) ?? await gatewayGet(CANONICAL);
  assert(answer.status === 200 && whoamiHostname(answer.body) !== null,
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${answer.status}, answered by the WORKLOAD itself (\`${whoamiHostname(answer.body)}\`, the container docker gave it) and not by the gateway (${elapsed()})`);
}
{
  // THE FIRST SWEEP, here rather than only at the end, because THIS is the
  // moment Milestone 5 published: the tenant has just chosen a gateway, which
  // was a signed kind `30438` carrying the workload id until this milestone.
  // Step 8's sweep at the end would find a replaceable event that had since
  // been replaced; this one catches it where it would have been made.
  const traces = tenantTraces(await readRelay('after-handover'), { tenantKeys, workloadIds });
  const swept = clean(traces);
  assert(swept,
    swept
      ? 'and the relay is unchanged by any of it: nothing signed by this tenant, no removed kind, nothing naming the workload that a provider did not sign — choosing a gateway published NOTHING, where until this milestone it published a signed Gateway Grant carrying the workload id (ADR 0017)'
      : `choosing a gateway left something on the relay: ${jstr({ signedByTenant: traces.signedByTenant.length, removedKind: traces.removedKind.length, namedByNonProvider: traces.namedByNonProvider.length, unaccountedAuthor: traces.unaccountedAuthor.length })}`);
}

step('5b. a DELEGATED `status` is answered exactly what the tenant is answered; a delegated `terminate` is refused both ways it can be sent');
{
  // The grant rides where the lease's own token rides, and the moment it was
  // derived for is named in the content. §6.5.1: a match here is READ
  // authority, and the answer is byte for byte what the token would have got.
  const mine = await statusWith(PRIMARY, requestFor('status'));
  const delegated = await statusWith(PRIMARY, {
    ...requestFor('status', PRIMARY, { gateway_expires_at: handover.expires_at }),
    continuation: GRANT,
  });
  const theirs = delegated.fulfilled && delegated.status === 200 ? delegated.text() : null;
  assert(theirs !== null && theirs === (mine.fulfilled && mine.status === 200 ? mine.text() : '<the tenant was refused>'),
    theirs === null ? `the delegated status was refused: ${jstr(refusal(delegated))}`
      : 'the delegated `status` is answered BYTE FOR BYTE what the tenant is answered — a grant delegates reading this lease and changes nothing about what reading it says (spec §6.5.1)');
  const past = nowSec() - 60;
  const expired = await statusWith(PRIMARY, {
    ...requestFor('status', PRIMARY, { gateway_expires_at: past }),
    continuation: gatewaySubFor(continuationFor(leaseSecret, PRIMARY.pubkey), past),
  });
  const stale = refusal(expired);
  assert(stale.code === 'bad_grant',
    `a well-formed grant derived for a moment that has passed is refused \`${stale.code}\` — the delegation asserted decides the code, not the defect (spec §5, §6.5.1): ${stale.message}`);
}
{
  // TWO WAYS, and the SHAPE is what refuses the first: `terminate` content is
  // `{ workload_id }` and no other key, so a gateway asserting its grant there
  // is refused for a field the route does not name; one that asserts nothing
  // is a stranger presenting a value that is not the lease's token (§6.6).
  const asserting = await sendTo(PRIMARY, PRIMARY.terminateRoute, {
    request: { ...requestFor('terminate', PRIMARY, { gateway_expires_at: handover.expires_at }), continuation: GRANT },
  });
  const named = refusal(asserting);
  assert(named.code === 'invalid_request',
    `a \`terminate\` carrying \`gateway_expires_at\` is \`${named.code}\`: the route names no such field, so the SHAPE refuses it before any authority is weighed`);
  const silent = await sendTo(PRIMARY, PRIMARY.terminateRoute, {
    request: { ...requestFor('terminate'), continuation: GRANT },
  });
  const unnamed = refusal(silent);
  assert(unnamed.code === 'not_tenant',
    `and one that asserts nothing presents a value that is not the lease's token: \`${unnamed.code}\`, exactly as any other stranger's is`);
  assert(containerState(container) === 'running', `${container} is still ${containerState(container)}: a read delegation stayed a read delegation`);
}
step('5c. a Gateway Withdrawal takes the workload off, and the same `curl` answers the gateway\'s own error');
{
  const withdrawn = handoverTool(['--withdraw', '--workload', workloadId, '--standby', PRIMARY.service, '--expires-at', String(handover.expires_at)]);
  assert(withdrawn.delivered === true && withdrawn.withdrawal?.standby_set?.[0]?.grant === GRANT,
    `the withdrawal BORE the grant in force — which is what makes it safe with no signature, since only the lease's holder can derive one (spec §12.7) — and the gateway acted on it`);
  const answer = await gatewayGet(CANONICAL);
  assert(gatewayRefused(answer, 'no_grant'),
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${answer.status} \`${gatewayReason(answer)}\` — the GATEWAY'S OWN error where the workload was a moment ago, in spec §5's shape`);
  assert(containerState(container) === 'running',
    `and the lease runs on, untouched: ${container} is ${containerState(container)}. A withdrawal ends SERVING, not reading — the gateway still holds a working grant until ${new Date(handover.expires_at * 1000).toISOString()}`);
}

// ── 6. terminate, with the token alone ────────────────────────────────────
step('6. `terminate` bearing the lease\'s own token ends it, and the workload is gone from the host daemon');
{
  const ended = await sendTo(PRIMARY, PRIMARY.terminateRoute, { request: requestFor('terminate') });
  const body = ended.fulfilled && ended.status === 200 ? ended.json() : null;
  assert(jstr(body?.state) === jstr({ ended: 'termination' }) && body?.workload_id === workloadId,
    `the provider answered ${ended.fulfilled ? ended.status : jstr(refusal(ended))} ${jstr(body?.state)} — the token was sufficient authority for the whole control plane, and no key signed any of it`);
  assert(await workloadGone(container, 30), `${container} is gone from the host daemon`);
}

// ── 7. the Standby Set: a token per member ────────────────────────────────
step(`7. a spawn forms a Standby Set across ${PRIMARY.service} and ${STANDBY.service}: one content, one request per member, one token per member`);
const setSecret = newRootSecret();
const setWorkloadId = newWorkloadId();
workloadIds.push(setWorkloadId);
const setContent = { ...httpSpawnContent(setWorkloadId, tenant), standby_set: SET.map((P) => P.pubkey) };
let setContainer = null;
/** `requestFor`'s sibling for the SET's lease: its own root secret, its own workload id. */
const setRequestFor = (op, P, extra = {}) =>
  tokenRequest(setSecret, op, { workload_id: setWorkloadId, ...extra }, REQUEST_TTL_S, P);
{
  const tokens = SET.map((P) => continuationFor(setSecret, P.pubkey));
  assert(new Set(tokens).size === SET.length,
    `the two members are addressed with two DIFFERENT tokens (${tokens.map((t) => `${t.slice(0, 8)}…`).join(', ')}) — \`continuation(provider)\` derives under each member's own key, so a shared secret is not even expressible (spec §6.1.1)`);
  const spawned = await sendTo(PRIMARY, PRIMARY.spawnRoute(L.name, L.version), { request: tokenRequest(setSecret, 'spawn', setContent, REQUEST_TTL_S, PRIMARY) });
  const body = spawned.fulfilled && spawned.status === 200 ? spawned.json() : null;
  if (!body) fatal(`the primary's spawn: ${spawned.fulfilled ? `${spawned.status} ${spawned.text().slice(0, 200)}` : jstr(refusal(spawned))}`);
  assert(body.workload_id === setWorkloadId && body.role === 'primary' && body.access !== undefined, `${PRIMARY.service} answers role ${body.role} WITH access`);
  setContainer = (await findWorkload(body.access.ssh_port, 30))?.name ?? null;
  const reserved = await sendTo(STANDBY, STANDBY.standbyRoute(L.name, L.version), { request: tokenRequest(setSecret, 'standby', setContent, REQUEST_TTL_S, STANDBY) });
  const rbody = reserved.fulfilled && reserved.status === 200 ? reserved.json() : null;
  if (!rbody) fatal(`the standby's reservation: ${reserved.fulfilled ? `${reserved.status} ${reserved.text().slice(0, 200)}` : jstr(refusal(reserved))}`);
  assert(rbody.workload_id === setWorkloadId && rbody.role === 'standby' && !('access' in rbody),
    `${STANDBY.service} answers role ${rbody.role} with NO access, from the SAME content under op=standby in a request naming only itself (${elapsed()})`);
}
step('7b. THE REGRESSION per-provider derivation exists to prevent: a request bearing the PRIMARY\'s token is refused at the STANDBY');
{
  // The primary's token, correctly derived, in a request correctly addressed
  // to the standby. Everything about it is well formed; it simply is not the
  // token the standby's lease was taken with, which is the whole point of
  // deriving per provider (spec §6.1.1, §7).
  const asPrimary = { ...setRequestFor('status', STANDBY), continuation: continuationFor(setSecret, PRIMARY.pubkey) };
  const refusedStatus = refusal(await statusWith(STANDBY, asPrimary));
  assert(refusedStatus.code === 'not_tenant',
    `\`status\` at ${STANDBY.service} bearing ${PRIMARY.service}'s token: \`${refusedStatus.code}\` — one member of a set cannot READ another member's lease`);
  const refusedTerminate = refusal(await sendTo(STANDBY, STANDBY.terminateRoute, {
    request: { ...setRequestFor('terminate', STANDBY), continuation: continuationFor(setSecret, PRIMARY.pubkey) },
  }));
  assert(refusedTerminate.code === 'not_tenant',
    `and \`terminate\` the same way: \`${refusedTerminate.code}\` — nor END one, which is the failure a single shared secret would have been`);
  const mine = await statusWith(STANDBY, setRequestFor('status', STANDBY));
  const body = mine.fulfilled && mine.status === 200 ? mine.json() : null;
  assert(body?.state === 'reserved' && body.role === 'standby',
    `while the standby's OWN token reads it perfectly: state ${jstr(body?.state)}, role ${body?.role} — so the two refusals above are about the token and not about the standby`);
  const reverse = refusal(await statusWith(PRIMARY, { ...setRequestFor('status', PRIMARY), continuation: continuationFor(setSecret, STANDBY.pubkey) }));
  assert(reverse.code === 'not_tenant', `and it is symmetric: ${STANDBY.service}'s token at ${PRIMARY.service} is \`${reverse.code}\``);
}
{
  for (const P of SET) {
    const ended = await sendTo(P, P.terminateRoute, { request: setRequestFor('terminate', P) });
    const body = ended.fulfilled && ended.status === 200 ? ended.json() : null;
    assert(jstr(body?.state) === jstr({ ended: 'termination' }), `${P.service}: each member ended with ITS OWN token — ${jstr(body?.state ?? refusal(ended))}`);
  }
  if (setContainer) assert(await workloadGone(setContainer, 30), `${setContainer} is gone from the host daemon`);
}

// ── 8. the assertion that closes the milestone ────────────────────────────
step('8. the relay, swept across the whole namespace: nothing a tenant could have made is on it');
{
  // FIRST, PROVE THE SWEEP CATCHES SOMETHING. A sweep that finds nothing is
  // worth exactly what its ability to find something is worth, and the only
  // honest way to show that here is to run the same function over a relay that
  // HAS what this milestone removed — fabricated, never sent anywhere, because
  // publishing one would poison this relay for every later run and there is no
  // un-publishing.
  //
  // FOUR EVENTS, one per net, and the third is the one that matters most: a
  // tenant-signed publication of a kind this milestone never named, carrying
  // NO toon.network label — so it is in no namespace listing, is of no removed
  // kind, and would escape every net but the workload id it carries. Kind
  // 30437 is not chosen at random: spec §3.1.2 reserves Deployment, which is
  // tenant-signed and publishes the whole statement, and #56 leaves it out of
  // scope precisely as the thing a tenant tool must not emit by default.
  // Fourth is the case that must NOT fire: a Takeover is provider-signed and
  // §7.1 REQUIRES it to carry the workload id, so counting it as a leak would
  // fail this build on an event the protocol demands.
  const provider = PRIMARY.pubkey;
  const stranger = 'f'.repeat(64);
  const labelled = [
    { kind: K_PROFILE, pubkey: provider, tags: [['L', TOON_LABEL]], content: '{}' },
    { kind: 30438, pubkey: stranger, tags: [['L', TOON_LABEL]], content: '{}' },
  ];
  const forged = {
    all: [
      ...labelled,
      { kind: 4432, pubkey: tenantKeys[0], tags: [['op', 'spawn']], content: JSON.stringify({ workload_id: workloadIds[0] }) },
      { kind: 30437, pubkey: stranger, tags: [['d', workloadIds[0]]], content: '{}' },
      { kind: 30433, pubkey: provider, tags: [['d', workloadIds[0]], ['L', TOON_LABEL]], content: '{}' },
    ],
    labelled,
  };
  const caught = tenantTraces(forged, { tenantKeys, workloadIds });
  assert(!clean(caught) && caught.signedByTenant.length === 1 && caught.removedKind.length === 2
    && caught.namedByNonProvider.length === 2 && caught.naming.length === 3 && caught.unaccountedAuthor.length === 1,
    `the sweep run over a FABRICATED relay finds every one: ${caught.signedByTenant.length} signed by a tenant of this run, ${caught.removedKind.length} of a removed kind, ${caught.namedByNonProvider.length} of the ${caught.naming.length} events naming a workload id signed by somebody who is not a provider — an UNLABELLED kind 30437 among them, which no other net would see — and ${caught.unaccountedAuthor.length} author accounted for by nothing. The provider-signed Takeover naming the same id is correctly NOT counted (spec §7.1)`);
}
{
  const relay = await readRelay('closing');
  const traces = tenantTraces(relay, { tenantKeys, workloadIds });
  // A sweep over an empty relay would pass vacuously, so what it FOUND is
  // asserted first: the providers' own directory events, which have to be
  // there for any of the rest to mean anything.
  const providers = traces.authors.filter((a) => a.role === 'provider');
  assert(relay.all.length > 0 && relay.labelled.length > 0 && providers.length >= 2,
    `the relay holds ${relay.all.length} event(s), ${relay.labelled.length} of them in the toon.network namespace, from ${traces.authors.length} author(s) — ${providers.length} providers and ${traces.authors.length - providers.length} publisher(s). There is something here to sweep`);
  assert(traces.signedByTenant.length === 0,
    traces.signedByTenant.length === 0
      ? `NOT ONE event is signed by a key a tenant of this run held (${tenantKeys.map((k) => `${k.slice(0, 12)}…`).join(', ')}) — the tenant's Nostr key never entered the request path (ADR 0016)`
      : `${traces.signedByTenant.length} event(s) signed by this run's tenant: ${traces.signedByTenant.map((e) => `kind ${e.kind}`).join(', ')}`);
  assert(traces.removedKind.length === 0,
    traces.removedKind.length === 0
      ? `no event of kind ${Object.entries(K_REMOVED).map(([k, what]) => `${k} (${what})`).join(' or ')} — both numbers are back in the free range`
      : `${traces.removedKind.length} event(s) of a kind this milestone removed: ${traces.removedKind.map((e) => e.kind).join(', ')}`);
  assert(traces.namedByNonProvider.length === 0,
    traces.namedByNonProvider.length === 0
      ? `no event anywhere on the relay — labelled or not, of any kind — names ${workloadIds.length === 1 ? 'the workload id' : 'either workload id'} this run chose (${workloadIds.map((id) => `${id.slice(0, 12)}…`).join(', ')}) except ones a provider signed, of which there are ${traces.naming.length}. The TENANT's side of the join across independently signed events is gone (ADR 0016); a provider's Takeover and Eviction Notice still carry it, and #56 leaves them there`
      : `${traces.namedByNonProvider.length} event(s) name a workload id of this run and no provider signed them: ${traces.namedByNonProvider.map((e) => `kind ${e.kind} by ${e.pubkey.slice(0, 12)}…`).join(', ')}`);
  assert(traces.unaccountedAuthor.length === 0,
    traces.unaccountedAuthor.length === 0
      ? `and every author in the namespace is accounted for: ${traces.authors.map((a) => `${a.pubkey.slice(0, 8)}… ${a.role} (kinds ${a.kinds.join(',')})`).join('; ')}`
      : `${traces.unaccountedAuthor.length} author(s) are neither a provider nor a publisher: ${traces.unaccountedAuthor.map((a) => `${a.pubkey.slice(0, 12)}… kinds ${a.kinds.join(',')}`).join('; ')}`);
}

console.log(`\n  total run time ${Math.round((Date.now() - startedAt) / 1000)}s`);
done(`a tenant paid for a workload, read it, delegated reading it to a Workload Gateway, had it served at ${CANONICAL}, took it off again and ended the lease — and signed nothing at any point. A wrong token, an absent token, a replayed request and a request addressed to the other provider were each refused with their own code and left the lease untouched; the provider was stopped and started mid-run and the same token still read and still ended a workload that never stopped running. A Standby Set formed across both providers with a different token at each member, and the primary's token was refused \`not_tenant\` at the standby on \`status\` and on \`terminate\` alike. And the relay, read across the whole namespace, carries not one event signed by a key this run's tenants held, not one of kind 4432 or 30438, and not one naming either workload id that a provider did not sign — swept once where Milestone 5 published and once at the end, with the same sweep first shown, on a fabricated relay, to catch each of those and to leave a provider's Takeover alone.`);
