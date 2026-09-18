// MILESTONE 2 ACCEPTANCE TEST (TOON_Network #10, ticket #26; spec §8,
// Appendix A): the TOON-native image path end to end against the real
// sandbox — gateway, store, relay, connectors and the provider behind its
// connector. Run from sandbox/ on the host after `make up` (the FULL stack:
// the store and the gateway are not on the payments profile); `make smoke-m2`.
//
//   1.  PUBLISH a two-layer image built here: a public base layer kept
//       upstream as an `oci` source (alpine, declared with --upstream from a
//       `docker save` of the base) and one layer built by this smoke — an
//       sshd that admits the tenant's key — stored in the TOON store as
//       parts, with its config and manifest. Exactly those three blobs are
//       stored, one Blob Record each, and one Image Registry entry names all
//       four with their sources. Then a TEMPLATE for it: the image by content
//       address plus its entry, state at /data, LISTEN_PORT and USER_NAME
//       fixed by the author, TOON_TENANT_NOTE left to the tenant.
//   2.  EXPAND the Template tenant-side (scripts/lib/template.mjs) with one
//       value: a spawn with { digest, registry_entry }, NO reference, env =
//       env_fixed + the tenant's value, a volume for data_path, and
//       `template` = the Template's address. The free `availability` says
//       would_run first; then the PAID spawn runs the workload BY DIGEST on
//       the host daemon — the provider fetched the base layer from Docker
//       Hub and the rest from the local gateway, verified every part and
//       blob, and `docker load`ed the layout — reachable over SSH with the
//       tenant's key; `status` reports running and the template address;
//       the tenant ends the lease.
//   3.  PUBLISH a tiny ALL-STORE image (busybox plus a marker layer, every
//       blob in the TOON store, no upstream at all) and spawn it by
//       { digest } ALONE — no entry, no reference: the provider finds each
//       blob's Blob Record on its Relay Set by #x. A SECOND spawn of it
//       fetches nothing: the provider's blob cache, which every fetch writes
//       to, is byte-for-byte the same set of files before and after (the
//       gateway logs no requests at its configured level and the provider
//       logs fetches only when they fail, so the cache is the observation).
//   4.  READ BACK: both entries from the relay by address, every Blob Record
//       by #x, each record's store copy and every part from the gateway's
//       /raw/<txid> with every hash checked — the publisher's own *-verify
//       commands, run as a provider would.
//   5.  THE BOOKS, to the unit, from what every packet was charged: the hub's
//       client book on the tenant's channel grew by every claim; the store
//       connector's peer book by what every part and Blob Record upload paid
//       less the hub's fee; the provider connector's peer book by the listing
//       price per spawn and nothing for the free calls; the relay writes cost
//       one unit per event.
//
// THE LISTING: `smoke` (conf/provider.toml), the sandbox-only 30 s tier the
// Milestone 1 smoke buys too. Three spawns, each ended by the tenant.
//
// THE PUBLISHER: a THROWAWAY dev key, committed here like the provider's, so
// the entry and Template addresses are the same run to run — republishing
// moves the tag. The built layers carry a per-run nonce, so every run stores
// fresh blobs for the two-layer image; the all-store image's busybox layer is
// recorded once and KEPT by later runs (the publisher skips a blob the relay
// already records), which this smoke reports rather than hides.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getPublicKey } from 'nostr-tools/pure';
import {
  ROOT, HUB, PROVIDER_EDGE, PROVIDER_CHANNEL, STORE_CHANNEL, HUB_FEE,
  K_PROFILE, K_IMAGE, K_BLOB, K_TEMPLATE, TOON_LABEL,
  AVAILABILITY_ROUTE, STATUS_ROUTE, TERMINATE_ROUTE, spawnRoute, IMAGE, SSH_USER,
  listing,
  reporter, jstr, nowSec, waitFor,
  claims, clientBookOnChannel, peerBookTotal,
  relayReadUntil, directoryFilter, hasTag,
  docker, composeNotRunning, findWorkload, workloadGone,
  newTenant, newRootSecret, tokenRequest, newWorkloadId, openChannel, sshInto,
} from './lib/provider-smoke.mjs';
import { publishImage } from './publisher/image.mjs';
import { hexOf } from './publisher/blob.mjs';
import { publishTemplate } from './publisher/template.mjs';
import { openToonIo, findImageEntryOnRelay, findBlobRecordOnRelay, STORE_ROUTE, RELAY_ROUTE } from './publisher/toon-io.mjs';
import { readTemplate, expandTemplate, VOLUME_MOUNT_PATH } from './lib/template.mjs';

