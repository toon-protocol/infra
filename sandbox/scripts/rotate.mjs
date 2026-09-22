#!/usr/bin/env node
// The rotate script: the TENANT replacing a lease's Continuation Token at
// every member of its Standby Set (TOON_Network Milestone 7, #75; spec §6.8,
// ADR 0018). Run from sandbox/ on the host against a running stack. Not a
// tenant product — the tool it runs is (provider/tools/grant, `seal.mjs
// rotate`); this is that tool with the sandbox's values filled in, exactly as
// scripts/handover.mjs is for a handover:
//
//   node scripts/rotate.mjs <lease.json>
//
//   <lease.json>  the file scripts/spawn.mjs wrote (.toon-client/spawn-<id>.json).
//                 The TOOL reads the workload id and the root secret from it
//                 and writes the new root secret back: into `rotation` before
//                 a request leaves, and over `root_secret` once every member
//                 has confirmed. Until then the file keeps BOTH, because a
//                 member that has not rotated is still read with the old one;
//                 run this again to finish, and it resumes with the same new
//                 root secret
//
// Prints the tool's JSON report on stdout — each member, and whether it
// rotated (`recovered: true` where the answer was lost and `status` with the
// new token confirmed it) — and no secret. Exit codes are the tool's: 0 when
// every member rotated, 1 when one did not, 2 for a refusal before anything
// was sent. Progress goes to stderr.
//
// WHAT IT ENDS. Every grant derived from the old root secret is `bad_grant`
// at every member from the moment it rotates: a Workload Gateway handed one
// stops READING the lease, not only serving it, and answers
// `503 member_unreachable`. To keep the sandbox gateway serving, hand over
// again: `node scripts/handover.mjs <lease.json>` derives from the root secret
// the file now holds.
//
// WHAT IT FILLS IN, and where each value comes from:
//   the members      the lease file's `standby_set`, by compose name, resolved
//                    out of conf/: each provider's pubkey (nostr_private_key),
//                    the `ilp_address` its routes hang off, and the
//                    `connector_seal_key` its Profile PINS (ADR 0011) — the
//                    tool seals to that and fetches nothing.
//   `provider-hs`    reached DIRECTLY over anon (spec §10, §12.8;
//                    TOON_Network #81), not through the hub: its own
//                    connector — the `.anyone` address `make up-hs` rendered
//                    (conf/.rendered/provider-hs.toml), read here the same way
//                    smoke-hs.mjs and smoke-milestone4.mjs do — is passed to
//                    the tool as the member's fourth field, and the tool dials
//                    it through the buyer's own anon-client SOCKS proxy
//                    (TOON_SOCKS_PROXY, below). `<addr>.rotate` and
//                    `<addr>.status` are free routes (spec §5, §6.8), so
//                    nothing is paid for there and no channel opens — the
//                    account index and chain below are for IDENTITY only
//   the payer        anvil's public test phrase at ACCOUNT INDEX 4, the
//                    handover script's wallet, paying THROUGH THE HUB at
//                    :3200 (100 per free route, the hub's fee) on its own
//                    channel store .toon-client/rotate-channels.json — not the
//                    smokes' channels.json, which a smoke holds open while it
//                    runs this, and not handover-channels.json, whose channel
//                    is with the gateway's connector. A hidden member's is a
//                    SEPARATE identity, account index 7 — free (below), left
//                    beside smoke-hs's (5) and smoke-milestone4's (6) rather
//                    than reusing either
// Every TOON_* variable the tool reads may still be set in the environment and
// wins over these defaults (the tool's README lists them).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { HUB, MNEMONIC, PROVIDERS, ROOT, RPC_URL, usageFromHeader } from './lib/provider-smoke.mjs';

const PROVIDER_CONTEXT = process.env.PROVIDER_CONTEXT ?? join(ROOT, '..', '..', 'provider');
const TOOL_DIR = join(PROVIDER_CONTEXT, 'tools', 'grant');
// Account index 4 of the committed test phrase: see scripts/seed-toon-solana.mjs.
const ROTATE_PAYER_ACCOUNT_INDEX = '4';
const CHANNEL_STORE = join(ROOT, '.toon-client', 'rotate-channels.json');
// The hidden path: `provider-hs`'s own connector, reached over the buyer's
// anon-client SOCKS proxy, on the sandbox's second chain (`evm`, the private
// anvil provider-hs settles on — conf/provider-hs.toml's `[anon]` table).
// Account index 7 of the SAME test phrase: free, and distinct from every
// other account this sandbox already names (README §2).
const ANON_SOCKS_PORT = process.env.ANON_SOCKS_PORT ?? '19050';
const HIDDEN_SOCKS_PROXY = process.env.TOON_SOCKS_PROXY ?? `socks5h://127.0.0.1:${ANON_SOCKS_PORT}`;
const HIDDEN_ACCOUNT_INDEX = '7';
const HIDDEN_CHANNEL_STORE = join(ROOT, '.toon-client', 'rotate-hs-channels.json');
const RENDERED_HS_PROVIDER = join(ROOT, 'conf', '.rendered', 'provider-hs.toml');

