// MILESTONE 7 ACCEPTANCE TEST (TOON_Network #69, ticket #76; spec §6.5.1,
// §6.8, §8.2, §8.4, §12.7, ADR 0018): a tenant can REVOKE a Workload
// Gateway's reading of its lease before the grant runs out, and keep serving
// from an image too large for one Blob Record. Run from sandbox/ on the host
// after `make up-gateway` (the FULL stack plus the gateway: the store is
// where the paged image lives); `make smoke-m7`.
//
//   0.  the stack is up with the store, both providers and the gateway, and
//       the gateway answers a hostname it holds no grant for with its own 503
//   1.  A STANDBY SET, with the developer's own command: `node
//       scripts/spawn.mjs --standby provider --standby provider2` spawns
//       `traefik/whoami` on the primary and reserves the standby, and writes
//       the lease file every later command reads the root secret from
//   2.  THE HANDOVER, with `node scripts/handover.mjs <lease>`: one grant per
//       member, each re-derived here from the lease's own root secret and
//       matching; the canonical hostname answers with the workload's own body.
//       A delegated `status` bearing each member's grant is answered — the
//       grant works, at both members, before anything is rotated
//   3.  THE ROTATION, with `node scripts/rotate.mjs <lease>`: every member
//       rotated, and the lease file holds a NEW root secret and no rotation
//       record. On the wire, at EVERY member: the old grant is `bad_grant`,
//       the old token is `not_tenant`, and the new token reads the lease
//   4.  THE GATEWAY NOTICES WITH NO ONE TELLING IT: within a couple of its
//       cadences the same hostname answers 503 `member_unreachable`, in spec
//       §5's error shape, the message naming each member's `bad_grant` — the
//       gateway was not withdrawn; it simply cannot read the lease any more
//   5.  A NEW HANDOVER, the same command again: its grants derive from the
//       ROTATED tokens (re-derived here and matching, and none of them an old
//       one), the gateway ADMITS it by asking the members, and the hostname
//       answers with the workload's body again. The lease is then ended with
//       the new token at both members
//   6.  A PAGED IMAGE: busybox plus a 2 MiB layer of random bytes, published
//       with the Blob Record ceiling LOWERED so that record pages (see
//       RECORD_MAX below — a real 70 MB layer would be 700 paid uploads for
//       the same shape). On the wire: the layer's Blob Record, read from the
//       relay AND from its store copy, carries `pages` and no `parts`, and
//       every page, fetched from the gateway's /raw/, hashes and counts as
//       the record says; the publisher's own `blob-verify` and `image-verify`
//       read it back through its pages
//   7.  A LEASE FROM IT: `availability` says would_run for the image by
//       `{ digest, registry_entry }`; the PAID spawn runs it BY DIGEST — the
//       provider read the paged record, every page and every part — `status`
//       answers running, and the tenant ends it
//
// Buys the 600 s `warm` tier on the first provider with a standby on the
// second, then the 30 s `smoke` tier once; two to three minutes, most of it
// the gateway's cadence and the store uploads. Shares
// `.toon-client/channels.json` with every other smoke, and with
// scripts/spawn.mjs, which this runs BEFORE opening its own client on it
// rather than beside it — so do not run two smokes at once.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  ROOT, HUB, K_PROFILE, K_BLOB,
  providerOf,
  checkLeaseBody,
  reporter, jstr, nowSec, waitFor,
  relayReadUntil, directoryFilter, docker, composeNotRunning, composeHealthy, findWorkload, workloadGone,
  continuationFor, gatewaySubFor, newRootSecret, newTenant, newWorkloadId, openChannel, tokenRequest,
} from './lib/provider-smoke.mjs';
import {
  GATEWAY_HTTP_PORT,
  canonicalLabel, gatewayDomain, gatewayGet, gatewayReason, gatewayRefused, errorBody, whoamiHostname,
} from './lib/gateway-smoke.mjs';
import { publishImage } from './publisher/image.mjs';
import { hexOf, partListOf, sha256Hex, maxPartSize, DATA_ITEM_MAX_BYTES } from './publisher/blob.mjs';
import { openToonIo, findBlobRecordOnRelay, readRaw, GATEWAY } from './publisher/toon-io.mjs';

