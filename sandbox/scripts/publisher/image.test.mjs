// The image publisher (TOON_Network #21), driven through its two seams: the
// OCI layout it is pointed at (a real one, written to a temp directory) and
// the paid I/O it is handed (in-memory fakes, as in blob.test.mjs). Nothing
// here touches the network, the store, a relay or Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { K_BLOB, TOON_LABEL } from './blob.mjs';
import { publishImage, resolveUpstream, imageEntryTemplate, K_IMAGE } from './image.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const jsonBlob = (o) => Buffer.from(JSON.stringify(o), 'utf8');
const MT = {
  index: 'application/vnd.oci.image.index.v1+json',
  manifest: 'application/vnd.oci.image.manifest.v1+json',
  config: 'application/vnd.oci.image.config.v1+json',
  layer: 'application/vnd.oci.image.layer.v1.tar+gzip',
};

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** Deterministic non-trivial bytes, so every layer differs and hashes are real. */
function bytes(n, seed) {
  const out = Buffer.alloc(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x & 0xff; }
  return out;
}

/** Collects blobs and hands back OCI descriptors for them. */
function blobs() {
  const held = new Map(); // hex -> Buffer
  const add = (buf, mediaType) => {
    const hex = sha(buf);
    held.set(hex, buf);
    return { mediaType, digest: `sha256:${hex}`, size: buf.length };
  };
  return {
    held, add,
    /** A single-platform image: layers, a config over them, and the manifest. */
    image(layers, marker = 0) {
      const layerDescs = layers.map((b) => add(b, MT.layer));
      const config = add(jsonBlob({
        architecture: 'amd64', os: 'linux', marker,
        rootfs: { type: 'layers', diff_ids: layerDescs.map((d) => d.digest) },
      }), MT.config);
      const manifest = add(jsonBlob({ schemaVersion: 2, mediaType: MT.manifest, config, layers: layerDescs }), MT.manifest);
      return { manifest, config, layers: layerDescs };
    },
    /** An OCI index over `manifests`. */
    index(manifests) {
      return add(jsonBlob({
        schemaVersion: 2, mediaType: MT.index,
        manifests: manifests.map((m, i) => ({ ...m, platform: { architecture: i === 0 ? 'amd64' : 'arm64', os: 'linux' } })),
      }), MT.index);
    },
  };
}

/** Writes the collected blobs out as an OCI layout directory rooted at `roots`. */
function layout(b, roots, { omit = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'toon-oci-'));
  temps.push(dir);
  mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true });
  for (const [hex, buf] of b.held) {
    if (!omit.includes(`sha256:${hex}`)) writeFileSync(join(dir, 'blobs', 'sha256', hex), buf);
  }
  writeFileSync(join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 2, mediaType: MT.index, manifests: roots }));
  return dir;
}

/** In-memory store + relay, shared across publishes so a second image sees the first's records. */
function fakeIo() {
  const uploads = []; // { bytes, contentType, txid }
  const published = []; // signed events
  const records = new Map(); // blob digest hex -> { event, store_txid }
  return {
    uploads, published, records,
    store: {
      async upload(data, contentType) {
        const txid = `tx${String(uploads.length + 1).padStart(41, '0')}`; // 43 chars, like Arweave
        uploads.push({ bytes: Buffer.from(data), contentType, txid });
        return txid;
      },
    },
    relay: {
      async publish(event) {
        published.push(event);
        if (event.kind === K_BLOB) records.set(event.tags.find((t) => t[0] === 'x')[1], { event, store_txid: null });
      },
      async findBlobRecord(hex) { return records.get(hex) ?? null; },
    },
    // The ledger: which store upload holds each record's copy (toon-io.mjs).
    async remember(hex, storeTxid) { records.get(hex).store_txid = storeTxid; },
  };
}

const sourceOf = (report, digest) => report.blobs.find((b) => b.digest === digest).source;