const { step, ok, assert, fatal, done } = reporter('MILESTONE 2 SMOKE');
const startedAt = Date.now();

const L = listing(process.env.TOON_M2_LISTING ?? 'smoke');
const SPAWN_ROUTE = spawnRoute(L.name, L.version);
const HUB_PRICE = L.price + HUB_FEE;
// THROWAWAY publisher identity (hex secret key). Its public key is what the
// entry and Template addresses below carry.
const PUBLISHER_SECRET = Uint8Array.from(Buffer.from('7a5e6d2c1b0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d', 'hex'));
const PUBLISHER_PUBKEY = getPublicKey(PUBLISHER_SECRET);
const BASE_IMAGE = 'alpine:3.22';
const BASE_UPSTREAM = 'registry-1.docker.io/library/alpine';
const STORE_BASE_IMAGE = 'busybox:latest';
const NAME = 'toon-m2-smoke';
const RUN_NONCE = `${nowSec()}-${randomBytes(4).toString('hex')}`;
// The tenant's one value, checked inside the workload it reaches.
const TENANT_NOTE = `hello from tenant ${RUN_NONCE}`;
const WORK = join(ROOT, '.toon-client', 'm2-smoke');
const PROVIDER_CACHE = '/var/lib/toon-provider/blobs';

// ── 0. the stack, and the routes this smoke pays ─────────────────────────
step('0. the full stack is up and the hub prices the store, relay and provider routes');
{
  const missing = composeNotRunning(['provider', 'provider-connector', 'directory-publisher', 'relay', 'relay-connector', 'store', 'store-connector', 'envoy', 'core', 'upload-service']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — this smoke needs the FULL stack, \`make up\``);
  ok('provider, its connector and publisher, the relay and its connector, the store and its connector, the gateway and the upload service are up');
}
const advertised = {};
for (const [name, url] of [['hub', HUB], ['provider-connector', PROVIDER_EDGE]]) {
  const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
  if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  advertised[name] = Object.fromEntries((desc.routes ?? []).map((r) => [r.prefix, r.price]));
}
assert(BigInt(advertised['provider-connector'][SPAWN_ROUTE]) === L.price && BigInt(advertised.hub[SPAWN_ROUTE]) === HUB_PRICE,
  `${SPAWN_ROUTE} is ${L.price} at the provider connector and ${HUB_PRICE} = price + fee ${HUB_FEE} at the hub`);
// The hub's route table advertises g.toon.store by its base alone; the per
// KiB part is in conf/connector-relay.toml and shows up in what each upload
// is charged (step 8).
assert(advertised.hub[STORE_ROUTE] !== undefined && BigInt(advertised.hub[RELAY_ROUTE]) === 1n,
  `the hub sells ${STORE_ROUTE} (advertised at ${jstr(advertised.hub[STORE_ROUTE])}, plus per KiB) and ${RELAY_ROUTE} at ${advertised.hub[RELAY_ROUTE]} per event`);
const relayHint = await (async () => {
  const profiles = await relayReadUntil(directoryFilter(K_PROFILE), 'profile', 60);
  const relays = profiles[0] ? JSON.parse(profiles[0].content).relays : null;
  assert(Array.isArray(relays) && relays.length > 0, `the Provider Profile names the provider's Relay Set: ${jstr(relays)} — the relay hint a registry_entry carries`);
  return relays?.[0] ?? fatal('no Relay Set to hint at');
})();
console.log(`  listing ${L.name} v${L.version}: ${L.price} uUSDC per ${L.lease_interval_s}s; publisher ${PUBLISHER_PUBKEY.slice(0, 12)}…; run ${RUN_NONCE}`);

