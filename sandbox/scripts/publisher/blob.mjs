// Store a blob as parts in the TOON store and publish its Blob Record
// (TOON_Network #20, #73, #76; spec §8.2, §11 item 2, ADR 0006).
//
// A blob — a layer, a config, a manifest — is split at `partSize`, every part
// is one paid kind:5094 store upload, and the Blob Record lists the parts in
// order with their transaction ids and hashes: INLINE (`parts`) when the
// signed record fits one store data item, PAGED (`pages`) when it does not —
// each page one more upload of its own, the JSON array of a slice of the part
// list. WHICH SHAPE, and what every page's bytes are, is not decided here:
// it is `planBlobRecord` in the provider checkout's tools/publisher/blob.mjs
// (PROVIDER_CONTEXT, default ../../provider), imported rather than restated,
// so the pages this sandbox uploads are the pages that tool's tests and the
// provider's own reader are proven against. This file is the rest of a
// publisher that module leaves to its caller on purpose: the key that signs
// the record, and the money that uploads it. The record is published to the
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
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { finalizeEvent } from 'nostr-tools/pure';
import { K_BLOB, ROOT, TOON_LABEL } from '../lib/provider-smoke.mjs';

export { K_BLOB, TOON_LABEL };

// THE CANONICAL PLANNER, from the provider checkout the provider images build
// from (the Makefile exports PROVIDER_CONTEXT, relative to sandbox/).
const PLANNER = join(resolve(ROOT, process.env.PROVIDER_CONTEXT ?? join('..', '..', 'provider')), 'tools', 'publisher', 'blob.mjs');
if (!existsSync(PLANNER)) {
  throw new Error(`the Blob Record planner is not at ${PLANNER}: the provider checkout (toon-protocol/provider, with tools/publisher/blob.mjs) is expected at ../../provider; PROVIDER_CONTEXT=/path/to/provider says where else`);
}
const { planBlobRecord } = await import(pathToFileURL(PLANNER).href);

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

/** The hex of a `sha256:<hex>` digest — what an `x` tag and a `#x` filter carry. */
export function hexOf(digest) {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1];
  if (!hex) throw new Error(`not a sha256 digest: ${digest}`);
  return hex;
}

/** `bytes` cut into `partSize` pieces, the last one shorter. An empty blob has no parts. */
export function splitParts(bytes, partSize) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += partSize) {
    parts.push(bytes.subarray(offset, Math.min(offset + partSize, bytes.length)));
  }
  return parts;
}

/**
 * The unsigned Blob Record for `digestHex`: over `parts` ([{ txid, sha256,
 * size }], in order) inline, or over `pages` ([{ txid, sha256, parts }], in
 * order) when it is paged — exactly one of the two (spec §8.2).
 */
export function blobRecordTemplate({ digestHex, size, partSize, parts, pages = null, createdAt }) {
  return {
    kind: K_BLOB,
    created_at: createdAt,
    tags: [['d', `sha256:${digestHex}`], ['x', digestHex], ['L', TOON_LABEL]],
    content: JSON.stringify({ digest: `sha256:${digestHex}`, size, part_size: partSize, ...(pages === null ? { parts } : { pages }) }),
  };
}

// A signed event is the template plus `id` (64 hex), `pubkey` (64 hex) and
// `sig` (128 hex) — the JSON grows by these three fields exactly.
const SIGNED_OVERHEAD = JSON.stringify({ id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128) }).length - 1;
const ARWEAVE_TXID_LEN = 43;
// A txid of the real length, for sizing an upload before it has one: a page
// lists its parts' txids, so a page planned with these is the size the real
// one will be.
const PENDING_TXID = 'T'.repeat(ARWEAVE_TXID_LEN);

/**
 * How many bytes the SIGNED record JSON will be once every part has a real
 * txid and hash, computed before any part is uploaded: txids are always 43
 * chars and hashes 64, so only the sizes vary and those are known now.
 */
