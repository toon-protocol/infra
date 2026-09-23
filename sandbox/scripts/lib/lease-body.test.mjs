// The shape guard every lease packet passes before it leaves
// (TOON_Network#115, spec §5, §6.3, ADR 0003, ADR 0025).
//
// Nothing here opens a socket or spends anything: the whole point of the
// guard is that it decides before there is a packet to pay for, so the test
// of it is a pure one. `smoke-extend-shape.mjs` is the other half — the same
// two bodies against the running sandbox, where the connector's own book says
// what each of them cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkLeaseBody, extendBody, LeaseBodyError } from './lease-body.mjs';

const ADDR = 'g.toon.provider';
const ID = 'a'.repeat(64);
const EXTEND = `${ADDR}.basic.v1.extend`;
const STANDBY_EXTEND = `${ADDR}.warm.v1.standby.extend`;
const envelope = { request: { request_id: 'b'.repeat(64), op: 'status', provider: 'd'.repeat(64), expiration: 1, continuation: 'c'.repeat(64), content: { workload_id: ID } } };

test('an extension body is bare, and names its workload as 64 hex', () => {
  assert.deepEqual(extendBody(ID), { workload_id: ID });
  assert.throws(() => extendBody('toon-1000'), LeaseBodyError);
  assert.throws(() => extendBody(undefined), LeaseBodyError);
});

test('the bare body passes on both extension routes and the envelope does not', () => {
  for (const route of [EXTEND, STANDBY_EXTEND]) {
    assert.deepEqual(checkLeaseBody(route, extendBody(ID)), { workload_id: ID });
    // The mistake #115 was billed for: refused here, so no packet exists.
    assert.throws(() => checkLeaseBody(route, envelope), (e) =>
      e instanceof LeaseBodyError && /BARE/.test(e.message) && /Nothing was sent/.test(e.message));
  }
});

test('the five enveloped routes refuse a bare body', () => {
  for (const route of [`${ADDR}.basic.v1.spawn`, `${ADDR}.warm.v1.standby`, `${ADDR}.status`, `${ADDR}.terminate`, `${ADDR}.rotate`]) {
    assert.deepEqual(checkLeaseBody(route, envelope), envelope);
    assert.throws(() => checkLeaseBody(route, { workload_id: ID }), LeaseBodyError);
  }
});

test('availability is neither shape and is left alone', () => {
  const body = { listing: 'basic', version: 1, image: { digest: `sha256:${'d'.repeat(64)}` } };
  assert.deepEqual(checkLeaseBody(`${ADDR}.availability`, body), body);
});

test('a route this guard does not know is left alone', () => {
  // The guard reads §5's routes and nothing else: a relay write or a store
  // upload is not a lease packet and has no business being judged here.
  assert.deepEqual(checkLeaseBody('g.toon.relay', { event: {} }), { event: {} });
});
