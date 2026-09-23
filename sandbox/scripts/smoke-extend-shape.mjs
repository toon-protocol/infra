// What a malformed extension costs, measured on the connector's own book
// (TOON_Network#115, spec §5 and §6.3, ADR 0003, ADR 0025). Run from sandbox/
// on the host after `make up-payments`; `make smoke-extend-shape`.
//
// `.extend` takes its content BARE — `{ "workload_id": "…" }` — while
// `.spawn`, `.standby`, `.status`, `.terminate` and `.rotate` take the §6.1
// Lease Request envelope, `{ "request": { … } }`. An extension presents no
// Continuation Token because paying the route is its whole authority, and the
// envelope is that token's carriage (ADR 0005, ADR 0025). So the two shapes
// are not interchangeable, and the connector collects the route's price before
// the provider app reads a byte: the wrong shape is `invalid_request` AT FULL
// PRICE, which is how #115 was found on the live devnet.
//
// This is the proof of both halves, in one run, on ONE channel, against a
// workload id that does not exist — so nothing needs a lease and nothing is
// left running:
//
//   0. the stack is up, and the provider connector prices `.extend`
//   1. a Solana mock-USDC channel against the PROVIDER's own edge (no hub, so
//      the book moves by the listing price and nothing else)
//   2. THE GUARD: `checkLeaseBody` refuses the enveloped extension before the
//      packet exists, and the connector's book has not moved a unit
//   3. THE COST, measured: the SAME body sent past the guard is answered
//      `invalid_request` — and BILLED the full listing price, which the book
//      confirms. This is the loss the guard prevents
//   4. and the instrument is honest: a WELL-FORMED extension for the same
//      unknown workload is answered `unknown_workload` and billed exactly the
//      same, so step 2's flat book is the guard working, not a broken meter
//
// Steps 3 and 4 each spend one Lease Interval of sandbox mock USDC on
// purpose. That is the whole measurement.
import {
  PROVIDER_EDGE, providerOf,
  checkLeaseBody, extendBody, LeaseBodyError,
  reporter, jstr,
  claims, clientBookOnChannel,
  composeNotRunning, newWorkloadId, openChannel, tokenRequest, newRootSecret,
} from './lib/provider-smoke.mjs';

const { step, ok, bad, assert, fatal, done } = reporter('EXTEND SHAPE SMOKE');

const P = providerOf(process.env.TOON_SMOKE_PROVIDER ?? 'provider');
const L = P.listing(process.env.TOON_EXTEND_SHAPE_LISTING ?? 'basic');
const EXTEND_ROUTE = P.extendRoute(L.name, L.version);

// ── 0. the stack, and the price this run is measured in ──────────────────
step(`0. the stack is up and ${P.connectorNode} prices ${EXTEND_ROUTE}`);
{
  const missing = composeNotRunning([P.service, P.connectorNode]);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-payments\` first`);
  const res = await fetch(`${PROVIDER_EDGE}/ilp`).catch((e) => fatal(`${P.connectorNode} unreachable at ${PROVIDER_EDGE}: ${e.message}`));
  if (!res.ok) fatal(`${P.connectorNode} GET /ilp -> ${res.status}`);
  const routes = Object.fromEntries(((await res.json()).routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
  assert(routes[EXTEND_ROUTE] === L.price, `${EXTEND_ROUTE} costs ${L.price} uUSDC — conf/${P.confFile}'s \`${L.name}\` price`);
}

// ── 1. one channel, paid DIRECTLY, so the book moves by the price alone ──
// The same channel store `scripts/spawn.mjs --direct` uses: one payer, one
// channel per edge, adopted rather than opened again.
step('1. a mock-USDC channel against the provider connector itself');
const { client, opened } = await openChannel(P.edge, `${P.service}-direct.json`);
const channelKey = `solana:${opened.channelId}`;
const book = async () => clientBookOnChannel(await claims(P.connectorNode), channelKey);
ok(`channel ${opened.channelId} (status ${opened.status ?? 'open'})`);

// A workload id this provider has never held. Every refusal below is about
// the SHAPE or about the id, and neither needs a lease to exist — which is
// what keeps this run cheap and leaves nothing behind.
const workloadId = newWorkloadId();
// The mistake, filled in as well as a tenant could fill it in: the envelope
// `status` takes, addressed to this provider, bearing a token.
const wrapped = { request: tokenRequest(newRootSecret(), 'status', { workload_id: workloadId }, 120, P) };

const baseline = await book();
console.log(`  the connector's client book on this channel: ${baseline}`);

// ── 2. the guard: refused before there is a packet ───────────────────────
step('2. the guarded send REFUSES the enveloped extension, and nothing leaves the channel');
let refusedLocally = null;
try {
  await client.send(EXTEND_ROUTE, { body: checkLeaseBody(EXTEND_ROUTE, wrapped) }, { sealTo: P.edge, timeoutMs: 120_000 });
} catch (e) {
  refusedLocally = e;
}
assert(refusedLocally instanceof LeaseBodyError, `the body was refused here, by name: ${refusedLocally?.name ?? 'nothing was thrown'}`);
assert(/BARE/.test(refusedLocally?.message ?? '') && /Nothing was sent/.test(refusedLocally?.message ?? ''),
  `and it says what the route takes and that nothing was sent`);
const afterGuard = await book();
assert(afterGuard === baseline, `the connector's book is still ${afterGuard}: NO PAYMENT LEFT THE CHANNEL`);

// ── 3. the same body, past the guard: what it would have cost ────────────
step('3. the SAME body sent anyway is refused by the provider — and billed the full price');
const billed = await client.send(EXTEND_ROUTE, { body: wrapped }, { sealTo: P.edge, timeoutMs: 120_000 });
if (!billed.fulfilled) {
  bad(`the packet never reached the provider: ${billed.code} (refusedBy ${billed.refusedBy}) ${billed.message}`);
} else {
  const body = billed.json();
  assert(body.error === 'invalid_request', `the provider answered ${jstr(body.error)}: ${String(body.message).slice(0, 200)}`);
  assert(BigInt(billed.claim?.amount ?? 0) === L.price,
    `and the claim that carried it spent ${billed.claim?.amount} uUSDC — one whole Lease Interval for an answer that bought nothing (ADR 0003)`);
}
const afterBilled = await book();
assert(afterBilled === baseline + L.price, `the connector's book moved ${baseline} -> ${afterBilled}, by exactly the listing price`);

// ── 4. the meter is honest ───────────────────────────────────────────────
step('4. a WELL-FORMED extension for the same unknown workload costs exactly the same');
const wellFormed = await client.send(EXTEND_ROUTE, { body: extendBody(workloadId) }, { sealTo: P.edge, timeoutMs: 120_000 });
if (!wellFormed.fulfilled) {
  bad(`the packet never reached the provider: ${wellFormed.code} ${wellFormed.message}`);
} else {
  const body = wellFormed.json();
  assert(body.error === 'unknown_workload', `the provider answered ${jstr(body.error)} — the shape was right and the lease was not there`);
  assert(BigInt(wellFormed.claim?.amount ?? 0) === L.price, `billed ${wellFormed.claim?.amount} uUSDC, the same as the malformed one`);
}
const afterWellFormed = await book();
assert(afterWellFormed === baseline + L.price * 2n,
  `the book is ${afterWellFormed} = ${baseline} + two intervals: step 2's flat book was the guard, not a meter that never moves`);

await client.close().catch(() => undefined);
done(`a wrong shape costs ${L.price} uUSDC at the provider and nothing at all when the tooling checks it first (TOON_Network#115)`);
