// PROTOTYPE — throwaway. The integration driver:
//   1. upload a payload with a unique string via the LOCAL Turbo bundler
//      (through the gateway's /bundler proxy) -> data-item id
//   2. verify the gateway serves /<id> (optical path, from gateway-upload proto)
//   3. spawn an ANT + buy an ArNS name + set the ANT '@' record to that id
//      (from solana-arns proto, against the LOCAL validator)
//   4. resolve the name THROUGH THE GATEWAY:
//        - GET /ar-io/resolver/<name>          (resolver endpoint)
//        - GET / with Host: <name>.ar.localhost (ArNS subdomain serving)
//      and require the unique string in the served body.
// Prereqs: stacks up (see README), validator seeded (node seed.mjs),
// head block seeded (./seed-head-block.sh).
// Usage: node flow.mjs [name]
import { readFileSync } from 'node:fs';
import { TurboFactory } from '@ardrive/turbo-sdk';
import { createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes } from '@solana/kit';
import { ARIO, DEVNET_PROGRAM_IDS, spawnSolanaANT, ANT } from '@ar.io/sdk';

const GATEWAY = 'http://localhost:3000';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8900';
const name = process.argv[2] ?? `toon-full-${Math.random().toString(36).slice(2, 8)}`;
const ARNS_ROOT_HOST = 'ar.localhost';

const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. upload via local Turbo ──────────────────────────────────────────
const jwk = JSON.parse(readFileSync(new URL('./throwaway-uploader-wallet.json', import.meta.url)));
const unique = `TOON-full-stack-${Date.now()}`;
const payload = `hello from the TOON full-stack prototype\nunique: ${unique}\nname: ${name}\n`;
console.log('=== 1. upload payload via turbo-sdk ->', `${GATEWAY}/bundler`, '===');
console.log('unique string:', unique);
const turbo = TurboFactory.authenticated({
  privateKey: jwk,
  token: 'arweave',
  uploadServiceConfig: { url: `${GATEWAY}/bundler` },
  paymentServiceConfig: { url: `${GATEWAY}/bundler` },
});
const upload = await turbo.upload({
  data: payload,
  dataItemOpts: {
    tags: [
      { name: 'App-Name', value: 'toon-proto-full-stack' },
      { name: 'Content-Type', value: 'text/plain' },
      { name: 'Unique', value: unique },
    ],
  },
});
console.log('upload response:', jstr(upload));
const dataItemId = upload.id;

// ─── 2. gateway serves the raw id (sanity: optical path works) ──────────
// NOTE: /<id> can't be used here — with ARNS_ROOT_HOST set, the sandbox
// middleware 302s any /<43charid> request to https://<base32id>.<root host>
// (no port), which is unreachable locally. /raw/<id> bypasses the sandbox.
console.log(`\n=== 2. sanity: GET ${GATEWAY}/raw/${dataItemId} ===`);
let sane = false;
for (let i = 0; i < 15 && !sane; i++) {
  const res = await fetch(`${GATEWAY}/raw/${dataItemId}`);
  const body = res.status === 200 ? await res.text() : '';
  console.log(`attempt ${i + 1}: HTTP ${res.status}`);
  sane = body.includes(unique);
  if (!sane) await sleep(2000);
}
if (!sane) throw new Error('gateway never served the uploaded data item by id — abort');
console.log('OK: gateway serves the data item by id');