// ── the images, built on the host daemon ─────────────────────────────────
// A two-layer sshd image on a public base, and a tiny all-store image. Both
// carry the run nonce in their built layer so every run publishes fresh
// blobs; both are exported as OCI layouts for the publisher.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const SSHD_DOCKERFILE = `FROM ${BASE_IMAGE}
ARG TOON_M2_NONCE=unset
RUN <<'BUILD'
set -e
apk add --no-cache openssh-server
cat > /entrypoint.sh <<'SH'
#!/bin/sh
# The Milestone 2 smoke's workload: an sshd admitting the key the provider
# hands every workload as SSH_PUBLIC_KEY, on LISTEN_PORT (the Template fixes
# it at 22, where the provider's ssh_port forwards).
set -e
adduser -D -s /bin/sh ${SSH_USER} 2>/dev/null || true
echo '${SSH_USER}:*' | chpasswd -e
mkdir -p /home/${SSH_USER}/.ssh
printf '%s\\n' "$SSH_PUBLIC_KEY" > /home/${SSH_USER}/.ssh/authorized_keys
chown -R ${SSH_USER}:${SSH_USER} /home/${SSH_USER}/.ssh
chmod 700 /home/${SSH_USER}/.ssh
chmod 600 /home/${SSH_USER}/.ssh/authorized_keys
ssh-keygen -A
exec /usr/sbin/sshd -D -e -p "\${LISTEN_PORT:-22}"
SH
chmod +x /entrypoint.sh
echo "$TOON_M2_NONCE" > /etc/toon-m2-marker
BUILD
ENTRYPOINT ["/entrypoint.sh"]
`;
const STORE_DOCKERFILE = `FROM ${STORE_BASE_IMAGE}
ARG TOON_M2_NONCE=unset
RUN echo "$TOON_M2_NONCE" > /etc/toon-m2-marker
ENTRYPOINT ["/bin/sleep", "3600"]
`;
/** Build `tag` from `dockerfile` (single-platform, no attestation manifest) and export it as an OCI layout tar. */
function buildAndSave(dir, dockerfile, tag) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Dockerfile'), dockerfile);
  docker('build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '-q',
    '--build-arg', `TOON_M2_NONCE=${RUN_NONCE}`, '-t', tag, dir);
  const tar = join(dir, 'image.tar');
  docker('save', '--platform', 'linux/amd64', tag, '-o', tar);
  return tar;
}
step('1. two images built on the host daemon and exported as OCI layouts');
const sshdTar = buildAndSave(join(WORK, 'sshd'), SSHD_DOCKERFILE, `${NAME}:sshd`);
const baseTar = join(WORK, 'base.tar');
docker('save', '--platform', 'linux/amd64', BASE_IMAGE, '-o', baseTar);
const storeTar = buildAndSave(join(WORK, 'store'), STORE_DOCKERFILE, `${NAME}:store`);
ok(`${NAME}:sshd (${BASE_IMAGE} + one built layer), ${NAME}:store (${STORE_BASE_IMAGE} + one built layer), and the base export for --upstream`);

// ── the tenant's channel, shared with the publisher ──────────────────────
// One client on the hub channel does everything paid here — the publisher's
// uploads and relay writes, and the tenant's spawns — because the channel
// store admits one client at a time. Every packet's claim is tallied by
// route, so the books can be closed from what was actually charged rather
// than from a formula about payload sizes.
step('2. one Solana mock-USDC channel against the hub, for the publisher and the tenant alike');
const { client, opened } = await openChannel(HUB);
const channelKey = `solana:${opened.channelId}`;
ok(`channel ${opened.channelId} (status ${opened.status ?? 'open'})`);
const charged = new Map(); // route -> [claim amounts]
const rawSend = client.send.bind(client);
client.send = async (route, request, opts) => {
  const answer = await rawSend(route, request, opts);
  if (answer.claim?.amount !== undefined) charged.set(route, [...(charged.get(route) ?? []), BigInt(answer.claim.amount)]);
  return answer;
};
const send = (route, body) => client.send(route, { body }, { sealTo: PROVIDER_EDGE, timeoutMs: 120_000 });
const sum = (route) => (charged.get(route) ?? []).reduce((s, a) => s + a, 0n);
const count = (route) => (charged.get(route) ?? []).length;
// One warm-up packet first, so a claim an aborted run left pending on the
// shared channel lands before the baseline (see smoke-milestone1.mjs).
await send(AVAILABILITY_ROUTE, { listing: L.name, version: L.version, image: IMAGE });
charged.clear();
const readBooks = async () => ({
  hub: clientBookOnChannel(await claims('relay-connector'), channelKey),
  store: peerBookTotal(await claims('store-connector'), STORE_CHANNEL),
  provider: peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL),
});
const before = await readBooks();
console.log(`  books before: hub client ${before.hub}, store peer ${before.store}, provider peer ${before.provider}`);

const io = await openToonIo({ secretKey: PUBLISHER_SECRET, client, log: (m) => console.log(`     ${m}`) });
const uploads = []; // every store upload's size, in order
const rawUpload = io.store.upload;
io.store.upload = async (bytes, contentType) => { uploads.push(bytes.length); return rawUpload(bytes, contentType); };
let relayWrites = 0;
const rawPublish = io.relay.publish;
io.relay.publish = async (event) => { relayWrites += 1; return rawPublish(event); };

// ── 3. the two-layer image and its Template ──────────────────────────────
step(`3. publish ${NAME}:sshd — the base layer upstream, the built layer, config and manifest in the TOON store — and a Template`);
const uploadsBefore = uploads.length;
const sshd = await publishImage({
  path: sshdTar, name: NAME, tag: 'sshd', secretKey: PUBLISHER_SECRET, io,
  upstream: [`${BASE_UPSTREAM}=${baseTar}`], log: (m) => console.log(`     ${m}`),
});
const ociBlobs = sshd.blobs.filter((b) => b.source.type === 'oci');
const storeBlobs = sshd.blobs.filter((b) => b.source.type === 'toon-store');
const kinds = (blobs) => blobs.map((b) => b.media_type.replace(/^application\/vnd\.oci\.image\./, '').replace(/^application\/vnd\.docker\./, '')).sort().join(', ');
assert(sshd.digest.startsWith('sha256:') && sshd.media_type.endsWith('manifest.v1+json'),
  `${sshd.address} is ${sshd.digest} (${sshd.media_type})`);
assert(ociBlobs.length === 1 && ociBlobs[0].media_type.includes('layer') && ociBlobs[0].source.registry === BASE_UPSTREAM.split('/')[0] && ociBlobs[0].source.repository === BASE_UPSTREAM.slice(BASE_UPSTREAM.indexOf('/') + 1),
  `the base layer ${ociBlobs[0]?.digest} is listed as an oci source at ${BASE_UPSTREAM}, nothing was paid to store it`);
assert(storeBlobs.length === 3 && sshd.stored.length === 3 && sshd.stored.every((s) => !s.skipped && s.parts > 0 && s.blob_record_txid?.length === 43),
  `exactly the three non-upstream blobs were stored as parts (${kinds(storeBlobs)}), one Blob Record each: ${sshd.stored.map((s) => `${s.digest.slice(7, 19)}… ${s.parts} part(s) -> ${s.blob_record_txid}`).join('; ')}`);
const partsStored = sshd.stored.reduce((n, s) => n + s.parts, 0);
assert(uploads.length - uploadsBefore === partsStored + sshd.stored.length,
  `${uploads.length - uploadsBefore} store uploads = ${partsStored} parts + ${sshd.stored.length} Blob Record copies`);
assert(hasTag(sshd.entry.event, ['d', `${NAME}:sshd`]) && hasTag(sshd.entry.event, ['x', hexOf(sshd.digest)]) && hasTag(sshd.entry.event, ['L', TOON_LABEL]) && sshd.entry.event.kind === K_IMAGE,
  `the entry ${sshd.entry.event_id} is kind ${K_IMAGE}, d = ${NAME}:sshd, x = the digest hex, labelled ${TOON_LABEL}`);

const templateContent = {
  version: 1,
  image: { digest: sshd.digest, registry_entry: { address: sshd.address, relay: relayHint } },
  ports: [],
  data_path: VOLUME_MOUNT_PATH,
  env_fixed: { LISTEN_PORT: '22', USER_NAME: SSH_USER },
  env_tenant: ['TOON_TENANT_NOTE'],
  min_resources: { cpu_millicores: 250, memory_mb: 64, storage_gb: 1 },
};
const template = await publishTemplate({ name: NAME, content: templateContent, secretKey: PUBLISHER_SECRET, io });
assert(template.address === `${K_TEMPLATE}:${PUBLISHER_PUBKEY}:${NAME}` && template.template.event.kind === K_TEMPLATE && hasTag(template.template.event, ['d', NAME]),
  `the Template ${template.template.event_id} is published at ${template.address}: image by content address via its entry (relay hint ${relayHint}), state at ${VOLUME_MOUNT_PATH}, TOON_TENANT_NOTE left to the tenant`);
const eventsA = relayWrites;
assert(eventsA === sshd.stored.length + 2, `${eventsA} paid relay writes: ${sshd.stored.length} Blob Records, the entry and the Template`);

// ── 4. read back, then the tenant expands the Template ───────────────────
step('4. the entry and every Blob Record read back from the relay; the tenant expands the Template');
{
  const entry = await findImageEntryOnRelay(PUBLISHER_PUBKEY, `${NAME}:sshd`);
  assert(entry?.id === sshd.entry.event_id, `the relay serves the entry at ${sshd.address}: event ${entry?.id}`);
  for (const s of sshd.stored) {
    const record = await findBlobRecordOnRelay(hexOf(s.digest));
    assert(record?.id === s.event_id && record.kind === K_BLOB && JSON.parse(record.content).parts.length === s.parts,
      `#x ${hexOf(s.digest).slice(0, 12)}… finds Blob Record ${record?.id} with ${s.parts} part(s)`);
  }
}
const tenant = newTenant('m2-tenant');
const read = await readTemplate(template.address);
assert(read?.event.id === template.template.event_id && read.address === template.address, `the tenant reads the Template back by address: ${read?.address}`);
const workloadA = newWorkloadId();
let expansionError = null;
try {
  expandTemplate(read, { workloadId: workloadA, sshPublicKey: tenant.sshPublicKey });
} catch (e) {
  expansionError = e.message;
}
assert(expansionError?.includes('TOON_TENANT_NOTE'), `expanding it with no value is refused before anything is paid: ${expansionError}`);
const spawnA = expandTemplate(read, { values: { TOON_TENANT_NOTE: TENANT_NOTE }, workloadId: workloadA, sshPublicKey: tenant.sshPublicKey });
assert(spawnA.image.reference === undefined && spawnA.image.digest === sshd.digest && spawnA.image.registry_entry?.address === sshd.address && spawnA.image.registry_entry?.relay === relayHint,
  `the spawn names the image by digest + registry_entry and carries NO reference`);
