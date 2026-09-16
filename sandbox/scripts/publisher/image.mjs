// Publish an Image Registry entry for a locally built image
// (TOON_Network #21; spec §8.1, ADR 0006).
//
// The entry is what makes `<npub>/<name>:<tag>` resolve to an image digest.
// It MUST list every blob reachable from that digest — the index if there is
// one, every manifest, every config and every layer — and say, for each,
// where its bytes are:
//
//   { type: "toon-store", blob_record_txid }   stored by #20, cited by the
//                                              store copy of its Blob Record
//   { type: "oci", registry, repository }      already public upstream
//
// A blob that is neither present in the layout nor declared upstream would
// make the list incomplete, so the whole publish is refused before anything
// is paid for.
//
// Two seams, and nothing else: the OCI layout on disk (oci-layout.mjs) and
// the paid `io` of blob.mjs. See image.test.mjs for the fakes of both.
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { K_IMAGE, TOON_LABEL } from '../lib/provider-smoke.mjs';
import { publishBlob, DEFAULT_PART_SIZE, DATA_ITEM_MAX_BYTES } from './blob.mjs';
import { openLayout, isIndex, isManifest } from './oci-layout.mjs';

export { K_IMAGE, TOON_LABEL };

/** The entry address a provider resolves: `30434:<pubkey>:<name>:<tag>`. */
export const imageAddress = (pubkey, name, tag) => `${K_IMAGE}:${pubkey}:${name}:${tag}`;

/** `<name>:<tag>` split at the LAST colon, so a name may carry a registry path. */
export function parseRef(ref) {
  const at = ref.lastIndexOf(':');
  if (at <= 0 || at === ref.length - 1) throw new Error(`an image reference must be <name>:<tag>, got "${ref}"`);
  return { name: ref.slice(0, at), tag: ref.slice(at + 1) };
}

// ── upstream declarations ─────────────────────────────────────────────────
// Publishing pays for bytes, so the publisher says which blobs are already
// public. No form of the declaration calls the upstream registry: the
// sandbox has no outbound network guarantee, and a registry round trip at
// publish time would be a new failure mode for a fact the publisher knows.
//
//   <registry>/<repository>@sha256:<hex>   this one blob is upstream
//   <registry>/<repository>=<path>         every blob of the OCI layout at
//                                          <path> is upstream (`docker save
//                                          alpine:3.22 -o base.tar`)
//   <registry>/<repository>                every blob the image REFERENCES
//                                          but the layout does not hold
//
// An explicit form wins over the bare one, and an upstream declaration wins
// over a blob that happens to also be in the layout — the point of declaring
// a base layer is not to pay to re-store it.

/** `registry/repository` split at the first slash. */
function parseRepository(text, spec) {
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error(`--upstream ${spec}: expected <registry>/<repository>, e.g. registry-1.docker.io/library/alpine`);
  }
  return { registry: text.slice(0, slash), repository: text.slice(slash + 1) };
}

/**
 * Turn `--upstream` strings into `{ byDigest, fallback }`. Reads any layout a
 * `=<path>` form names; touches no network.
 */
export function resolveUpstream(specs = []) {
  const byDigest = new Map();
  let fallback = null;
  for (const spec of specs) {
    const blobAt = spec.indexOf('@');
    const pathAt = spec.indexOf('=');
    if (blobAt > 0) {
      const digest = spec.slice(blobAt + 1);
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`--upstream ${spec}: "${digest}" is not a sha256 digest`);
      byDigest.set(digest, parseRepository(spec.slice(0, blobAt), spec));
    } else if (pathAt > 0) {
      const where = parseRepository(spec.slice(0, pathAt), spec);
      const base = openLayout(spec.slice(pathAt + 1));
      try {
        for (const root of base.roots) {
          // Lenient: a `docker save` of a multi-platform base holds only the
          // platforms this host pulled, and the ones it lacks are not ours.
          for (const desc of walkImage(base, root)) if (base.has(desc.digest)) byDigest.set(desc.digest, where);
        }
      } finally {
        base.close();
      }
    } else {
      if (fallback) throw new Error(`--upstream ${spec}: a second bare repository is ambiguous — ${fallback.registry}/${fallback.repository} already claims every blob missing from the layout`);
      fallback = parseRepository(spec, spec);
    }
  }
  return { byDigest, fallback };
}

