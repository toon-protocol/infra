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
//
// A relay that SELLS ITS LIVE FEED (infra#53; relay's docs/paid-feed.md) adds
// `toon_subscription`, read off the same answer:
//
//   ilp_address          the address a subscription is paid at — a route of
//                        the same connector whose handler is the relay's
//                        `POST /subscribe` (`TOON_SUBSCRIBE_ILP_ADDRESS`)
//   price                that route's flat price: what one packet credits
//   broadcast_price      what one live event debits — the relay's own setting
//                        (`TOON_BROADCAST_PRICE`), so held to its env
//
// and lists NIP-42 in `supported_nips`, which a subscriber reads it with. Told
// all three of its settings (with `TOON_RELAY_URL`) and given a connector that
// terminates the address at a flat price above zero, it publishes the object;
// anything less, and it publishes none.

/** What a client sends to be answered the document instead of `426`. */
export const RELAY_DOCUMENT_ACCEPT = 'application/nostr+json';

/** The route `description` terminates at `address`, or the problem that it terminates none. */
function terminated(description, address) {
  const routes = description?.routes ?? [];
  const route = routes.find((r) => r.prefix === address);
  return route ? { route } : { problem: `the connector terminates no ${address} (it terminates ${routes.map((r) => r.prefix).join(', ') || 'nothing'})` };
}

// A price is a decimal string on the connector's wire and in an env file, and
// a number in the document.
const samePrice = (a, b) => String(a) === String(b);

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
  const { route, problem } = terminated(description, address);
  if (!route) return [problem];

  const problems = [];
  if (toon.ilp_address !== address) problems.push(`\`ilp_address\` is ${toon.ilp_address}, not this node’s write address ${address}`);
  if (toon.connector_url !== description.httpEndpoint) {
    problems.push(`\`connector_url\` is ${toon.connector_url}, and the connector publishes ${description.httpEndpoint}`);
  }
  if (typeof toon.connector_seal_key !== 'string' || toon.connector_seal_key !== description.edgeIdentity?.publicKey) {
    problems.push(`\`connector_seal_key\` is ${toon.connector_seal_key}, and the connector’s edge identity is ${description.edgeIdentity?.publicKey}`);
  }
  if (!samePrice(toon.price, route.price)) problems.push(`\`price\` is ${toon.price}, and the connector charges ${route.price} for ${address}`);
  const terms = (list) => (Array.isArray(list) ? list : []).map((s) => `${s.network} ${s.asset}`).sort();
  const networks = (list) => (Array.isArray(list) ? list : []).map((s) => s.network).sort().join(', ') || 'nothing';
  if (!Array.isArray(toon.settlement)) problems.push('`settlement` is not a list');
  else if (terms(toon.settlement).join('\n') !== terms(description.batchSettlements).join('\n')) {
    problems.push(`\`settlement\` lists ${networks(toon.settlement)}, and the connector accepts ${networks(description.batchSettlements)}`);
  }
  return problems;
}

/**
 * Everything `document` says about its paid live feed that `description` (its
 * connector's `GET /ilp`) and the relay's own `broadcastPrice` setting do
 * not, for the node whose subscribe address is `address`. Empty when they
 * agree.
 */
export function subscriptionProblems(document, description, { address, broadcastPrice }) {
  const offer = document?.toon_subscription;
  if (typeof offer !== 'object' || offer === null) {
    return [`the document has no \`toon_subscription\`: the relay does not sell its live feed — its connector has no flat-priced, non-free route for ${address} to its POST /subscribe, it is not told all three of TOON_SUBSCRIBE_ILP_ADDRESS, TOON_BROADCAST_PRICE and TOON_RELAY_URL, or it last read its connector before the route was there (it re-reads every five minutes)`];
  }
  const { route, problem } = terminated(description, address);
  if (!route) return [problem];

  const problems = [];
  if (offer.ilp_address !== address) problems.push(`\`toon_subscription.ilp_address\` is ${offer.ilp_address}, not this node’s subscribe address ${address}`);
  if (!samePrice(offer.price, route.price)) problems.push(`\`toon_subscription.price\` is ${offer.price}, and the connector charges ${route.price} for ${address}`);
  if (broadcastPrice === undefined) problems.push('the relay’s env sets no TOON_BROADCAST_PRICE, which a relay that sells its feed is told');
  else if (!samePrice(offer.broadcast_price, broadcastPrice)) {
    problems.push(`\`toon_subscription.broadcast_price\` is ${offer.broadcast_price}, and the relay’s env sets TOON_BROADCAST_PRICE=${broadcastPrice}`);
  }
  const nips = Array.isArray(document.supported_nips) ? document.supported_nips : [];
  if (!nips.includes(42)) problems.push(`\`supported_nips\` lists ${nips.join(', ') || 'nothing'} and not 42, which a subscriber authenticates with`);
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
 * The `[[routes]]` row of a connector config whose `handler_url` is
 * `handlerUrl`: its `prefix`, and its `price` as written — a whole number
 * for a flat price, an inline `{ base, per_kib }` table for one by the KiB.
 * The handler is the one fact a connector's self-description leaves out, and
 * so the one a relay has to be told the address of.
 */
export function connectorRoute(toml, handlerUrl) {
  for (const block of toml.split(/^\[\[routes\]\]\s*$/m).slice(1)) {
    const row = block.split(/^\[/m)[0];
    const value = (key) => row.match(new RegExp(`^${key}\\s*=\\s*(.*?)\\s*$`, 'm'))?.[1].replace(/^"(.*)"$/, '$1');
    if (value('handler_url') === handlerUrl) return { prefix: value('prefix'), price: value('price') };
  }
  return undefined;
}
