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
//   node scripts/publisher.mjs image <layout> <name>:<tag> --key <hex>
//           [--upstream <spec>]... [--root <sha256:hex>] [--dry-run]
//       Publish the Image Registry entry for a locally built image (issue
//       #21). <layout> is an OCI image layout: a directory, or the tar
//       `docker save --platform linux/amd64 <image> -o image.tar` writes.
//       Every blob reachable from the image digest — the index if there is
//       one, every manifest, every config and every layer — is listed with
//       its source. A blob declared upstream is listed as `oci`; every other
//       blob is stored by `blob` above and listed as `toon-store` citing its
//       Blob Record's store txid. An image whose blob list would be
//       incomplete is refused before anything is paid for. --dry-run prints
//       that list and stops. Republishing the same <name>:<tag> moves the tag.
//
//       --upstream says which blobs are already public, in one of three
//       forms (none of them calls the registry):
//         <registry>/<repository>@sha256:<hex>  this one blob
//         <registry>/<repository>=<layout>      every blob of that layout,
//                                               e.g. `docker save alpine:3.22`
//         <registry>/<repository>               every blob the image
//                                               references but the layout
//                                               does not hold
//
//   node scripts/publisher.mjs image-verify <30434:pubkey:name:tag>
//       Read an entry back the way a provider would: from the relay by its
//       address, then every toon-store blob's Blob Record from the gateway's
//       /raw/<blob_record_txid>. Free — nothing is paid.
//
//   node scripts/publisher.mjs template <file> <name> --key <hex> [--dry-run]
//       Publish a Template (issue #25): a description of a spawn that a
//       TENANT expands — an image by content address, its ports, where it
//       keeps state, the settings its author fixed and the names a tenant may
//       supply. <file> is that content as JSON (`version`, `image { digest,
//       registry_entry? }`, `ports`, `data_path?`, `env_fixed`, `env_tenant`,
//       `min_resources?`); <name> becomes the `d` tag. Prints the address
//       30436:<pubkey>:<name>. A Template GRANTS NOTHING: a content field
//       that looks like a capability, or one spec §8.3 does not define, is
//       refused here before anything is signed or paid (ADR 0004).
//       Republishing the same <name> replaces it. --dry-run prints the event
//       it would sign and stops.
//
//   node scripts/publisher.mjs template-verify <30436:pubkey:name> [--value NAME=VALUE]...
//       Read a Template back the way a TENANT would: from the relay by its
//       address, checked for shape and signature, and — with a --value for
//       each of its env_tenant names — expanded into the spawn content it
//       would produce. Free — nothing is paid, and no spawn is sent.
//
// --key may also come from PUBLISHER_KEY. URLs: HUB_URL, STORE_EDGE_URL,
// GATEWAY_URL, RELAY_WS (defaults are the sandbox's host-side ports).
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { hasTag } from './lib/provider-smoke.mjs';
import { publishBlob, planBlob, sha256Hex, hexOf, DEFAULT_PART_SIZE, DATA_ITEM_MAX_BYTES, K_BLOB } from './publisher/blob.mjs';
import { publishImage, planImage, parseRef, imageAddress, K_IMAGE, TOON_LABEL } from './publisher/image.mjs';
import { openLayout } from './publisher/oci-layout.mjs';
import { publishTemplate, templateEventTemplate } from './publisher/template.mjs';
import { expandTemplate, templateFromEvent, parseTemplateAddress, K_TEMPLATE, VOLUME_MOUNT_PATH } from './lib/template.mjs';
import { openToonIo, readLedger, findBlobRecordOnRelay, findImageEntryOnRelay, findTemplateOnRelay, readRaw, GATEWAY } from './publisher/toon-io.mjs';

const log = (m) => console.error(`  ${m}`);
/**
 * The running checklist both `*-verify` commands keep: every check is printed
 * as it is made, and the command exits non-zero if any failed.
 */
function checklist() {
  const checks = [];
  return {
    check(ok, what) { checks.push({ ok, what }); log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); },
    skip(what) { log(`skip ${what}`); },
    report(summary) {
      const failed = checks.filter((c) => !c.ok).length;
      console.log(JSON.stringify({ ...summary, checks: checks.length, failed }, null, 2));
      process.exit(failed === 0 ? 0 : 1);
    },
  };
}
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
    if (!report.skipped) await io.remember(hexOf(report.digest), report.record.store_txid);
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
  const { check, report } = checklist();
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

  report({ digest, record: { event_id: event.id, store_txid: storeTxid }, parts: content.parts.length });
}