assert(jstr(spawnA.env) === jstr({ LISTEN_PORT: '22', USER_NAME: SSH_USER, TOON_TENANT_NOTE: TENANT_NOTE }) && spawnA.volume_gb === 1 && spawnA.template === template.address,
  `env = env_fixed + the tenant's value, volume_gb ${spawnA.volume_gb} for ${VOLUME_MOUNT_PATH}, template = ${spawnA.template}`);

// ── 5. availability, then the paid spawn from the Template ───────────────
step(`5. the free ${AVAILABILITY_ROUTE} resolves the image through its entry; the PAID spawn runs it by digest`);
{
  const avail = await send(AVAILABILITY_ROUTE, { listing: L.name, version: L.version, image: spawnA.image });
  const body = avail.fulfilled && avail.status === 200 ? avail.json() : null;
  assert(body?.would_run === true, `would_run: ${avail.fulfilled ? `${avail.status} ${avail.text()}` : `${avail.code} ${avail.message ?? ''}`}`);
}
// ONE ROOT SECRET PER LEASE (spec §6.1.1), minted here and handed back with
// the lease: the token this spawn presents derives from it, and so does the
// one `status` and `terminate` present later. Two leases of this one tenant
// therefore share no observable value, which is the point of minting it per
// lease rather than per tenant.
async function paidSpawn(content, what) {
  const t0 = nowSec();
  const rootSecret = newRootSecret();
  const spawned = await send(SPAWN_ROUTE, { request: tokenRequest(rootSecret, 'spawn', content) });
  if (!spawned.fulfilled) fatal(`${what} was refused short of the app: ${spawned.code} (${spawned.refusedBy}) ${spawned.message ?? ''}`);
  const body = spawned.status === 200 ? spawned.json() : null;
  assert(spawned.status === 200, `${what}: the provider answered ${spawned.status} ${spawned.text().slice(0, 300)}`);
  if (!body) fatal(`no lease to continue with — \`docker compose logs provider\``);
  assert(body.workload_id === content.workload_id && body.role === 'standalone' && body.expires_at >= t0 + L.lease_interval_s && Number.isInteger(body.access?.ssh_port),
    `workload ${content.workload_id.slice(0, 12)}…, role ${body.role}, expires_at ${body.expires_at}, ssh ${body.access?.host}:${body.access?.ssh_port} (${nowSec() - t0}s)`);
  const workload = await findWorkload(body.access.ssh_port);
  assert(workload !== null, workload ? `RUNNING on the host daemon: ${workload.line}` : `no toon-<id> container publishes ${body.access.ssh_port} -> 22/tcp`);
  return { body, workload, rootSecret };
}
async function endLease(workloadId, workload, what, rootSecret) {
  const ended = await send(TERMINATE_ROUTE, { request: tokenRequest(rootSecret, 'terminate', { workload_id: workloadId }) });
  const body = ended.fulfilled && ended.status === 200 ? ended.json() : null;
  assert(jstr(body?.state) === jstr({ ended: 'termination' }), `${what} ended by the tenant: state ${jstr(body?.state)}`);
  const gone = workload ? await workloadGone(workload.name, 30) : false;
  assert(gone, workload ? `${workload.name} is gone from the host daemon` : 'no workload to watch');
}
const a = await paidSpawn(spawnA, 'the Template spawn');
if (a.workload) {
  const image = docker('inspect', '-f', '{{.Config.Image}}', a.workload.name).trim();
  assert(image === sshd.digest, `it runs the image BY DIGEST, the id \`docker load\` gave the verified layout: ${image}`);
  const env = docker('inspect', '-f', '{{json .Config.Env}}', a.workload.name);
  assert(JSON.parse(env).includes(`TOON_TENANT_NOTE=${TENANT_NOTE}`), 'the tenant\'s value reached the workload\'s environment');
  const ssh = await sshInto(tenant, a.body.access);
  assert(ssh.ok === true, ssh.err ? `ssh never succeeded: ${ssh.err}` : `ssh -p ${a.body.access.ssh_port} ${SSH_USER}@${a.body.access.host}: toon-ssh-ok, user ${ssh.user}`);
}
{
  const status = await send(STATUS_ROUTE, { request: tokenRequest(a.rootSecret, 'status', { workload_id: workloadA }) });
  const body = status.fulfilled && status.status === 200 ? status.json() : null;
  assert(body?.state === 'running' && body?.template === template.address,
    `status: state ${jstr(body?.state)}, template ${body?.template} — the address the values came from, echoed, never resolved`);
}
await endLease(workloadA, a.workload, 'the Template spawn', a.rootSecret);