const { step, ok, assert, fatal, done } = reporter('MILESTONE 7 SMOKE');
const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;

const PRIMARY = providerOf('provider');
const STANDBY = providerOf('provider2');
const SET = [PRIMARY, STANDBY];
const WARM = PRIMARY.listing('warm');
if (STANDBY.listing('warm').standby_price === null) {
  fatal(`conf/${STANDBY.confFile}'s \`warm\` sets no standby_price, so nothing sells a standby`);
}
const SMOKE = PRIMARY.listing('smoke');
const DOMAIN = gatewayDomain();
const REQUEST_TTL_S = 120;
// How long the gateway may take to notice a rotation: it re-asks every member
// once per cadence (the gateway's 30 s default; conf/workload-gateway.conf
// sets no other), and a round in flight at the moment of rotation may still
// have been answered with the old grant. Three cadences is slack, not a
// deadline.
const NOTICE_S = 100;

// THE PAGED IMAGE. The sandbox store takes one signed data item of at most
// 107,520 bytes, and an inline Blob Record fits that up to 689 parts at the
// 100 KiB part size — some 67 MiB. Storing a layer that big is ~700 paid
// uploads to prove a SHAPE, so the smoke pages a 2 MiB layer instead, by
// LOWERING the size above which the publisher pages (`recordMax`, the
// publisher's `--record-max`): its ~21-part record measures well over 2 KiB
// and pages, four parts to a page. The store's own ceiling is untouched —
// every part is still a full 100 KiB upload — and the provider is told
// nothing: it reads whatever shape the record has, which is the point.
const RECORD_MAX = 2048;
const PARTS_PER_PAGE = 4;
const LAYER_BYTES = 2 * 1024 * 1024;
// THROWAWAY publisher identity (hex secret key), committed like the M2 one.
const PUBLISHER_SECRET = Uint8Array.from(Buffer.from('3c1d7e5a9b2f4e6d8c0a1b3d5f7e9a2c4b6d8f0e1a3c5b7d9f2e4a6c8b0d1f37', 'hex'));
const IMAGE_NAME = 'toon-m7-paged';
const RUN_NONCE = `${nowSec()}-${randomBytes(4).toString('hex')}`;
const WORK = join(ROOT, '.toon-client', 'm7-smoke');

/** Run a sandbox script as a developer would, and give back its exit status and the JSON it printed. */
function runScript(script, args) {
  console.log(`  node scripts/${script} ${args.join(' ')}`);
  const ran = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  let report = null;
  try {
    report = JSON.parse(ran.stdout);
  } catch {
    report = null;
  }
  return { status: ran.status, report, stderr: ran.stderr ?? '' };
}
const lastLines = (text, n = 6) => text.trim().split('\n').slice(-n).join('\n');
const readLease = (file) => JSON.parse(readFileSync(file, 'utf8'));

// ── 0. the stack ──────────────────────────────────────────────────────────
step('0. the full stack is up with the `gateway` profile: store, both providers, the relay, the gateway');
{
  const missing = composeNotRunning([
    'provider', 'provider-connector', 'directory-publisher', 'provider2', 'provider2-connector', 'directory-publisher2',
    'relay', 'relay-connector', 'store', 'store-connector', 'envoy', 'core', 'upload-service',
    'workload-gateway', 'workload-gateway-connector',
  ]);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-gateway\` first (the FULL stack: the paged image lives in the store)`);
  ok('both providers with their connectors and publishers, the relay, the store and its gateway, and the Workload Gateway with its connector are up');
}
if (!(await composeHealthy('workload-gateway', 60))) fatal('workload-gateway never reported healthy');
{
  const answer = await gatewayGet('127.0.0.1');
  assert(gatewayRefused(answer, 'no_grant'), `a hostname it holds no grant for is answered ${answer.status} \`${gatewayReason(answer)}\` by the gateway itself`);
}