async function image(positionals, values) {
  const [path, ref] = positionals;
  if (!path || !ref) usage();
  const { name, tag } = parseRef(ref);
  const secretKey = secretKeyFrom(values.key ?? process.env.PUBLISHER_KEY);
  const upstream = values.upstream ?? [];
  const opts = {
    path, name, tag, upstream, rootDigest: values.root,
    partSize: Number(values['part-size'] ?? DEFAULT_PART_SIZE),
    dataItemMax: Number(values['data-item-max'] ?? DATA_ITEM_MAX_BYTES),
  };

  // The layout is opened once and shared with `publishImage`, which makes the
  // plan — and refuses an incomplete blob list — before a channel is opened.
  const layout = openLayout(path);
  try {
    const plan = planImage({ layout, ...opts });
    const pay = plan.blobs.filter((b) => b.source.type === 'toon-store');
    log(`publisher ${getPublicKey(secretKey)}; ${path} ${name}:${tag} is ${plan.digest} (${plan.media_type})`);
    log(`${plan.blobs.length} blobs: ${pay.length} through the TOON store, ${plan.blobs.length - pay.length} upstream`);
    // A bare `--upstream <repo>` speaks for whatever the layout does not
    // hold, so a layer left out of an export by accident becomes an `oci`
    // claim nobody checked. Name every blob it claimed: only the publisher
    // can tell a base layer from an export that went wrong.
    for (const blob of plan.claimed) {
      log(`claimed upstream, NOT in ${path}: ${blob.digest} (${blob.media_type}, ${blob.size} bytes) -> ${blob.source.registry}/${blob.source.repository}`);
    }
    if (values['dry-run']) {
      console.log(JSON.stringify({ address: imageAddress(getPublicKey(secretKey), name, tag), ...plan, root: undefined }, null, 2));
      return;
    }

    const io = await openToonIo({ secretKey, log });
    try {
      const report = await publishImage({ ...opts, layout, plan, secretKey, io, log });
      const { event, ...entry } = report.entry;
      console.log(JSON.stringify({ ...report, entry }, null, 2));
    } finally {
      await io.close();
    }
  } finally {
    layout.close();
  }
}

async function imageVerify(positionals) {
  const address = positionals[0] ?? '';
  const parts = address.split(':');
  if (parts.length < 4 || Number(parts[0]) !== K_IMAGE || !/^[0-9a-f]{64}$/.test(parts[1])) usage();
  const [, pubkey, ...rest] = parts;
  const d = rest.join(':');

  const event = await findImageEntryOnRelay(pubkey, d);
  if (!event) throw new Error(`no kind ${K_IMAGE} Image Registry entry at ${address} on the relay`);
  const { check, skip, report } = checklist();
  const content = JSON.parse(event.content);
  const hex = hexOf(content.digest);

  check(hasTag(event, ['d', d]) && hasTag(event, ['x', hex]) && hasTag(event, ['L', TOON_LABEL]),
    `entry ${event.id} is d=${d}, x=${hex}, L=${TOON_LABEL}`);
  check(verifyEvent(event), `signed by ${pubkey}`);
  check(content.blobs?.some((b) => b.digest === content.digest), `the ${content.blobs?.length} blobs include the image digest ${content.digest}`);

  for (const blob of content.blobs ?? []) {
    if (blob.source?.type === 'oci') {
      skip(`${blob.digest} is upstream at ${blob.source.registry}/${blob.source.repository}`);
      continue;
    }
    // A source type this reader does not know is a FAILED check, never a
    // skipped blob: the entry claims to be complete for the digest, so a
    // blob it cannot resolve makes the whole entry unusable (spec §8.1).
    if (blob.source?.type !== 'toon-store') {
      check(false, `${blob.digest}: source type ${JSON.stringify(blob.source?.type ?? null)} is not one this reader knows (oci, toon-store)`);
      continue;
    }
    const txid = blob.source.blob_record_txid;
    if (typeof txid !== 'string' || txid.length !== 43) {
      check(false, `${blob.digest}: its toon-store source cites no Blob Record txid`);
      continue;
    }
    const record = JSON.parse((await readRaw(txid)).toString('utf8'));
    const recorded = JSON.parse(record.content);
    const parts = Array.isArray(recorded.parts) ? recorded.parts : [];
    check(
      record.kind === K_BLOB && verifyEvent(record) && recorded.digest === blob.digest && recorded.size === blob.size &&
        parts.length > 0 && parts.reduce((n, p) => n + p.size, 0) === blob.size,
      `${blob.digest} (${blob.size} bytes, ${blob.media_type}): Blob Record at ${GATEWAY}/raw/${txid}, ${parts.length} parts`,
    );
  }

  report({ address, event_id: event.id, digest: content.digest, blobs: content.blobs?.length });
}