// ── 6. the all-store image, by bare digest, twice ────────────────────────
step(`6. publish ${NAME}:store with EVERY blob in the TOON store, spawn it by { digest } alone, then again from the cache`);
const uploadsB = uploads.length;
const store = await publishImage({ path: storeTar, name: NAME, tag: 'store', secretKey: PUBLISHER_SECRET, io, log: (m) => console.log(`     ${m}`) });
const kept = store.stored.filter((s) => s.skipped);
assert(store.blobs.every((b) => b.source.type === 'toon-store') && store.stored.length === store.blobs.length && store.stored.every((s) => s.blob_record_txid?.length === 43),
  `${store.address} is ${store.digest}: all ${store.blobs.length} blobs (${kinds(store.blobs)}) are toon-store sources with a Blob Record each` +
    (kept.length > 0 ? ` — ${kept.length} already recorded by an earlier run and KEPT (${kept.map((s) => s.digest.slice(7, 19) + '…').join(', ')})` : ''));
assert(store.stored.filter((s) => !s.skipped).length >= 3, `${store.stored.filter((s) => !s.skipped).length} fresh blobs stored this run (the built layer, its config and manifest carry the run nonce)`);
const eventsB = relayWrites - eventsA;
assert(eventsB === store.stored.filter((s) => !s.skipped).length + 1, `${eventsB} paid relay writes: one Blob Record per fresh blob and the entry`);
{
  const entry = await findImageEntryOnRelay(PUBLISHER_PUBKEY, `${NAME}:store`);
  assert(entry?.id === store.entry.event_id, `the relay serves the entry at ${store.address}: event ${entry?.id}`);
}
const bareImage = { digest: store.digest };
{
  const avail = await send(AVAILABILITY_ROUTE, { listing: L.name, version: L.version, image: bareImage });
  const body = avail.fulfilled && avail.status === 200 ? avail.json() : null;
  assert(body?.would_run === true, `availability for { digest } alone, no entry, no reference: would_run ${body?.would_run ?? `${avail.code ?? avail.status} ${avail.message ?? avail.text?.() ?? ''}`}`);
}
const bareSpawn = () => ({ workload_id: newWorkloadId(), image: bareImage, env: {}, ports: [], ssh_public_key: tenant.sshPublicKey });
/** The provider's blob cache: every file with its size and mtime, sorted — the same string means no fetch wrote anything. */
const cacheListing = () => docker('compose', '--profile', 'full', 'exec', '-T', 'provider', 'sh', '-c', `find ${PROVIDER_CACHE} -type f -printf '%p %s %T@\\n' | sort`).trim();
const b1Content = bareSpawn();
const b1 = await paidSpawn(b1Content, 'the first bare-digest spawn');
if (b1.workload) {
  const image = docker('inspect', '-f', '{{.Config.Image}}', b1.workload.name).trim();
  assert(image === store.digest, `it runs the all-store image BY DIGEST with no registry entry and no upstream registry: ${image}`);
}
await endLease(b1Content.workload_id, b1.workload, 'the first bare-digest spawn', b1.rootSecret);
const cacheBefore = cacheListing();
const cachedBlobs = cacheBefore.split('\n').filter(Boolean).length;
assert(cachedBlobs >= store.blobs.length, `the provider's blob cache holds ${cachedBlobs} verified blobs after the fetches so far (${PROVIDER_CACHE})`);
const tB2 = Date.now();
const b2Content = bareSpawn();
const b2 = await paidSpawn(b2Content, 'the second bare-digest spawn');
const cacheAfter = cacheListing();
assert(cacheAfter === cacheBefore,
  `the second spawn fetched NOTHING: the blob cache is the same ${cachedBlobs} files, sizes and mtimes as before (every fetch writes what it verified), and the spawn took ${Math.round((Date.now() - tB2) / 1000)}s`);
