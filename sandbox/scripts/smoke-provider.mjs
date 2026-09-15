// Compute-provider smoke test (TOON_Network Milestone 1, ticket #3): one paid
// spawn through the hub, end to end. Run from sandbox/ on the host after
// `make up-payments` (or `make up`); `make smoke-provider`.
//
//   0.  both edges answer GET /ilp and agree on the prices: the provider
//       connector terminates g.toon.provider.basic.v1.spawn at the listing
//       price, the hub forwards it at listing price + its 100 uUSDC fee, and
//       the three free provider routes are 0 at the provider
//   0b. the relay-provider Solana channel is open and collateralised on chain
//   1.  a real client (@toon-protocol/client) opens a SOLANA mock-USDC channel
//       against the hub — the same payer, mnemonic and channel store as
//       scripts/smoke-toon.mjs, so both smokes share one channel
//   2.  a TENANT signs a Lease Request with a fresh Nostr key: kind
//       K_LEASE_REQUEST, tags p = the provider's pubkey, op = spawn,
//       expiration; content names the image by reference + digest, an
//       ed25519 SSH public key made just now, and the env/entrypoint that
//       make the image's sshd install that key
//   3.  the client PAYS g.toon.provider.basic.v1.spawn through the hub,
//       sealed to the provider connector's edge, and the answer carries the
//       workload_id it chose, role standalone, expires_at = now + the
//       listing's lease interval, and access { host, ssh_port, ports }
//   4.  a container is RUNNING on the host daemon, publishing that ssh_port
//   5.  `ssh -i <tenant key> -p <ssh_port> tenant@127.0.0.1` works — the
//       tenant's key, and only that, opens the workload
//   6.  the money, from the connectors' own books: the hub's client book
//       grew by price + fee, the provider connector's peer-book watermark on
//       the committed channel account grew by the price
//   7.  the SAME Lease Request sent again is refused stale_request — and the
//       refusal is BILLED (one route, one price, no refunds: ADR 0003), which
//       the books show as a second increment
//   8.  the tenant ENDS its lease through the provider: the free
//       g.toon.provider.terminate route, tenant-signed, answers
//       { "ended": "termination" }, costs only the hub's fee, and the
//       workload is gone — so the provider's own count (and the Liveness
//       `make smoke-directory` reads) is right immediately, rather than three
//       minutes later. TOON_SMOKE_KEEP_WORKLOAD=1 skips this and leaves the
//       lease for the provider's expiry sweep (conf/provider.toml: 180 s);
//       the lease then counts against the listing's capacity (4) until it
//       expires, so more than four such runs inside three minutes answer
//       no_capacity — which is the provider being right, not the smoke.
import {
  HUB, PROVIDER_EDGE, PROVIDER_CHANNEL, PROVIDER_SOL, HUB_SOL, BUYER_SOL, USDC_MINT,
  PAYMENT_CHANNEL_PROGRAM, HUB_CHANNEL_DEPOSIT, HUB_FEE,
  TERMINATE_ROUTE, spawnRoute, extendRoute, IMAGE, SSH_USER,
  listing, reporter, jstr, nowSec, waitFor,
  claims, clientBookTotal, peerBookTotal, readSolanaChannel,
  docker, findWorkload, workloadGone,
  newTenant, leaseRequest, newWorkloadId, spawnContent, openChannel, sshInto,
} from './lib/provider-smoke.mjs';

const { step, ok, bad, assert, fatal, done } = reporter('PROVIDER SMOKE');
const KEEP_WORKLOAD = /^(1|true|yes)$/i.test(process.env.TOON_SMOKE_KEEP_WORKLOAD ?? '');

// The listing every ticket-level smoke buys, and its route.
const L = listing('basic');
const SPAWN_ROUTE = spawnRoute(L.name, L.version);
const HUB_PRICE = L.price + HUB_FEE;

async function booksAdvanceTo(hubBefore, providerBefore, hubDelta, providerDelta) {
  let hubNow = hubBefore, providerNow = providerBefore;
  await waitFor(async () => {
    hubNow = clientBookTotal(await claims('relay-connector'));
    providerNow = peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL);
    return hubNow - hubBefore >= hubDelta && providerNow - providerBefore >= providerDelta;
  }, 10);
  return { hub: hubNow - hubBefore, provider: providerNow - providerBefore };
}