// ─── 3. buy the name on the local validator, point '@' at the data item ─
console.log('\n=== 3. buy ArNS name on local validator ===');
const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(new URL('./keys/admin.json', import.meta.url)))));
console.log('buyer:', signer.address, ' name:', name);
const ario = ARIO.init({
  rpc, rpcSubscriptions, signer,
  coreProgramId: DEVNET_PROGRAM_IDS.core,
  garProgramId: DEVNET_PROGRAM_IDS.gar,
  arnsProgramId: DEVNET_PROGRAM_IDS.arns,
  antProgramId: DEVNET_PROGRAM_IDS.ant,
});
const cost = await ario.getTokenCost({ intent: 'Buy-Name', name, type: 'lease', years: 1 });
console.log('[read] Buy-Name lease 1y cost:', cost, 'mARIO');
const spawn = await spawnSolanaANT({ rpc, rpcSubscriptions, signer, state: { name }, antProgramId: DEVNET_PROGRAM_IDS.ant });
console.log('[spawn] ANT processId:', spawn.processId);
const buy = await ario.buyRecord({ name, type: 'lease', years: 1, processId: spawn.processId });
console.log('[buy] buyRecord:', jstr(buy));
try {
  console.log('[sync] syncAttributes:', jstr(await ario.syncAttributes({ name })));
} catch (e) {
  console.log('[sync] syncAttributes FAILED (non-fatal):', e.message);
}
const ant = await ANT.init({ processId: spawn.processId, rpc, rpcSubscriptions, signer, antProgramId: DEVNET_PROGRAM_IDS.ant });
const setRec = await ant.setRecord({ undername: '@', transactionId: dataItemId, ttlSeconds: 60 });
console.log(`[ant] setRecord '@' -> ${dataItemId}:`, jstr(setRec));
console.log('[read] getArNSRecord:', jstr(await ario.getArNSRecord({ name })));
console.log('[read] ANT getRecords:', jstr(await ant.getRecords()));

// ─── 4. resolve through the gateway ─────────────────────────────────────
// The gateway's base-name list re-hydrates on a miss at most every
// ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS (5s here), so poll.
console.log(`\n=== 4a. resolver endpoint: GET ${GATEWAY}/ar-io/resolver/${name} ===`);
let resolved;
for (let i = 0; i < 30; i++) {
  const res = await fetch(`${GATEWAY}/ar-io/resolver/${name}`);
  const body = await res.text();
  console.log(`attempt ${i + 1}: HTTP ${res.status}: ${body.slice(0, 300)}`);
  if (res.status === 200) {
    resolved = JSON.parse(body);
    break;
  }
  await sleep(3000);
}
if (!resolved) {
  console.log('RESOLVER ENDPOINT FAILED: never returned 200 — continuing to subdomain test anyway');
} else if (resolved.txId === dataItemId) {
  console.log(`RESOLVER OK: ${name} -> ${resolved.txId} (matches uploaded data item)`);
} else {
  console.log(`RESOLVER MISMATCH: expected ${dataItemId}, got ${resolved.txId}`);
}

// NOTE: fetch() drops a user-set Host header (forbidden per spec), so hit the
// real vhost URL — *.localhost resolves to loopback on this machine (verified:
// getent hosts foo.ar.localhost -> ::1). curl -H 'Host: ...' works too.
const nameUrl = `http://${name}.${ARNS_ROOT_HOST}:3000/`;
console.log(`\n=== 4b. subdomain serving: GET ${nameUrl} ===`);
let served = false;
let servedHeaders;
for (let i = 0; i < 30 && !served; i++) {
  const res = await fetch(nameUrl);
  const body = await res.text();
  console.log(`attempt ${i + 1}: HTTP ${res.status}, x-arns-resolved-id=${res.headers.get('x-arns-resolved-id')}, x-arns-ttl-seconds=${res.headers.get('x-arns-ttl-seconds')}`);
  if (res.status === 200 && body.includes(unique)) {
    served = true;
    servedHeaders = Object.fromEntries(res.headers.entries());
    console.log('body:\n' + body);
  } else if (res.status !== 200) {
    console.log('  body head:', body.slice(0, 200).replace(/\n/g, ' '));
  }
  if (!served) await sleep(3000);
}
if (served) console.log('served response headers:', jstr(servedHeaders));

console.log('\n=== summary ===');
console.log('data item id :', dataItemId);
console.log('arns name    :', name);
console.log('ant processId:', spawn.processId);
console.log(served
  ? `FULL STACK OK: http://${name}.${ARNS_ROOT_HOST}:3000/ serves the uploaded payload (unique string matched)`
  : 'FULL STACK FAILED: gateway did not serve the payload for the ArNS name');
process.exit(served ? 0 : 1);