await endLease(b2Content.workload_id, b2.workload, 'the second bare-digest spawn', b2.rootSecret);

// ── 7. everything read back the way a provider would ─────────────────────
step('7. entries by address, Blob Records by #x, store copies and every part at the gateway\'s /raw/, every hash checked');
/** Run a publisher `*-verify` command and parse its JSON summary. */
function verify(...args) {
  try {
    const out = execFileSync('node', ['scripts/publisher.mjs', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (e) {
    return { failed: -1, error: String(e.stderr ?? e.message).trim().split('\n').slice(-3).join(' | ') };
  }
}
for (const published of [sshd, store]) {
  const v = verify('image-verify', published.address);
  assert(v.failed === 0, `image-verify ${published.address}: ${v.checks ?? 0} checks, ${v.failed} failed${v.error ? ` — ${v.error}` : ''}`);
  for (const s of published.stored) {
    const b = verify('blob-verify', s.digest);
    assert(b.failed === 0 && b.record?.store_txid === s.blob_record_txid,
      `blob-verify ${s.digest.slice(0, 19)}…: relay record, store copy ${b.record?.store_txid} and ${b.parts} part(s) at /raw/, ${b.checks ?? 0} checks, ${b.failed} failed${b.error ? ` — ${b.error}` : ''}`);
  }
}

// ── 8. the books ─────────────────────────────────────────────────────────
step('8. the connectors\' own books, to the unit, from what every packet was charged');
const storeCharges = charged.get(STORE_ROUTE) ?? [];
const spawns = count(SPAWN_ROUTE);
const freeRoutes = [AVAILABILITY_ROUTE, STATUS_ROUTE, TERMINATE_ROUTE];
const freeCalls = freeRoutes.reduce((n, r) => n + count(r), 0);
const expected = {
  hub: [...charged.values()].flat().reduce((s, a) => s + a, 0n),
  store: storeCharges.reduce((s, a) => s + a - HUB_FEE, 0n),
  provider: BigInt(spawns) * L.price,
};
const after = await waitFor(async () => {
  const now = await readBooks();
  return now.hub - before.hub >= expected.hub && now.store - before.store >= expected.store && now.provider - before.provider >= expected.provider ? now : null;
}, 15) ?? await readBooks();
assert(storeCharges.length === uploads.length && storeCharges.every((c) => c > HUB_FEE),
  `${uploads.length} store uploads (${uploads.reduce((s, n) => s + n, 0)} bytes in parts and Blob Record copies), each charged base ${jstr(advertised.hub[STORE_ROUTE])} + per KiB on its size, plus the hub's fee: ${sum(STORE_ROUTE)} in all`);
assert(after.store - before.store === expected.store,
  `the store connector's peer book on ${STORE_CHANNEL} grew by ${after.store - before.store} = every upload's charge less the fee ${HUB_FEE} (${expected.store})`);
assert(count(RELAY_ROUTE) === relayWrites && sum(RELAY_ROUTE) === BigInt(relayWrites),
  `${relayWrites} relay writes (${eventsA} for ${NAME}:sshd and its Template, ${eventsB} for ${NAME}:store) cost ${sum(RELAY_ROUTE)}: one unit per event, at the hub itself`);
assert(spawns === 3 && sum(SPAWN_ROUTE) === 3n * HUB_PRICE && after.provider - before.provider === expected.provider,
  `the provider connector's peer book on ${PROVIDER_CHANNEL} grew by ${after.provider - before.provider} = ${spawns} spawns x ${L.price}; the ${freeCalls} free calls (${freeRoutes.map((r) => `${count(r)} ${r.split('.').pop()}`).join(', ')}) added nothing there`);
assert(after.hub - before.hub === expected.hub,
  `the hub's client book on the tenant's channel grew by ${after.hub - before.hub} = every claim this run made (${expected.hub}: store ${sum(STORE_ROUTE)} + relay ${sum(RELAY_ROUTE)} + spawns ${sum(SPAWN_ROUTE)} + ${freeCalls} free calls x ${HUB_FEE})`);

// ── clean up ─────────────────────────────────────────────────────────────
await io.close();
await client.close?.();
for (const tag of [`${NAME}:sshd`, `${NAME}:store`]) {
  try { docker('rmi', '-f', tag); } catch { /* already gone */ }
}
rmSync(WORK, { recursive: true, force: true });

console.log(`\n  total run time ${Math.round((Date.now() - startedAt) / 1000)}s`);
done(`a two-layer image was published with its base layer upstream and the rest in the TOON store, a Template for it was expanded by the tenant and spawned by { digest, registry_entry } with no reference — fetched, verified, loaded and run by digest, reached over SSH, its template echoed by status — an all-store image spawned by { digest } alone and again from the cache with no fetch, every entry, Blob Record, store copy and part read back and checked, and every book grew by exactly what was paid.`);
