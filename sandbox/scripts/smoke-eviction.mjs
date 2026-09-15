// Eviction smoke test (TOON_Network Milestone 1, ticket #7): the operator
// command stops a lease right now and leaves a public record. Run from
// sandbox/ on the host after `make up-payments` (or `make up`);
// `make smoke-eviction`.
//
//   0.  the provider, its connector, the relay and its connector are up
//   1.  a real client (@toon-protocol/client) opens/reuses the SOLANA
//       mock-USDC channel against the hub — the same buyer, mnemonic and
//       channel store as scripts/smoke-provider.mjs, so every smoke here
//       shares one channel
//   2.  a TENANT signs a Lease Request and PAYS
//       g.toon.provider.basic.v1.spawn through the hub, sealed to the
//       provider connector's edge, exactly as smoke-provider.mjs does — this
//       smoke needs its OWN lease so evicting it does not disturb anyone
//       else's
//   3.  the workload is RUNNING on the host daemon
//   4.  `docker compose exec provider toon-provider evict --config
//       /etc/toon-provider/provider.toml --workload-id <id> --reason
//       maintenance` — the OPERATOR command, run inside the provider's own
//       container against its loopback-only operator endpoint, never a
//       published port
//   5.  the container is GONE
//   6.  the free `g.toon.provider.status` route, tenant-signed and paid
//       through the hub (sealed to the provider connector's edge, exactly
//       like step 2's spawn), reports `{ "ended": "eviction" }` and no
//       `access`
//   7.  the Eviction Notice is on the sandbox relay (ws://localhost:7100):
//       kind K_EVICTION, tagged `x` = the workload id and
//       `["L","toon.network"]`, authored by the provider's own Nostr key,
//       and its content names the same workload id, reason and message the
//       operator command was given
//
// The lease this smoke spawns is ALWAYS ended by eviction before the script
// exits (even on an assertion failure) — never left to expire — so it never
// skews `smoke-directory`'s Docker-derived running count the way
// smoke-provider.mjs's raw `docker rm -f` can (see that script's header).
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ToonClient } from '@toon-protocol/client';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // sandbox/
const HUB = process.env.HUB_URL ?? 'http://localhost:3200';
const PROVIDER_EDGE = process.env.PROVIDER_EDGE_URL ?? 'http://localhost:3240';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const RELAY_WS = process.env.RELAY_WS ?? 'ws://localhost:7100';
const MNEMONIC = 'test test test test test test test test test test test junk';

// Mirrored from the provider's src/nostr/kinds.rs. EVERY NUMBER IS A
// PLACEHOLDER until kinds are allocated (spec §11); what is normative is the
// NIP-01 class.
const K_LEASE_REQUEST = 4432; // regular, never published
const K_EVICTION = 4433; // regular
const TOON_LABEL = 'toon.network';

const LISTING = 'basic';
const VERSION = 1;
const SPAWN_ROUTE = `g.toon.provider.${LISTING}.v${VERSION}.spawn`;
const STATUS_ROUTE = 'g.toon.provider.status';

// The same throwaway sshd image smoke-provider.mjs spawns: this smoke does
// not SSH in, but the provider's spawn validation resolves and verifies the
// image regardless, so it needs to be a real, pullable one.
const IMAGE = {
  reference: 'lscr.io/linuxserver/openssh-server',
  digest: 'sha256:39ba37d50fdd6be1bf70644c871e5dcb9234ee79ac56424ea03ca08cadf1e7b0',
};

const EVICT_REASON = 'maintenance';
const EVICT_MESSAGE = 'smoke-eviction.mjs: reclaiming capacity';

