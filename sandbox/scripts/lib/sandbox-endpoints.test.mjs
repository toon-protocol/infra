// The host's view of the peered nodes (infra#39). A node dials what another
// PUBLISHES, so the five peered connectors publish their compose-network names;
// a smoke on the host reaches the same nodes on their published ports, and
// this rewrite is the whole of that difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostUrl, hostFetch, HOST_REWRITE } from './sandbox-endpoints.mjs';

test('a peered node’s compose origin becomes its host port', () => {
  assert.equal(hostUrl('http://relay-connector:3000/ilp'), 'http://127.0.0.1:3200/ilp');
  assert.equal(hostUrl('http://provider2-connector:3000/ilp/claim-state'), 'http://127.0.0.1:3250/ilp/claim-state');
  assert.equal(hostUrl('http://relay-connector:3000/ilp/batch-settlement/solana/open'), 'http://127.0.0.1:3200/ilp/batch-settlement/solana/open');
  assert.equal(hostUrl('ws://relay-connector:3000/ilp/btp'), 'ws://127.0.0.1:3200/ilp/btp');
});

test('the Onboarder the EVM nodes name is the host’s published one', () => {
  assert.equal(hostUrl('http://onboarder:4022/supported'), 'http://127.0.0.1:4022/supported');
});

test('anything else is left alone', () => {
  for (const url of ['http://127.0.0.1:3260/ilp', 'http://localhost:8899', 'http://relay-connector:3001/ilp', 'https://example.com/']) {
    assert.equal(hostUrl(url), url);
  }
});

test('the fetch it hands a client dials the rewritten URL, for a string or a Request', async () => {
  const seen = [];
  const fetch = hostFetch(async (input, init) => {
    seen.push([typeof input === 'string' ? input : input.url, init?.method ?? input.method]);
    return new Response('ok');
  });
  await fetch('http://relay-connector:3000/ilp', { method: 'POST' });
  await fetch(new Request('http://gas-connector:3000/ilp', { method: 'GET' }));
  await fetch(new URL('http://store-connector:3000/ilp'));
  assert.deepEqual(seen, [
    ['http://127.0.0.1:3200/ilp', 'POST'],
    ['http://127.0.0.1:3220/ilp', 'GET'],
    ['http://127.0.0.1:3210/ilp', undefined],
  ]);
});

test('the same map, as the TOON_ENDPOINT_REWRITE a provider tool takes', () => {
  // provider/tools/grant/seal.mjs and the directory publisher read this
  // variable as JSON `{ "<from origin>": "<to origin>" }`.
  const map = JSON.parse(HOST_REWRITE);
  assert.equal(map['http://relay-connector:3000'], 'http://127.0.0.1:3200');
  assert.equal(map['http://onboarder:4022'], 'http://127.0.0.1:4022');
  for (const [from, to] of Object.entries(map)) assert.equal(hostUrl(`${from}/ilp`), `${to}/ilp`);
});