// ── 1. a Standby Set, with the developer's own command ────────────────────
step(`1. \`scripts/spawn.mjs\` spawns ${PRIMARY.service} + ${STANDBY.service} on \`${WARM.name}\` and writes the lease file`);
let leaseFile;
let lease;
{
  const ran = runScript('spawn.mjs', ['--standby', PRIMARY.service, '--standby', STANDBY.service]);
  const r = ran.report;
  if (ran.status !== 0 || r === null) fatal(`scripts/spawn.mjs exited ${ran.status}: ${lastLines(ran.stderr)}`);
  leaseFile = join(ROOT, '.toon-client', `spawn-${r.workload_id.slice(0, 12)}.json`);
  lease = readLease(leaseFile);
  const primary = r.members[PRIMARY.service]?.body;
  const standby = r.members[STANDBY.service]?.body;
  assert(primary?.role === 'primary' && primary.workload_id === r.workload_id && primary.access !== undefined,
    `${PRIMARY.service} answered role ${primary?.role} WITH access, workload ${r.workload_id.slice(0, 12)}…`);
  assert(standby?.role === 'standby' && !('access' in (standby ?? {})),
    `${STANDBY.service} answered role ${standby?.role} with no access — a Warm Standby holds a reservation, not a workload`);
  assert(lease.root_secret === r.root_secret && jstr(lease.standby_set) === jstr(SET.map((P) => P.service)),
    `${leaseFile.slice(ROOT.length + 1)} holds the root secret and the set ${jstr(lease.standby_set)} (${elapsed()})`);
}
const WORKLOAD_ID = lease.workload_id;
const OLD_ROOT = lease.root_secret;
const CANONICAL = `${canonicalLabel(WORKLOAD_ID)}.${DOMAIN}`;
const container = (await findWorkload(lease.access.ssh_port, 30))?.name ?? fatal(`no toon-<id> container publishes ssh_port ${lease.access.ssh_port}`);
ok(`${container} is running on the host daemon`);

// The tenant's own client, opened only now: spawn.mjs above paid on the same
// channel store and has exited, so the two never hold one nonce watermark.
const { client } = await openChannel(HUB, 'channels.json');
const sendTo = (P, route, body) => client.send(route, { body: checkLeaseBody(route, body) }, { sealTo: P.edge, timeoutMs: 120_000 });
/** `{ status, body }` of the app's answer, or `{ code }` for a packet refused short of it. */
const answerOf = (sent) => {
  if (!sent.fulfilled) return { status: null, code: `${sent.code} (${sent.refusedBy})`, body: null };
  try {
    return { status: sent.status, body: JSON.parse(sent.text()) };
  } catch {
    return { status: sent.status, body: sent.text().slice(0, 200) };
  }
};
/** `status` at `P` for this lease with `continuation` presented, delegated when `gatewayExpiresAt` is given. */
const statusWith = async (P, root, { continuation, gatewayExpiresAt } = {}) => {
  const request = tokenRequest(root, 'status', { workload_id: WORKLOAD_ID, ...(gatewayExpiresAt === undefined ? {} : { gateway_expires_at: gatewayExpiresAt }) }, REQUEST_TTL_S, P);
  if (continuation !== undefined) request.continuation = continuation;
  return answerOf(await sendTo(P, P.statusRoute, { request }));
};
const expectedState = (P) => (P === PRIMARY ? 'running' : 'reserved');

/** The gateway at CANONICAL until it answers 200, or the last answer. */
const servedWithin = (seconds) => waitFor(async () => {
  const a = await gatewayGet(CANONICAL).catch((e) => ({ status: 0, headers: {}, body: String(e.message) }));
  return a.status === 200 ? a : null;
}, seconds, 1500).then(async (a) => a ?? gatewayGet(CANONICAL).catch((e) => ({ status: 0, headers: {}, body: String(e.message) })));

// ── 2. the handover ───────────────────────────────────────────────────────
step(`2. \`scripts/handover.mjs\` hands the set to the gateway: one grant per member, and ${CANONICAL} serves the workload`);
/**
 * `scripts/handover.mjs <lease> --expires-in 1h`, the developer's command, and
 * what it sealed: asserted to be ONE GRANT PER MEMBER, each the `gateway_sub`
 * of that member's token under `root`, re-derived here independently.
 */
