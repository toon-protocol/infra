// A relay node's INFORMATION DOCUMENT, held to its connector (infra#51).
//
// A relay answers a plain `GET /` on its read port, asked with
// `Accept: application/nostr+json`, with the NIP-11 document; its `toon`
// object says where a write to it is paid:
//
//   ilp_address          the address a write is sent to
//   connector_url        the connector that takes it — what that connector
//                        PUBLISHES, so a compose-network name here (or a
//                        hidden node's `.anyone` endpoint); a host-run reader
//                        moves it with scripts/lib/sandbox-endpoints.mjs
//   connector_seal_key   the key a write is sealed to
//   price                what the connector charges for the route, in µUSDC
//   settlement           the `{ network, asset }` terms the connector accepts
//   carriage             only when the connector pins one; none here does
//
// The relay decides none of it. It is told its connector and its write address
// (`TOON_CONNECTOR_URL`, `TOON_WRITE_ILP_ADDRESS`, conf/relay*.conf), reads
// the rest off that connector's free `GET /ilp`, and re-reads it in the
// background — every five minutes once it has an answer, every five seconds
// until then. Told neither, or told an address its connector does not
// terminate, it publishes NO `toon` object. So the check is a comparison with
// the connector's own answer and never with a literal: a relay still holding
// what its connector said before it was restarted on another config fails it.

/** What a client sends to be answered the document instead of `426`. */
export const RELAY_DOCUMENT_ACCEPT = 'application/nostr+json';

/**
 * Everything `document` (a relay's information document) says that
 * `description` (its connector's `GET /ilp`) does not, for the node whose
 * write address is `address`. Empty when the two agree.
 */
export function documentProblems(document, description, address) {
  const toon = document?.toon;
  if (typeof toon !== 'object' || toon === null) {
    return ['the document has no `toon` object: the relay does not say where a write is paid — it is told no connector and write address (TOON_CONNECTOR_URL, TOON_WRITE_ILP_ADDRESS), has not read its connector yet, or was refused the address'];
  }
  const routes = description?.routes ?? [];
  const route = routes.find((r) => r.prefix === address);
  if (!route) return [`the connector terminates no ${address} (it terminates ${routes.map((r) => r.prefix).join(', ') || 'nothing'})`];

  const problems = [];
  if (toon.ilp_address !== address) problems.push(`\`ilp_address\` is ${toon.ilp_address}, not this node’s write address ${address}`);
  if (toon.connector_url !== description.httpEndpoint) {
    problems.push(`\`connector_url\` is ${toon.connector_url}, and the connector publishes ${description.httpEndpoint}`);
  }
  if (typeof toon.connector_seal_key !== 'string' || toon.connector_seal_key !== description.edgeIdentity?.publicKey) {
    problems.push(`\`connector_seal_key\` is ${toon.connector_seal_key}, and the connector’s edge identity is ${description.edgeIdentity?.publicKey}`);
  }
  // A route's price is a decimal string on the connector's wire and a number
  // in the document.
  if (String(toon.price) !== String(route.price)) problems.push(`\`price\` is ${toon.price}, and the connector charges ${route.price} for ${address}`);
  const terms = (list) => (Array.isArray(list) ? list : []).map((s) => `${s.network} ${s.asset}`).sort();
  const networks = (list) => (Array.isArray(list) ? list : []).map((s) => s.network).sort().join(', ') || 'nothing';
  if (!Array.isArray(toon.settlement)) problems.push('`settlement` is not a list');
  else if (terms(toon.settlement).join('\n') !== terms(description.batchSettlements).join('\n')) {
    problems.push(`\`settlement\` lists ${networks(toon.settlement)}, and the connector accepts ${networks(description.batchSettlements)}`);
  }
  return problems;
}

/** The `KEY=value` lines of a compose `env_file`. */
export function readEnv(text) {
  return Object.fromEntries(text.split('\n').filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line)).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

/**
 * The prefix of the `[[routes]]` row of a connector config whose
 * `handler_url` is `handlerUrl` — the one fact a connector's self-description
 * leaves out, and so the one a relay has to be told.
 */
export function writeRoutePrefix(toml, handlerUrl) {
  for (const block of toml.split(/^\[\[routes\]\]\s*$/m).slice(1)) {
    const row = block.split(/^\[/m)[0];
    if (row.match(/^handler_url\s*=\s*"([^"]+)"/m)?.[1] === handlerUrl) return row.match(/^prefix\s*=\s*"([^"]+)"/m)?.[1];
  }
  return undefined;
}
