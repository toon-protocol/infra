#!/usr/bin/env node
// The publisher: development tooling for putting images on the TOON Network
// (TOON_Network Milestone 2). Run from sandbox/ on the host against a running
// stack (`make up`). Not a tenant product.
//
//   node scripts/publisher.mjs blob <file> --key <hex> [--part-size 102400] [--data-item-max 107520]
//       Store <file> as parts in the TOON store and publish its Blob Record
//       (issue #20). Prints the digest, every part's txid, and the record's
//       relay event id and store txid. A blob already recorded on the relay
//       is skipped and the existing record reported. --data-item-max is the
//       store's signed data item ceiling (the sandbox's free tier by default;
//       a production store's differs).
//
//   node scripts/publisher.mjs blob-verify <sha256:hex>
//       Read a Blob Record back the way a provider would: from the relay by
//       #x, its copy and every part from the gateway's /raw/, checking every
//       hash. Free — nothing is paid.
//
// --key may also come from PUBLISHER_KEY. URLs: HUB_URL, STORE_EDGE_URL,
// GATEWAY_URL, RELAY_WS (defaults are the sandbox's host-side ports).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { publishBlob, planBlob, sha256Hex, DEFAULT_PART_SIZE, DATA_ITEM_MAX_BYTES, K_BLOB } from './publisher/blob.mjs';
import { openToonIo, rememberRecord, readLedger, findBlobRecordOnRelay, readRaw, GATEWAY } from './publisher/toon-io.mjs';

const log = (m) => console.error(`  ${m}`);
const EVENT_FIELDS = ['id', 'pubkey', 'kind', 'created_at', 'content', 'sig'];
const sameEvent = (a, b) =>
  EVENT_FIELDS.every((k) => a[k] === b[k]) && JSON.stringify(a.tags) === JSON.stringify(b.tags);
const usage = () => {
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(1).map((l) => l.slice(3)).join('\n'));
  process.exit(2);
};

function secretKeyFrom(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex ?? '')) {
    console.error('a publisher key is required: --key <64 hex> or PUBLISHER_KEY');
    process.exit(2);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

async function blob(positionals, values) {
  const [file] = positionals;
  if (!file) usage();
  const secretKey = secretKeyFrom(values.key ?? process.env.PUBLISHER_KEY);
  const partSize = Number(values['part-size'] ?? DEFAULT_PART_SIZE);
  const dataItemMax = Number(values['data-item-max'] ?? DATA_ITEM_MAX_BYTES);
  const bytes = readFileSync(file);
  // Refuse a plan that cannot fit BEFORE a channel is opened or anything paid.
  const plan = planBlob({ bytes, partSize, dataItemMax, createdAt: 0 });
  log(`publisher ${getPublicKey(secretKey)}; ${file}: ${bytes.length} bytes, ${plan.pieces.length} parts of ${partSize} (${plan.digest})`);

  const io = await openToonIo({ secretKey, log });
  try {
    const report = await publishBlob({ bytes, secretKey, partSize, dataItemMax, io });
    if (!report.skipped) rememberRecord(report.digest.slice('sha256:'.length), report.record.store_txid);
    const { event, ...record } = report.record;
    console.log(JSON.stringify({ ...report, record }, null, 2));
  } finally {
    await io.close();
  }
}

async function blobVerify(positionals) {
  const [digest] = positionals;
  const hex = digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (!hex) usage();
  const event = await findBlobRecordOnRelay(hex);
  if (!event) throw new Error(`no kind ${K_BLOB} Blob Record for #x ${hex} on the relay`);
  const content = JSON.parse(event.content);
  const checks = [];
  const check = (cond, what) => { checks.push({ ok: cond, what }); log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };
  check(content.digest === digest && event.tags.some((t) => t[0] === 'd' && t[1] === digest), `relay record ${event.id} names ${digest}`);

  const storeTxid = readLedger()[hex] ?? null;
  if (storeTxid) {
    // The relay re-serializes an event it hands back (key order is not part
    // of the signature), so the copy is compared as an event, not as bytes.
    const copy = JSON.parse((await readRaw(storeTxid)).toString('utf8'));
    check(sameEvent(copy, event) && verifyEvent(copy), `store copy ${GATEWAY}/raw/${storeTxid} is the relay record, same id, signature and fields`);
  } else {
    log(`no store txid in the local ledger for ${hex}; skipping the copy check`);
  }

  const pieces = [];
  for (const [i, part] of content.parts.entries()) {
    const bytes = await readRaw(part.txid);
    check(bytes.length === part.size && sha256Hex(bytes) === part.sha256, `part ${i} ${GATEWAY}/raw/${part.txid}: ${bytes.length} bytes, sha256 ${part.sha256.slice(0, 12)}…`);
    pieces.push(bytes);
  }
  const whole = Buffer.concat(pieces);
  check(whole.length === content.size && `sha256:${sha256Hex(whole)}` === digest, `${content.parts.length} parts reassemble to ${digest} (${whole.length} bytes)`);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(JSON.stringify({ digest, record: { event_id: event.id, store_txid: storeTxid }, parts: content.parts.length, checks: checks.length, failed }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { key: { type: 'string' }, 'part-size': { type: 'string' }, 'data-item-max': { type: 'string' } },
});
const [command, ...rest] = positionals;
const commands = { blob, 'blob-verify': blobVerify };
if (!commands[command]) usage();
commands[command](rest, values).then(
  () => process.exit(0),
  (e) => { console.error(`publisher ${command} failed: ${e.message}`); process.exit(1); },
);
