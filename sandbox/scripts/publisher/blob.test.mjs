// The blob publisher (TOON_Network #20), driven through its one seam: the
// paid I/O it is handed. Nothing here touches the network, the store or a
// relay; the fakes record what the publisher asked them to do and the tests
// assert on that and on what the publisher reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import {
  publishBlob, partListOf, signedRecordBytes, K_BLOB, TOON_LABEL, DATA_ITEM_MAX_BYTES, DATA_ITEM_ENVELOPE_BYTES, maxPartSize,
} from './blob.mjs';

const KiB = 1024;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Deterministic non-trivial bytes so parts differ and hashes are real. */
function bytes(n, seed = 1) {
  const out = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 0xff; }
  return out;
}

/** In-memory store + relay: every call is journaled, txids are minted in order. */
function fakeIo({ existing = null } = {}) {
  const uploads = []; // { bytes, contentType, txid }
  const published = []; // signed events
  return {
    uploads, published,
    store: {
      async upload(data, contentType) {
        const txid = `tx${String(uploads.length + 1).padStart(41, '0')}`; // 43 chars, like Arweave
        uploads.push({ bytes: Buffer.from(data), contentType, txid });
        return txid;
      },
    },
    relay: {
      async publish(event) { published.push(event); },
      async findBlobRecord(hex) { return existing && existing.hex === hex ? existing.found : null; },
    },
  };
}

test('a 250 KiB blob at a 100 KiB part size is three uploads and one Blob Record of the spec shape', async () => {
  const data = bytes(250 * KiB);
  const secretKey = generateSecretKey();
  const io = fakeIo();

  const report = await publishBlob({ bytes: data, secretKey, partSize: 100 * KiB, io });

  // Three part uploads, in order, then the record's own copy.
  const parts = io.uploads.slice(0, 3);
  assert.deepEqual(parts.map((u) => u.bytes.length), [100 * KiB, 100 * KiB, 50 * KiB]);
  assert.ok(parts.every((u) => u.contentType === 'application/octet-stream'));
  assert.equal(Buffer.concat(parts.map((u) => u.bytes)).equals(data), true, 'the parts concatenate to the blob');

  // The Blob Record, as spec §8.2 draws it.
  const hex = sha256(data);
  const [record] = io.published;
  assert.equal(io.published.length, 1);
  assert.equal(record.kind, K_BLOB);
  assert.equal(record.pubkey, getPublicKey(secretKey));
  assert.ok(verifyEvent(record), 'the record is signed by the publisher key');
  assert.deepEqual(record.tags, [['d', `sha256:${hex}`], ['x', hex], ['L', TOON_LABEL]]);
  assert.deepEqual(JSON.parse(record.content), {
    digest: `sha256:${hex}`,
    size: 250 * KiB,
    part_size: 100 * KiB,
    parts: parts.map((u) => ({ txid: u.txid, sha256: sha256(u.bytes), size: u.bytes.length })),
  });

  // Reported identifiers.
  assert.equal(report.skipped, false);
  assert.equal(report.digest, `sha256:${hex}`);
  assert.deepEqual(report.parts.map((p) => p.txid), parts.map((u) => u.txid));
  assert.equal(report.record.event_id, record.id);
  assert.equal(io.uploads[3].bytes.length, signedRecordBytes({ digestHex: hex, size: 250 * KiB, partSize: 100 * KiB, partSizes: [100 * KiB, 100 * KiB, 50 * KiB], createdAt: record.created_at }),
    'the pre-upload size estimate of the signed record is exact');
});

test('the Blob Record is published to the relay and the byte-identical signed event is uploaded to the store', async () => {
  const io = fakeIo();
  const report = await publishBlob({ bytes: bytes(30 * KiB, 7), secretKey: generateSecretKey(), partSize: 100 * KiB, io });

  assert.equal(io.uploads.length, 2, 'one part, then the record copy');
  const copy = io.uploads[1];
  assert.equal(copy.contentType, 'application/json');
  assert.equal(copy.bytes.toString('utf8'), JSON.stringify(io.published[0]), 'the store copy is the relay event, byte for byte');
  assert.equal(report.record.store_txid, copy.txid);
  assert.equal(report.record.event_id, io.published[0].id);
});

test('a part size over the data item cap is refused before any upload', async () => {
  const io = fakeIo();
  const partSize = maxPartSize() + 1;
  await assert.rejects(
    publishBlob({ bytes: bytes(10), secretKey: generateSecretKey(), partSize, io }),
    (e) => e.message.includes(String(partSize)) && e.message.includes(String(DATA_ITEM_MAX_BYTES)),
  );
  assert.equal(io.uploads.length, 0);
  assert.equal(io.published.length, 0);
});

test('the largest allowed part still fits the store data item with its envelope', () => {
  assert.equal(maxPartSize() + DATA_ITEM_ENVELOPE_BYTES, DATA_ITEM_MAX_BYTES);
  assert.ok(maxPartSize() >= 102_400, 'the sandbox default of 100 KiB is allowed');
});

