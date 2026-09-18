#!/usr/bin/env node
// The handover script: the TENANT side of the Workload Gateway (TOON_Network
// Milestone 6, #62; spec §6.5.1, §12.1, §12.7). Run from sandbox/ on the host
// against a running stack (`make up-gateway`). Not a tenant product — the
// tool it runs is (provider/tools/grant, #59); this is that tool with the
// sandbox's values filled in, in the publisher's style, so choosing the
// sandbox gateway is one command and leaving it is one more:
//
//   node scripts/handover.mjs <lease.json> [--expires-in 1h | --expires-at <unix seconds>] \
//       [--name <label>] [--http-port <container port>] [--dry-run]
//   node scripts/handover.mjs --withdraw <lease.json> [--dry-run]
//
//   <lease.json>  the file scripts/spawn.mjs wrote (.toon-client/spawn-<id>.json):
//                 the workload id, the Standby Set, the container ports and THE
//                 ROOT SECRET are read from it, so the secret never crosses a
//                 command line. A handover records what it sealed back into it
//                 (`handover`: the moment, the name, the URLs), which is what a
//                 later --withdraw bears
//   --expires-in  how long the grant admits the gateway (default 1h); or
//   --expires-at  the same as a moment. Keep it short and run this again to
//                 renew: the same command IS the renewal (rotation is
//                 re-derivation at a later moment, spec §6.5.1)
//   --name        an optional readable label, served beside the canonical one
//   --http-port   which of the spawn's container ports carries HTTP. Default:
//                 the lease file's first port
//   --withdraw    seal a Gateway Withdrawal instead: the gateway stops serving
//                 the workload AT ONCE, bearing the grant the handover recorded
//                 in the lease file. It ends SERVING, not READING — the
//                 gateway keeps a working grant until the moment it was handed
//                 over for (spec §12.7)
//   --dry-run     derive the message, print it, and stop: nothing is paid for,
//                 no channel is opened, nothing is sent
//
// Without a lease file — a lease spawned by hand, the hidden provider's for
// one (README §2, "Reaching a hidden workload by hand") — the same values come
// from flags, and the root secret from the environment:
//
//   TOON_ROOT_SECRET=<64 hex> node scripts/handover.mjs --workload <64 hex> \
//       --standby <member> [--standby <member>…] --http-port <container port> \
//       [--ports <port,port,…>] [--expires-in 1h] [--name <label>] [--dry-run]
//   TOON_ROOT_SECRET=<64 hex> node scripts/handover.mjs --withdraw --workload <64 hex> \
//       --standby <member> [--standby <member>…] --expires-at <unix seconds>
//
//   --standby     the Standby Set, PRIMARY FIRST, one flag per member: a
//                 sandbox provider's compose name (`provider`, `provider2`,
//                 `provider-hs`), resolved to its pubkey out of conf/, or a
//                 64-hex pubkey as is. A standalone lease's is its one provider
//
// Prints the tool's JSON report on stdout — the message as sealed (one grant
// PER MEMBER, derived under that member's key), the gateway's route and
// sealing key, and whether the gateway took it — with `hostnames` and `urls`
// added to a handover's: the canonical hostname (the lowercase unpadded
// base32 of the workload id, 52 characters, spec §12.2) and the `name` under
// the sandbox gateway domain, at both of the gateway's published listeners.
// Exit codes are the tool's: 0 when the gateway took the message (or on a dry
// run), 1 when it refused, 2 for a refusal before anything was derived or paid
// for. Progress goes to stderr.
//
// NOTHING IS PUBLISHED, and there is no key. The grant is DERIVED from the
// Continuation Token this lease holds for that member — which in turn derives
// from the lease's root secret (spec §6.1.1, §6.5.1) — and the message is
// SEALED to the sandbox gateway's own connector (spec §12.1, ADR 0011),
// which unseals it and hands
// the gateway plaintext JSON; the gateway then asks the members whether the
// grant works, and serves the workload if one of them says so. No relay is
// written, no relay is read by this script, and the tenant's Nostr key —
// still generated beside the SSH key — is used for nothing here.
//
// WHAT IT FILLS IN, and where each value comes from:
//   the payer        anvil's public test phrase at ACCOUNT INDEX 4, its own
//                    wallet and its own channel — against THE GATEWAY'S OWN
//                    CONNECTOR at :3260, paid directly, the way `spawn.mjs
//                    --direct` pays a provider's edge — funded by
//                    scripts/seed-toon-solana.mjs; its channel store is
//                    .toon-client/handover-channels.json, NOT the smokes'
//                    channels.json — a smoke holds its own client open on that
//                    one while it runs this script, and two processes on one
//                    channel share one nonce watermark
//   the route        the one prefix conf/connector-workload-gateway.toml
//                    terminates, g.toon.workload-gateway.handover, at price 0
//   the sealing key  DERIVED from keys/toon/workload-gateway-connector/signer.key
//                    — pinned out of band, as a tenant pins a Provider Profile's
//                    (ADR 0011); nothing is fetched to learn it
//   the members      conf/provider.toml, conf/provider2.toml,
//                    conf/provider-hs.toml, by nostr_private_key
// Every TOON_* variable the tool reads may still be set in the environment and
// wins over these defaults (the tool's README lists them) — except the root
// secret, which a lease file names explicitly and therefore wins.
//
// The tool itself is run where it lives, ../../provider/tools/grant
// (PROVIDER_CONTEXT overrides), rather than copied here: the sandbox seals
// exactly the bytes the tool's own tests prove against the wire fixtures.
// `make setup` installs its dependencies.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { MNEMONIC, PROVIDERS, ROOT, RPC_URL, usageFromHeader } from './lib/provider-smoke.mjs';
import { GATEWAY_EDGE, canonicalLabel, gatewayDomain, gatewaySealKey, handoverRoute, urlsFor } from './lib/gateway-smoke.mjs';

