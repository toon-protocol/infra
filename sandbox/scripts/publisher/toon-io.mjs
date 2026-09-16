// The publisher's paid I/O against the sandbox: the real @toon-protocol/client
// payer behind blob.mjs's `io` seam. One client, one Solana mock-USDC channel
// against the hub (shared with the smokes through .toon-client/channels.json —
// one payer, one nonce watermark), and three things bought or read with it:
//
//   store.upload        a paid kind:5094 job on g.toon.store, sealed to the
//                       store connector, answered with an Arweave txid
//   relay.publish       a paid write on g.toon.relay
//   relay.findBlobRecord a FREE NIP-01 read at the relay, by `#x`, plus the
//                       local ledger that remembers which store txid holds
//                       each record's copy (the event cannot carry its own)
//
// Prices and routes are the sandbox's: conf/connector-relay.toml forwards
// g.toon.store to the store connector at {base 1000, per_kib 10} and sells
// g.toon.relay at 1; every packet also pays the hub's cut.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendJob } from '@toon-protocol/client';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { ROOT, HUB, RELAY_WS, openChannel, relayRead } from '../lib/provider-smoke.mjs';
import { K_BLOB } from './blob.mjs';

export const STORE_EDGE = process.env.STORE_EDGE_URL ?? 'http://localhost:3210';
export const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
export const STORE_ROUTE = 'g.toon.store';
export const RELAY_ROUTE = 'g.toon.relay';
// What a kind:5094 request declares it will pay; the connector charges the
// route price regardless (the same figure scripts/smoke-toon.mjs declares).
const STORE_BID = '1000000';

// ── the ledger: digest hex -> the store txid of that record's copy ─────────
// A Blob Record is signed before it is uploaded, so the event cannot name the
// txid of its own store copy; the publisher that made the upload remembers it
// here, and a later run that finds the record on the relay reports it from
// here. Under .toon-client/ like the channel store: sandbox state, wiped by
// `make clean`.
const LEDGER = join(ROOT, '.toon-client', 'publisher-records.json');
export function readLedger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
}
export function rememberRecord(digestHex, storeTxid) {
  mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
  const ledger = readLedger();
  ledger[digestHex] = storeTxid;
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
}

/** The newest Blob Record on the relay for `hex`, or null. */
export async function findBlobRecordOnRelay(hex) {
  const events = await relayRead({ kinds: [K_BLOB], '#x': [hex] }, `blob-${hex.slice(0, 8)}`);
  if (events.length === 0) return null;
  return events.reduce((newest, e) => (e.created_at > newest.created_at ? e : newest));
}

/**
 * The paid `io` for blob.mjs, plus `close()`. `secretKey` signs the kind:5094
 * job requests (the store does not care who; the publisher's own key keeps the
 * audit trail in one place).
 */
export async function openToonIo({ secretKey, log = () => {} }) {
  const { client, opened } = await openChannel(HUB);
  log(`paying ${HUB} on channel ${opened.channelId ?? '(id unreported)'}`);
  const store = {
    async upload(bytes, contentType) {
      const request = buildBlobStorageRequest({ blobData: Buffer.from(bytes), contentType, bid: STORE_BID }, secretKey);
      const answer = await sendJob({ client, destination: STORE_ROUTE, sealTo: STORE_EDGE, timeoutMs: 120_000 }, request);
      if (!answer.accepted) {
        throw new Error(`${STORE_ROUTE} refused a ${bytes.length}-byte upload: ${answer.code} ${answer.message}`);
      }
      const txid = answer.receipt?.txId ?? answer.receipt?.result?.txId;
      if (typeof txid !== 'string' || txid.length !== 43) {
        throw new Error(`the store answered no Arweave txid: ${JSON.stringify(answer.receipt).slice(0, 200)}`);
      }
      log(`stored ${bytes.length} bytes (${contentType}) -> ${txid}`);
      return txid;
    },
  };
  const relay = {
    async publish(event) {
      const written = await client.send(RELAY_ROUTE, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event }),
      });
      if (!written.fulfilled) throw new Error(`${RELAY_ROUTE} refused by ${written.refusedBy}: ${written.code} ${written.message}`);
      if (written.status !== 200) throw new Error(`the relay answered HTTP ${written.status}: ${written.text().slice(0, 200)}`);
      log(`published kind ${event.kind} ${event.id} to ${RELAY_WS}`);
    },
    async findBlobRecord(hex) {
      const event = await findBlobRecordOnRelay(hex);
      return event ? { event, store_txid: readLedger()[hex] ?? null } : null;
    },
  };
  return { store, relay, close: async () => client.close?.() };
}

/** GET {gateway}/raw/{txid}, retried while the gateway is still indexing the upload. */
export async function readRaw(txid, { attempts = 15, everyMs = 2000 } = {}) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${GATEWAY}/raw/${txid}`);
    if (res.status === 200) return Buffer.from(await res.arrayBuffer());
    last = `HTTP ${res.status}`;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`${GATEWAY}/raw/${txid}: ${last} after ${attempts} attempts`);
}
