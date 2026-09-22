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
//   remember            the write side of that ledger, free and local
//
// and, beside the seam, two free address lookups the verify commands read
// with: findBlobRecordOnRelay and findImageEntryOnRelay. (A Template's is in
// ../lib/template.mjs: a tenant reads one, and nothing tenant-side should
// have to reach through the publisher's paid I/O to do it.)
//
// Prices and routes are the sandbox's: conf/connector-relay.toml forwards
// g.toon.store to the store connector at {base 1000, per_kib 10} and sells
// g.toon.relay at 1; every packet also pays the hub's cut.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendJob } from '@toon-protocol/client';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { ROOT, HUB, RELAY_WS, K_IMAGE, STORE_EDGE, newestMatching, openChannel } from '../lib/provider-smoke.mjs';
import { K_BLOB } from './blob.mjs';

export { STORE_EDGE };
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
export const findBlobRecordOnRelay = (hex) => newestMatching({ kinds: [K_BLOB], '#x': [hex] }, `blob-${hex.slice(0, 8)}`);

/** The newest Image Registry entry on the relay at `30434:<pubkey>:<d>`, or null. */
export const findImageEntryOnRelay = (pubkey, d) => newestMatching({ kinds: [K_IMAGE], authors: [pubkey], '#d': [d] }, `image-${d}`);


/**
 * The paid `io` for blob.mjs, plus `close()`. `secretKey` signs the kind:5094
 * job requests (the store does not care who; the publisher's own key keeps the
 * audit trail in one place). A caller that already holds a client on the
 * hub channel (a smoke that is also the tenant) passes it as `client`: the
 * channel store admits one client at a time, and that caller keeps the
 * closing of it — `close()` is then a no-op.
 */
export async function openToonIo({ secretKey, log = () => {}, client: given }) {
  let client = given;
  if (!client) {
    const opened = await openChannel(HUB);
    client = opened.client;
    log(`paying ${HUB} on channel ${opened.opened.channelId ?? '(id unreported)'}`);
  }
  const store = {
    async upload(bytes, contentType) {
      const answer = await sendJob({ client, destination: STORE_ROUTE, sealTo: STORE_EDGE, timeoutMs: 120_000 },
        buildBlobStorageRequest({ blobData: Buffer.from(bytes), contentType, bid: STORE_BID }, secretKey));
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
  // The ledger write, behind the same seam: a publisher that stores a blob
  // notes which store upload holds its record's copy, so a later Image
  // Registry entry can cite it (image.mjs).
  const remember = async (digestHex, storeTxid) => rememberRecord(digestHex, storeTxid);
  return { store, relay, remember, close: async () => (given ? undefined : client.close?.()) };
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