const PROVIDER_CONTEXT = process.env.PROVIDER_CONTEXT ?? join(ROOT, '..', '..', 'provider');
const TOOL_DIR = join(PROVIDER_CONTEXT, 'tools', 'grant');
// Account index 4 of the committed test phrase: see scripts/seed-toon-solana.mjs.
const HANDOVER_PAYER_ACCOUNT_INDEX = '4';
const CHANNEL_STORE = join(ROOT, '.toon-client', 'handover-channels.json');

const log = (m) => console.error(`[handover] ${m}`);
const usage = (problem) => usageFromHeader(import.meta.url, 'handover', problem);

/** A Standby Set member as given on the command line or in a lease file: a sandbox provider's name, or a pubkey. */
function memberPubkey(member) {
  if (/^[0-9a-f]{64}$/.test(member)) return member;
  const provider = PROVIDERS[member];
  if (!provider) {
    throw new Error(`--standby ${member} is neither a 64-hex pubkey nor a sandbox provider (${Object.keys(PROVIDERS).join(', ')})`);
  }
  return provider.pubkey;
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        withdraw: { type: 'boolean', default: false },
        workload: { type: 'string' },
        standby: { type: 'string', multiple: true },
        'http-port': { type: 'string' },
        ports: { type: 'string' },
        'expires-at': { type: 'string' },
        'expires-in': { type: 'string' },
        name: { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    return usage(e.message);
  }
})();
if (values.help) usage();
if (positionals.length > 1) usage(`one lease at a time, not ${positionals.join(' and ')}`);
const withdrawing = values.withdraw;