// ── walking the image ─────────────────────────────────────────────────────

/**
 * Every blob reachable from `root`, depth first and deduplicated: the root
 * descriptor, then for an index each manifest it names, and for a manifest
 * its config and then its layers in order. A blob the layout does not hold is
 * still listed (its source may be upstream) but cannot be descended into;
 * those are marked `unreadable`.
 */
export function walkImage(layout, root) {
  const found = [];
  const seen = new Set();
  const visit = (desc) => {
    if (seen.has(desc.digest)) return;
    seen.add(desc.digest);
    const blob = { digest: desc.digest, size: desc.size, media_type: desc.mediaType };
    found.push(blob);
    if (!isIndex(desc.mediaType) && !isManifest(desc.mediaType)) return;
    if (!layout.has(desc.digest)) {
      blob.unreadable = true;
      return;
    }
    const doc = JSON.parse(layout.read(desc.digest).toString('utf8'));
    if (isIndex(desc.mediaType)) for (const child of doc.manifests ?? []) visit(child);
    else {
      if (doc.config) visit(doc.config);
      for (const layer of doc.layers ?? []) visit(layer);
    }
  };
  visit(root);
  return found;
}

/** The image `index.json` points at, or the one `rootDigest` names. */
function selectRoot(layout, rootDigest) {
  const describe = (r) => `  ${r.digest} ${r.mediaType}${r.annotations?.['io.containerd.image.name'] ? ` (${r.annotations['io.containerd.image.name']})` : ''}`;
  if (rootDigest) {
    const found = layout.roots.find((r) => r.digest === rootDigest);
    if (!found) throw new Error(`${layout.path}: index.json names no image ${rootDigest}. It holds:\n${layout.roots.map(describe).join('\n')}`);
    return found;
  }
  if (layout.roots.length === 1) return layout.roots[0];
  throw new Error(`${layout.path}: index.json names ${layout.roots.length} images; choose one with --root <digest>:\n${layout.roots.map(describe).join('\n')}`);
}

/**
 * What publishing `<name>:<tag>` from `layout` would put in the entry, decided
 * before anything is paid for:
 *   { d, digest, media_type, root, blobs: [{ digest, size, media_type, source }] }
 * where a `toon-store` source still has a null `blob_record_txid`. Throws when
 * the blob list would be incomplete, naming every blob at fault.
 */
export function planImage({ layout, name, tag, upstream = [], rootDigest }) {
  const declared = Array.isArray(upstream) ? resolveUpstream(upstream) : upstream;
  const root = selectRoot(layout, rootDigest);
  const walked = walkImage(layout, root);

  const faults = [];
  const blobs = walked.map((blob) => {
    const held = layout.has(blob.digest);
    const upstreamAt = declared.byDigest.get(blob.digest) ?? (held ? null : declared.fallback);
    if (blob.unreadable) {
      faults.push(`${blob.digest} (${blob.media_type}) is not in the layout, so the blobs it references cannot be listed` +
        (upstreamAt ? ' — an index or manifest must be present locally even when it is public upstream' : ''));
    } else if (!upstreamAt && !held) {
      faults.push(`${blob.digest} (${blob.media_type}, ${blob.size} bytes) is neither in the layout nor declared with --upstream`);
    } else if (held && layout.size(blob.digest) !== blob.size) {
      faults.push(`${blob.digest} is ${layout.size(blob.digest)} bytes in the layout but ${blob.size} in the descriptor that references it`);
    }
    const source = upstreamAt
      ? { type: 'oci', registry: upstreamAt.registry, repository: upstreamAt.repository }
      : { type: 'toon-store', blob_record_txid: null };
    return { digest: blob.digest, size: blob.size, media_type: blob.media_type, source };
  });

  if (faults.length > 0) {
    throw new Error(`${layout.path} cannot be published as ${name}:${tag}: the blob list would be incomplete.\n` +
      faults.map((f) => `  - ${f}`).join('\n') +
      '\n  Declare them with --upstream <registry>/<repository>[@<digest>] or export a layout that holds them.');
  }
  return { d: `${name}:${tag}`, digest: root.digest, media_type: root.mediaType, root, blobs };
}

