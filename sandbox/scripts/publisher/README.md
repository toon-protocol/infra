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
node scripts/publisher.mjs template <file> <name> --key <hex> [--dry-run]
node scripts/publisher.mjs template-verify 30436:<pubkey>:<name> [--value NAME=VALUE]...
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

The bare form is the loose one: it speaks for whatever the layout happens not
to hold, so a layer left out of an export by accident becomes an `oci` claim
nobody checked. It is therefore never silent — every blob it claimed is named
on stderr before the publish, and `planImage` returns them as `claimed`, for
the publisher to recognise or not.

### What is refused, before anything is paid for

The entry's `blobs` MUST be complete for the digest (spec §8.1), so the whole
publish is refused — nothing uploaded, nothing published — when:

- a blob is neither in the layout nor declared upstream;
- an index or manifest is missing from the layout, even when it is declared
  upstream: its bytes are needed to list what it references;
- a blob's bytes do not hash to the digest they are filed under, or its size
  disagrees with the descriptor that references it.

A blob that ANOTHER publisher already stored is not a refusal: its Blob
Record is on the relay, but which store upload holds that record's copy is
only in the uploader's ledger, so the publisher uploads the same signed
record once more — one data item, no part re-uploaded — and cites that copy.
Every blob is verified by digest wherever it is stored, so a record from any
signer is safe to cite (ADR 0006). The report marks those `recopied`.

## `image-verify` — read an entry back as a provider would

Free. Finds the entry on the relay by its address (kind 30434, author,
`#d`), checks `d`, `x`, the label, the signature and that `blobs` contains
the image digest, then fetches every `toon-store` blob's Blob Record at
`GATEWAY/raw/<blob_record_txid>` and checks it is a signed kind 30435 record
for that digest whose parts add up to the blob's size. `oci` blobs are
reported and not fetched; a source type this reader does not know is a FAILED
check rather than a skipped blob, because the entry claims to be complete for
the digest. Exit 0 when every check passes. #26's smoke reads the entry back
the same way.

## `template` — a Template published, and expanded tenant-side (#25)

Spec §8.3, ADR 0004. A **Template** is a published description of a spawn: an
image by content address, its ports, where it keeps state, the settings its
author fixed and the names a tenant may supply. `<file>` is that content as
JSON and `<name>` becomes the `d` tag:

```
kind 30436, d = "<name>", L = toon.network
{ "version": 1,
  "image": { "digest": "sha256:…", "registry_entry": { "address": "30434:…", "relay": "ws://…" } },
  "ports": [ { "container_port": 8080, "protocol": "tcp" } ],
  "data_path": "/data",
  "env_fixed": { "MODE": "production" },
  "env_tenant": [ "SITE_TITLE" ],
  "min_resources": { "cpu_millicores": 500, "memory_mb": 256, "storage_gb": 4 } }
```

No `x` tag: a Template is found by name, and the digest it carries is the
image's, not its own. It is one paid `g.toon.relay` write and nothing else —
no store upload, no blob. The command prints the address
`30436:<pubkey>:<name>`; `--dry-run` prints the event it would sign and stops.
Republishing the same `<name>` REPLACES the Template, the way an addressable
event is replaced.

The content is rebuilt field by field in §8.3's order before it is signed, so
a hand-written JSON file in any key order makes the same event as the wire
fixture.

### What a Template may not say

**A Template grants nothing** (ADR 0004): capabilities come from the
provider's Listing, and only from there. So a content field that looks like a
privilege — `privileged`, `capabilities`, `devices`, `mounts`,
`runtime_flags`, `docker`, … — is refused, and so is any other field spec §8.3
does not define, nested ones included. An image named by an upstream
`reference` is refused too: a Template names its image by content address, or
a mutable tag someone else controls could repoint what a tenant runs.

That check is the **reader's**, `../lib/template.mjs`, imported here rather
than restated: the publisher refuses to sign exactly what the tenant-side
expander would refuse to expand, so a Template nobody could run is never
published either.

## Expanding one: `../lib/template.mjs` (tenant-side)

The provider NEVER reads a Template (spec §8.3). A tenant reads one, supplies
the settings its author left open, and signs the resulting spawn itself:

```js
import { readTemplate, expandTemplate, expandTemplateFromRelay } from './lib/template.mjs';

const t = await readTemplate('30436:<pubkey>:static-site');   // free; null if none
const spawn = expandTemplate(t, {
  values: { SITE_TITLE: 'Hello' },   // one per env_tenant name
  workloadId, sshPublicKey,
  volumeGb: 4,                       // optional; see data_path below
});
// { workload_id, image, env, ports, volume_gb?, ssh_public_key, template }

const { template, spawn } = await expandTemplateFromRelay(address, { values, workloadId, sshPublicKey });
```