function handover(root, what) {
  const ran = runScript('handover.mjs', [leaseFile, '--expires-in', '1h']);
  const r = ran.report;
  if (ran.status !== 0 || r === null) fatal(`scripts/handover.mjs exited ${ran.status}: ${lastLines(ran.stderr)}`);
  const message = r.handover;
  const grants = SET.map((P) => gatewaySubFor(continuationFor(root, P.pubkey), message.expires_at));
  assert(r.delivered === true && r.hostnames?.[0] === CANONICAL,
    `the gateway ADMITTED it (delivered ${r.delivered}${r.failed ? `: ${r.failed}` : ''}) at ${r.hostnames?.[0]} — ${what}`);
  assert(message.standby_set.length === SET.length && SET.every((P, i) => message.standby_set[i].provider === P.pubkey && message.standby_set[i].grant === grants[i]),
    `it carries one grant per member, primary first, each the \`gateway_sub\` of THAT member's token for ${message.expires_at} — re-derived here from the lease file's root secret and matching byte for byte (spec §6.5.1)`);
  return { expiresAt: message.expires_at, grants };
}
const first = handover(OLD_ROOT, 'the first handover');
{
  const answer = await servedWithin(90);
  assert(answer.status === 200 && whoamiHostname(answer.body) !== null,
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${answer.status}, answered by the WORKLOAD (\`${whoamiHostname(answer.body)}\`) (${elapsed()})`);
}
for (const [i, P] of SET.entries()) {
  const a = await statusWith(P, OLD_ROOT, { continuation: first.grants[i], gatewayExpiresAt: first.expiresAt });
  assert(a.status === 200 && a.body?.state === expectedState(P),
    `a delegated \`status\` at ${P.service} bearing its grant is answered ${a.status ?? a.code} state ${jstr(a.body?.state ?? a.body)} — the grant READS the lease, before anything is rotated`);
}

// ── 3. the rotation ───────────────────────────────────────────────────────
step('3. `scripts/rotate.mjs` rotates every member; on the wire, the old grant and the old token are refused at each, and the new token reads');
{
  const ran = runScript('rotate.mjs', [leaseFile]);
  const r = ran.report;
  if (ran.status !== 0 || r === null) fatal(`scripts/rotate.mjs exited ${ran.status}: ${lastLines(ran.stderr)}`);
  assert(r.rotated === true && r.workload_id === WORKLOAD_ID && r.members.length === SET.length
    && SET.every((P, i) => r.members[i].provider === P.pubkey && r.members[i].rotated === true),
    `every member rotated: ${r.members.map((m, i) => `${SET[i].service} ${m.rotated}${m.recovered ? ' (recovered)' : ''}`).join(', ')} — one free \`.rotate\` each, naming only itself (spec §6.8)`);
  assert(!jstr(r).includes(OLD_ROOT) && !SET.some((P) => jstr(r).includes(continuationFor(OLD_ROOT, P.pubkey))),
    'and its report carries no secret: neither root nor any token');
}
lease = readLease(leaseFile);
const NEW_ROOT = lease.root_secret;
assert(/^[0-9a-f]{64}$/.test(NEW_ROOT) && NEW_ROOT !== OLD_ROOT && lease.rotation === undefined && Number.isInteger(lease.rotated_at),
  `the lease file now holds a NEW root secret and no rotation record (rotated_at ${lease.rotated_at}) — the old root reads nothing anywhere, so it is dropped`);
for (const [i, P] of SET.entries()) {
  const grant = await statusWith(P, OLD_ROOT, { continuation: first.grants[i], gatewayExpiresAt: first.expiresAt });
  assert(grant.status === 403 && grant.body?.error === 'bad_grant',
    `${P.service}: the grant the gateway holds is now ${grant.status ?? grant.code} \`${grant.body?.error}\` — the provider recomputes a grant from the token it stores, and that is the new one`);
  const token = await statusWith(P, OLD_ROOT);
  assert(token.body?.error === 'not_tenant', `${P.service}: the OLD token itself is \`${token.body?.error ?? token.code}\``);
  const fresh = await statusWith(P, NEW_ROOT);
  assert(fresh.status === 200 && fresh.body?.state === expectedState(P) && fresh.body?.workload_id === WORKLOAD_ID,
    `${P.service}: the NEW token reads the lease: state ${jstr(fresh.body?.state)} — rotation replaced the credential and left the lease alone`);
}

// ── 4. the gateway notices ────────────────────────────────────────────────
step(`4. with nobody telling it, the gateway stops serving ${CANONICAL}: 503 \`member_unreachable\`, naming each member's \`bad_grant\``);
{
  const t0 = Date.now();
  const answer = await waitFor(async () => {
    const a = await gatewayGet(CANONICAL).catch(() => null);
    return a !== null && gatewayReason(a) === 'member_unreachable' ? a : null;
  }, NOTICE_S, 2000) ?? await gatewayGet(CANONICAL);
  const message = errorBody(answer)?.message ?? '';
  const named = (message.match(/refused `status` \(bad_grant\)/g) ?? []).length;
  assert(gatewayRefused(answer, 'member_unreachable'),
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${answer.status} \`${gatewayReason(answer)}\` after ${Math.round((Date.now() - t0) / 1000)}s, header and body agreeing in spec §5's error shape — the gateway can no longer READ the lease, and says so (§6.8, §12)`);
  assert(named === SET.length,
    `its message names the refusal at each of the ${SET.length} members — ${named} × \`refused \\\`status\\\` (bad_grant)\`: ${message.slice(0, 240)}${message.length > 240 ? '…' : ''}`);
  const still = await statusWith(PRIMARY, NEW_ROOT);
  assert(still.body?.state === 'running',
    `while the workload runs on, untouched: ${PRIMARY.service} answers ${jstr(still.body?.state)} to the new token — the gateway lost READING, and the tenant lost nothing`);
}

// ── 5. a new handover, and the end of the lease ───────────────────────────
step('5. the same `scripts/handover.mjs` again: grants of the ROTATED tokens, admitted, and the hostname serves again');
{
  const second = handover(NEW_ROOT, 'grants derived from the ROTATED tokens');
  assert(second.grants.every((g) => !first.grants.includes(g) && !SET.some((P) => g === gatewaySubFor(continuationFor(OLD_ROOT, P.pubkey), second.expiresAt))),
    'and not one of them is a grant the OLD root could have derived, for any moment it was handed over for');
  const answer = await servedWithin(90);
  assert(answer.status === 200 && whoamiHostname(answer.body) !== null,
    `http://${CANONICAL}:${GATEWAY_HTTP_PORT}/ -> ${answer.status}, the workload's own body again (\`${whoamiHostname(answer.body)}\`) (${elapsed()})`);
}
{
  for (const P of SET) {
    const request = tokenRequest(NEW_ROOT, 'terminate', { workload_id: WORKLOAD_ID }, REQUEST_TTL_S, P);
    const ended = answerOf(await sendTo(P, P.terminateRoute, { request }));
    assert(jstr(ended.body?.state) === jstr({ ended: 'termination' }), `${P.service}: ended with the NEW token — ${jstr(ended.body?.state ?? ended.body ?? ended.code)}`);
  }
  assert(await workloadGone(container, 30), `${container} is gone from the host daemon`);
}

// ── 6. a paged image ──────────────────────────────────────────────────────
step(`6. publish ${IMAGE_NAME}:v1 — busybox + a ${LAYER_BYTES / 1024 / 1024} MiB layer — with the record ceiling lowered to ${RECORD_MAX} bytes, so its layer's Blob Record PAGES`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'Dockerfile'), `FROM busybox:latest
ARG TOON_M7_NONCE=unset
RUN head -c ${LAYER_BYTES} /dev/urandom > /toon-m7-payload && echo "$TOON_M7_NONCE" > /etc/toon-m7-marker
ENTRYPOINT ["/bin/sleep", "3600"]
`);
docker('build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '-q',
  '--build-arg', `TOON_M7_NONCE=${RUN_NONCE}`, '-t', `${IMAGE_NAME}:v1`, WORK);