test('a two-layer image with one upstream base layer lists every reachable blob, each with its source', async () => {
  const b = blobs();
  const base = bytes(4096, 11);
  const top = bytes(512, 22);
  const { manifest, config, layers } = b.image([base, top]);
  const dir = layout(b, [manifest]);
  const secretKey = generateSecretKey();
  const io = fakeIo();

  const report = await publishImage({
    path: dir, name: 'demo', tag: 'v1', secretKey, io,
    upstream: [`registry-1.docker.io/library/busybox@${layers[0].digest}`],
  });

  // Every blob reachable from the digest: the manifest, its config, both layers.
  assert.deepEqual(report.blobs.map((x) => x.digest), [manifest.digest, config.digest, layers[0].digest, layers[1].digest]);
  assert.deepEqual(report.blobs.map((x) => x.size), [manifest.size, config.size, base.length, top.length]);
  assert.deepEqual(report.blobs.map((x) => x.media_type), [MT.manifest, MT.config, MT.layer, MT.layer]);

  // The declared base layer stays upstream; nothing else does.
  assert.deepEqual(sourceOf(report, layers[0].digest), {
    type: 'oci', registry: 'registry-1.docker.io', repository: 'library/busybox',
  });
  for (const other of [manifest, config, layers[1]]) {
    assert.equal(sourceOf(report, other.digest).type, 'toon-store');
  }

  // Each toon-store source cites the Blob Record's STORE txid, which is the
  // JSON upload that follows that blob's parts.
  for (const desc of [manifest, config, layers[1]]) {
    const hex = desc.digest.slice('sha256:'.length);
    const record = io.published.find((e) => e.kind === K_BLOB && e.tags.some((t) => t[0] === 'x' && t[1] === hex));
    assert.ok(record, `a Blob Record was published for ${desc.digest}`);
    const copy = io.uploads.find((u) => u.contentType === 'application/json' && u.bytes.toString('utf8') === JSON.stringify(record));
    assert.equal(sourceOf(report, desc.digest).blob_record_txid, copy.txid);
  }

  // The base layer's bytes were never uploaded.
  assert.equal(io.uploads.some((u) => u.bytes.equals(base)), false, 'the upstream layer is not stored');
  assert.equal(io.uploads.some((u) => u.bytes.equals(top)), true, 'the new layer is stored');
});

test('an OCI index is walked through every manifest it names, index first', async () => {
  const b = blobs();
  const amd = b.image([bytes(300, 1)], 1);
  const arm = b.image([bytes(400, 2)], 2);
  const index = b.index([amd.manifest, arm.manifest]);
  const dir = layout(b, [index]);
  const io = fakeIo();

  const report = await publishImage({ path: dir, name: 'multi', tag: 'latest', secretKey: generateSecretKey(), io });

  assert.equal(report.digest, index.digest);
  assert.equal(report.media_type, MT.index);
  assert.deepEqual(report.blobs.map((x) => x.digest), [
    index.digest,
    amd.manifest.digest, amd.config.digest, amd.layers[0].digest,
    arm.manifest.digest, arm.config.digest, arm.layers[0].digest,
  ]);
});

test('the entry is a signed kind 30434 event of the spec §8.1 shape', async () => {
  const b = blobs();
  const { manifest } = b.image([bytes(200, 5)]);
  const dir = layout(b, [manifest]);
  const secretKey = generateSecretKey();
  const io = fakeIo();

  const report = await publishImage({ path: dir, name: 'demo', tag: 'v1', secretKey, io });

  const entry = io.published.find((e) => e.kind === K_IMAGE);
  assert.equal(io.published.filter((e) => e.kind === K_IMAGE).length, 1);
  assert.ok(verifyEvent(entry), 'the entry is signed by the publisher key');
  assert.equal(entry.pubkey, getPublicKey(secretKey));
  assert.deepEqual(entry.tags, [['d', 'demo:v1'], ['x', manifest.digest.slice('sha256:'.length)], ['L', TOON_LABEL]]);
  assert.deepEqual(Object.keys(JSON.parse(entry.content)), ['digest', 'media_type', 'blobs']);
  assert.deepEqual(JSON.parse(entry.content).blobs.map((x) => Object.keys(x)), Array(3).fill(['digest', 'size', 'media_type', 'source']));
  assert.equal(JSON.parse(entry.content).digest, manifest.digest);

  assert.equal(report.address, `${K_IMAGE}:${getPublicKey(secretKey)}:demo:v1`);
  assert.equal(report.entry.event_id, entry.id);
  // The entry is the LAST thing published: no tag moves onto blobs that are
  // still uploading.
  assert.equal(io.published.at(-1).kind, K_IMAGE);
});