// ── conf/provider.toml, the source of truth for the price and the key ─────
const providerConf = readFileSync(join(ROOT, 'conf', 'provider.toml'), 'utf8');
const confValue = (key) => {
  const m = providerConf.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\s#]+)"?`, 'm'));
  if (!m) throw new Error(`conf/provider.toml has no ${key} line`);
  return m[1];
};
const PROVIDER_PRICE = BigInt(confValue('price'));
const LEASE_INTERVAL_S = Number(confValue('lease_interval_s'));
const PROVIDER_PUBKEY = getPublicKey(
  Uint8Array.from(Buffer.from(confValue('nostr_private_key'), 'hex')),
);
// conf/connector-relay.toml's relay-provider [[peers]] row: the hub's own cut
// on top of the provider's price, charged on every route it forwards,
// including the free ones (smoke-provider.mjs step 0 proves this).
const HUB_FEE = 100n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const step = (name) => console.log(`\n\x1b[1m== ${name}\x1b[0m`);
const ok = (msg) => console.log(`  \x1b[32mok\x1b[0m   ${msg}`);
const bad = (msg) => {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`);
};
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));
const fatal = (msg) => {
  console.error(`\nEVICTION SMOKE FAILED: ${msg}`);
  process.exit(1);
};

const docker = (...args) => execFileSync('docker', args, { cwd: ROOT, encoding: 'utf8' });

/** One NIP-01 REQ against the relay, resolved at EOSE (common/smoke-directory.mjs's helper). */
function read(filter, label = 'eviction') {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(RELAY_WS);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no EOSE from ${RELAY_WS} in 15s`));
    }, 15_000);
    socket.onopen = () => socket.send(JSON.stringify(['REQ', label, filter]));
    socket.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${e.message ?? e}`));
    };
    socket.onmessage = (m) => {
      const frame = JSON.parse(m.data);
      if (frame[0] === 'EVENT' && frame[1] === label) events.push(frame[2]);
      if (frame[0] === 'EOSE' && frame[1] === label) {
        clearTimeout(timer);
        socket.close();
        resolve(events);
      }
    };
  });
}

async function readUntil(filter, label, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    const events = await read(filter, label).catch(() => []);
    if (events.length > 0) return events;
    await sleep(500);
  }
  return [];
}

const hasTag = (event, cells) =>
  event.tags.some((t) => t.length >= cells.length && cells.every((c, i) => t[i] === c));

// ── 0. the stack is up ────────────────────────────────────────────────────
step('0. the provider, its connector, the relay and its connector are up');
const running = docker('compose', 'ps', '--format', '{{.Service}} {{.State}}');
for (const service of ['provider', 'provider-connector', 'relay', 'relay-connector']) {
  if (!new RegExp(`^${service} running`, 'm').test(running)) {
    fatal(`the \`${service}\` service is not running — \`make up-payments\` first`);
  }
}
ok('provider, provider-connector, relay and relay-connector are up');

// ── 1. a channel against the hub ─────────────────────────────────────────
step('1. a mock-USDC payment channel ON SOLANA against the hub (shared with smoke-provider.mjs)');
mkdirSync(join(ROOT, '.toon-client'), { recursive: true });
const client = await ToonClient.create({
  connector: HUB,
  mnemonic: MNEMONIC,
  chain: 'solana',
  rpcUrl: RPC_URL,
  channelStore: join(ROOT, '.toon-client', 'channels.json'),
  deposit: 10_000_000n,
  timeoutMs: 60_000,
});
const opened = await client.channel.open({ deposit: 10_000_000n });
ok(`channel ${opened.channelId ?? '(id unreported)'} status=${opened.status ?? 'open'}`);

// ── 2. spawn a lease of our OWN, so evicting it disturbs nobody else's ────
step('2. a tenant pays for its own lease, so this smoke evicts only what it spawned');
const tenantSecret = generateSecretKey();
const tenantPubkey = getPublicKey(tenantSecret);
const keyPath = join(ROOT, '.toon-client', 'eviction-tenant_ed25519');
for (const f of [keyPath, `${keyPath}.pub`]) if (existsSync(f)) rmSync(f);
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'toon-sandbox-eviction-tenant', '-f', keyPath]);
const sshPublicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
const workloadId = randomBytes(32).toString('hex');
const now = Math.floor(Date.now() / 1000);
const spawnContent = {
  workload_id: workloadId,
  image: IMAGE,
  env: { LISTEN_PORT: '22', USER_NAME: 'tenant' },
  ports: [],
  ssh_public_key: sshPublicKey,
  entrypoint: ['/bin/sh'],
  args: ['-c', 'PUBLIC_KEY="$SSH_PUBLIC_KEY" exec /init'],
};
const spawnRequest = finalizeEvent(
  {
    kind: K_LEASE_REQUEST,
    created_at: now,
    tags: [['p', PROVIDER_PUBKEY], ['op', 'spawn'], ['expiration', String(now + 120)]],
    content: JSON.stringify(spawnContent),
  },
  tenantSecret,
);
ok(`tenant ${tenantPubkey} signed a spawn for workload ${workloadId}`);

