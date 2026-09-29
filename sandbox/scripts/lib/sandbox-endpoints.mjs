// Where the HOST reaches the sandbox's peered nodes (infra#39).
//
// A connector dials the endpoints another node PUBLISHES, and `POST /peers`
// reads them off the other node's `GET /ilp`. So the five nodes that peer —
// the hub, the store, the gas station and the two providers — publish their
// compose-network names (`http://relay-connector:3000/ilp`), which every
// container on the network can dial. A smoke running on the host cannot: it
// reaches the same node at `127.0.0.1:<published port>`. A client dials what
// the node publishes rather than the URL it was given, so a host-run client
// is handed `hostFetch`, which moves exactly those origins onto the host and
// touches nothing else. The Onboarder the EVM nodes name as their
// `facilitator` (`http://onboarder:4022`) is moved the same way.
//
// Sandbox-only, like everything under scripts/: a deployment publishes a
// public name that resolves the same from everywhere.
import { NODES } from '../peerings.mjs';

const ORIGINS = new Map([
  ...Object.entries(NODES).flatMap(([service, { port }]) => [
    [`http://${service}:3000`, `http://127.0.0.1:${port}`],
    [`ws://${service}:3000`, `ws://127.0.0.1:${port}`],
  ]),
  ['http://onboarder:4022', 'http://127.0.0.1:4022'],
]);

/** `url` with a peered node's compose origin replaced by its host origin. */
export function hostUrl(url) {
  const text = String(url);
  const { origin } = new URL(text);
  const host = ORIGINS.get(origin);
  return host === undefined ? text : host + text.slice(origin.length);
}

/**
 * The same map as `TOON_ENDPOINT_REWRITE` (JSON `{ "<from>": "<to>" }`), the
 * variable the provider repo's host-run tools read — tools/grant/seal.mjs,
 * which scripts/rotate.mjs runs against the hub.
 */
export const HOST_REWRITE = JSON.stringify(Object.fromEntries(ORIGINS));

/** A `fetch` for a host-run client: every request dials `hostUrl(url)`. */
export function hostFetch(fetchImpl = globalThis.fetch) {
  return (input, init) => {
    if (input instanceof Request) return fetchImpl(new Request(hostUrl(input.url), input), init);
    return fetchImpl(hostUrl(input instanceof URL ? input.href : input), init);
  };
}
