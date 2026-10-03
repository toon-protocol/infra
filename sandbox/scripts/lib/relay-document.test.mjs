// A relay node's information document against its connector (infra#51), and
// the paid live feed it sells (infra#53).
//
// A relay speaks no ILP and holds no price: its document's `toon` object is
// its connector's own self-description, narrowed to the one route that reaches
// the relay's `POST /write`. So the first half holds the comparison
// `make smoke-topology` makes — a document is right when it says what the
// connector says NOW, never when it matches a literal. The second half holds
// the committed wiring to itself: a relay is TOLD only its connector and its
// write address (conf/relay*.conf), and nothing at runtime notices a relay
// told another node's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODES } from '../peerings.mjs';
import { NODE_KINDS, relayUrl } from './topology.mjs';
import { connectorRoute, documentProblems, readEnv, subscriptionProblems } from './relay-document.mjs';

// The hub's `GET /ilp` as the sandbox serves it under CHAINS=evm, and the
// document its relay renders from it.
const description = () => ({
  ilpAddresses: ['g.toon.relay', 'g.toon.relay.ephemeral'],
  httpEndpoint: 'http://relay-connector:3000/ilp',
  edgeIdentity: { keyId: 'connector-signer', publicKey: '0x04915d29908235be4b53f8f23cd7ac72c88c99be3bcca876dadf5c1a4494' },
  batchSettlements: [{
    network: 'eip155:31337', asset: '0x0a867ca0442383c2a89951244b955aa19b615b58',
    payTo: '0x3f43d923a611bcb2d0bfb5d6ee2c3ac3efeaf308', facilitator: 'http://onboarder:4022',
  }],
  routes: [{ prefix: 'g.toon.relay', price: '1' }, { prefix: 'g.toon.relay.ephemeral', price: '0' }, { prefix: 'g.toon.relay.subscribe', price: '1' }],
});
const document = (toon) => ({
  name: 'TOON relay',
  limitation: { payment_required: true },
  toon: {
    ilp_address: 'g.toon.relay',
    connector_url: 'http://relay-connector:3000/ilp',
    connector_seal_key: '0x04915d29908235be4b53f8f23cd7ac72c88c99be3bcca876dadf5c1a4494',
    price: 1,
    settlement: [{ network: 'eip155:31337', asset: '0x0a867ca0442383c2a89951244b955aa19b615b58' }],
    ...toon,
  },
});
// The same document from a relay that sells its feed.
const selling = (subscription) => ({
  ...document(),
  supported_nips: [1, 9, 11, 40, 42],
  toon_subscription: { ilp_address: 'g.toon.relay.subscribe', price: 1, broadcast_price: 1, ...subscription },
});
const feed = { address: 'g.toon.relay.subscribe', broadcastPrice: '1' };

test('a document that says what its connector says has no problem', () => {
  assert.deepEqual(documentProblems(document(), description(), 'g.toon.relay'), []);
});

test('a document with no `toon` object is the one problem, and says how a relay comes to publish none', () => {
  const { toon, ...bare } = document();
  const problems = documentProblems(bare, description(), 'g.toon.relay');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no `toon` object/);
  assert.match(problems[0], /TOON_CONNECTOR_URL/);
  assert.deepEqual(documentProblems(null, description(), 'g.toon.relay').length, 1);
});

test('another node’s write address is a problem', () => {
  const problems = documentProblems(document({ ilp_address: 'g.toon.relay2' }), description(), 'g.toon.relay');
  assert.deepEqual(problems, ['`ilp_address` is g.toon.relay2, not this node’s write address g.toon.relay']);
});

test('the price is held to what the connector charges for the route, across its string and number forms', () => {
  assert.deepEqual(documentProblems(document({ price: 2 }), description(), 'g.toon.relay'),
    ['`price` is 2, and the connector charges 1 for g.toon.relay']);
  const numeric = description();
  numeric.routes[0].price = 1;
  assert.deepEqual(documentProblems(document(), numeric, 'g.toon.relay'), []);
});

test('the endpoint and the seal key are the connector’s own', () => {
  const problems = documentProblems(
    document({ connector_url: 'http://relay2-connector:3000/ilp', connector_seal_key: '0x02ab' }), description(), 'g.toon.relay');
  assert.deepEqual(problems, [
    '`connector_url` is http://relay2-connector:3000/ilp, and the connector publishes http://relay-connector:3000/ilp',
    '`connector_seal_key` is 0x02ab, and the connector’s edge identity is 0x04915d29908235be4b53f8f23cd7ac72c88c99be3bcca876dadf5c1a4494',
  ]);
});