The spawn is only the fields §6.2 allows, so a Template can never smuggle a
privilege into one: `image` exactly as the Template names it, its `ports`,
`env` = `env_fixed` merged with the tenant's values, and `template` = the
Template's own address, which the provider keeps with the lease and reports in
`status` without ever acting on it.

**Everything that could go wrong is an error BEFORE anything is paid:** a
missing tenant value (named), a value the Template never opened, a
capability-like or undefined field, an `env_tenant` name `env_fixed` already
fixes, a `workload_id` that is not 32 bytes of hex or an `ssh_public_key` that
is not one OpenSSH line. A spawn refused at the provider is a spawn the tenant
was billed for (ADR 0003), so none of these is worth finding there.

### How `data_path` maps onto a spawn

A spawn has `volume_gb` and **no mount path** (spec §6.2); the provider mounts
a workload's volume at a path of its own, `/data` (`spawn::VOLUME_MOUNT_PATH`).
So:

| Template | Spawn |
|---|---|
| no `data_path` | no `volume_gb` — the workload is stateless |
| `data_path: "/data"` | `volume_gb` = the caller's `volumeGb`, else `min_resources.storage_gb`, else 1 |
| any other `data_path` | **refused**, naming both paths |

The Template says *that* the workload keeps state and the tenant says *how
much*; the path is the provider's. A Template that keeps state somewhere else
is refused rather than silently expanded, because the spawn has no field to
carry the difference and the workload would find its state missing from a
directory it was told it had.

## `template-verify` — read one back as a tenant would

Free. Finds the Template on the relay by its address, checks `d`, the label
and the signature, runs the reader's own shape check, and — with a `--value
NAME=VALUE` for each `env_tenant` name — prints the spawn content it expands
to. Nothing is paid and no spawn is sent anywhere. Exit 0 when every check
passes.

## As a library

`blob.mjs`, `image.mjs` and `template.mjs` are the logic, `oci-layout.mjs`
reads the image off the disk, and `toon-io.mjs` is the paid I/O behind the one
seam they share. The M2 smoke (#26) builds on the same pieces:

```js
import { publishBlob } from './publisher/blob.mjs';
import { publishImage, planImage, parseRef, imageAddress } from './publisher/image.mjs';
import { publishTemplate } from './publisher/template.mjs';
import { openToonIo, findImageEntryOnRelay, findTemplateOnRelay } from './publisher/toon-io.mjs';

const io = await openToonIo({ secretKey });          // one client, one channel

const r = await publishBlob({ bytes, secretKey, partSize, io });
// r = { skipped, digest, size, part_size, parts: [{ txid, sha256, size }],
//       record: { event_id, store_txid, event } }
if (!r.skipped) await io.remember(r.digest.slice(7), r.record.store_txid);

const image = await publishImage({ path, name, tag, secretKey, upstream, io });
// image = { address: '30434:<pubkey>:<name>:<tag>', d, digest, media_type,
//           blobs: [{ digest, size, media_type, source }],
//           stored: [{ digest, skipped, recopied, parts, blob_record_txid, event_id }],
//           entry: { event_id, event } }

const t = await publishTemplate({ name: 'static-site', content, secretKey, io });
// t = { address: '30436:<pubkey>:static-site', name, template: { event_id, event } }

await io.close();
const entry = await findImageEntryOnRelay(pubkey, `${name}:${tag}`);  // free
const tpl = await findTemplateOnRelay(pubkey, 'static-site');         // free
```

`publishImage` opens and closes the layout itself; pass an already-open one
as `layout` instead of `path` to reuse it. `planImage({ layout, name, tag,
upstream })` is the same decision without publishing — what `--dry-run`
prints, and what refuses an incomplete image; hand the result back as `plan`
to publish exactly what you showed the publisher, and so that the refusal
lands before a payment channel is opened (which is what the CLI does).

`io` is `{ store.upload(bytes, contentType) -> txid, relay.publish(event),
relay.findBlobRecord(hex) -> { event, store_txid } | null, remember(hex,
storeTxid) }`; the tests in `blob.test.mjs`, `image.test.mjs` and
`template.test.mjs` drive all three publishers with in-memory fakes of exactly
that, and `image.test.mjs` writes real OCI layouts (and a real tar) to a temp
directory for the other seam. The expander needs no seam at all —
`../lib/template.test.mjs` hands `expandTemplate` a Template and reads the
spawn it produced.
