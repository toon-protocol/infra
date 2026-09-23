// The two request-body shapes spec §5 has, and the check that a lease packet
// carries the right one BEFORE it becomes a signed claim (TOON_Network#115).
//
// No client, no connector, no config: this module is pure so that the guard
// can be tested without any of them, and so that nothing it imports can make
// it optional.

const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * The body `.extend` and `.standby.extend` take: **bare**, one key, no Lease
 * Request (spec §6.3, ADR 0005, ADR 0025).
 *
 * This exists beside `tokenRequest` so the asymmetry is built rather than
 * remembered. An extension presents no Continuation Token because paying the
 * route is its whole authority — any payer may extend any lease — and the
 * envelope is that token's carriage, so there is nothing here to wrap.
 */
export const extendBody = (workloadId) => {
  if (typeof workloadId !== 'string' || !/^[0-9a-f]{64}$/.test(workloadId))
    throw new LeaseBodyError(`an extension names a workload id as 64 lowercase hex characters, not ${jstr(workloadId)}`);
  return { workload_id: workloadId };
};

/** A body this sandbox refused to send. Thrown BEFORE the packet, which is the point. */
export class LeaseBodyError extends Error {
  constructor(message) { super(message); this.name = 'LeaseBodyError'; }
}

/**
 * The check every lease packet passes before it leaves (TOON_Network#115).
 *
 * **A refused paid request is billed in full and nothing is refunded**
 * (spec §5, ADR 0003): the connector collects at the route, and the provider
 * app does not see the body until the money is already spent. The one refusal
 * that is pure loss is a body of the wrong SHAPE, because it buys nothing at
 * all — and §5 has two shapes, which is what makes it easy:
 *
 * - `.extend` and `.standby.extend` take a bare `{ "workload_id": "…" }`;
 * - `.spawn`, `.standby`, `.status`, `.terminate` and `.rotate` take the §6.1
 *   Lease Request envelope, `{ "request": { … } }`;
 * - `.availability` takes neither and is free anyway.
 *
 * Sending one where the other belongs is `invalid_request` at full price —
 * 1000 µUSDC on devnet's `basic`, which is how #115 was found. So this throws
 * rather than returning a problem: a sandbox script that would pay for an
 * answer it cannot use is a bug in this repository, not a condition to report.
 *
 * (When `@toon-protocol/client` ships its `beforePay` hook this becomes what
 * the smokes hand it; until the pinned version has it, the wrappers below call
 * it themselves, which is the same check one step earlier.)
 */
export function checkLeaseBody(route, body) {
  const bare = /\.(standby\.)?extend$/.test(route);
  const shape = body === null || typeof body !== 'object' ? 'nothing' : 'request' in body ? 'envelope' : 'workload_id' in body ? 'bare' : 'something else';
  if (bare && shape !== 'bare')
    throw new LeaseBodyError(
      `${route} takes a BARE { "workload_id": "…" } and was handed ${shape} (${jstr(body)}). ` +
      `A Lease Request here is \`invalid_request\` AT FULL PRICE — an extension carries no ` +
      `Continuation Token because paying the route is its authority (spec §6.3, ADR 0025). Nothing was sent.`
    );
  if (!bare && /\.(spawn|standby|status|terminate|rotate)$/.test(route) && shape !== 'envelope')
    throw new LeaseBodyError(
      `${route} takes { "request": <Lease Request> } and was handed ${shape} (${jstr(body)}). ` +
      `Spec §6.1: a body with any other key is refused \`invalid_request\`, and on a paid route ` +
      `that refusal is billed. Nothing was sent.`
    );
  return body;
}
