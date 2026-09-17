#!/usr/bin/env node
// A spawn, from the host: development tooling for putting a workload on a
// sandbox provider so that something exists to put a hostname on (TOON_Network
// Milestone 5, #53). Run from sandbox/ against a running stack. Not a tenant
// product — the Milestone smokes do exactly this in code (scripts/lib/
// provider-smoke.mjs is where every piece here comes from); this is the same
// ceremony as one command, so README §2's walk-through can be followed by hand:
//
//   node scripts/spawn.mjs --image <reference>@sha256:<hex> --port <container port> \
//       [--port <container port>…] [--listing warm] \
//       [--standby <provider> [--standby <provider>…]] [--direct] [--terminate <lease.json>]
//
//   --image      the image, by reference AND digest (spec §6.2: a provider pulls
//                `reference@digest`, so the daemon verifies the bytes). Default:
//                traefik/whoami, an HTTP echo on port 80 — it answers with the
//                request it saw, forwarding headers included, which is exactly
//                what a gateway walk-through wants to look at
//   --port       a container port to publish, repeatable. Default: 80
//   --listing    the tier, by name in conf/provider.toml. Default: `warm`, the
//                600 s tier that also sells Warm Standbys — ten minutes is
//                enough to publish a grant and open a browser
//   --standby    the Standby Set, PRIMARY FIRST, by compose name (`provider`,
//                `provider2`); one member is a standalone lease. Default:
//                `provider`. Two members is what `make smoke-m3` buys: the
//                spawn is paid on the primary's `.spawn` and the reservation on
//                the standby's `.standby`, one signed request to both
//   --direct     pay the primary's OWN client edge (:3240 / :3250) instead of
//                the hub — the Milestone 1 smoke's second half. Standalone only.
//                The hub gives a peer 30 s to answer, and a spawn is a docker
//                pull and a container start; on a slow daemon that is T01 at
//                the hub while the provider went on and started the lease
//   --terminate  end the lease described by a JSON file this printed, signed
//                with the tenant key inside it, on every member. Free
//
// Prints one JSON report on stdout — the tenant's key (THE KEY A GRANT MUST BE
// SIGNED WITH, spec §6.5), the workload id, each member's answer, and the
// scripts/grant.mjs command that puts the sandbox gateway in front of it — and
// writes the same to .toon-client/spawn-<workload id>.json. Progress on stderr.
//
// PAYS from the smokes' buyer: account index 0 of the committed test phrase,
// on the shared .toon-client/channels.json (or provider-direct.json /
// provider2-direct.json for --direct), exactly as the smokes do. Do not run it
// while a smoke is running: two processes on one channel share one nonce
// watermark, and the loser has every later claim refused.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  HTTP_CONTAINER_PORT, HTTP_IMAGE, HUB, HUB_FEE, ROOT,
  jstr, leaseRequest, listing, newTenant, newWorkloadId, openChannel, providerOf, usageFromHeader,
} from './lib/provider-smoke.mjs';

// scripts/lib/provider-smoke.mjs's HTTP workload image, by reference@digest —
// the same bytes `make smoke-m5` spawns, so this walk-through and that smoke
// put the same thing behind the gateway.
const DEFAULT_IMAGE = `${HTTP_IMAGE.reference}@${HTTP_IMAGE.digest}`;
// The provider refuses a Lease Request valid for longer than this (spec §6.1).
const REQUEST_TTL_S = 300;

const log = (m) => console.error(`[spawn] ${m}`);
const usage = (problem) => usageFromHeader(import.meta.url, 'spawn', problem);

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        image: { type: 'string', default: DEFAULT_IMAGE },
        port: { type: 'string', multiple: true },
        listing: { type: 'string', default: 'warm' },
        standby: { type: 'string', multiple: true },
        direct: { type: 'boolean', default: false },
        terminate: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    return usage(e.message);
  }
})();
if (values.help) usage();

/** The result of one packet, as the smokes read it: the app's answer, or the refusal. */
const answer = (sent) => (sent.fulfilled ? { status: sent.status, body: sent.status === 200 ? sent.json() : sent.text().slice(0, 400) } : { refused: sent.code, by: sent.refusedBy, message: sent.message });

// ── terminate ──────────────────────────────────────────────────────────────
if (values.terminate) {
  const lease = JSON.parse(readFileSync(values.terminate, 'utf8'));
  const tenant = { secret: Uint8Array.from(Buffer.from(lease.tenant_key, 'hex')) };
  const members = lease.standby_set.map((name) => providerOf(name));
  const { client } = await openChannel(lease.paid_at === 'hub' ? HUB : members[0].edge, lease.channel_store);
  const out = {};
  for (const P of members) {
    const sent = await client.send(P.terminateRoute, { body: { request: leaseRequest(tenant, 'terminate', { workload_id: lease.workload_id }, 120, P) } }, { sealTo: P.edge, timeoutMs: 120_000 });
    out[P.service] = answer(sent);
    log(`${P.service}: ${jstr(out[P.service])}`);
  }
  console.log(JSON.stringify({ workload_id: lease.workload_id, terminated: out }, null, 2));
  process.exit(Object.values(out).every((a) => a.status === 200) ? 0 : 1);
}