const tar = join(WORK, 'image.tar');
docker('save', '--platform', 'linux/amd64', `${IMAGE_NAME}:v1`, '-o', tar);
ok(`${IMAGE_NAME}:v1 built on the host daemon and exported as an OCI layout (run ${RUN_NONCE})`);

const io = await openToonIo({ secretKey: PUBLISHER_SECRET, client, log: (m) => console.log(`     ${m}`) });
const image = await publishImage({
  path: tar, name: IMAGE_NAME, tag: 'v1', secretKey: PUBLISHER_SECRET, io,
  recordMax: RECORD_MAX, partsPerPage: PARTS_PER_PAGE, log: (m) => console.log(`     ${m}`),
});
const layer = image.blobs
  .filter((b) => b.media_type.includes('layer'))
  .map((b) => ({ ...b, stored: image.stored.find((s) => s.digest === b.digest) }))
  .find((b) => b.stored?.skipped === false && b.size >= LAYER_BYTES / 2);
if (!layer) fatal(`no freshly stored layer of ~${LAYER_BYTES} bytes in ${jstr(image.stored)}`);
assert(image.blobs.every((b) => b.source.type === 'toon-store'),
  `${image.address} is ${image.digest}: all ${image.blobs.length} blobs in the TOON store, one Blob Record each (${image.stored.map((s) => `${s.pages ? `${s.pages} pages` : s.skipped ? 'kept' : 'inline'}`).join(', ')})`);
