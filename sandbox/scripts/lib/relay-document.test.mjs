// A relay node's information document against its connector (infra#51).
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
import { NODE_KINDS } from './topology.mjs';
import { documentProblems, readEnv, writeRoutePrefix } from './relay-document.mjs';

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
  routes: [{ prefix: 'g.toon.relay', price: '1' }, { prefix: 'g.toon.relay.ephemeral', price: '0' }],
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
  assert.deepEqual(problems, ['the connector terminates no g.toon.relay2 (it terminates g.toon.relay, g.toon.relay.ephemeral)']);
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
    const terminated = writeRoutePrefix(read(`conf/connector-${node}.toml`), `http://${node}:3100/write`);
    assert.equal(env(node).TOON_WRITE_ILP_ADDRESS, terminated, `conf/${node}.conf against conf/connector-${node}.toml`);
    assert.equal(kind.relay.address, terminated, `scripts/lib/topology.mjs, ${node}`);
  }
});

test('no two relays share a connector or a write address', () => {
  for (const key of ['TOON_CONNECTOR_URL', 'TOON_WRITE_ILP_ADDRESS']) {
    const values = relayNodes.map(([node]) => env(node)[key]);
    assert.equal(new Set(values).size, values.length, `${key}: ${values.join(', ')}`);
  }
});

test('every relay service is pinned to one digest', () => {
  const pins = [...read('docker-compose.yml').matchAll(/^\s*image: ghcr\.io\/toon-protocol\/relay@(sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
  assert.equal(pins.length, relayNodes.length, 'one pinned relay image per relay node');
  assert.equal(new Set(pins).size, 1, `relay pins differ: ${pins.join(', ')}`);
});