// ── spawn ──────────────────────────────────────────────────────────────────
const [reference, digest] = values.image.split('@');
if (!reference || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) usage(`--image must be <reference>@sha256:<64 hex>, not ${values.image}`);
const ports = (values.port ?? [String(HTTP_CONTAINER_PORT)]).map((p) => Number(p));
if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) usage(`--port must be a port: ${values.port}`);
const names = values.standby ?? ['provider'];
let SET;
try {
  SET = names.map((n) => providerOf(n));
} catch (e) {
  usage(e.message);
}
if (values.direct && SET.length > 1) usage('--direct pays one edge, so it is for a standalone lease; a Standby Set is paid through the hub');
const [PRIMARY, ...STANDBYS] = SET;
const L = listing(values.listing, PRIMARY);
if (STANDBYS.length > 0 && L.standby_price === null) usage(`conf/${PRIMARY.confFile}'s \`${L.name}\` sets no standby_price, so it sells no standby`);

const channelStore = values.direct ? `${PRIMARY.service}-direct.json` : 'channels.json';
const { client } = await openChannel(values.direct ? PRIMARY.edge : HUB, channelStore);
const sendTo = (P, route, body) => client.send(route, { body }, { sealTo: P.edge, timeoutMs: 300_000 });

const tenant = newTenant('spawn-tenant');
const workloadId = newWorkloadId();
const content = {
  workload_id: workloadId,
  image: { reference, digest },
  env: {},
  ports: ports.map((p) => ({ container_port: p, protocol: 'tcp' })),
  ssh_public_key: tenant.sshPublicKey,
  ...(SET.length > 1 ? { standby_set: SET.map((P) => P.pubkey) } : {}),
};
const request = leaseRequest(tenant, 'spawn', content, REQUEST_TTL_S, SET.length > 1 ? SET : PRIMARY);
log(`workload ${workloadId}: ${reference}@${digest.slice(0, 19)}…, ports ${ports.join(',')}, ${L.name} v${L.version} (${L.lease_interval_s} s, ${L.price}${values.direct ? '' : ` + ${HUB_FEE} hub fee`}) on ${SET.map((P) => P.service).join(' + ')}, paid ${values.direct ? `at ${PRIMARY.edge}` : 'through the hub'}`);

const members = {};
const t0 = Date.now();
const spawned = await sendTo(PRIMARY, PRIMARY.spawnRoute(L.name, L.version), { request });
members[PRIMARY.service] = answer(spawned);
log(`${PRIMARY.service} (.spawn) after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${jstr(members[PRIMARY.service]).slice(0, 300)}`);
for (const S of STANDBYS) {
  const reserved = await sendTo(S, S.standbyRoute(L.name, L.version), { request });
  members[S.service] = answer(reserved);
  log(`${S.service} (.standby): ${jstr(members[S.service]).slice(0, 300)}`);
}

const primary = members[PRIMARY.service].body;
const ok = typeof primary === 'object' && primary?.workload_id === workloadId;
const out = {
  workload_id: workloadId,
  tenant_key: Buffer.from(tenant.secret).toString('hex'),
  tenant_pubkey: tenant.pubkey,
  standby_set: SET.map((P) => P.service),
  listing: { name: L.name, version: L.version, lease_interval_s: L.lease_interval_s },
  ports,
  paid_at: values.direct ? PRIMARY.service : 'hub',
  channel_store: channelStore,
  members,
  ...(ok ? { access: primary.access, expires_at: primary.expires_at } : {}),
  grant: ok
    ? `node scripts/grant.mjs --workload ${workloadId} --key ${Buffer.from(tenant.secret).toString('hex')} --http-port ${ports[0]} --ports ${ports.join(',')} ${SET.map((P) => `--standby ${P.service}`).join(' ')} --expires-in 1h`
    : null,
};
const file = join(ROOT, '.toon-client', `spawn-${workloadId.slice(0, 12)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (ok) {
  log(`running at ${primary.access?.host}:${primary.access?.ports?.map((p) => p.host_port).join(',')} until ${new Date(primary.expires_at * 1000).toISOString()}; written to ${file}`);
  log(`next: ${out.grant}`);
  log(`end it early: node scripts/spawn.mjs --terminate ${file}`);
}
process.exit(ok ? 0 : 1);
