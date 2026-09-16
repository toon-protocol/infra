// Store a blob as parts in the TOON store and publish its Blob Record
// (TOON_Network #20; spec §8.2, ADR 0006).
//
// A blob — a layer, a config, a manifest — is split at `partSize`, every part
// is one paid kind:5094 store upload, and the Blob Record lists the parts in
// order with their transaction ids and hashes. The record is published to the
// relay (kind K_BLOB, addressable by `d = "sha256:<hex>"`, findable by `#x`)
// AND uploaded once, as the byte-identical signed event JSON, to the store:
// that upload's txid is what an Image Registry entry cites, so the part list
// outlives every relay.
//
// Everything paid goes through `io`, the one seam (see toon-io.mjs for the
// real payers and blob.test.mjs for the fakes):
//
//   io.store.upload(bytes, contentType)  -> txid          one kind:5094 job
//   io.relay.publish(event)              -> void          one paid relay write
//   io.relay.findBlobRecord(hex)         -> { event, store_txid? } | null
//
// Nothing here knows about money, channels or connectors.
import { createHash } from 'node:crypto';
import { finalizeEvent } from 'nostr-tools/pure';
import { K_BLOB, TOON_LABEL } from '../lib/provider-smoke.mjs';

export { K_BLOB, TOON_LABEL };

// The sandbox store serves Turbo's free tier only: a SIGNED ANS-104 data item
// of at most 107,520 bytes (conf/store.conf, README §6.4). The store measures
// that ceiling on the signed item, not the payload — the ed25519 envelope
// (2 + 64 + 32 + 1 + 1 + 8 + 8 = 116 bytes) plus the avro tag block it adds
// (`Content-Type` and its own app tags). 256 bytes covers that with room, so
// a part of `maxPartSize()` bytes is accepted and one byte more is refused
// HERE rather than by the store halfway through an upload.
export const DATA_ITEM_MAX_BYTES = 107_520;
export const DATA_ITEM_ENVELOPE_BYTES = 256;
/** The sandbox part size: 100 KiB, under the cap with the envelope to spare. */
export const DEFAULT_PART_SIZE = 102_400;

/** The largest part `dataItemMax` admits once the store's envelope is added. */
export const maxPartSize = (dataItemMax = DATA_ITEM_MAX_BYTES) => dataItemMax - DATA_ITEM_ENVELOPE_BYTES;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** `bytes` cut into `partSize` pieces, the last one shorter. An empty blob has no parts. */
export function splitParts(bytes, partSize) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += partSize) {
    parts.push(bytes.subarray(offset, Math.min(offset + partSize, bytes.length)));
  }
  return parts;
}

/** The unsigned Blob Record for `digestHex` over `parts` ([{ txid, sha256, size }], in order). */
export function blobRecordTemplate({ digestHex, size, partSize, parts, createdAt }) {
  return {
    kind: K_BLOB,
    created_at: createdAt,
    tags: [['d', `sha256:${digestHex}`], ['x', digestHex], ['L', TOON_LABEL]],
    content: JSON.stringify({ digest: `sha256:${digestHex}`, size, part_size: partSize, parts }),
  };
}

// A signed event is the template plus `id` (64 hex), `pubkey` (64 hex) and
// `sig` (128 hex) — the JSON grows by these three fields exactly.
const SIGNED_OVERHEAD = JSON.stringify({ id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128) }).length - 1;
const ARWEAVE_TXID_LEN = 43;

/**
 * How many bytes the SIGNED record JSON will be once every part has a real
 * txid and hash, computed before any part is uploaded: txids are always 43
 * chars and hashes 64, so only the sizes vary and those are known now.
 */
export function signedRecordBytes({ digestHex, size, partSize, partSizes, createdAt }) {
  const parts = partSizes.map((s) => ({ txid: 'T'.repeat(ARWEAVE_TXID_LEN), sha256: 'h'.repeat(64), size: s }));
  return JSON.stringify(blobRecordTemplate({ digestHex, size, partSize, parts, createdAt })).length + SIGNED_OVERHEAD;
}