/** The unsigned Image Registry entry for `plan` (spec §8.1). */
export function imageEntryTemplate({ plan, createdAt }) {
  return {
    kind: K_IMAGE,
    created_at: createdAt,
    tags: [['d', plan.d], ['x', plan.digest.slice('sha256:'.length)], ['L', TOON_LABEL]],
    content: JSON.stringify({
      digest: plan.digest,
      media_type: plan.media_type,
      blobs: plan.blobs.map((b) => ({ digest: b.digest, size: b.size, media_type: b.media_type, source: b.source })),
    }),
  };
}

/**
 * Publish `<name>:<tag>` from the OCI layout at `path` (or an already-open
 * `layout`): store every blob that is not upstream through #20's part upload,
 * then publish the entry. Resolves to
 *   { address, d, digest, media_type, blobs, stored: [{ digest, skipped, parts, blob_record_txid, event_id }],
 *     entry: { event_id, event } }
 * Nothing is uploaded or published if the blob list would be incomplete, or
 * if a blob's existing Blob Record cannot be cited.
 */
export async function publishImage({
  path, layout: given, name, tag, secretKey, upstream = [], rootDigest, io,
  partSize = DEFAULT_PART_SIZE, dataItemMax = DATA_ITEM_MAX_BYTES,
  now = () => Math.floor(Date.now() / 1000), log = () => {},
}) {
  const layout = given ?? openLayout(path);
  try {
    const plan = planImage({ layout, name, tag, upstream, rootDigest });
    const toStore = plan.blobs.filter((b) => b.source.type === 'toon-store');

    // A blob already recorded by ANOTHER host is found on the relay but its
    // store copy's txid is not: the record is signed before it is uploaded,
    // so only the uploader's ledger knows it (toon-io.mjs). The entry cannot
    // cite what it does not know, so this is settled with free relay reads
    // before the first paid upload rather than half way through.
    for (const blob of toStore) {
      const hex = blob.digest.slice('sha256:'.length);
      const existing = await io.relay.findBlobRecord(hex);
      if (existing && !existing.store_txid) {
        throw new Error(`${blob.digest} already has a Blob Record on the relay (${existing.event.id}) but no store copy txid is known here, ` +
          `so the entry cannot cite it. Publish from the host that stored it, or re-store the blob against a relay that does not have it.`);
      }
    }

    const stored = [];
    for (const blob of toStore) {
      const bytes = layout.read(blob.digest);
      const report = await publishBlob({ bytes, secretKey, partSize, dataItemMax, io, now });
      if (report.digest !== blob.digest) throw new Error(`the layout served ${report.digest} for ${blob.digest}`);
      // The record was signed before its store copy existed, so which upload
      // holds that copy is remembered beside the event, in the publisher's
      // ledger; the next entry to cite this blob reads the txid back there.
      if (!report.skipped) await io.remember?.(blob.digest.slice('sha256:'.length), report.record.store_txid);
      blob.source.blob_record_txid = report.record.store_txid;
      stored.push({
        digest: blob.digest, skipped: report.skipped, parts: report.parts?.length ?? null,
        blob_record_txid: report.record.store_txid, event_id: report.record.event_id,
      });
      log(`${report.skipped ? 'kept  ' : 'stored'} ${blob.digest} (${blob.size} bytes) -> ${report.record.store_txid}`);
    }

    const event = finalizeEvent(imageEntryTemplate({ plan, createdAt: now() }), secretKey);
    await io.relay.publish(event);
    return {
      address: imageAddress(getPublicKey(secretKey), name, tag),
      d: plan.d, digest: plan.digest, media_type: plan.media_type,
      blobs: plan.blobs, stored,
      entry: { event_id: event.id, event },
    };
  } finally {
    if (!given) layout.close();
  }
}