export function signedRecordBytes({ digestHex, size, partSize, partSizes, pageCounts = null, createdAt }) {
  const parts = partSizes.map((s) => ({ txid: PENDING_TXID, sha256: 'h'.repeat(64), size: s }));
  const pages = pageCounts === null ? null : pageCounts.map((n) => ({ txid: PENDING_TXID, sha256: 'h'.repeat(64), parts: n }));
  return JSON.stringify(blobRecordTemplate({ digestHex, size, partSize, parts, pages, createdAt })).length + SIGNED_OVERHEAD;
}

/**
 * What storing `bytes` at `partSize` will take, decided before anything is
 * paid for: the digest, the pieces, the record's SHAPE and the size of the
 * signed record they will make.
 *
 * The shape is `planBlobRecord`'s (see the top of this file): inline when the
 * signed record fits `recordMax`, paged otherwise, `partsPerPage` part
 * objects to a page (default: as many as fit one upload). `recordMax` is the
 * store's own ceiling unless it is LOWERED to page a small blob on purpose —
 * which is how `make smoke-m7` publishes a paged record without storing
 * 70 MB. Throws when `partSize` does not fit one store data item, or when a
 * page or the record itself would not.
 */
export function planBlob({
  bytes, partSize = DEFAULT_PART_SIZE, dataItemMax = DATA_ITEM_MAX_BYTES, recordMax = dataItemMax, partsPerPage, createdAt,
}) {
  if (!Number.isInteger(partSize) || partSize <= 0) throw new Error(`part size must be a positive integer, got ${partSize}`);
  const cap = maxPartSize(dataItemMax);
  if (partSize > cap) {
    throw new Error(
      `part size ${partSize} does not fit one store data item: the cap is ${dataItemMax} bytes ` +
        `including the store's envelope, so the largest part is ${cap} bytes`,
    );
  }
  if (recordMax > dataItemMax) {
    throw new Error(`a record kept inline up to ${recordMax} bytes would not fit one store data item of ${dataItemMax}`);
  }

  const digestHex = sha256Hex(bytes);
  const size = bytes.length;
  const pieces = splitParts(bytes, partSize);
  const shape = planBlobRecord({ bytes, partSize, dataItemMax: recordMax, partsPerPage, txidOf: () => PENDING_TXID });
  const pageSizes = shape.uploads.filter((u) => u.kind === 'page').map((u) => u.bytes.length);
  const tooBig = pageSizes.findIndex((n) => n > cap);
  if (tooBig !== -1) {
    throw new Error(`page ${tooBig} of the Blob Record for sha256:${digestHex} would be ${pageSizes[tooBig]} bytes, more than one store upload (${cap}): fewer parts per page`);
  }
  const recordBytes = signedRecordBytes({
    digestHex, size, partSize, partSizes: pieces.map((p) => p.length), pageCounts: shape.pages?.map((p) => p.parts) ?? null, createdAt,
  });
  if (recordBytes > dataItemMax) {
    throw new Error(
      `the Blob Record for sha256:${digestHex} would be ${recordBytes} bytes ${shape.pages === null ? `over ${pieces.length} parts` : `over ${shape.pages.length} pages`} — ` +
        `more than one store data item (${dataItemMax} bytes)${shape.pages === null ? '' : ': more parts per page'}`,
    );
  }
  return { digestHex, digest: `sha256:${digestHex}`, size, pieces, pages: shape.pages?.length ?? null, recordBytes };
}

/**
 * Store `bytes` as parts and publish the Blob Record. Resolves to
 *   { skipped: false, digest, size, part_size, parts: [{ txid, sha256, size }], pages, record: { event_id, store_txid, event } }
 * where `parts` is the whole ordered part list whichever shape the record
 * took, and `pages` is null for an inline record and [{ txid, sha256, parts }]
 * for a paged one; or, when the relay already has a record for this digest,
 *   { skipped: true, digest, size, record: { event_id, store_txid, event } }
 * (`store_txid` is null there when nobody recorded which store copy is the record's).
 * Throws, via `planBlob`, before touching the network when a part, a page or the record would not fit a data item.
 */