assert(layer.stored.pages === Math.ceil(layer.stored.parts / PARTS_PER_PAGE),
  `the payload layer ${layer.digest.slice(0, 19)}… (${layer.size} bytes, ${layer.stored.parts} parts) was published PAGED over ${layer.stored.pages} pages of ${PARTS_PER_PAGE} parts`);

step('6b. on the wire: the layer\'s Blob Record carries `pages` and no `parts`, from the relay and from its store copy, and every page holds what it says');
{
  const hex = hexOf(layer.digest);
  const onRelay = await findBlobRecordOnRelay(hex);
  const copy = JSON.parse((await readRaw(layer.source.blob_record_txid)).toString('utf8'));
  for (const [where, event] of [[`the relay (#x ${hex.slice(0, 12)}…)`, onRelay], [`the store copy ${GATEWAY}/raw/${layer.source.blob_record_txid}`, copy]]) {
    const content = event ? JSON.parse(event.content) : {};
    assert(event?.kind === K_BLOB && Array.isArray(content.pages) && !('parts' in content) && content.digest === layer.digest && content.size === layer.size,
      `${where}: kind ${event?.kind}, content keys ${Object.keys(content).sort().join(', ')} — ${content.pages?.length} pages and NO inline part list (spec §8.2)`);
  }
  assert(onRelay?.id === copy.id, `and the two are one signed event, ${copy.id.slice(0, 16)}…`);
  const content = JSON.parse(copy.content);
  const listed = await partListOf(content, readRaw);
  assert(listed.problems.length === 0 && listed.pages.every((p) => p.ok),
    `every page fetched from ${GATEWAY}/raw/ hashes to its \`sha256\` and holds its \`parts\` count: ${content.pages.map((p) => p.parts).join(' + ')} = ${listed.parts?.length} parts${listed.problems.length ? ` — ${listed.problems.join('; ')}` : ''}`);
  const pageBytes = await Promise.all(content.pages.map((p) => readRaw(p.txid)));
  assert(pageBytes.every((b) => b.length <= maxPartSize(DATA_ITEM_MAX_BYTES)) && listed.parts.every((p, i) => p.size === (i < listed.parts.length - 1 ? content.part_size : layer.size - content.part_size * (listed.parts.length - 1))),
    `each page is one ordinary store upload (${pageBytes.map((b) => b.length).join(', ')} bytes), and the part list they make is \`part_size\` ${content.part_size} throughout but the last, summing to ${layer.size}`);
  const whole = Buffer.concat(await Promise.all(listed.parts.map((p) => readRaw(p.txid))));
  assert(`sha256:${sha256Hex(whole)}` === layer.digest, `and the parts, joined page by page, ARE the layer: ${whole.length} bytes hashing to ${layer.digest.slice(0, 19)}…`);
}
{
  const verify = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'publisher.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const blob = verify('blob-verify', layer.digest);
  const blobReport = (() => { try { return JSON.parse(blob.stdout); } catch { return null; } })();
  assert(blob.status === 0 && blobReport?.failed === 0 && blobReport?.pages === layer.stored.pages,
    `\`publisher.mjs blob-verify ${layer.digest.slice(0, 19)}…\` reads it back through its ${blobReport?.pages} pages: ${blobReport?.checks} checks, ${blobReport?.failed} failed`);
  const entry = verify('image-verify', image.address);
  const entryReport = (() => { try { return JSON.parse(entry.stdout); } catch { return null; } })();
  assert(entry.status === 0 && entryReport?.failed === 0,
    `\`publisher.mjs image-verify ${image.address.slice(0, 24)}…\`: every Blob Record the entry cites, paged or inline, adds up — ${entryReport?.checks} checks, ${entryReport?.failed} failed`);
}

