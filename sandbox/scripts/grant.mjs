#!/usr/bin/env node
// The grant script: the TENANT side of the Workload Gateway (TOON_Network
// Milestone 5, #53; spec §3.1.3, §12). Run from sandbox/ on the host against
// a running stack (`make up-gateway`). Not a tenant product — the tool it runs
// is (provider/tools/grant, #48); this is that tool with the sandbox's values
// filled in, in the publisher's style, so publishing a grant is one command:
//
//   node scripts/grant.mjs --workload <64 hex> --key <tenant hex> \
//       --http-port <container port> --ports <port,port,…> \
//       --standby <member> [--standby <member>…] \
//       (--expires-in <24h | 90m | 7d | seconds> | --expires-at <unix seconds>) \
//       [--name <label>] [--gateway <pubkey>] [--relay <ws://…>…] [--dry-run]
//
//   --workload    the workload id the spawn was signed with
//   --key         the tenant's Nostr secret key, hex — THE KEY THAT SIGNED THE
//                 SPAWN, because a provider accepts a grant exactly when its
//                 signer is the lease's tenant (spec §6.5). Or TOON_TENANT_KEY.
//   --http-port   which of the spawn's container ports carries HTTP
//   --ports       every container_port the spawn asked for, comma-separated
//   --standby     the Standby Set, PRIMARY FIRST, one flag per member: a
//                 sandbox provider's compose name (`provider`, `provider2`,
//                 `provider-hs`), resolved to its pubkey out of conf/, or a
//                 64-hex pubkey as is. A standalone lease's is its one provider
//   --expires-in  when the grant stops admitting the gateway; keep it short and
//                 run this again to renew (the same command IS the renewal)
//   --name        an optional readable label, served beside the canonical one
//   --gateway     the gateway's pubkey. Default: THE SANDBOX GATEWAY, derived
//                 from conf/workload-gateway.conf's GATEWAY_SECRET_KEY
//   --relay       a relay to publish to (repeatable); default: the sandbox
//                 relay at ws://localhost:7100, paid on g.toon.relay
//   --dry-run     sign, print the event, and stop: nothing is paid for
//
// Prints the tool's JSON report on stdout — the address, the event id, the
// content as signed, which relays accepted it — with `hostnames` and `urls`
// added: the canonical hostname (the lowercase unpadded base32 of the workload
// id, 52 characters, spec §12.2) and the `name` under the sandbox gateway
// domain, at both of the gateway's published listeners. Exit codes are the
// tool's: 0 when a relay accepted the grant, 1 when none did, 2 for a refusal
// before anything was signed or paid for. Progress goes to stderr.
//
// WHAT IT FILLS IN, and where each value comes from:
//   the payer        anvil's public test phrase at ACCOUNT INDEX 4, its own
//                    wallet and its own channel against the hub (:3200),
//                    funded by scripts/seed-toon-solana.mjs; its channel store
//                    is .toon-client/grant-channels.json, NOT the smokes'
//                    channels.json — a Milestone 5 smoke holds its own client
//                    open on that one while it runs this script, and two
//                    processes on one channel share one nonce watermark
//   the relay        ws://localhost:7100 read, g.toon.relay written (1 unit)
//   the gateway      conf/workload-gateway.conf — the key `make up-gateway`
//                    runs the gateway with, so the grant names the gateway
//                    that is actually watching this relay
//   the members      conf/provider.toml, conf/provider2.toml,
//                    conf/provider-hs.toml, by nostr_private_key
// Every TOON_* variable the tool reads may still be set in the environment and
// wins over these defaults (the tool's README lists them).
//
// The tool itself is run where it lives, ../../provider/tools/grant
// (PROVIDER_CONTEXT overrides), rather than copied here: the sandbox publishes
// exactly the bytes the tool's own tests prove against the wire fixtures.
// `make setup` installs its dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { getPublicKey } from 'nostr-tools/pure';
import { HUB, MNEMONIC, PROVIDERS, RELAY_WS, ROOT, RPC_URL, usageFromHeader } from './lib/provider-smoke.mjs';

// The sandbox gateway's HOST-side listeners (docker-compose.yml publishes
// 8080 -> 3280 and 8443 -> 3443), for the URLs printed at the end.
const GATEWAY_HTTP_PORT = Number(process.env.GATEWAY_HTTP_PORT ?? 3280);
const GATEWAY_HTTPS_PORT = Number(process.env.GATEWAY_HTTPS_PORT ?? 3443);
const GATEWAY_CONF = join(ROOT, 'conf', 'workload-gateway.conf');
const PROVIDER_CONTEXT = process.env.PROVIDER_CONTEXT ?? join(ROOT, '..', '..', 'provider');
const TOOL_DIR = join(PROVIDER_CONTEXT, 'tools', 'grant');
// Account index 4 of the committed test phrase: see scripts/seed-toon-solana.mjs.
const GRANT_PAYER_ACCOUNT_INDEX = '4';
const CHANNEL_STORE = join(ROOT, '.toon-client', 'grant-channels.json');

const log = (m) => console.error(`[grant] ${m}`);
const usage = (problem) => usageFromHeader(import.meta.url, 'grant', problem);

/** A `KEY=value` line out of the gateway's env file, or throw naming it. */
function gatewayConf(key) {
  const text = readFileSync(GATEWAY_CONF, 'utf8');
  const value = text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
  if (!value) throw new Error(`conf/workload-gateway.conf has no ${key} line`);
  return value;
}
/** The sandbox gateway's public key: what `make up-gateway` runs it with. */
const sandboxGatewayPubkey = () =>
  getPublicKey(Uint8Array.from(Buffer.from(gatewayConf('GATEWAY_SECRET_KEY'), 'hex')));