test('a blob whose inline record would not fit one data item is PAGED: every part, then every page, then the record (spec §8.2)', async () => {
  const data = bytes(1024 * KiB, 3);
  const io = fakeIo();
  // 1 KiB parts of a 1 MiB blob = 1024 parts: ~145 bytes each inline, well over 107,520.
  const report = await publishBlob({ bytes: data, secretKey: generateSecretKey(), partSize: KiB, io });

  const parts = io.uploads.slice(0, 1024);
  assert.ok(parts.every((u) => u.contentType === 'application/octet-stream' && u.bytes.length === KiB));
  const pages = io.uploads.slice(1024, -1);
  assert.ok(pages.length >= 2, `${pages.length} pages`);
  assert.ok(pages.every((u) => u.contentType === 'application/json' && u.bytes.length <= maxPartSize()), 'every page fits one upload');

  const content = JSON.parse(io.published[0].content);
  assert.equal('parts' in content, false, 'a paged record lists no parts inline');
  assert.deepEqual(content.pages, pages.map((u) => ({ txid: u.txid, sha256: sha256(u.bytes), parts: JSON.parse(u.bytes).length })));
  assert.deepEqual(pages.flatMap((u) => JSON.parse(u.bytes)), parts.map((u) => ({ txid: u.txid, sha256: sha256(u.bytes), size: KiB })),
    "the pages, joined in order, are exactly the part list `parts` would have been");
  assert.deepEqual(report.pages, content.pages);
  assert.equal(report.parts.length, 1024, 'the report still carries the whole part list');
  assert.equal(io.uploads.at(-1).bytes.toString('utf8'), JSON.stringify(io.published[0]), 'and the store copy is the signed record');
});

test('a LOWERED record ceiling pages a small blob on purpose, parts_per_page parts to a page', async () => {
  const io = fakeIo();
  const report = await publishBlob({ bytes: bytes(10 * KiB, 5), secretKey: generateSecretKey(), partSize: KiB, recordMax: 1024, partsPerPage: 4, io });
  assert.deepEqual(report.pages.map((p) => p.parts), [4, 4, 2]);
  const inline = await publishBlob({ bytes: bytes(10 * KiB, 5), secretKey: generateSecretKey(), partSize: KiB, io: fakeIo() });
  assert.equal(inline.pages, null, 'the same blob at the store\'s own ceiling stays inline');
});

test('a record ceiling above the data item is refused before any upload', async () => {
  const io = fakeIo();
  await assert.rejects(publishBlob({ bytes: bytes(10), secretKey: generateSecretKey(), recordMax: DATA_ITEM_MAX_BYTES + 1, io }), /would not fit one store data item/);
  assert.equal(io.uploads.length, 0);
});

test('partListOf reads a paged record as a reader must: each page checked before a part from it is trusted', async () => {
  const io = fakeIo();
  await publishBlob({ bytes: bytes(10 * KiB, 5), secretKey: generateSecretKey(), partSize: KiB, recordMax: 1024, partsPerPage: 4, io });
  const byTxid = new Map(io.uploads.map((u) => [u.txid, u.bytes]));
  const readRaw = async (txid) => byTxid.get(txid) ?? Promise.reject(new Error('404'));
  const content = JSON.parse(io.published[0].content);

  const read = await partListOf(content, readRaw);
  assert.deepEqual(read.problems, []);
  assert.equal(read.parts.length, 10);
  assert.ok(read.pages.every((p) => p.ok));
  assert.deepEqual(Buffer.concat(read.parts.map((p) => byTxid.get(p.txid))), bytes(10 * KiB, 5));

  const tampered = { ...content, pages: content.pages.map((p, i) => (i === 1 ? { ...p, parts: 3 } : p)) };
  const bad = await partListOf(tampered, readRaw);
  assert.equal(bad.parts, null);
  assert.match(bad.problems[0], /page 1 .*lists 4 part objects, not 3/);

  const both = await partListOf({ ...content, parts: [] }, readRaw);
  assert.match(both.problems[0], /carries both/);
  assert.deepEqual((await partListOf({ parts: [{ txid: 'x', sha256: 'y', size: 1 }] }, readRaw)).parts.length, 1);
});

test('a blob already recorded on the relay is skipped: no upload, the existing identifiers reported', async () => {
  const data = bytes(120 * KiB, 9);
  const hex = sha256(data);
  const found = { event: { id: 'e'.repeat(64), kind: K_BLOB, tags: [['d', `sha256:${hex}`], ['x', hex]] }, store_txid: 'r'.repeat(43) };
  const io = fakeIo({ existing: { hex, found } });

  const report = await publishBlob({ bytes: data, secretKey: generateSecretKey(), partSize: 100 * KiB, io });

  assert.equal(io.uploads.length, 0);
  assert.equal(io.published.length, 0);
  assert.equal(report.skipped, true);
  assert.equal(report.digest, `sha256:${hex}`);
  assert.equal(report.record.event_id, found.event.id);
  assert.equal(report.record.store_txid, found.store_txid);
});

test('at the sandbox part size an inline record holds 689 parts (a 67 MiB blob) and the 690th pages', async () => {
  const io = fakeIo();
  const at = (n) => signedRecordBytes({ digestHex: 'a'.repeat(64), size: n * 102_400, partSize: 102_400, partSizes: Array(n).fill(102_400), createdAt: 1_789_565_195 });
  assert.ok(at(689) <= DATA_ITEM_MAX_BYTES, `689 parts: ${at(689)} bytes`);
  assert.ok(at(690) > DATA_ITEM_MAX_BYTES, `690 parts: ${at(690)} bytes`);
  assert.equal(io.uploads.length, 0);
});
