# The publisher

Development tooling for putting images on the TOON Network (TOON_Network
Milestone 2, issue #10). Runs from `sandbox/` on the host against the full
stack (`make up`): it pays the store and the relay through the hub and reads
back through the local gateway. Not a tenant product.

```
node scripts/publisher.mjs blob <file> --key <hex> [--part-size 102400]
node scripts/publisher.mjs blob-verify sha256:<hex>
make test
```

`--key` (or `PUBLISHER_KEY`) is the publisher's Nostr secret key, 64 hex. It
signs the Blob Record. URLs default to the sandbox's host-side ports and can
be moved with `HUB_URL`, `STORE_EDGE_URL`, `GATEWAY_URL`, `RELAY_WS`.

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

- **Refused before any upload:** a `--part-size` over `maxPartSize()` (the
  cap less the store's data item envelope), or a blob whose record would not
  fit one data item (689 parts at 100 KiB — some 67 MiB — after which
  the message names the part size to raise).
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

## As a library

`scripts/publisher/blob.mjs` is the logic and `scripts/publisher/toon-io.mjs`
the paid I/O behind its one seam; the commands for Image Registry entries
(#21) and Templates (#25) build on the same pieces:

```js
import { publishBlob } from './publisher/blob.mjs';
import { openToonIo, rememberRecord } from './publisher/toon-io.mjs';

const io = await openToonIo({ secretKey });          // one client, one channel
const r = await publishBlob({ bytes, secretKey, partSize, io });
// r = { skipped, digest, size, part_size, parts: [{ txid, sha256, size }],
//       record: { event_id, store_txid, event } }
if (!r.skipped) rememberRecord(r.digest.slice(7), r.record.store_txid);
await io.close();
```

`io` is `{ store.upload(bytes, contentType) -> txid, relay.publish(event),
relay.findBlobRecord(hex) -> { event, store_txid } | null }`; the tests in
`blob.test.mjs` drive `publishBlob` with in-memory fakes of exactly that.
