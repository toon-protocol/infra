// The open-peerings job's table and the pure decisions it makes from it
// (infra#39, connector ADR 0075: a peering is two x402 channels, each opened by
// its own node's POST /peers).
//
// The first two tests are the ones that matter most. A forwarded route's price
// is ADR 0028 arithmetic — the hub charges `price`, keeps the peering's `fee`
// and forwards the rest — and NOTHING in the connector checks it: a hub row one
// unit short is refused F03 at the far end, a row that overshoots is silently
// overpaid. The hub's rows now live in scripts/peerings.mjs (a runtime route
// cannot live in a config file whose peering is runtime), and the payees'
// prices in their committed conf/connector-*.toml, so this holds the two
// halves to one sum on every `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODES, PEERINGS, OPEN_DEPOSIT, CHANNEL_TARGET } from '../peerings.mjs';
import { peerBody, presentPeerings, readTerminatedRoutes, topUp } from './peering-plan.mjs';

const conf = (node) => readFileSync(new URL(`../../conf/${node.replace(/-connector$/, '').replace(/^/, 'connector-')}.toml`, import.meta.url), 'utf8');
const flat = (price) => (typeof price === 'number' ? { base: price, per_kib: 0 } : price);

test('every forwarded route forwards exactly the payee’s own price', () => {
  for (const peering of PEERINGS) {
    const terminated = new Map(readTerminatedRoutes(conf(peering.payee)).map((r) => [r.prefix, flat(r.price)]));
    for (const route of peering.routes) {
      const theirs = terminated.get(route.prefix);
      assert.ok(theirs, `${peering.payee} terminates no ${route.prefix}, but the hub forwards it over ${peering.id}`);
      const ours = flat(route.price);
      assert.equal(ours.base - peering.fee, theirs.base, `${route.prefix}: hub ${ours.base} - fee ${peering.fee} must be ${peering.payee}'s ${theirs.base}`);
      assert.equal(ours.per_kib, theirs.per_kib, `${route.prefix}: the per-KiB slope is forwarded untouched`);
    }
  }
});

test('every route a peered payee terminates is reachable through the hub', () => {
  for (const peering of PEERINGS) {
    const forwarded = new Set(peering.routes.map((r) => r.prefix));
    for (const { prefix } of readTerminatedRoutes(conf(peering.payee))) {
      assert.ok(forwarded.has(prefix), `${peering.payee} terminates ${prefix}, and the hub has no row forwarding it over ${peering.id}`);
    }
  }
});

test('every peering names two nodes the table knows, on a chain both settle on', () => {
  for (const { id, payer, payee, chain } of PEERINGS) {
    assert.ok(NODES[payer] && NODES[payee], `${id} names an unknown node`);
    assert.ok(['evm', 'solana'].includes(chain), `${id}: chain ${chain}`);
    for (const node of [payer, payee]) {
      assert.match(conf(node), new RegExp(`^\\[settlement\\.${chain}\\]$`, 'm'), `${node} has no [settlement.${chain}]`);
    }
  }
});

test('the payee binds first, with a reverse leg that carries nothing', () => {
  const [peering] = PEERINGS;
  const body = JSON.parse(peerBody(peering, 'payee', NODES));
  assert.deepEqual(body, {
    id: peering.id,
    url: NODES[peering.payer].url,
    fee: 0,
    max_packet_amount: 0,
    chain: peering.chain,
    deposit: Number(OPEN_DEPOSIT),
  });
});

test('the payer opens its channel with the whole target behind it', () => {
  const [peering] = PEERINGS;
  const body = JSON.parse(peerBody(peering, 'payer', NODES));
  assert.deepEqual(body, {
    id: peering.id,
    url: NODES[peering.payee].url,
    fee: peering.fee,
    max_packet_amount: 0,
    chain: peering.chain,
    deposit: Number(CHANNEL_TARGET),
  });
});

test('a top-up is the shortfall to the target, and nothing at or above it', () => {
  assert.equal(topUp(1_000_000n, 100_000_000n), 99_000_000n);
  assert.equal(topUp(100_000_000n, 100_000_000n), 0n);
  assert.equal(topUp(150_000_000n, 100_000_000n), 0n);
});

test('a peering whose payee this profile does not run is skipped, not failed', () => {
  const present = new Set(['relay-connector', 'provider-connector', 'provider2-connector']);
  const { run, skipped } = presentPeerings(PEERINGS, present);
  assert.deepEqual(run.map((p) => p.id), ['relay-provider', 'relay-provider2']);
  assert.deepEqual(skipped.map((p) => p.id), ['relay-store', 'relay-gas']);
});

test('the route reader takes flat and metered prices, and skips forwarded rows', () => {
  const routes = readTerminatedRoutes(`
[[routes]]
prefix = "g.a"
handler_url = "http://a:1/x"
price = 1000

[[routes]]
prefix = "g.b"
handler_url = "http://b:1/x"
price = { base = 1000, per_kib = 10 }

[[routes]]
prefix = "g.c"
peer_id = "p"
price = 5
`);
  assert.deepEqual(routes, [
    { prefix: 'g.a', price: 1000 },
    { prefix: 'g.b', price: { base: 1000, per_kib: 10 } },
  ]);
});
