// Smoke test: proves the whole sandbox in one run (run from sandbox/ on the
// host after `make up`; wired to `make smoke`).
//
//   0. anvil answers eth_chainId (31337) and arlocal answers /info
//   1. upload a payload with a unique string via the LOCAL Turbo bundler
//      (through the gateway's /bundler proxy) -> data-item id
//   2. verify the gateway serves /raw/<id> (optical path)
//   3. spawn an ANT + buy an ArNS name + set the ANT '@' record to that id
//      (against the LOCAL validator)
//   4. resolve the name THROUGH THE GATEWAY:
//        - GET /ar-io/resolver/<name>
//        - GET http://<name>.ar.localhost:3000/  (ArNS subdomain serving)
//      and require the unique string in the served body.
//
// Usage: node scripts/smoke-test.mjs [name]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TurboFactory } from '@ardrive/turbo-sdk';
import { createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes } from '@solana/kit';
import { ARIO, DEVNET_PROGRAM_IDS, spawnSolanaANT, ANT } from '@ar.io/sdk';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8900';
const ANVIL_URL = process.env.ANVIL_URL ?? 'http://localhost:8545';
const ARLOCAL_URL = process.env.ARLOCAL_URL ?? 'http://localhost:1984';
const ARNS_ROOT_HOST = 'ar.localhost';
const name = process.argv[2] ?? `toon-smoke-${Math.random().toString(36).slice(2, 8)}`;

const jstr = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`\nSMOKE TEST FAILED: ${msg}`); process.exit(1); };

// ─── 0. chain sanity: anvil + arlocal ───────────────────────────────────
console.log('=== 0. chain sanity ===');
{
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }).catch((e) => fail(`anvil unreachable at ${ANVIL_URL}: ${e.message}`));
  const { result } = await res.json();
  if (parseInt(result, 16) !== 31337) fail(`anvil eth_chainId = ${result}, expected 31337 (0x7a69)`);
  console.log(`anvil OK: eth_chainId = ${result} (31337)`);
}
{
  const res = await fetch(`${ARLOCAL_URL}/info`).catch((e) => fail(`arlocal unreachable at ${ARLOCAL_URL}: ${e.message}`));
  const info = await res.json();
  if (info.network == null) fail(`arlocal /info has no network field: ${JSON.stringify(info)}`);
  console.log(`arlocal OK: network = ${info.network}, height = ${info.height}`);
}

// ─── 1. upload via local Turbo ──────────────────────────────────────────
const jwk = JSON.parse(readFileSync(join(ROOT, 'keys', 'uploader-wallet.json')));
const unique = `TOON-sandbox-smoke-${Date.now()}`;
const payload = `hello from the TOON sandbox smoke test\nunique: ${unique}\nname: ${name}\n`;
console.log(`\n=== 1. upload payload via turbo-sdk -> ${GATEWAY}/bundler ===`);
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
      { name: 'App-Name', value: 'toon-sandbox-smoke' },
      { name: 'Content-Type', value: 'text/plain' },
      { name: 'Unique', value: unique },
    ],
  },
});
console.log('upload response:', jstr(upload));
const dataItemId = upload.id;

// ─── 2. gateway serves the raw id (optical path works) ──────────────────
// NOTE: /<id> can't be used — with ARNS_ROOT_HOST set, the sandbox
// middleware 302s any /<43charid> request to https://<base32id>.<root host>
// (no port), unreachable locally. /raw/<id> bypasses the sandbox.
console.log(`\n=== 2. gateway serves GET ${GATEWAY}/raw/${dataItemId} ===`);
let sane = false;
for (let i = 0; i < 15 && !sane; i++) {
  const res = await fetch(`${GATEWAY}/raw/${dataItemId}`);
  const body = res.status === 200 ? await res.text() : '';
  console.log(`attempt ${i + 1}: HTTP ${res.status}`);
  sane = body.includes(unique);
  if (!sane) await sleep(2000);
}
if (!sane) fail('gateway never served the uploaded data item by id');
console.log('OK: gateway serves the data item by id');

// ─── 3. buy the name on the local validator, point '@' at the data item ─
console.log('\n=== 3. buy ArNS name on the local validator ===');
const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(join(ROOT, 'keys', 'admin.json')))));
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
const ant = await ANT.init({ processId: spawn.processId, rpc, rpcSubscriptions, signer, antProgramId: DEVNET_PROGRAM_IDS.ant });
const setRec = await ant.setRecord({ undername: '@', transactionId: dataItemId, ttlSeconds: 60 });
console.log(`[ant] setRecord '@' -> ${dataItemId}:`, jstr(setRec));

// ─── 4a. resolver endpoint ──────────────────────────────────────────────
// The gateway's base-name list re-hydrates on a miss at most every
// ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS (5s here), so poll.
console.log(`\n=== 4a. resolver endpoint: GET ${GATEWAY}/ar-io/resolver/${name} ===`);
let resolved;
for (let i = 0; i < 30 && !resolved; i++) {
  const res = await fetch(`${GATEWAY}/ar-io/resolver/${name}`);
  const body = await res.text();
  console.log(`attempt ${i + 1}: HTTP ${res.status}: ${body.slice(0, 200)}`);
  if (res.status === 200) resolved = JSON.parse(body);
  else await sleep(3000);
}
if (!resolved) fail('resolver endpoint never returned 200');
if (resolved.txId !== dataItemId) fail(`resolver mismatch: expected ${dataItemId}, got ${resolved.txId}`);
console.log(`RESOLVER OK: ${name} -> ${resolved.txId} (matches uploaded data item)`);

// ─── 4b. subdomain serving ──────────────────────────────────────────────
// NOTE: fetch() drops a user-set Host header (forbidden per spec), so hit
// the real vhost URL — *.localhost resolves to loopback on modern systems.
const nameUrl = `http://${name}.${ARNS_ROOT_HOST}:3000/`;
console.log(`\n=== 4b. subdomain serving: GET ${nameUrl} ===`);
let served = false;
for (let i = 0; i < 30 && !served; i++) {
  const res = await fetch(nameUrl);
  const body = await res.text();
  console.log(`attempt ${i + 1}: HTTP ${res.status}, x-arns-resolved-id=${res.headers.get('x-arns-resolved-id')}`);
  if (res.status === 200 && body.includes(unique)) served = true;
  else await sleep(3000);
}
if (!served) fail(`gateway did not serve the payload at ${nameUrl}`);

console.log('\n=== summary ===');
console.log('data item id :', dataItemId);
console.log('arns name    :', name);
console.log('ant processId:', spawn.processId);
console.log(`\nSMOKE TEST OK: ${nameUrl} serves the uploaded payload (unique string matched); anvil + arlocal answered.`);
process.exit(0);
