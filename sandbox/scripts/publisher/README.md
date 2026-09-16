# The publisher

Development tooling for putting images on the TOON Network (TOON_Network
Milestone 2, issue #10). Runs from `sandbox/` on the host against the full
stack (`make up`): it pays the store and the relay through the hub and reads
back through the local gateway. Not a tenant product.

```
node scripts/publisher.mjs blob <file> --key <hex> [--part-size 102400] [--data-item-max 107520]
node scripts/publisher.mjs blob-verify sha256:<hex>
node scripts/publisher.mjs image <layout> <name>:<tag> --key <hex> [--upstream <spec>]... [--root <digest>] [--dry-run]
node scripts/publisher.mjs image-verify 30434:<pubkey>:<name>:<tag>
make test
```

`--key` (or `PUBLISHER_KEY`) is the publisher's Nostr secret key, 64 hex. It
signs the Blob Record and the Image Registry entry. URLs default to the
sandbox's host-side ports and can be moved with `HUB_URL`, `STORE_EDGE_URL`,
`GATEWAY_URL`, `RELAY_WS`.

## `blob` — a file into the TOON store, with its Blob Record (#20)

Spec §8.2, ADR 0006. The file is split at `--part-size` (100 KiB by
default — the sandbox store serves Turbo's free tier, one signed data item
of at most 107,520 bytes), every part is one paid `kind:5094` job on
`g.toon.store`, and the **Blob Record** is built from the answers:

```
kind 30435, d = "sha256:<hex>", x = <hex>, L = toon.network
{ "digest": "sha256:…", "size": n, "part_size": 102400,
  "parts": [ { "txid": "<arweave txid>", "sha256": "<hex>", "size": n }, … ] }
```

It is published to the relay as a paid `g.toon.relay` write, and then the
same signed event JSON is uploaded once to the store. The command prints
JSON: the blob digest, every part, and the record's `event_id` (relay) and
`store_txid` (the copy an Image Registry entry cites).

- **Refused before a channel is opened or anything uploaded:** a
  `--part-size` over `maxPartSize()` (the cap less the store's data item
  envelope), or a blob whose record would not fit one data item (689 parts
  at 100 KiB — some 67 MiB — after which the message names the part size
  to raise to). `--data-item-max` moves the cap for a store whose ceiling
  is not the sandbox's free tier.
- **Skipped:** a blob the relay already records (a `kind 30435` event with
  `#x = <hex>`) makes no upload; the existing record's `event_id` is
  reported, and its `store_txid` when this host uploaded it.

The store copy's txid cannot live in the record (the record is signed before
it is uploaded), so the publisher remembers it in
`.toon-client/publisher-records.json`, keyed by digest hex. That file is
sandbox state, wiped by `make clean`; a record published from another host
is reported with `store_txid: null`.

## `blob-verify` — read a record back as a provider would

Free. Finds the record on the relay by `#x`, fetches the store copy at
`GATEWAY/raw/<store_txid>` (when the ledger knows it) and checks it is the
same signed event, fetches every part at `GATEWAY/raw/<txid>` and checks its
size and sha256, reassembles and checks the blob digest. Exit 0 when every
check passes.

## `image` — an Image Registry entry from a local image (#21)

Spec §8.1, ADR 0006. `<layout>` is an **OCI image layout**: a directory
(`oci-layout`, `index.json`, `blobs/sha256/<hex>`) or the tar `docker save`
writes, which is the same thing tarred. With the containerd image store
`docker save` keeps the registry's own compressed layer bytes, so a base
layer's digest in the export is the digest that layer has upstream.

```
docker build --platform linux/amd64 -t demo:v1 .
docker save demo:v1 --platform linux/amd64 -o demo.tar
node scripts/publisher.mjs image demo.tar demo:v1 --key <hex> \
    --upstream registry-1.docker.io/library/busybox=base.tar
```

The publisher walks every blob reachable from the image digest — the index
if there is one, then each manifest, its config and its layers, depth first
and deduplicated — and decides each blob's source. Blobs that are not
upstream go through `blob` above, one at a time; then the entry is signed and
published as a paid `g.toon.relay` write:

```
kind 30434, d = "<name>:<tag>", x = <digest hex>, L = toon.network
{ "digest": "sha256:…", "media_type": "…",
  "blobs": [ { "digest": "sha256:…", "size": n, "media_type": "…",
               "source": { "type": "toon-store", "blob_record_txid": "…" } },
             { …, "source": { "type": "oci", "registry": "…", "repository": "…" } } ] }
```