// ── 7. a lease from it ────────────────────────────────────────────────────
step(`7. a lease from the paged image: \`availability\` would_run, then a PAID ${PRIMARY.spawnRoute(SMOKE.name, SMOKE.version)} runs it BY DIGEST`);
{
  const profiles = await relayReadUntil(directoryFilter(K_PROFILE), 'profile', 60);
  const relay = profiles[0] ? JSON.parse(profiles[0].content).relays?.[0] : null;
  if (!relay) fatal('the Provider Profile names no Relay Set to hint a registry_entry at');
  const spawnImage = { digest: image.digest, registry_entry: { address: image.address, relay } };
  const avail = answerOf(await sendTo(PRIMARY, PRIMARY.availabilityRoute, { listing: SMOKE.name, version: SMOKE.version, image: spawnImage }));
  assert(avail.body?.would_run === true,
    `the free \`availability\` for { digest, registry_entry } says would_run ${jstr(avail.body?.would_run ?? avail.body ?? avail.code)} — asking stays free and accurate for a paged record (§8.4)`);

  const tenant = newTenant('m7-tenant');
  const root = newRootSecret();
  const workloadId = newWorkloadId();
  const content = { workload_id: workloadId, image: spawnImage, env: {}, ports: [], ssh_public_key: tenant.sshPublicKey };
  const spawned = answerOf(await sendTo(PRIMARY, PRIMARY.spawnRoute(SMOKE.name, SMOKE.version), { request: tokenRequest(root, 'spawn', content, REQUEST_TTL_S, PRIMARY) }));
  if (spawned.status !== 200) fatal(`the spawn from the paged image: ${spawned.status ?? spawned.code} ${jstr(spawned.body).slice(0, 300)} — \`docker compose logs provider\``);
  assert(spawned.body.workload_id === workloadId && spawned.body.role === 'standalone' && Number.isInteger(spawned.body.access?.ssh_port),
    `the provider answered 200: workload ${workloadId.slice(0, 12)}…, role ${spawned.body.role} (${elapsed()})`);
  const workload = await findWorkload(spawned.body.access.ssh_port, 30);
  if (!workload) fatal(`no toon-<id> container publishes ssh_port ${spawned.body.access.ssh_port}`);
  const runs = docker('inspect', '-f', '{{.Config.Image}}', workload.name).trim();
  assert(runs === image.digest,
    `${workload.name} runs ${runs} — the paged image BY DIGEST, fetched through ${layer.stored.pages} pages and ${layer.stored.parts} parts from the TOON store, verified and loaded`);
  const status = answerOf(await sendTo(PRIMARY, PRIMARY.statusRoute, { request: tokenRequest(root, 'status', { workload_id: workloadId }, REQUEST_TTL_S, PRIMARY) }));
  assert(status.body?.state === 'running', `\`status\` answers ${jstr(status.body?.state)}`);
  const ended = answerOf(await sendTo(PRIMARY, PRIMARY.terminateRoute, { request: tokenRequest(root, 'terminate', { workload_id: workloadId }, REQUEST_TTL_S, PRIMARY) }));
  assert(jstr(ended.body?.state) === jstr({ ended: 'termination' }), `the tenant ended it: ${jstr(ended.body?.state)}`);
  assert(await workloadGone(workload.name, 30), `${workload.name} is gone from the host daemon`);
}
await io.close?.();

console.log(`\n  total run time ${Math.round((Date.now() - startedAt) / 1000)}s`);
done(`a Standby Set was handed to the Workload Gateway and served at ${CANONICAL}; one rotation of both members made the grant the gateway held \`bad_grant\` at each and the old token \`not_tenant\`, and the gateway — told nothing — answered \`member_unreachable\` naming both refusals while the workload ran on; a handover of grants derived from the rotated tokens was admitted and the hostname served again. Then an image whose layer's Blob Record carries \`pages\` and no \`parts\` — on the relay and in the store, every page checked — was spawned by digest, run, and ended.`);