async function template(positionals, values) {
  const [file, name] = positionals;
  if (!file || !name) usage();
  const secretKey = secretKeyFrom(values.key ?? process.env.PUBLISHER_KEY);
  const content = JSON.parse(readFileSync(file, 'utf8'));

  // The shape check is the READER's (lib/template.mjs), run before a channel
  // is opened: a Template no tenant could expand is never published.
  const unsigned = templateEventTemplate({ name, content, createdAt: 0 });
  const pubkey = getPublicKey(secretKey);
  log(`publisher ${pubkey}; ${file} as ${K_TEMPLATE}:${pubkey}:${name}`);
  log(`image ${content.image.digest}${content.image.registry_entry ? ` via ${content.image.registry_entry.address}` : ' (by digest alone)'}`);
  log(`fixed ${Object.keys(content.env_fixed).join(', ') || '(none)'}; the tenant supplies ${content.env_tenant.join(', ') || '(nothing)'}`);
  if (values['dry-run']) {
    console.log(JSON.stringify({ address: `${K_TEMPLATE}:${pubkey}:${name}`, event: unsigned }, null, 2));
    return;
  }

  const io = await openToonIo({ secretKey, log });
  try {
    const report = await publishTemplate({ name, content, secretKey, io });
    const { event, ...published } = report.template;
    console.log(JSON.stringify({ ...report, template: published }, null, 2));
  } finally {
    await io.close();
  }
}

async function templateVerify(positionals, values) {
  const address = positionals[0] ?? '';
  let named;
  try {
    named = parseTemplateAddress(address);
  } catch {
    usage();
  }
  const event = await findTemplateOnRelay(named.pubkey, named.name);
  if (!event) throw new Error(`no kind ${K_TEMPLATE} Template at ${address} on the relay`);
  const { check, report } = checklist();

  check(hasTag(event, ['d', named.name]) && hasTag(event, ['L', TOON_LABEL]), `template ${event.id} is d=${named.name}, L=${TOON_LABEL}`);
  check(verifyEvent(event), `signed by ${named.pubkey}`);
  // `templateFromEvent` is the tenant's own reader: it refuses a capability
  // field, an undefined field and a mutable image reference (ADR 0004).
  let template = null;
  try {
    template = templateFromEvent(event);
    check(true, `content is a Template spec §8.3 defines: image ${template.content.image.digest}, ${template.content.ports.length} ports, ${template.content.env_tenant.length} tenant settings`);
  } catch (e) {
    check(false, `content: ${e.message}`);
  }

  // With a --value for each of its names, expand it: what a tenant would
  // sign. Nothing is sent to any provider.
  let spawn = null;
  if (template) {
    const given = Object.fromEntries((values.value ?? []).map((v) => {
      const at = v.indexOf('=');
      if (at <= 0) throw new Error(`--value ${v}: expected NAME=VALUE`);
      return [v.slice(0, at), v.slice(at + 1)];
    }));
    try {
      spawn = expandTemplate(template, {
        values: given,
        workloadId: randomBytes(32).toString('hex'),
        sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGRyeS1ydW4tcGxhY2Vob2xkZXIta2V5 template-verify',
      });
      check(spawn.template === address, `expands to a spawn naming ${address}: env ${Object.keys(spawn.env).join(', ') || '(none)'}${spawn.volume_gb ? `, a ${spawn.volume_gb} GiB volume at ${VOLUME_MOUNT_PATH}` : ''}`);
    } catch (e) {
      check(false, `expanding it: ${e.message}`);
    }
  }

  report({ address, event_id: event.id, name: named.name, spawn });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: 'string' }, 'part-size': { type: 'string' }, 'data-item-max': { type: 'string' },
    upstream: { type: 'string', multiple: true }, root: { type: 'string' }, 'dry-run': { type: 'boolean' },
    value: { type: 'string', multiple: true },
  },
});
const [command, ...rest] = positionals;
const commands = { blob, 'blob-verify': blobVerify, image, 'image-verify': imageVerify, template, 'template-verify': templateVerify };
if (!commands[command]) usage();
commands[command](rest, values).then(
  () => process.exit(0),
  (e) => { console.error(`publisher ${command} failed: ${e.message}`); process.exit(1); },
);