const sandboxGatewayDomain = () => gatewayConf('GATEWAY_DOMAIN').toLowerCase();

/**
 * RFC 4648 base32, lowercase, unpadded — the canonical label of spec §12.2, as
 * the gateway derives it (its src/hostname.mjs), so the URL printed here is
 * the one it serves. A smoke that wants this lifts it into scripts/lib/.
 */
function canonicalLabel(workloadId) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of Buffer.from(workloadId, 'hex')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** A Standby Set member as given on the command line: a sandbox provider's name, or a pubkey. */
function memberPubkey(member) {
  if (/^[0-9a-f]{64}$/.test(member)) return member;
  const provider = PROVIDERS[member];
  if (!provider) {
    throw new Error(`--standby ${member} is neither a 64-hex pubkey nor a sandbox provider (${Object.keys(PROVIDERS).join(', ')})`);
  }
  return provider.pubkey;
}

/** The URLs a workload is served at under the sandbox gateway. */
function urlsFor(labels, domain) {
  return labels.flatMap((label) => [
    `http://${label}.${domain}:${GATEWAY_HTTP_PORT}/`,
    `https://${label}.${domain}:${GATEWAY_HTTPS_PORT}/`,
  ]);
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        workload: { type: 'string' },
        key: { type: 'string' },
        gateway: { type: 'string' },
        'http-port': { type: 'string' },
        ports: { type: 'string' },
        standby: { type: 'string', multiple: true },
        'expires-at': { type: 'string' },
        'expires-in': { type: 'string' },
        name: { type: 'string' },
        relay: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (e) {
    return usage(e.message);
  }
})();
if (values.help) usage();
if (!values.workload) usage('--workload is required');
if (!values.standby?.length) usage('at least one --standby is required (primary first)');
const tenantKey = values.key ?? process.env.TOON_TENANT_KEY;
if (!tenantKey) usage('the tenant\'s key is required: --key <64 hex> or TOON_TENANT_KEY — the key that signed the spawn');

if (!existsSync(join(TOOL_DIR, 'publish.mjs'))) {
  log(`the grant tool is not at ${TOOL_DIR} — the provider checkout (toon-protocol/provider, branch with tools/grant) is`);
  log('expected at ../../provider; PROVIDER_CONTEXT=/path/to/provider says where else.');
  process.exit(2);
}
if (!existsSync(join(TOOL_DIR, 'node_modules'))) {
  log(`${TOOL_DIR} has no node_modules: run \`make setup\` (or \`npm install --prefix ${TOOL_DIR}\`) once.`);
  process.exit(2);
}

let gateway;
let members;
let domain;
try {
  gateway = values.gateway ?? sandboxGatewayPubkey();
  members = values.standby.map(memberPubkey);
  domain = sandboxGatewayDomain();
} catch (e) {
  usage(e.message);
}

// The tool's own arguments, with the sandbox's values filled in.
const args = [
  join(TOOL_DIR, 'publish.mjs'),
  '--workload', values.workload,
  '--gateway', gateway,
  '--key', tenantKey,
  ...members.flatMap((m) => ['--standby', m]),
  ...(values['http-port'] !== undefined ? ['--http-port', values['http-port']] : []),
  ...(values.ports !== undefined ? ['--ports', values.ports] : []),
  ...(values['expires-at'] !== undefined ? ['--expires-at', values['expires-at']] : []),
  ...(values['expires-in'] !== undefined ? ['--expires-in', values['expires-in']] : []),
  ...(values.name !== undefined ? ['--name', values.name] : []),
  ...(values.relay ?? []).flatMap((r) => ['--relay', r]),
  ...(values['dry-run'] ? ['--dry-run'] : []),
];
const env = {
  TOON_CONNECTOR_URL: HUB,
  TOON_CHAIN: 'solana',
  TOON_RPC_URL: RPC_URL,
  TOON_MNEMONIC: MNEMONIC,
  TOON_ACCOUNT_INDEX: GRANT_PAYER_ACCOUNT_INDEX,
  TOON_CHANNEL_STORE: CHANNEL_STORE,
  RELAY_WRITE_ROUTES: JSON.stringify({ [RELAY_WS]: 'g.toon.relay' }),
  // Anything set in the environment wins: the tool's README names them all.
  ...process.env,
};

log(`gateway ${gateway.slice(0, 12)}… (${values.gateway ? '--gateway' : 'the sandbox gateway, conf/workload-gateway.conf'}), Standby Set ${members.map((m) => m.slice(0, 12) + '…').join(', ')}`);
log(`paying through ${HUB} from account index ${env.TOON_ACCOUNT_INDEX}, channel store ${env.TOON_CHANNEL_STORE}`);
const ran = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
if (ran.error) {
  log(`could not run the grant tool: ${ran.error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(ran.stdout);
} catch {
  // Not a report (a --dry-run prints the event; a refusal prints nothing):
  // pass it through as it came.
  process.stdout.write(ran.stdout);
  process.exit(ran.status ?? 1);
}
const labels = [canonicalLabel(values.workload), ...(report.grant?.name ? [report.grant.name] : [])];
const out = {
  ...report,
  hostnames: labels.map((l) => `${l}.${domain}`),
  urls: urlsFor(labels, domain),
};
console.log(JSON.stringify(out, null, 2));
if (ran.status === 0) {
  log(`served at ${out.urls[0]} once the gateway has resolved it (a first request may answer 503 not_resolved; ask again)`);
}
process.exit(ran.status ?? 1);
