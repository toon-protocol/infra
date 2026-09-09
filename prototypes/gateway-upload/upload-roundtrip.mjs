// PROTOTYPE — throwaway driver: upload via @ardrive/turbo-sdk to the LOCAL
// Turbo upload service, then fetch back through the LOCAL ar.io gateway.
import { readFileSync } from 'node:fs';
import { TurboFactory } from '@ardrive/turbo-sdk';

const GATEWAY = 'http://localhost:3000';
const BUNDLER_VIA_GATEWAY = `${GATEWAY}/bundler`; // envoy proxies /bundler/* -> upload-service:5100
const BUNDLER_DIRECT = 'http://localhost:5100';

const jwk = JSON.parse(readFileSync(new URL('./throwaway-uploader-wallet.json', import.meta.url)));
const unique = `TOON-proto-roundtrip-${Date.now()}`;
const payload = `hello from the TOON local gateway prototype\nunique: ${unique}\n`;

console.log('=== 1. upload via turbo-sdk ===');
console.log('unique string:', unique);

async function uploadVia(url) {
  // The custom-endpoint option is `uploadServiceConfig: { url }` on
  // TurboFactory.authenticated (TurboUnauthenticatedConfiguration in types.d.ts).
  const turbo = TurboFactory.authenticated({
    privateKey: jwk,
    token: 'arweave',
    uploadServiceConfig: { url },
    paymentServiceConfig: { url }, // unused (SKIP_BALANCE_CHECKS=true) but avoid prod default
  });
  return turbo.upload({
    data: payload,
    dataItemOpts: {
      tags: [
        { name: 'App-Name', value: 'toon-proto-gateway-upload' },
        { name: 'Content-Type', value: 'text/plain' },
        { name: 'Unique', value: unique },
      ],
    },
  });
}

let uploadResult;
let usedUrl = BUNDLER_VIA_GATEWAY;
try {
  uploadResult = await uploadVia(BUNDLER_VIA_GATEWAY);
} catch (e) {
  console.log('upload via gateway /bundler failed:', e?.message ?? e);
  usedUrl = BUNDLER_DIRECT;
  uploadResult = await uploadVia(BUNDLER_DIRECT);
}
console.log('upload endpoint used:', usedUrl);
console.log('upload response:', JSON.stringify(uploadResult, null, 2));
const id = uploadResult.id;

console.log(`\n=== 2. fetch back through gateway ${GATEWAY}/${id} ===`);
let served = false;
for (let i = 0; i < 30; i++) {
  const res = await fetch(`${GATEWAY}/${id}`);
  const body = await res.text();
  console.log(`attempt ${i + 1}: HTTP ${res.status}, content-type=${res.headers.get('content-type')}, x-ar-io-verified=${res.headers.get('x-ar-io-verified')}, x-ar-io-trusted=${res.headers.get('x-ar-io-trusted')}, cache=${res.headers.get('x-cache')}`);
  if (res.status === 200) {
    console.log('body:\n' + body);
    served = body.includes(unique);
    if (served) break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(served ? 'ROUND TRIP OK: unique string served by local gateway' : 'ROUND TRIP FAILED: unique string not served');

console.log(`\n=== 3. /raw/${id} ===`);
const rawRes = await fetch(`${GATEWAY}/raw/${id}`);
console.log(`HTTP ${rawRes.status}`);
console.log((await rawRes.text()).slice(0, 300));

console.log('\n=== 4. GraphQL lookup ===');
const gqlQuery = {
  query: `{ transactions(ids: ["${id}"]) { edges { node { id owner { address } data { size } tags { name value } bundledIn { id } block { height } } } } }`,
};
for (let i = 0; i < 10; i++) {
  const gqlRes = await fetch(`${GATEWAY}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(gqlQuery),
  });
  const gql = await gqlRes.json();
  console.log(`attempt ${i + 1}: HTTP ${gqlRes.status}:`, JSON.stringify(gql, null, 2));
  if (gql?.data?.transactions?.edges?.length > 0) break;
  await new Promise((r) => setTimeout(r, 2000));
}

console.log('\ndata item id:', id);
console.log('done');