/** The `.anyone` address `make up-hs` rendered for `provider-hs`, or throw — the same read smoke-hs.mjs and smoke-milestone4.mjs make. */
function hiddenConnector() {
  if (!existsSync(RENDERED_HS_PROVIDER)) {
    throw new Error(`${RENDERED_HS_PROVIDER} does not exist: \`make up-hs\` renders provider-hs's .anyone address`);
  }
  const address = (readFileSync(RENDERED_HS_PROVIDER, 'utf8').match(/[a-z2-7]{56}\.anyone/) ?? [])[0];
  if (!address) throw new Error(`${RENDERED_HS_PROVIDER} names no <56-base32>.anyone address — re-run \`make up-hs\``);
  return `http://${address}`;
}

const log = (m) => console.error(`[rotate] ${m}`);
const usage = (problem) => usageFromHeader(import.meta.url, 'rotate', problem);

const { values, positionals } = (() => {
  try {
    return parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    return usage(e.message);
  }
})();
if (values.help) usage();
if (positionals.length !== 1) usage('one lease file, the one scripts/spawn.mjs wrote');
// Absolute, because the tool runs with sandbox/ as its working directory.
const leaseFile = resolve(positionals[0]);
if (!existsSync(leaseFile)) usage(`${leaseFile} does not exist`);

let lease;
try {
  lease = JSON.parse(readFileSync(leaseFile, 'utf8'));
} catch (e) {
  usage(`${leaseFile} is not JSON: ${e.message}`);
}
if (!Array.isArray(lease.standby_set) || lease.standby_set.length === 0) {
  usage(`${leaseFile} names no standby_set: the members to rotate, primary first`);
}

/**
 * `--member` for the tool: the pubkey, the ILP address and the pinned sealing
 * key — plus, for `provider-hs`, a fourth field naming its own `.anyone`
 * connector, which the tool dials directly, over anon (spec §10, §12.8).
 */
function memberArg(name) {
  const P = PROVIDERS[name];
  if (!P) throw new Error(`${leaseFile} names ${name}, which is not a sandbox provider (${Object.keys(PROVIDERS).join(', ')})`);
  const base = `${P.pubkey},${P.ilpAddress},${P.confValue('connector_seal_key')}`;
  return name === 'provider-hs' ? `${base},${hiddenConnector()}` : base;
}

let members;
try {
  members = lease.standby_set.map(memberArg);
} catch (e) {
  usage(e.message);
}

if (!existsSync(join(TOOL_DIR, 'seal.mjs'))) {
  log(`the handover tool is not at ${TOOL_DIR} — the provider checkout (toon-protocol/provider, branch with tools/grant/rotate.mjs) is`);
  log('expected at ../../provider; PROVIDER_CONTEXT=/path/to/provider says where else.');
  process.exit(2);
}
if (!existsSync(join(TOOL_DIR, 'node_modules'))) {
  log(`${TOOL_DIR} has no node_modules: run \`make setup\` (or \`npm install --prefix ${TOOL_DIR}\`) once.`);
  process.exit(2);
}

const hasHidden = lease.standby_set.includes('provider-hs');
const args = [join(TOOL_DIR, 'seal.mjs'), 'rotate', '--lease', leaseFile, ...members.flatMap((m) => ['--member', m])];
const env = {
  TOON_CONNECTOR_URL: HUB,
  TOON_CHAIN: 'solana',
  TOON_RPC_URL: RPC_URL,
  TOON_MNEMONIC: MNEMONIC,
  TOON_ACCOUNT_INDEX: ROTATE_PAYER_ACCOUNT_INDEX,
  TOON_CHANNEL_STORE: CHANNEL_STORE,
  // provider-hs's own path (spec §10, §12.8): unused, and nothing dialled,
  // unless `standby_set` names it.
  TOON_SOCKS_PROXY: HIDDEN_SOCKS_PROXY,
  TOON_HIDDEN_CHAIN: 'evm',
  TOON_HIDDEN_ACCOUNT_INDEX: HIDDEN_ACCOUNT_INDEX,
  TOON_HIDDEN_CHANNEL_STORE: HIDDEN_CHANNEL_STORE,
  // Anything set in the environment wins: the tool's README names them all.
  ...process.env,
};

log(`rotate workload ${String(lease.workload_id).slice(0, 12)}… at ${lease.standby_set.join(' + ')}, one request each, through the hub ${HUB}`);
log(`paying from account index ${env.TOON_ACCOUNT_INDEX}, channel store ${env.TOON_CHANNEL_STORE}; the new root secret goes into ${leaseFile} and nowhere else`);
if (hasHidden) {
  log(`provider-hs dialled directly over anon (${env.TOON_SOCKS_PROXY}), account index ${env.TOON_HIDDEN_ACCOUNT_INDEX} — free there, so nothing is paid`);
}
const ran = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
if (ran.error) {
  log(`could not run the handover tool: ${ran.error.message}`);
  process.exit(2);
}
if (ran.status === 0) log(`every member rotated; hand the gateway grants of the new root with: node scripts/handover.mjs ${leaseFile}`);
else if (ran.status === 1) log(`not every member rotated; ${leaseFile} keeps both root secrets — run this again to finish`);
process.exit(ran.status ?? 1);