export async function publishBlob({
  bytes, secretKey, partSize = DEFAULT_PART_SIZE, io, dataItemMax = DATA_ITEM_MAX_BYTES, recordMax = dataItemMax, partsPerPage,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const createdAt = now();
  const { digestHex, digest, size, pieces, pages: paged } = planBlob({ bytes, partSize, dataItemMax, recordMax, partsPerPage, createdAt });

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

  // A PAGED record: plan again with the txids the parts really got — a page
  // is the JSON of its parts, so its bytes exist only now — and upload every
  // page. A page's own txid is not in its bytes, only in the record.
  let pages = null;
  if (paged !== null) {
    const planned = planBlobRecord({
      bytes, partSize, dataItemMax: recordMax, partsPerPage,
      txidOf: (_, kind, i) => (kind === 'part' ? parts[i].txid : PENDING_TXID),
    });
    pages = [];
    for (const [i, upload] of planned.uploads.filter((u) => u.kind === 'page').entries()) {
      const txid = await io.store.upload(upload.bytes, 'application/json');
      pages.push({ txid, sha256: planned.pages[i].sha256, parts: planned.pages[i].parts });
    }
  }

  const event = finalizeEvent(blobRecordTemplate({ digestHex, size, partSize, parts, pages, createdAt }), secretKey);
  const json = JSON.stringify(event);
  await io.relay.publish(event);
  const storeTxid = await io.store.upload(Buffer.from(json, 'utf8'), 'application/json');

  return {
    skipped: false, digest, size, part_size: partSize, parts, pages,
    record: { event_id: event.id, store_txid: storeTxid, event },
  };
}

/**
 * The ordered part list a Blob Record's content names, however it names it —
 * read the way spec §8.2 tells a reader to: `parts` as is, or every page
 * fetched with `readRaw(txid)`, its sha256 and its part count checked BEFORE
 * a part from it is trusted, and the pages' lists joined in page order.
 *
 * Returns `{ parts, pages, problems }`: `pages` null for an inline record,
 * else `[{ txid, sha256, parts, ok, why? }]`; `problems` every reason the list
 * cannot be trusted (both shapes, neither, a page that failed) — `parts` is
 * null whenever it is not empty. It asserts nothing; the verifiers do.
 */
export async function partListOf(content, readRaw) {
  const hasParts = Array.isArray(content?.parts);
  const hasPages = Array.isArray(content?.pages);
  if (hasParts === hasPages) {
    return { parts: null, pages: null, problems: [`a Blob Record carries exactly one of \`parts\` or \`pages\`, and this one carries ${hasParts ? 'both' : 'neither'}`] };
  }
  if (hasParts) return { parts: content.parts, pages: null, problems: [] };
  const parts = [];
  const pages = [];
  const problems = [];
  for (const [i, page] of content.pages.entries()) {
    let why = null;
    try {
      const bytes = await readRaw(page.txid);
      const listed = sha256Hex(bytes) === page.sha256 ? JSON.parse(bytes.toString('utf8')) : null;
      if (listed === null) why = `its bytes do not hash to ${page.sha256}`;
      else if (!Array.isArray(listed) || listed.length !== page.parts) why = `it lists ${Array.isArray(listed) ? listed.length : 'no'} part objects, not ${page.parts}`;
      else parts.push(...listed);
    } catch (e) {
      why = `unreadable: ${e.message}`;
    }
    pages.push({ ...page, ok: why === null, ...(why === null ? {} : { why }) });
    if (why !== null) problems.push(`page ${i} (${page.txid}): ${why}`);
  }
  return { parts: problems.length === 0 ? parts : null, pages, problems };
}