The command prints the entry address `30434:<pubkey>:<name>:<tag>`, the
digest, every blob with its source, and what each stored blob cost (`skipped`
when the relay already had its Blob Record). `--dry-run` prints that list
and stops, before a channel is opened. Republishing the same `<name>:<tag>`
moves the tag: same `d`, new `x`, and the relay keeps the newer entry.

`--root <digest>` picks one image out of a layout that holds several (an
export of two tags); without it such a layout is refused with the list.

### Which blobs are upstream

`--upstream` is repeatable and says which blobs are already public, so the
publisher does not pay to re-store them. **No form of it calls the upstream
registry** — the sandbox has no outbound network guarantee, and a registry
round trip at publish time would be a new way to fail for a fact the
publisher already knows.

| Form | Means |
| --- | --- |
| `<registry>/<repository>@sha256:<hex>` | that one blob is upstream |
| `<registry>/<repository>=<layout>` | every blob the OCI layout at `<layout>` holds is upstream — `docker save busybox:latest -o base.tar` and point at it |
| `<registry>/<repository>` | every blob the image *references* but the layout does not hold is upstream |

An explicit form (`@` or `=`) wins over the bare one, and an upstream
declaration wins over a blob that is also in the layout — declaring a base
layer is exactly how you say "do not store these bytes again". Only one bare
repository is allowed; a second is ambiguous and refused.

### What is refused, before anything is paid for

The entry's `blobs` MUST be complete for the digest (spec §8.1), so the whole
publish is refused — nothing uploaded, nothing published — when:

- a blob is neither in the layout nor declared upstream;
- an index or manifest is missing from the layout, even when it is declared
  upstream: its bytes are needed to list what it references;
- a blob's bytes do not hash to the digest they are filed under, or its size
  disagrees with the descriptor that references it;
- a blob already has a Blob Record on the relay but no store copy txid is
  known on this host (it was published elsewhere), so the entry could not
  cite it.

## `image-verify` — read an entry back as a provider would

Free. Finds the entry on the relay by its address (kind 30434, author,
`#d`), checks `d`, `x`, the label, the signature and that `blobs` contains
the image digest, then fetches every `toon-store` blob's Blob Record at
`GATEWAY/raw/<blob_record_txid>` and checks it is a signed kind 30435 record
for that digest whose parts add up to the blob's size. `oci` blobs are
reported and not fetched. Exit 0 when every check passes. #26's smoke reads
the entry back the same way.

## As a library

`blob.mjs` and `image.mjs` are the logic, `oci-layout.mjs` reads the image
off the disk, and `toon-io.mjs` is the paid I/O behind the one seam both
share. Templates (#25) and the M2 smoke (#26) build on the same pieces:

```js
import { publishBlob } from './publisher/blob.mjs';
import { publishImage, planImage, parseRef, imageAddress } from './publisher/image.mjs';
import { openToonIo, findImageEntryOnRelay } from './publisher/toon-io.mjs';

const io = await openToonIo({ secretKey });          // one client, one channel

const r = await publishBlob({ bytes, secretKey, partSize, io });
// r = { skipped, digest, size, part_size, parts: [{ txid, sha256, size }],
//       record: { event_id, store_txid, event } }
if (!r.skipped) await io.remember(r.digest.slice(7), r.record.store_txid);

const image = await publishImage({ path, name, tag, secretKey, upstream, io });
// image = { address: '30434:<pubkey>:<name>:<tag>', d, digest, media_type,
//           blobs: [{ digest, size, media_type, source }],
//           stored: [{ digest, skipped, parts, blob_record_txid, event_id }],
//           entry: { event_id, event } }

await io.close();
const entry = await findImageEntryOnRelay(pubkey, `${name}:${tag}`);  // free
```

`publishImage` opens and closes the layout itself; pass an already-open one
as `layout` instead of `path` to reuse it. `planImage({ layout, name, tag,
upstream })` is the same decision without publishing — what `--dry-run`
prints, and what refuses an incomplete image.

`io` is `{ store.upload(bytes, contentType) -> txid, relay.publish(event),
relay.findBlobRecord(hex) -> { event, store_txid } | null, remember(hex,
storeTxid) }`; the tests in `blob.test.mjs` and `image.test.mjs` drive both
publishers with in-memory fakes of exactly that, and `image.test.mjs` writes
real OCI layouts (and a real tar) to a temp directory for the other seam.