// ── the lease: a file scripts/spawn.mjs wrote, or flags and the environment ──
const leaseFile = positionals[0];
let lease;
if (leaseFile !== undefined) {
  if (!existsSync(leaseFile)) usage(`${leaseFile} does not exist`);
  lease = JSON.parse(readFileSync(leaseFile, 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(lease.root_secret ?? '')) {
    usage(`${leaseFile} holds no root_secret: a lease file from before Milestone 6 (tenant_key) has nothing a grant derives from`);
  }
  for (const flag of ['workload', 'standby', 'ports']) {
    if (values[flag] !== undefined) usage(`--${flag} is read from ${leaseFile}; pass one or the other`);
  }
} else {
  if (!values.workload) usage('a lease is required: the file scripts/spawn.mjs wrote, or --workload with --standby and TOON_ROOT_SECRET');
  if (!values.standby?.length) usage('at least one --standby is required (primary first) when no lease file is given');
  if (!process.env.TOON_ROOT_SECRET) usage('TOON_ROOT_SECRET is required when no lease file is given: the root secret the lease was spawned from');
  lease = {
    workload_id: values.workload,
    root_secret: process.env.TOON_ROOT_SECRET,
    standby_set: values.standby,
    ports: values.ports === undefined ? undefined : values.ports.split(',').map((p) => Number(p.trim())),
  };
}

// What a withdrawal bears is the grant IN FORCE: the moment the handover was
// derived for. A lease file remembers it; by hand it is --expires-at.
if (withdrawing) {
  for (const flag of ['http-port', 'ports', 'name', 'expires-in']) {
    if (values[flag] !== undefined) usage(`--${flag} is a handover's: a withdrawal names the workload and bears its grant`);
  }
  if (values['expires-at'] === undefined) {
    if (lease.handover?.expires_at === undefined) {
      usage(`${leaseFile ?? 'this lease'} records no handover to withdraw; --expires-at <unix seconds> names the moment the handover was derived for`);
    }
  } else if (lease.handover?.expires_at !== undefined && Number(values['expires-at']) !== lease.handover.expires_at) {
    usage(`--expires-at ${values['expires-at']} is not the moment ${leaseFile} recorded (${lease.handover.expires_at}); the gateway holds the grant derived for that moment and no other`);
  }
} else {
  if (values['expires-at'] !== undefined && values['expires-in'] !== undefined) usage('--expires-at and --expires-in: one or the other');
  if (values['http-port'] === undefined && !(lease.ports?.length > 0)) usage('--http-port is required when the lease names no ports');
}

if (!existsSync(join(TOOL_DIR, 'seal.mjs'))) {
  log(`the handover tool is not at ${TOOL_DIR} — the provider checkout (toon-protocol/provider, branch with tools/grant/seal.mjs) is`);
  log('expected at ../../provider; PROVIDER_CONTEXT=/path/to/provider says where else.');
  process.exit(2);
}
if (!values['dry-run'] && !existsSync(join(TOOL_DIR, 'node_modules'))) {
  log(`${TOOL_DIR} has no node_modules: run \`make setup\` (or \`npm install --prefix ${TOOL_DIR}\`) once. (--dry-run needs none.)`);
  process.exit(2);
}

let members;
let domain;
let route;
let sealKey;
try {
  members = lease.standby_set.map(memberPubkey);
  domain = gatewayDomain();
  route = handoverRoute();
  sealKey = gatewaySealKey();
} catch (e) {
  usage(e.message);
}

// The tool's own arguments, with the sandbox's values filled in.
const expiresAt = withdrawing ? values['expires-at'] ?? String(lease.handover.expires_at) : values['expires-at'];
const args = [
  join(TOOL_DIR, 'seal.mjs'),
  withdrawing ? 'withdrawal' : 'handover',
  '--workload', lease.workload_id,
  ...members.flatMap((m) => ['--standby', m]),
  '--gateway-route', route,
  '--gateway-seal-key', sealKey,
  ...(expiresAt !== undefined ? ['--expires-at', expiresAt] : []),
  ...(withdrawing ? [] : [
    '--http-port', values['http-port'] ?? String(lease.ports[0]),
    ...(lease.ports?.length > 0 ? ['--ports', lease.ports.join(',')] : []),
    ...(expiresAt === undefined ? ['--expires-in', values['expires-in'] ?? '1h'] : []),
    ...(values.name !== undefined ? ['--name', values.name] : []),
  ]),
  ...(values['dry-run'] ? ['--dry-run'] : []),
];
const env = {
  TOON_CONNECTOR_URL: GATEWAY_EDGE,
  TOON_CHAIN: 'solana',
  TOON_RPC_URL: RPC_URL,
  TOON_MNEMONIC: MNEMONIC,
  TOON_ACCOUNT_INDEX: HANDOVER_PAYER_ACCOUNT_INDEX,
  TOON_CHANNEL_STORE: CHANNEL_STORE,
  // Anything set in the environment wins: the tool's README names them all…
  ...process.env,
  // …but the root secret of a named lease file is that lease's, whatever the
  // shell happens to hold.
  TOON_ROOT_SECRET: lease.root_secret,
};

log(`${withdrawing ? 'withdrawal' : 'handover'} of workload ${lease.workload_id.slice(0, 12)}… to ${route} (the sandbox gateway's connector, sealing key ${sealKey.slice(0, 12)}…), Standby Set ${members.map((m) => m.slice(0, 12) + '…').join(', ')}`);
log(`paying ${GATEWAY_EDGE} directly from account index ${env.TOON_ACCOUNT_INDEX}, channel store ${env.TOON_CHANNEL_STORE}; nothing is published`);
const ran = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
if (ran.error) {
  log(`could not run the handover tool: ${ran.error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(ran.stdout);
} catch {
  // Not a report (a refusal prints nothing): pass it through as it came.
  process.stdout.write(ran.stdout);
  process.exit(ran.status ?? 1);
}
const message = withdrawing ? report.withdrawal : report.handover;
const labels = withdrawing ? [] : [canonicalLabel(lease.workload_id), ...(message?.name ? [message.name] : [])];
const out = {
  ...report,
  ...(withdrawing ? {} : { hostnames: labels.map((l) => `${l}.${domain}`), urls: urlsFor(labels, domain) }),
};
console.log(JSON.stringify(out, null, 2));

// A delivered message is recorded in the lease file, so the next command
// knows what the gateway holds: a handover's moment (what a withdrawal must
// bear) and its URLs; a withdrawal clears the record.
if (leaseFile !== undefined && ran.status === 0 && !values['dry-run']) {
  const recorded = withdrawing
    ? { ...lease, handover: undefined, withdrawn_at: Math.floor(Date.now() / 1000) }
    : { ...lease, withdrawn_at: undefined, handover: { expires_at: message.expires_at, ...(message.name ? { name: message.name } : {}), hostnames: out.hostnames, urls: out.urls } };
  writeFileSync(leaseFile, JSON.stringify(recorded, null, 2), { mode: 0o600 });
}
if (ran.status === 0 && !values['dry-run']) {
  if (withdrawing) {
    log(`the gateway no longer serves ${canonicalLabel(lease.workload_id)}.${domain}; it still holds a working grant until ${new Date(Number(expiresAt) * 1000).toISOString()} (a withdrawal ends serving, not reading)`);
  } else {
    // The admission round already asked the members and kept where the
    // workload is running (gateway src/admit.mjs `remember`), so the first
    // request is normally a 200. A 503 not_resolved here means the member
    // stopped running it between admission and the request; ask again.
    log(`served at ${out.urls[0]}`);
    if (leaseFile !== undefined) log(`take it off again: node scripts/handover.mjs --withdraw ${leaseFile}`);
    else log(`take it off again: TOON_ROOT_SECRET=… node scripts/handover.mjs --withdraw --workload ${lease.workload_id} ${lease.standby_set.map((m) => `--standby ${m}`).join(' ')} --expires-at ${message.expires_at}`);
  }
}
process.exit(ran.status ?? 1);
