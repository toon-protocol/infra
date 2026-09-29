// The operator-write signer the open-peerings job signs every POST with
// (connector ADR 0008: RFC 9421 + RFC 9530, ed25519).
//
// The vector below was produced by the connector's OWN shipped signer,
// docs/operators/sign-write.sh at release 2026.09.29.1, over the hub's
// committed throwaway operator key. ed25519 is deterministic, so the same key,
// body, `created` and `expires` must give byte-identical headers here — which
// is what holds this file to the node's verifier without a node running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { keyIdFor, signWrite } from './operator-write.mjs';

const HUB_KEY = readFileSync(new URL('../../keys/toon/relay-connector/operator-send.key', import.meta.url), 'utf8');
const BODY = '{"id":"relay-store","url":"http://store-connector:3000/ilp","fee":100,"max_packet_amount":1000000,"deposit":1000000}';

test('the keyid is the public half the hub allowlists', () => {
  const allowlist = readFileSync(new URL('../../keys/toon/relay-connector/operator-write.keys', import.meta.url), 'utf8');
  const committed = allowlist.split('\n').find((line) => /^[0-9a-f]{64}$/.test(line.trim())).trim();
  assert.equal(keyIdFor(HUB_KEY), committed);
});

test('the headers are byte-identical to the connector sign-write.sh vector', () => {
  const headers = signWrite({ key: HUB_KEY, method: 'post', path: '/peers', body: BODY, created: 1790693756, expiresIn: 300 });
  assert.deepEqual(headers, {
    'signature-input':
      'sig1=("@method" "@path" "content-digest");created=1790693756;expires=1790694056;keyid="16697ac195064632c417d50470130b2e220688c4908f22f409428badd68630f9";alg="ed25519"',
    signature: 'sig1=:v+xQ69q9GAIeO+fN8AgRT04NJiUMIiEPcq3I/X+y2piXupplSVIc5rGwAt404UMaeNqtbYnrr8haFK3HB4OdAg==:',
    'content-digest': 'sha-256=:hgNhzP2fNbAhYn0TMjXxfb8i5eLX2rPdXiqlGW1UfS0=:',
  });
});

test('a key that is not 64 hex characters is refused by name', () => {
  assert.throws(() => keyIdFor('not-a-key'), /64 hex/);
});
