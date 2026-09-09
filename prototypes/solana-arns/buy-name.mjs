// PROTOTYPE — throwaway. Drives the @ar.io/sdk v4 against the local validator:
//   1. ARIO.init with RPC + program-id overrides (= SDK DEVNET_PROGRAM_IDS,
//      which equal the staging ids the compose file loads at genesis)
//   2. read: getInfo / getTokenCost (Buy-Name quote)
//   3. spawnSolanaANT — mints the MPL Core asset + ario-ant PDAs (the "ANT")
//   4. buyRecord({ name, type: lease, years: 1, processId }) — the store's shape
//   5. syncAttributes (holder-gated; we ARE the holder here, should succeed)
//   6. read back the ArNS record + ANT state, print everything
// Usage: node buy-name.mjs [name]   (default: toon-proto-<rand>)
import {
  createSolanaRpc, createSolanaRpcSubscriptions, createKeyPairSignerFromBytes,
} from '@solana/kit';
import { ARIO, DEVNET_PROGRAM_IDS, spawnSolanaANT, ANT } from '@ar.io/sdk';
import { readFileSync } from 'node:fs';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8900';
const name = process.argv[2] ?? `toon-proto-${Math.random().toString(36).slice(2, 8)}`;

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync('keys/admin.json'))));
console.log('signer (buyer):', signer.address);
console.log('name to buy   :', name);
console.log('program ids   :', JSON.stringify(DEVNET_PROGRAM_IDS));

const ario = ARIO.init({
  rpc,
  rpcSubscriptions,
  signer,
  coreProgramId: DEVNET_PROGRAM_IDS.core,
  garProgramId: DEVNET_PROGRAM_IDS.gar,
  arnsProgramId: DEVNET_PROGRAM_IDS.arns,
  antProgramId: DEVNET_PROGRAM_IDS.ant,
});

// ── reads before ────────────────────────────────────────────────────────
console.log('\n[read] getBalance(buyer):', await ario.getBalance({ address: signer.address }));
const cost = await ario.getTokenCost({ intent: 'Buy-Name', name, type: 'lease', years: 1 });
console.log('[read] getTokenCost Buy-Name lease 1y:', cost, 'mARIO');
console.log('[read] getArNSRecord before:', await ario.getArNSRecord({ name }).catch((e) => `not found (${e.message})`));

// ── spawn ANT ───────────────────────────────────────────────────────────
const spawn = await spawnSolanaANT({
  rpc,
  rpcSubscriptions,
  signer,
  state: { name },
  antProgramId: DEVNET_PROGRAM_IDS.ant,
});
console.log('\n[spawn] ANT spawned:', JSON.stringify(spawn, null, 2));

// ── buy the name against the spawned ANT ────────────────────────────────
const buy = await ario.buyRecord({ name, type: 'lease', years: 1, processId: spawn.processId });
console.log('\n[buy] buyRecord result:', JSON.stringify(buy, null, 2));

// ── holder-side attribute reconcile ─────────────────────────────────────
try {
  const sync = await ario.syncAttributes({ name });
  console.log('\n[sync] syncAttributes:', JSON.stringify(sync, null, 2));
} catch (e) {
  console.log('\n[sync] syncAttributes FAILED (non-fatal):', e.message);
}

// ── reads after ─────────────────────────────────────────────────────────
const record = await ario.getArNSRecord({ name });
console.log('\n[read] getArNSRecord after:', JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log('[read] getBalance(buyer) after:', await ario.getBalance({ address: signer.address }));

const ant = await ANT.init({
  processId: spawn.processId,
  rpc,
  rpcSubscriptions,
  signer,
  antProgramId: DEVNET_PROGRAM_IDS.ant,
});
console.log('\n[read] ANT getInfo:', JSON.stringify(await ant.getInfo(), (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

// ── set an explicit target on the ANT's root record ─────────────────────
const TARGET_TX = 'BNttzDav3jHVnNiV7nYbQv-GY0HQ-4XXsdkE5K9ylHQ'; // arbitrary well-formed Arweave tx id
const setRec = await ant.setRecord({ undername: '@', transactionId: TARGET_TX, ttlSeconds: 900 });
console.log('\n[ant] setRecord @ ->', TARGET_TX, ':', JSON.stringify(setRec));
console.log('[read] ANT getRecords:', JSON.stringify(await ant.getRecords(), (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

console.log('\nDONE: bought ArNS name + spawned ANT fully locally.');