test('republishing a name:tag with a different image keeps the `d` and moves the `x`', async () => {
  const secretKey = generateSecretKey();
  const io = fakeIo();
  const published = [];
  for (const seed of [31, 41]) {
    const b = blobs();
    const { manifest } = b.image([bytes(256, seed)], seed);
    published.push(manifest.digest);
    await publishImage({ path: layout(b, [manifest]), name: 'demo', tag: 'latest', secretKey, io });
  }

  const entries = io.published.filter((e) => e.kind === K_IMAGE);
  assert.equal(entries.length, 2);
  assert.notEqual(published[0], published[1], 'the two images really differ');
  assert.deepEqual(entries.map((e) => e.tags.find((t) => t[0] === 'd')[1]), ['demo:latest', 'demo:latest']);
  assert.deepEqual(entries.map((e) => e.tags.find((t) => t[0] === 'x')[1]), published.map((d) => d.slice('sha256:'.length)));
  // Addressable on `d` and signed by one key: the relay replaces the first.
  assert.equal(entries[0].pubkey, entries[1].pubkey);
});

test('a second image sharing a layer stores that layer once and cites the same Blob Record', async () => {
  const secretKey = generateSecretKey();
  const io = fakeIo();
  const shared = bytes(2048, 77);

  const first = blobs();
  const one = first.image([shared, bytes(64, 1)], 1);
  const a = await publishImage({ path: layout(first, [one.manifest]), name: 'demo', tag: 'v1', secretKey, io });

  const uploadsAfterFirst = io.uploads.length;
  const second = blobs();
  const two = second.image([shared, bytes(64, 2)], 2);
  const bRep = await publishImage({ path: layout(second, [two.manifest]), name: 'demo', tag: 'v2', secretKey, io });

  const sharedDigest = `sha256:${sha(shared)}`;
  assert.equal(bRep.stored.find((s) => s.digest === sharedDigest).skipped, true, 'the shared layer is skipped');
  assert.equal(io.uploads.slice(uploadsAfterFirst).some((u) => u.bytes.equals(shared)), false, 'no part of it is uploaded again');
  assert.deepEqual(sourceOf(bRep, sharedDigest), sourceOf(a, sharedDigest), 'both entries cite the same Blob Record txid');
  assert.equal(sourceOf(bRep, sharedDigest).blob_record_txid.length, 43);
});

test('an image whose blob list would be incomplete is refused before anything is published', async () => {
  const b = blobs();
  const { manifest, layers } = b.image([bytes(128, 3), bytes(128, 4)]);
  // The layout is exported without the first layer and nobody declares it.
  const dir = layout(b, [manifest], { omit: [layers[0].digest] });
  const io = fakeIo();

  await assert.rejects(
    publishImage({ path: dir, name: 'demo', tag: 'v1', secretKey: generateSecretKey(), io }),
    (e) => e.message.includes(layers[0].digest) && /--upstream/.test(e.message) && /incomplete/.test(e.message),
  );
  assert.equal(io.uploads.length, 0, 'nothing was uploaded');
  assert.equal(io.published.length, 0, 'nothing was published');
});

test('a manifest missing from the layout is refused even when it is declared upstream', async () => {
  const b = blobs();
  const amd = b.image([bytes(128, 8)], 8);
  const arm = b.image([bytes(128, 9)], 9);
  const index = b.index([amd.manifest, arm.manifest]);
  const dir = layout(b, [index], { omit: [arm.manifest.digest, arm.config.digest, arm.layers[0].digest] });
  const io = fakeIo();

  await assert.rejects(
    publishImage({
      path: dir, name: 'demo', tag: 'v1', secretKey: generateSecretKey(), io,
      upstream: [`registry-1.docker.io/library/busybox@${arm.manifest.digest}`],
    }),
    (e) => e.message.includes(arm.manifest.digest) && /present locally/.test(e.message),
  );
  assert.equal(io.uploads.length + io.published.length, 0);
});

