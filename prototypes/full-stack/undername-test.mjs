// PROTOTYPE — bonus check: undername record ('www') on an already-bought name.
// Usage: node undername-test.mjs <name> <antProcessId> <txId>
import { readFileSync } from 'node:fs';
import { createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes } from '@solana/kit';
import { ANT, DEVNET_PROGRAM_IDS } from '@ar.io/sdk';

const [name, processId, txId] = process.argv.slice(2);
if (!name || !processId || !txId) throw new Error('usage: node undername-test.mjs <name> <antProcessId> <txId>');

const rpc = createSolanaRpc('http://127.0.0.1:8899');
const rpcSubscriptions = createSolanaRpcSubscriptions('ws://127.0.0.1:8900');
const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(new URL('./keys/admin.json', import.meta.url)))));
const ant = await ANT.init({ processId, rpc, rpcSubscriptions, signer, antProgramId: DEVNET_PROGRAM_IDS.ant });
await ant.setRecord({ undername: 'www', transactionId: txId, ttlSeconds: 60 });
console.log('set www undername ->', txId);
console.log('records:', JSON.stringify(await ant.getRecords(), (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

// ArNS undername convention: <undername>_<basename>.<root host>
const url = `http://www_${name}.ar.localhost:3000/`;
for (let i = 0; i < 10; i++) {
  const res = await fetch(url);
  const body = await res.text();
  console.log(`GET ${url} -> HTTP ${res.status}, x-arns-record=${res.headers.get('x-arns-record')}, x-arns-resolved-id=${res.headers.get('x-arns-resolved-id')}`);
  if (res.status === 200) {
    console.log('body:\n' + body);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
process.exit(1);