// ── 0. the edges and their prices ────────────────────────────────────────
step('0. both edges are live and price the spawn route consistently');
const advertised = {};
for (const [name, url] of [['relay-connector (hub)', HUB], ['provider-connector', PROVIDER_EDGE]]) {
  const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
  if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  advertised[name] = Object.fromEntries((desc.routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
  ok(`${name}: ${desc.ilpAddresses?.join(',')} — ${(desc.routes ?? []).filter((r) => r.prefix.startsWith('g.toon.provider')).map((r) => `${r.prefix}@${r.price}`).join(', ')}`);
}
assert(advertised['provider-connector'][SPAWN_ROUTE] === L.price,
  `the provider connector terminates ${SPAWN_ROUTE} at ${L.price} uUSDC — conf/provider.toml's listing price, via \`toon-provider routes\``);
assert(advertised['provider-connector'][extendRoute(L.name, L.version)] === L.price,
  'and the extend route at the same price (one interval, one price)');
for (const free of ['availability', 'status', 'terminate']) {
  assert(advertised['provider-connector'][`g.toon.provider.${free}`] === 0n, `g.toon.provider.${free} is free at the provider`);
  assert(advertised['relay-connector (hub)'][`g.toon.provider.${free}`] === HUB_FEE,
    `the hub forwards g.toon.provider.${free} at exactly its fee (${HUB_FEE}): 0 arrives`);
}
assert(advertised['relay-connector (hub)'][SPAWN_ROUTE] === HUB_PRICE,
  `the hub forwards ${SPAWN_ROUTE} at ${HUB_PRICE} = provider price + fee ${HUB_FEE}`);

// ── 0b. the peering channel on chain ─────────────────────────────────────
step('0b. the relay-provider peering channel is open and collateralised on SOLANA');
{
  const ch = await waitFor(() => readSolanaChannel(PROVIDER_CHANNEL), 90, 2000);
  if (!ch) {
    bad(`channel account ${PROVIDER_CHANNEL} never appeared on the validator (docker compose logs open-toon-solana-channels)`);
  } else {
    assert(ch.owner === PAYMENT_CHANNEL_PROGRAM && ch.discriminator === 'pchannel', `${PROVIDER_CHANNEL} is a payment_channel program account`);
    const participants = [ch.participantA, ch.participantB].sort();
    assert(participants.join() === [HUB_SOL, PROVIDER_SOL].sort().join(), `participants are the hub and the provider connector (${participants.join(', ')})`);
    assert(ch.mint === USDC_MINT, 'settles in the Solana mock USDC mint');
    assert(ch.status === 0, 'status Opened');
    const hubDeposit = ch.participantA === HUB_SOL ? ch.depositA : ch.depositB;
    assert(hubDeposit >= HUB_CHANNEL_DEPOSIT, `the hub's own side holds ${hubDeposit} base units of collateral (>= ${HUB_CHANNEL_DEPOSIT})`);
  }
}

// ── 1. a channel against the hub ─────────────────────────────────────────
step('1. a mock-USDC payment channel ON SOLANA against the hub');
const { client, opened } = await openChannel(HUB);
assert(client.identity?.solanaPublicKey === BUYER_SOL, `the payer is ${client.identity?.solanaPublicKey} — the address seed-toon-solana funded`);
ok(`channel ${opened.channelId ?? '(id unreported)'} status=${opened.status ?? 'open'}`);
const hubBefore = clientBookTotal(await claims('relay-connector'));
const providerBefore = peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL);
console.log(`  books before: hub client=${hubBefore}, provider peer=${providerBefore}`);
const send = (route, body) => client.send(route, { body }, { sealTo: PROVIDER_EDGE, timeoutMs: 120_000 });

// ── 2. the tenant, its key, its Lease Request ────────────────────────────
step('2. a tenant signs a Lease Request with a fresh Nostr key and a fresh SSH key');
const tenant = newTenant('tenant');
const workloadId = newWorkloadId();
const request = leaseRequest(tenant, 'spawn', spawnContent(workloadId, tenant));
ok(`tenant ${tenant.pubkey} signed request ${request.id} for workload ${workloadId} (p = ${request.tags[0][1]})`);

// ── 3. the PAID spawn, through the hub ───────────────────────────────────
step(`3. a PAID ${SPAWN_ROUTE} routes hub -> peering -> provider connector -> provider`);
const price = await client.price(SPAWN_ROUTE);
assert(price === HUB_PRICE, `the hub prices ${SPAWN_ROUTE} at ${jstr(price)}`);
const t0 = nowSec();
const spawned = await send(SPAWN_ROUTE, { request });
let access = null;
let workload = null;
if (!spawned.fulfilled) {
  bad(`the spawn was refused: ${spawned.code} (refusedBy ${spawned.refusedBy}) ${spawned.message}`);
} else {
  const body = spawned.status === 200 ? spawned.json() : null;
  assert(spawned.status === 200, `the provider answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
  assert(BigInt(spawned.claim?.amount ?? 0) === HUB_PRICE, `the client paid the hub exactly ${spawned.claim?.amount} uUSDC (${HUB_PRICE})`);
  if (body) {
    assert(body.workload_id === workloadId, `the answer names the tenant-chosen workload_id`);
    assert(body.role === 'standalone', `role ${body.role}`);
    const t1 = nowSec();
    assert(body.expires_at >= t0 + L.lease_interval_s && body.expires_at <= t1 + L.lease_interval_s,
      `expires_at ${body.expires_at} = now + lease_interval_s (${L.lease_interval_s}): one payment, one Lease Interval`);
    access = body.access;
    assert(access?.host === '127.0.0.1' && Number.isInteger(access?.ssh_port) && Array.isArray(access?.ports),
      `access: ssh ${access?.host}:${access?.ssh_port}, ports ${jstr(access?.ports ?? [])}`);
  }
}

// ── 4. the container, on the host daemon ─────────────────────────────────
step('4. the workload is RUNNING on the host daemon and publishes the SSH forward');
if (access) {
  workload = await findWorkload(access.ssh_port);
  if (workload) ok(workload.line);
  assert(workload !== null, `a toon-<id> container publishes host port ${access.ssh_port} -> 22/tcp`);
  if (workload) {
    const image = docker('inspect', '-f', '{{.Config.Image}}', workload.name).trim();
    assert(image === `${IMAGE.reference}@${IMAGE.digest}`, `it runs the image by reference@digest: ${image}`);
  }
}

// ── 5. SSH with the tenant's key ─────────────────────────────────────────
step("5. SSH into the workload with the tenant's key");
if (access) {
  const ssh = await sshInto(tenant, access);
  assert(ssh.out?.includes('toon-ssh-ok'),
    ssh.out ? `ssh -p ${access.ssh_port} ${SSH_USER}@${access.host}: ${ssh.out.trim().replace('\n', ', user ')}` : `ssh never succeeded: ${ssh.err}`);
}

// ── 6. the money ─────────────────────────────────────────────────────────
step("6. the connectors' own books say the spawn was PAID — hub client leg and provider peer leg");
{
  const d = await booksAdvanceTo(hubBefore, providerBefore, HUB_PRICE, L.price);
  assert(d.hub >= HUB_PRICE, `hub client book advanced by ${d.hub} uUSDC (>= ${HUB_PRICE}: listing price + fee)`);
  assert(d.provider >= L.price,
    `provider connector's peer-book watermark on channel ${PROVIDER_CHANNEL} advanced by ${d.provider} uUSDC (>= ${L.price}, the listing price)`);
}

// ── 7. a replay is refused, and billed ───────────────────────────────────
step('7. the SAME Lease Request again is refused stale_request — and still billed');
{
  const replay = await send(SPAWN_ROUTE, { request });
  if (!replay.fulfilled) {
    bad(`the replay was refused short of the app: ${replay.code} (${replay.refusedBy})`);
  } else {
    const err = replay.status !== 200 ? replay.json() : null;
    assert(replay.status === 400 && err?.error === 'stale_request', `the provider answered ${replay.status} ${jstr(err)}`);
    assert(BigInt(replay.claim?.amount ?? 0) === HUB_PRICE, `and the refusal cost ${replay.claim?.amount} uUSDC — a billed error, no refund (ADR 0003)`);
  }
  const d = await booksAdvanceTo(hubBefore, providerBefore, 2n * HUB_PRICE, 2n * L.price);
  assert(d.hub >= 2n * HUB_PRICE && d.provider >= 2n * L.price,
    `both books show two paid packets: hub +${d.hub}, provider +${d.provider}`);
}

// ── 8. the tenant ends its lease, through the provider ───────────────────
step(`8. the tenant ends the lease: the free ${TERMINATE_ROUTE}, tenant-signed`);
if (!access) {
  bad('no lease to terminate');
} else if (KEEP_WORKLOAD) {
  console.log(`  ${workload?.name ?? 'the workload'} is left running (TOON_SMOKE_KEEP_WORKLOAD); the provider's expiry sweep destroys it ~${L.lease_interval_s}s after the spawn.`);
} else {
  const terminated = await send(TERMINATE_ROUTE, { request: leaseRequest(tenant, 'terminate', { workload_id: workloadId }) });
  if (!terminated.fulfilled) {
    bad(`terminate was refused short of the app: ${terminated.code} (${terminated.refusedBy})`);
  } else {
    const body = terminated.status === 200 ? terminated.json() : null;
    assert(terminated.status === 200 && body?.workload_id === workloadId
      && JSON.stringify(body?.state) === JSON.stringify({ ended: 'termination' }),
    `the provider answered ${terminated.status} ${terminated.text().slice(0, 200)}`);
    assert(BigInt(terminated.claim?.amount ?? 0) === HUB_FEE,
      `it cost only the hub's fee (${terminated.claim?.amount}) — free at the provider, and nothing is refunded (ADR 0003)`);
  }
  if (workload) {
    assert(await workloadGone(workload.name), `${workload.name} is gone — the provider destroyed it, so its own count is right at once`);
  }
}

done('a tenant paid one spawn through the hub over a Solana USDC channel, the provider started its workload on the host by reference@digest, SSH opened with the tenant\'s key alone, both connectors booked the prices, a replay was refused and billed, and the tenant ended the lease through the free terminate route.');