test('`--upstream <repo>=<layout>` marks every blob a base image export holds', async () => {
  // The base is exported on its own (`docker save busybox -o base.tar`); the
  // application image is built on top and exported with it.
  const baseBlobs = blobs();
  const baseLayer = bytes(1024, 55);
  const base = baseBlobs.image([baseLayer], 55);
  const basePath = layout(baseBlobs, [base.manifest]);

  const b = blobs();
  const { manifest, config, layers } = b.image([baseLayer, bytes(96, 66)], 66);
  const io = fakeIo();

  const report = await publishImage({
    path: layout(b, [manifest]), name: 'app', tag: 'v1', secretKey: generateSecretKey(), io,
    upstream: [`registry-1.docker.io/library/busybox=${basePath}`],
  });

  const oci = { type: 'oci', registry: 'registry-1.docker.io', repository: 'library/busybox' };
  assert.deepEqual(sourceOf(report, layers[0].digest), oci, 'the base layer is upstream');
  assert.equal(sourceOf(report, manifest.digest).type, 'toon-store', "the application's own manifest is not");
  assert.equal(sourceOf(report, config.digest).type, 'toon-store', 'nor its config, which the base never had');
  assert.equal(sourceOf(report, layers[1].digest).type, 'toon-store');
  assert.equal(io.uploads.some((u) => u.bytes.equals(baseLayer)), false, 'the base layer is not stored');

  // The export claims all three of the base's own blobs, not only its layer.
  assert.deepEqual(
    [...resolveUpstream([`registry-1.docker.io/library/busybox=${basePath}`]).byDigest.keys()].sort(),
    [base.manifest.digest, base.config.digest, base.layers[0].digest].sort(),
  );
});

test('a bare `--upstream <repo>` claims every blob the layout does not hold', async () => {
  const b = blobs();
  const { manifest, config, layers } = b.image([bytes(700, 12), bytes(80, 13)]);
  const dir = layout(b, [manifest], { omit: [layers[0].digest] });
  const io = fakeIo();

  const report = await publishImage({
    path: dir, name: 'app', tag: 'v1', secretKey: generateSecretKey(), io,
    upstream: ['ghcr.io/toon-protocol/base'],
  });

  assert.deepEqual(sourceOf(report, layers[0].digest), { type: 'oci', registry: 'ghcr.io', repository: 'toon-protocol/base' });
  for (const held of [manifest, config, layers[1]]) assert.equal(sourceOf(report, held.digest).type, 'toon-store');
});

test('two bare `--upstream` repositories are refused as ambiguous', async () => {
  const b = blobs();
  const { manifest } = b.image([bytes(64, 1)]);
  await assert.rejects(
    publishImage({ path: layout(b, [manifest]), name: 'app', tag: 'v1', secretKey: generateSecretKey(), io: fakeIo(), upstream: ['ghcr.io/a/b', 'docker.io/c/d'] }),
    /ambiguous/,
  );
});

test('a `docker save` tar is read like a layout directory', async () => {
  const b = blobs();
  const { manifest, config, layers } = b.image([bytes(3000, 21), bytes(120, 22)]);
  const dir = layout(b, [manifest]);
  // Exactly what `docker save -o image.tar` writes: the layout, tarred.
  const tar = join(dir, '..', `${basename(dir)}.tar`);
  temps.push(tar);
  execFileSync('tar', ['-cf', tar, '-C', dir, 'oci-layout', 'index.json', 'blobs']);
  const io = fakeIo();

  const report = await publishImage({ path: tar, name: 'demo', tag: 'v1', secretKey: generateSecretKey(), io });

  assert.deepEqual(report.blobs.map((x) => x.digest), [manifest.digest, config.digest, layers[0].digest, layers[1].digest]);
  assert.equal(report.digest, manifest.digest);
  // The bytes came out of the tar intact: each blob's parts reassemble to it.
  for (const [i, layer] of [bytes(3000, 21), bytes(120, 22)].entries()) {
    const hex = layers[i].digest.slice('sha256:'.length);
    const record = JSON.parse(io.published.find((e) => e.kind === K_BLOB && e.tags.some((t) => t[0] === 'x' && t[1] === hex)).content);
    const parts = record.parts.map((p) => io.uploads.find((u) => u.txid === p.txid).bytes);
    assert.equal(Buffer.concat(parts).equals(layer), true);
  }
});