const spawned = await client.send(
  SPAWN_ROUTE,
  { body: { request: spawnRequest } },
  { sealTo: PROVIDER_EDGE, timeoutMs: 120_000 },
);
let access = null;
let containerName = null;
if (!spawned.fulfilled) {
  fatal(`the spawn was refused: ${spawned.code} (refusedBy ${spawned.refusedBy}) ${spawned.message}`);
}
const spawnBody = spawned.status === 200 ? spawned.json() : null;
assert(spawned.status === 200, `the provider answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
if (!spawnBody) fatal('no spawn body to evict; cannot continue');
assert(spawnBody.workload_id === workloadId, 'the answer names the tenant-chosen workload_id');
access = spawnBody.access;
assert(
  access?.host === '127.0.0.1' && Number.isInteger(access?.ssh_port),
  `access: ssh ${access?.host}:${access?.ssh_port}`,
);

// ── 3. the workload is running ────────────────────────────────────────────
step('3. the workload is RUNNING on the host daemon');
for (let i = 0; i < 10 && !containerName; i++) {
  const lines = docker('ps', '--filter', 'name=toon-', '--format', '{{.Names}}\t{{.Ports}}')
    .trim()
    .split('\n')
    .filter(Boolean);
  const line = lines.find((l) => l.includes(`:${access.ssh_port}->22/tcp`));
  if (line) {
    containerName = line.split('\t')[0];
    ok(`${line.replace(/\t/g, '  ')}`);
  } else {
    await sleep(1000);
  }
}
assert(containerName !== null, `a toon-<id> container publishes host port ${access.ssh_port} -> 22/tcp`);

// From here on, ALWAYS evict before exiting — a fatal() above already exited,
// but every assertion failure below still needs the lease cleaned up so it
// does not sit running for LEASE_INTERVAL_S and skew smoke-directory.
let evictAnswer = null;
try {
  // ── 4. the operator command, against the loopback-only endpoint ────────
  step('4. `toon-provider evict` inside the provider container (never a published port)');
  const evictOut = docker(
    'compose', 'exec', '-T', 'provider',
    'toon-provider', 'evict',
    '--config', '/etc/toon-provider/provider.toml',
    '--workload-id', workloadId,
    '--reason', EVICT_REASON,
    '--message', EVICT_MESSAGE,
  );
  // `toon-provider evict` pretty-prints its JSON answer across several
  // lines, and `docker compose exec -T` hands back exactly that on stdout
  // (its own stderr, inherited by execFileSync, carries nothing on success).
  evictAnswer = JSON.parse(evictOut.trim());
  ok(`toon-provider evict answered ${JSON.stringify(evictAnswer)}`);
  assert(evictAnswer.workload_id === workloadId, 'the answer names the evicted workload_id');
  assert(
    JSON.stringify(evictAnswer.state) === JSON.stringify({ ended: 'eviction' }),
    `state ${JSON.stringify(evictAnswer.state)}`,
  );
  assert(
    evictAnswer.notice_published === true,
    'the Eviction Notice reached every relay of the Relay Set (one relay, this sandbox)',
  );

  // ── 5. the container is gone ────────────────────────────────────────────
  step('5. the container is GONE');
  let stillThere = true;
  for (let i = 0; i < 10 && stillThere; i++) {
    const names = docker('ps', '-a', '--filter', `name=^${containerName}$`, '--format', '{{.Names}}').trim();
    stillThere = names.length > 0;
    if (stillThere) await sleep(500);
  }
  assert(!stillThere, `${containerName} no longer exists (stopped and deleted, the same as a termination)`);

  // ── 6. status reports the eviction ──────────────────────────────────────
  step('6. the free status route (paid through the hub, sealed to the provider) reports Ended(eviction)');
  const statusNow = Math.floor(Date.now() / 1000);
  const statusRequest = finalizeEvent(
    {
      kind: K_LEASE_REQUEST,
      created_at: statusNow,
      tags: [['p', PROVIDER_PUBKEY], ['op', 'status'], ['expiration', String(statusNow + 120)]],
      content: JSON.stringify({ workload_id: workloadId }),
    },
    tenantSecret,
  );
  const statusSent = await client.send(
    STATUS_ROUTE,
    { body: { request: statusRequest } },
    { sealTo: PROVIDER_EDGE, timeoutMs: 60_000 },
  );
  if (!statusSent.fulfilled) {
    bad(`the status request was refused short of the app: ${statusSent.code} (${statusSent.refusedBy})`);
  } else {
    assert(statusSent.status === 200, `the provider answered ${statusSent.status}: ${statusSent.text().slice(0, 300)}`);
    const statusBody = statusSent.status === 200 ? statusSent.json() : null;
    if (statusBody) {
      assert(
        JSON.stringify(statusBody.state) === JSON.stringify({ ended: 'eviction' }),
        `state ${JSON.stringify(statusBody.state)}`,
      );
      assert(statusBody.access === undefined, 'no access: the workload is gone');
    }
    assert(BigInt(statusSent.claim?.amount ?? 0) === HUB_FEE, `the free route still cost the hub's own fee (${HUB_FEE}), never the provider's price (${PROVIDER_PRICE})`);
  }

  // ── 7. the Eviction Notice is on the relay ──────────────────────────────
  step('7. the Eviction Notice is on the relay, signed by the provider');
  const notices = await readUntil(
    { kinds: [K_EVICTION], authors: [PROVIDER_PUBKEY], '#x': [workloadId] },
    'eviction-notice',
    30,
  );
  if (notices.length === 0) {
    bad(`no Eviction Notice for ${workloadId} from ${PROVIDER_PUBKEY} on ${RELAY_WS} — \`docker compose logs directory-publisher provider\` says why`);
  } else {
    assert(notices.length === 1, `exactly one Eviction Notice for this workload: got ${notices.length}`);
    const notice = notices[0];
    ok(`notice ${notice.id} created_at ${notice.created_at}`);
    assert(hasTag(notice, ['x', workloadId]), `tagged x = ${workloadId}`);
    assert(hasTag(notice, ['L', TOON_LABEL]), 'tagged ["L","toon.network"]');
    const content = JSON.parse(notice.content);
    assert(content.workload_id === workloadId, `content.workload_id ${content.workload_id}`);
    assert(content.reason === EVICT_REASON, `content.reason ${content.reason}`);
    assert(content.message === EVICT_MESSAGE, `content.message ${JSON.stringify(content.message)}`);
  }
} finally {
  // Belt and braces: if eviction itself failed for some reason, don't leave
  // the workload running the full lease_interval_s and skewing
  // smoke-directory's Docker-derived running count. A second eviction on an
  // already-ended lease is a no-op refusal (unknown_workload), so this is
  // safe to run unconditionally.
  if (!evictAnswer) {
    try {
      docker(
        'compose', 'exec', '-T', 'provider',
        'toon-provider', 'evict',
        '--config', '/etc/toon-provider/provider.toml',
        '--workload-id', workloadId,
        '--reason', EVICT_REASON,
        '--message', 'smoke-eviction.mjs cleanup after an earlier failure',
      );
    } catch {
      // Already evicted, or the container never came up; nothing more to do.
    }
  }
}

console.log(
  failures === 0
    ? "\n\x1b[32mEVICTION SMOKE OK: an operator command stopped a paid lease immediately, its container is gone, /status reports Ended(eviction), and a signed Eviction Notice naming the workload id and reason is readable on the sandbox relay.\x1b[0m"
    : `\n\x1b[31m${failures} assertion(s) failed.\x1b[0m`,
);
process.exit(failures === 0 ? 0 : 1);