test('a settlement the connector no longer accepts is a problem: a stale copy cannot pass', () => {
  // The relay read its connector while it still settled on Solana.
  const stale = [
    { network: 'eip155:31337', asset: '0x0a867ca0442383c2a89951244b955aa19b615b58' },
    { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H' },
  ];
  const problems = documentProblems(document({ settlement: stale }), description(), 'g.toon.relay');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^`settlement` lists eip155:31337, solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1, and the connector accepts eip155:31337$/);
  // The other way round — one the connector accepts and the document omits.
  assert.equal(documentProblems(document({ settlement: [] }), description(), 'g.toon.relay').length, 1);
});

test('a document and a connector that are silent in the same place do not agree by default', () => {
  const silent = description();
  delete silent.edgeIdentity;
  delete silent.batchSettlements;
  const { connector_seal_key, settlement, ...toon } = document().toon;
  const problems = documentProblems({ toon }, silent, 'g.toon.relay');
  assert.deepEqual(problems, [
    '`connector_seal_key` is undefined, and the connector’s edge identity is undefined',
    '`settlement` is not a list',
  ]);
});

test('a connector that does not terminate the address is a problem of its own', () => {
  const problems = documentProblems(document({ ilp_address: 'g.toon.relay2' }), description(), 'g.toon.relay2');
  assert.deepEqual(problems, ['the connector terminates no g.toon.relay2 (it terminates g.toon.relay, g.toon.relay.ephemeral, g.toon.relay.subscribe)']);
});

// ── The paid live feed (infra#53) ─────────────────────────────────────────
// `toon_subscription` is read off the same connector answer as `toon`: its
// address is a route the connector terminates and its price that route's. The
// broadcast price is the relay's own setting, so it is held to the env.

test('a document that offers the feed its connector prices has no problem', () => {
  assert.deepEqual(subscriptionProblems(selling(), description(), feed), []);
});

test('a document with no `toon_subscription` is the one problem, and names what turns it off', () => {
  const problems = subscriptionProblems(document(), description(), feed);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no `toon_subscription`/);
  for (const cause of [/route/, /TOON_SUBSCRIBE_ILP_ADDRESS/, /TOON_BROADCAST_PRICE/, /TOON_RELAY_URL/, /before/]) assert.match(problems[0], cause);
  assert.equal(subscriptionProblems(null, description(), feed).length, 1);
});

test('the subscribe price is the route’s, across its string and number forms', () => {
  assert.deepEqual(subscriptionProblems(selling({ price: 5 }), description(), feed),
    ['`toon_subscription.price` is 5, and the connector charges 1 for g.toon.relay.subscribe']);
  const numeric = description();
  numeric.routes[2].price = 1;
  assert.deepEqual(subscriptionProblems(selling(), numeric, feed), []);
});

test('another node’s subscribe address is a problem, and so is one the connector does not terminate', () => {
  assert.deepEqual(subscriptionProblems(selling({ ilp_address: 'g.toon.relay2.subscribe' }), description(), feed),
    ['`toon_subscription.ilp_address` is g.toon.relay2.subscribe, not this node’s subscribe address g.toon.relay.subscribe']);
  const bare = description();
  bare.routes.pop();
  assert.deepEqual(subscriptionProblems(selling(), bare, feed),
    ['the connector terminates no g.toon.relay.subscribe (it terminates g.toon.relay, g.toon.relay.ephemeral)']);
});

test('the broadcast price is the one the relay’s env sets', () => {
  assert.deepEqual(subscriptionProblems(selling({ broadcast_price: 3 }), description(), feed),
    ['`toon_subscription.broadcast_price` is 3, and the relay’s env sets TOON_BROADCAST_PRICE=1']);
  assert.deepEqual(subscriptionProblems(selling(), description(), { ...feed, broadcastPrice: undefined }),
    ['the relay’s env sets no TOON_BROADCAST_PRICE, which a relay that sells its feed is told']);
});

test('a relay that sells its feed lists NIP-42, which a subscriber reads it with', () => {
  assert.deepEqual(subscriptionProblems({ ...selling(), supported_nips: [1, 11] }, description(), feed),
    ['`supported_nips` lists 1, 11 and not 42, which a subscriber authenticates with']);
});