test('a layout holding several images asks which one, and takes --root', async () => {
  const b = blobs();
  const one = b.image([bytes(64, 1)], 1);
  const two = b.image([bytes(64, 2)], 2);
  const dir = layout(b, [one.manifest, two.manifest]);
  const io = fakeIo();

  await assert.rejects(
    publishImage({ path: dir, name: 'demo', tag: 'v1', secretKey: generateSecretKey(), io }),
    (e) => /--root/.test(e.message) && e.message.includes(one.manifest.digest) && e.message.includes(two.manifest.digest),
  );
  assert.equal(io.published.length, 0);

  const report = await publishImage({ path: dir, name: 'demo', tag: 'v1', secretKey: generateSecretKey(), io, rootDigest: two.manifest.digest });
  assert.equal(report.digest, two.manifest.digest);
});

test('a layout whose bytes do not hash to the digest they are filed under is refused', async () => {
  const b = blobs();
  const { manifest, layers } = b.image([bytes(200, 4)]);
  const dir = layout(b, [manifest]);
  writeFileSync(join(dir, 'blobs', 'sha256', layers[0].digest.slice('sha256:'.length)), bytes(200, 5));
  const io = fakeIo();

  await assert.rejects(
    publishImage({ path: dir, name: 'demo', tag: 'v1', secretKey: generateSecretKey(), io }),
    (e) => e.message.includes(layers[0].digest) && /hashes to/.test(e.message),
  );
});

test('the entry serializes exactly as the M2-1 `registry.image_entry` wire fixture does', async () => {
  // The fixture (TOON_Network docs/spec/fixtures/wire/registry.image_entry.json,
  // issue #19) is the independent statement of the shape: tag order, content
  // key order, and the key order inside each blob and each source. An entry
  // built from the fixture's own values must serialize to its `content`.
  const plan = {
    d: 'web:1.0',
    digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    media_type: 'application/vnd.oci.image.index.v1+json',
    blobs: [
      {
        digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        size: 1234, media_type: 'application/vnd.oci.image.manifest.v1+json',
        source: { type: 'oci', registry: 'registry-1.docker.io', repository: 'library/alpine' },
      },
      {
        digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        size: 235520, media_type: 'application/vnd.oci.image.layer.v1.tar+gzip',
        source: { type: 'toon-store', blob_record_txid: 'dG9vbi1zdG9yZS1ibG9iLXJlY29yZC10eGlk' },
      },
    ],
  };
  const template = imageEntryTemplate({ plan, createdAt: 1_700_000_000 });

  assert.equal(template.kind, 30434);
  assert.deepEqual(template.tags, [
    ['d', 'web:1.0'],
    ['x', '1111111111111111111111111111111111111111111111111111111111111111'],
    ['L', 'toon.network'],
  ]);
  assert.equal(
    template.content,
    '{"digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","media_type":"application/vnd.oci.image.index.v1+json","blobs":[{"digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","size":1234,"media_type":"application/vnd.oci.image.manifest.v1+json","source":{"type":"oci","registry":"registry-1.docker.io","repository":"library/alpine"}},{"digest":"sha256:3333333333333333333333333333333333333333333333333333333333333333","size":235520,"media_type":"application/vnd.oci.image.layer.v1.tar+gzip","source":{"type":"toon-store","blob_record_txid":"dG9vbi1zdG9yZS1ibG9iLXJlY29yZC10eGlk"}}]}',
  );
});
