// Eviction smoke test (TOON_Network Milestone 1, ticket #7): the operator
// command stops a lease right now and leaves a public record. Run from
// sandbox/ on the host after `make up-payments` (or `make up`);
// `make smoke-eviction`.
//
//   0.  the provider, its connector, the relay and its connector are up
//   1.  a real client (@toon-protocol/client) opens/reuses the SOLANA
//       mock-USDC channel against the hub — the same payer, mnemonic and
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
//   5.  the workload is GONE from the host daemon
//   6.  the free `g.toon.provider.status` route, bearing the lease's
//       Continuation Token and paid
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
// exits (even on an assertion failure) — never left to expire — so the
// provider's own count, and the Liveness `make smoke-directory` reads, is
// right immediately afterwards.
import {
  HUB, PROVIDER_EDGE, RELAY_WS, HUB_FEE,
  K_EVICTION, TOON_LABEL, STATUS_ROUTE, spawnRoute,
  listing, PROVIDER_PUBKEY, reporter,
  relayReadUntil, hasTag,
  docker, composeNotRunning, findWorkload, workloadGone,
  newTenant, newRootSecret, tokenRequest, checkLeaseBody, newWorkloadId, spawnContent, openChannel,
} from './lib/provider-smoke.mjs';

const { step, ok, bad, assert, fatal, done } = reporter('EVICTION SMOKE');

const L = listing('basic');
const SPAWN_ROUTE = spawnRoute(L.name, L.version);

const EVICT_REASON = 'maintenance';
const EVICT_MESSAGE = 'smoke-eviction.mjs: reclaiming capacity';

const evict = (message) => docker(
  'compose', 'exec', '-T', 'provider',
  'toon-provider', 'evict',
  '--config', '/etc/toon-provider/provider.toml',
  '--workload-id', workloadId,
  '--reason', EVICT_REASON,
  '--message', message,
);

// ── 0. the stack is up ────────────────────────────────────────────────────
step('0. the provider, its connector, the relay and its connector are up');
{
  const missing = composeNotRunning(['provider', 'provider-connector', 'relay', 'relay-connector']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-payments\` first`);
}
ok('provider, provider-connector, relay and relay-connector are up');

// ── 1. a channel against the hub ─────────────────────────────────────────
step('1. a mock-USDC payment channel ON SOLANA against the hub (shared with smoke-provider.mjs)');
const { client, opened } = await openChannel(HUB);
ok(`channel ${opened.channelId ?? '(id unreported)'} status=${opened.status ?? 'open'}`);
const send = (route, body) => client.send(route, { body: checkLeaseBody(route, body) }, { sealTo: PROVIDER_EDGE, timeoutMs: 120_000 });

// ── 2. spawn a lease of our OWN, so evicting it disturbs nobody else's ────
step('2. a tenant pays for its own lease, so this smoke evicts only what it spawned');
const tenant = newTenant('eviction-tenant');
const rootSecret = newRootSecret();
const workloadId = newWorkloadId();
ok(`a spawn for workload ${workloadId}, bearing the token this lease's root secret derives for the provider`);

const spawned = await send(SPAWN_ROUTE, { request: tokenRequest(rootSecret, 'spawn', spawnContent(workloadId, tenant)) });
if (!spawned.fulfilled) {
  fatal(`the spawn was refused: ${spawned.code} (refusedBy ${spawned.refusedBy}) ${spawned.message}`);
}
const spawnBody = spawned.status === 200 ? spawned.json() : null;
assert(spawned.status === 200, `the provider answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
if (!spawnBody) fatal('no spawn body to evict; cannot continue');
assert(spawnBody.workload_id === workloadId, 'the answer names the tenant-chosen workload_id');
const access = spawnBody.access;
assert(
  access?.host === '127.0.0.1' && Number.isInteger(access?.ssh_port),
  `access: ssh ${access?.host}:${access?.ssh_port}`,
);

// ── 3. the workload is running ────────────────────────────────────────────
step('3. the workload is RUNNING on the host daemon');
const workload = await findWorkload(access.ssh_port);
if (workload) ok(workload.line);
assert(workload !== null, `a toon-<id> container publishes host port ${access.ssh_port} -> 22/tcp`);

// From here on, ALWAYS evict before exiting — a fatal() above already exited,
// but every assertion failure below still needs the lease cleaned up so it
// does not sit running for lease_interval_s and skew smoke-directory.
let evictAnswer = null;
try {
  // ── 4. the operator command, against the loopback-only endpoint ────────
  step('4. `toon-provider evict` inside the provider container (never a published port)');
  // `toon-provider evict` pretty-prints its JSON answer across several
  // lines, and `docker compose exec -T` hands back exactly that on stdout
  // (its own stderr, inherited by execFileSync, carries nothing on success).
  evictAnswer = JSON.parse(evict(EVICT_MESSAGE).trim());
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
  step('5. the workload is GONE');
  const gone = workload ? await workloadGone(workload.name) : false;
  assert(gone, `${workload?.name} no longer exists (stopped and deleted, the same as a termination)`);

  // ── 6. status reports the eviction ──────────────────────────────────────
  step('6. the free status route (paid through the hub, sealed to the provider) reports Ended(eviction)');
  const statusSent = await send(STATUS_ROUTE, { request: tokenRequest(rootSecret, 'status', { workload_id: workloadId }) });
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
    assert(BigInt(statusSent.claim?.amount ?? 0) === HUB_FEE, `the free route still cost the hub's own fee (${HUB_FEE}), never the provider's price (${L.price})`);
  }

  // ── 7. the Eviction Notice is on the relay ──────────────────────────────
  step('7. the Eviction Notice is on the relay, signed by the provider');
  const notices = await relayReadUntil(
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
  // smoke-directory's count. A second eviction on an already-ended lease is
  // a no-op refusal (unknown_workload), so this is safe to run
  // unconditionally.
  if (!evictAnswer) {
    try {
      evict('smoke-eviction.mjs cleanup after an earlier failure');
    } catch {
      // Already evicted, or the container never came up; nothing more to do.
    }
  }
}

done('an operator command stopped a paid lease immediately, its workload is gone, /status reports Ended(eviction), and a signed Eviction Notice naming the workload id and reason is readable on the sandbox relay.');