// ── The committed wiring ──────────────────────────────────────────────────
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const relayNodes = Object.entries(NODE_KINDS).filter(([, kind]) => kind.relay);
const env = (node) => readEnv(read(`conf/${node}.conf`));

test('each relay is told its own connector, by the name that connector publishes', () => {
  for (const [node, kind] of relayNodes) {
    assert.equal(env(node).TOON_CONNECTOR_URL, NODES[kind.connector].url, `conf/${node}.conf`);
  }
});

test('each relay is told the address its own connector routes to its POST /write, the one the node table holds', () => {
  for (const [node, kind] of relayNodes) {
    const terminated = connectorRoute(read(`conf/connector-${node}.toml`), `http://${node}:3100/write`)?.prefix;
    assert.equal(env(node).TOON_WRITE_ILP_ADDRESS, terminated, `conf/${node}.conf against conf/connector-${node}.toml`);
    assert.equal(kind.relay.address, terminated, `scripts/lib/topology.mjs, ${node}`);
  }
});

test('each relay is told the address its own connector routes to its POST /subscribe, at a flat price above zero', () => {
  for (const [node, kind] of relayNodes) {
    const route = connectorRoute(read(`conf/connector-${node}.toml`), `http://${node}:3100/subscribe`);
    assert.ok(route, `conf/connector-${node}.toml has no route to http://${node}:3100/subscribe`);
    assert.equal(env(node).TOON_SUBSCRIBE_ILP_ADDRESS, route.prefix, `conf/${node}.conf against conf/connector-${node}.toml`);
    assert.equal(kind.relay.subscribe, route.prefix, `scripts/lib/topology.mjs, ${node}`);
    assert.match(route.price ?? '', /^[1-9][0-9]*$/,
      `conf/connector-${node}.toml prices ${route.prefix} at ${route.price}: the relay refuses a free route or one priced by the KiB`);
  }
});

test('each relay sets a whole broadcast price, and the URL a subscriber dials when it is not hidden', () => {
  for (const [node] of relayNodes) {
    assert.match(env(node).TOON_BROADCAST_PRICE ?? '', /^[1-9][0-9]*$/, `conf/${node}.conf TOON_BROADCAST_PRICE`);
    assert.equal(env(node).TOON_RELAY_URL, relayUrl(node, undefined), `conf/${node}.conf TOON_RELAY_URL`);
  }
});

test('connectorRoute reads a route’s prefix and price by its handler, and nothing past its own row', () => {
  const toml = '[[routes]]\nprefix = "a"\nhandler_url = "http://x/write"\nprice = 1\n\n[[routes]]\nprefix = "b"\nhandler_url = "http://x/subscribe"\nprice = { base = 1, per_kib = 2 }\n\n[operator]\nprice = 9\n';
  assert.deepEqual(connectorRoute(toml, 'http://x/write'), { prefix: 'a', price: '1' });
  assert.deepEqual(connectorRoute(toml, 'http://x/subscribe'), { prefix: 'b', price: '{ base = 1, per_kib = 2 }' });
  assert.equal(connectorRoute(toml, 'http://x/nothing'), undefined);
});

test('no two relays share a connector, a write address, a subscribe address or a URL', () => {
  for (const key of ['TOON_CONNECTOR_URL', 'TOON_WRITE_ILP_ADDRESS', 'TOON_SUBSCRIBE_ILP_ADDRESS', 'TOON_RELAY_URL']) {
    const values = relayNodes.map(([node]) => env(node)[key]);
    assert.equal(new Set(values).size, values.length, `${key}: ${values.join(', ')}`);
  }
});

test('every relay service is pinned to one digest, the Rust release that sells its feed', () => {
  const pins = [...read('docker-compose.yml').matchAll(/^\s*image: ghcr\.io\/toon-protocol\/relay@(sha256:[0-9a-f]{64}) # (\S+)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.equal(pins.length, relayNodes.length, 'one pinned relay image per relay node');
  assert.equal(new Set(pins).size, 1, `relay pins differ: ${pins.join(', ')}`);
  assert.match(pins[0], / rust-\d{4}\.\d{2}\.\d{2}\.\d+$/, 'the pin comment names a rust-* release tag');
});