/**
 * What storing `bytes` at `partSize` will take, decided before anything is
 * paid for: the digest, the pieces, and the size of the signed record they
 * will make. Throws when `partSize` does not fit one store data item, or when
 * the record would not — naming, in that case, the part size that would.
 */
export function planBlob({ bytes, partSize = DEFAULT_PART_SIZE, dataItemMax = DATA_ITEM_MAX_BYTES, createdAt }) {
  if (!Number.isInteger(partSize) || partSize <= 0) throw new Error(`part size must be a positive integer, got ${partSize}`);
  const cap = maxPartSize(dataItemMax);
  if (partSize > cap) {
    throw new Error(
      `part size ${partSize} does not fit one store data item: the cap is ${dataItemMax} bytes ` +
        `including the store's envelope, so the largest part is ${cap} bytes`,
    );
  }

  const digestHex = sha256Hex(bytes);
  const size = bytes.length;
  const pieces = splitParts(bytes, partSize);
  const recordBytes = signedRecordBytes({ digestHex, size, partSize, partSizes: pieces.map((p) => p.length), createdAt });
  if (recordBytes > dataItemMax) {
    const raiseTo = smallestFittingPartSize({ digestHex, size, createdAt, dataItemMax });
    throw new Error(
      `the Blob Record for sha256:${digestHex} would be ${recordBytes} bytes over ${pieces.length} parts of ${partSize} — ` +
        `more than one store data item (${dataItemMax} bytes). Raise the part size to ${raiseTo}` +
        (raiseTo > cap ? `, which is over the ${cap}-byte part cap: this blob cannot be stored at this data item size` : ' so the record fits'),
    );
  }
  return { digestHex, digest: `sha256:${digestHex}`, size, pieces, recordBytes };
}

/** The smallest part size whose record fits `dataItemMax` (binary search; 1 KiB granularity). */
function smallestFittingPartSize({ digestHex, size, createdAt, dataItemMax }) {
  const fits = (partSize) => signedRecordBytes({
    digestHex, size, partSize, partSizes: splitParts({ length: size, subarray: (a, b) => ({ length: b - a }) }, partSize).map((p) => p.length), createdAt,
  }) <= dataItemMax;
  let lo = 1, hi = size;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) hi = mid; else lo = mid + 1; }
  return Math.ceil(lo / 1024) * 1024;
}

/**
 * Store `bytes` as parts and publish the Blob Record. Resolves to
 *   { skipped: false, digest, size, part_size, parts: [{ txid, sha256, size }], record: { event_id, store_txid, event } }
 * or, when the relay already has a record for this digest,
 *   { skipped: true, digest, size, record: { event_id, store_txid, event } }
 * (`store_txid` is null there when nobody recorded which store copy is the record's).
 * Throws, via `planBlob`, before touching the network when `partSize` or the record would not fit a data item.
 */
export async function publishBlob({ bytes, secretKey, partSize = DEFAULT_PART_SIZE, io, dataItemMax = DATA_ITEM_MAX_BYTES, now = () => Math.floor(Date.now() / 1000) }) {
  const createdAt = now();
  const { digestHex, digest, size, pieces } = planBlob({ bytes, partSize, dataItemMax, createdAt });

  const existing = await io.relay.findBlobRecord(digestHex);
  if (existing) {
    return {
      skipped: true, digest, size,
      record: { event_id: existing.event.id, store_txid: existing.store_txid ?? null, event: existing.event },
    };
  }

  const parts = [];
  for (const piece of pieces) {
    const txid = await io.store.upload(piece, 'application/octet-stream');
    parts.push({ txid, sha256: sha256Hex(piece), size: piece.length });
  }

  const event = finalizeEvent(blobRecordTemplate({ digestHex, size, partSize, parts, createdAt }), secretKey);
  const json = JSON.stringify(event);
  await io.relay.publish(event);
  const storeTxid = await io.store.upload(Buffer.from(json, 'utf8'), 'application/json');

  return {
    skipped: false, digest, size, part_size: partSize, parts,
    record: { event_id: event.id, store_txid: storeTxid, event },
  };
}
