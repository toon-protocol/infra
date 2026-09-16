// Reading an image off the disk: an OCI image layout, either as a directory
// or as the tar `docker save` writes (TOON_Network #21).
//
// A layout is `oci-layout`, an `index.json` naming one or more root
// descriptors, and `blobs/sha256/<hex>` — one file per blob. `docker save`
// (with the containerd image store) writes exactly that, tarred, and keeps
// the registry's own compressed layer bytes, so a base layer's digest in the
// tar is the digest that base layer has upstream.
//
// The reader is deliberately small and read-only: it answers `has`, `size`
// and `read` for a digest, and hands back the root descriptors. Nothing here
// knows about the TOON store, relays or money.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MEDIA_TYPES = {
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
};

/** True for a media type whose blob is an index (a list of manifests). */
export const isIndex = (mediaType) => mediaType === MEDIA_TYPES.ociIndex || mediaType === MEDIA_TYPES.dockerList;
/** True for a media type whose blob is a manifest (a config and layers). */
export const isManifest = (mediaType) => mediaType === MEDIA_TYPES.ociManifest || mediaType === MEDIA_TYPES.dockerManifest;

const blobPath = (digest) => {
  const m = /^(sha256):([0-9a-f]{64})$/.exec(digest);
  if (!m) throw new Error(`not a sha256 digest: ${digest}`);
  return `blobs/${m[1]}/${m[2]}`;
};

/**
 * Open the OCI layout at `path` — a directory or a tar. Resolves to
 *   { path, kind, roots, has(digest), size(digest), read(digest), close() }
 * where `roots` is `index.json`'s `manifests` array (the images the layout
 * holds) and `read` verifies the bytes against the digest it was asked for.
 */
export function openLayout(path) {
  if (!existsSync(path)) throw new Error(`no OCI layout at ${path}`);
  const inner = statSync(path).isDirectory() ? openDirLayout(path) : openTarLayout(path);

  const index = JSON.parse(inner.read('index.json').toString('utf8'));
  const roots = index.manifests ?? [];
  if (roots.length === 0) throw new Error(`${path}: index.json names no image`);

  const read = (digest) => {
    const bytes = inner.read(blobPath(digest));
    const got = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (got !== digest) throw new Error(`${path}: the blob filed under ${digest} hashes to ${got}`);
    return bytes;
  };
  return {
    path, kind: inner.kind, roots, index, read,
    has: (digest) => inner.has(blobPath(digest)),
    size: (digest) => inner.size(blobPath(digest)),
    close: inner.close,
  };
}

/** A layout laid out as files under a directory. */
function openDirLayout(dir) {
  const at = (name) => join(dir, name);
  return {
    kind: 'dir',
    has: (name) => existsSync(at(name)),
    size: (name) => statSync(at(name)).size,
    read: (name) => {
      if (!existsSync(at(name))) throw new Error(`${dir}: no ${name}`);
      return readFileSync(at(name));
    },
    close: () => {},
  };
}

// ── tar ───────────────────────────────────────────────────────────────────
// `docker save` writes an uncompressed ustar archive. The whole tar is never
// read into memory: the headers are walked once to index every member's
// offset and size, and a blob is read from its offset on demand.
const BLOCK = 512;
const str = (buf, start, len) => {
  const end = buf.indexOf(0, start) === -1 ? start + len : Math.min(buf.indexOf(0, start), start + len);
  return buf.toString('utf8', start, end).trim();
};
/**
 * A tar numeric field. Normally NUL-terminated octal, but a size that does not
 * fit — a member of 8 GiB or more, which a big layer can be — is written as
 * base 256 with the top bit of the first byte set. Reading that as octal would
 * give 0 and desynchronize the whole header walk.
 */
const numeric = (buf, start, len) => {
  if (buf[start] & 0x80) {
    let value = BigInt(buf[start] & 0x7f);
    for (let i = start + 1; i < start + len; i++) value = (value << 8n) | BigInt(buf[i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`a tar member of ${value} bytes is too large to index`);
    return Number(value);
  }
  const text = str(buf, start, len).replace(/[^0-7]/g, '');
  return text === '' ? 0 : parseInt(text, 8);
};

/** A layout inside a tar: `{ name -> { offset, size } }` built by one header walk. */
function openTarLayout(file) {
  const fd = openSync(file, 'r');
  const members = new Map();
  try {
    const total = statSync(file).size;
    const header = Buffer.alloc(BLOCK);
    let offset = 0;
    let longName = null;
    while (offset + BLOCK <= total) {
      if (readSync(fd, header, 0, BLOCK, offset) < BLOCK) break;
      if (header[0] === 0) break; // the end-of-archive blocks
      const name = longName ?? [str(header, 345, 155), str(header, 0, 100)].filter(Boolean).join('/');
      const size = numeric(header, 124, 12);
      const type = String.fromCharCode(header[156]);
      longName = null;
      offset += BLOCK;
      if (type === 'L') {
        // A GNU long name: the next header's name is this member's contents.
        const nameBuf = Buffer.alloc(size);
        readSync(fd, nameBuf, 0, size, offset);
        longName = nameBuf.toString('utf8').replace(/\0+$/, '');
      } else if (type === '0' || type === '\0') {
        members.set(name.replace(/^\.\//, ''), { offset, size });
      }
      offset += Math.ceil(size / BLOCK) * BLOCK;
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  if (!members.has('index.json')) {
    closeSync(fd);
    throw new Error(`${file} is not an OCI layout tar: no index.json member (a \`docker save\` tar is one)`);
  }
  return {
    kind: 'tar',
    has: (name) => members.has(name),
    size: (name) => {
      const m = members.get(name);
      if (!m) throw new Error(`${file}: no ${name}`);
      return m.size;
    },
    read: (name) => {
      const m = members.get(name);
      if (!m) throw new Error(`${file}: no ${name}`);
      const out = Buffer.alloc(m.size);
      let done = 0;
      while (done < m.size) {
        const n = readSync(fd, out, done, m.size - done, m.offset + done);
        if (n === 0) throw new Error(`${file}: ${name} ended after ${done} of ${m.size} bytes`);
        done += n;
      }
      return out;
    },
    close: () => closeSync(fd),
  };
}
