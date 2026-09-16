// THE `ci` LISTING (TOON_Network #14; spec §4.4 and Appendix A.1): a tenant
// buys the tier that grants `docker` through the real connector path and gets
// a Docker daemon OF ITS OWN inside the workload. Run from sandbox/ on the
// host after `make up-payments` (or `make up`); `make smoke-ci`.
//
//   0.  the edges price g.toon.provider.ci.v1.spawn: 5000 at the provider
//       (conf/provider.toml, A.1's price), 5100 through the hub
//   1.  the `ci` Listing on the relay carries ["t","docker"] and A.1's
//       content: 2000 millicores, 4 GiB, 10 GB, amd64, capabilities
//       ["docker"] — the tag a CI runner selects on
//   2.  a real client opens a Solana mock-USDC channel against the hub
//   3.  a tenant signs a Lease Request for the sandbox's sshd image and PAYS
//       the spawn through the hub; the answer names its workload and access
//   4.  on the host daemon the lease is the pair spec §4.4 describes: the
//       workload `toon-<id>` running UNPRIVILEGED with no socket file
//       mounted, beside the provider's own PRIVILEGED `toon-<id>-dind`
//       sidecar; both under the lease's cgroup parent
//       `toon.slice/toon-<id>.slice`, whose cpu.max and memory.max are the
//       tier's limits — the workload, the daemon and every nested container
//       bounded as ONE UNIT; the socket, layer and network objects named
//       after the lease exist
//   5.  over SSH, with the tenant's key, as the tenant's (non-root) user:
//       /var/run/docker.sock is a socket; the daemon behind it answers
//       /info with an ID that is NOT the host daemon's (never the provider's
//       own); it pulls hello-world (nested pulls are the lease's egress),
//       creates, starts and waits a container from it and its logs say
//       "Hello from Docker!"; the image's own /var/run survived the mount
//   6.  the books: the hub's client book grew by price + fee, the provider
//       connector's peer-book watermark by the price
//   7.  the tenant ENDS the lease through the free terminate route: the
//       workload is gone, and so are the sidecar, both volumes, the network
//       and the slice — nothing of the lease outlives it
//
// An aborted run leaves its lease for the provider's expiry sweep (A.1's
// 600 s interval), counting against the tier's capacity of 2 until then.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  HUB, PROVIDER_EDGE, PROVIDER_CHANNEL, HUB_FEE, BUYER_SOL,
  K_LISTING, TOON_LABEL, TERMINATE_ROUTE, spawnRoute, extendRoute, SSH_USER,
  listing, reporter, jstr, nowSec, waitFor,
  claims, clientBookTotal, peerBookTotal,
  relayReadUntil, directoryFilter, tagValues, hasTag,
  docker, composeNotRunning, findWorkload, workloadGone,
  newTenant, leaseRequest, newWorkloadId, spawnContent, openChannel, sshRun,
} from './lib/provider-smoke.mjs';

const { step, ok, bad, assert, fatal, done } = reporter('CI LISTING SMOKE');

// What the provider's Docker backend runs beside every `docker` lease
// (provider `src/docker.rs`, `DIND_IMAGE`); the Makefile pre-pulls it.
const DIND_IMAGE = 'docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac';

// Spec Appendix A.1, the content the `ci` Listing MUST carry.
const A1 = { cpu_millicores: 2000, memory_mb: 4096, storage_gb: 10, arch: 'amd64', capabilities: ['docker'] };

const L = listing('ci');
const SPAWN_ROUTE = spawnRoute(L.name, L.version);
const HUB_PRICE = L.price + HUB_FEE;

const inspect = (name, format) => docker('inspect', '-f', format, name).trim();
/** Whether the host daemon has a container / volume / network of that name (quietly: absence is an answer here, not an error). */
const exists = (kind, name) => {
  try {
    execFileSync('docker', kind === 'container' ? ['inspect', name] : [kind, 'inspect', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const sliceOf = (name) => `/sys/fs/cgroup/toon.slice/${name}.slice`;
const readSlice = (name, file) => (existsSync(`${sliceOf(name)}/${file}`) ? readFileSync(`${sliceOf(name)}/${file}`, 'utf8').trim() : null);

// ── 0. the stack and the prices ──────────────────────────────────────────
step('0. the payment stack is up and both edges price the ci route');
{
  const missing = composeNotRunning(['relay', 'relay-connector', 'provider', 'provider-connector', 'directory-publisher']);
  if (missing.length > 0) fatal(`not running: ${missing.join(', ')} — \`make up-payments\` first`);
  const advertised = {};
  for (const [name, url] of [['hub', HUB], ['provider-connector', PROVIDER_EDGE]]) {
    const res = await fetch(`${url}/ilp`).catch((e) => fatal(`${name} unreachable at ${url}: ${e.message}`));
    if (!res.ok) fatal(`${name} GET /ilp -> ${res.status}`);
    advertised[name] = Object.fromEntries(((await res.json()).routes ?? []).map((r) => [r.prefix, BigInt(r.price)]));
  }
  assert(advertised['provider-connector'][SPAWN_ROUTE] === L.price && advertised['provider-connector'][extendRoute(L.name, L.version)] === L.price,
    `the provider connector terminates ${SPAWN_ROUTE} and .extend at ${L.price} uUSDC (A.1's price)`);
  assert(advertised.hub[SPAWN_ROUTE] === HUB_PRICE, `the hub forwards it at ${HUB_PRICE} = price + fee ${HUB_FEE}`);
}

// ── 1. the Listing on the relay ──────────────────────────────────────────
step('1. the `ci` Listing on the relay is Appendix A.1: ["t","docker"] and the tier\'s content');
{
  const events = await relayReadUntil(directoryFilter(K_LISTING), 'listings', 60);
  const ci = events.find((e) => tagValues(e, 'd')[0]?.[0] === L.name);
  if (!ci) fatal(`no \`${L.name}\` Listing on the relay — \`docker compose logs directory-publisher provider\``);
  assert(hasTag(ci, ['t', 'docker']) && hasTag(ci, ['L', TOON_LABEL]) && hasTag(ci, ['l', 'arch:amd64', TOON_LABEL]),
    'it carries ["t","docker"], the label and arch:amd64 — what a CI runner selects on');
  const c = JSON.parse(ci.content);
  assert(jstr(c.resources) === jstr({ cpu_millicores: A1.cpu_millicores, memory_mb: A1.memory_mb, storage_gb: A1.storage_gb })
    && c.arch === A1.arch && jstr(c.capabilities) === jstr(A1.capabilities) && c.version === L.version,
  `its content is A.1's: ${jstr(c.resources)}, ${c.arch}, capabilities ${jstr(c.capabilities)}, v${c.version}`);
  assert(c.lease_interval_s === L.lease_interval_s && BigInt(c.price) === L.price,
    `${c.price} uUSDC per ${c.lease_interval_s} s Lease Interval — what this smoke pays`);
}

// ── 2. a channel against the hub ─────────────────────────────────────────
step('2. a mock-USDC payment channel ON SOLANA against the hub');
const { client, opened } = await openChannel(HUB);
assert(client.identity?.solanaPublicKey === BUYER_SOL, `the payer is ${client.identity?.solanaPublicKey}`);
ok(`channel ${opened.channelId ?? '(id unreported)'} status=${opened.status ?? 'open'}`);
const hubBefore = clientBookTotal(await claims('relay-connector'));
const providerBefore = peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL);
const send = (route, body) => client.send(route, { body }, { sealTo: PROVIDER_EDGE, timeoutMs: 180_000 });

// ── 3. the paid spawn ────────────────────────────────────────────────────
step(`3. a tenant PAYS ${SPAWN_ROUTE} through the hub`);
const tenant = newTenant('ci-tenant');
const workloadId = newWorkloadId();
const t0 = nowSec();
const spawned = await send(SPAWN_ROUTE, { request: leaseRequest(tenant, 'spawn', spawnContent(workloadId, tenant), 300) });
let access = null;
if (!spawned.fulfilled) {
  bad(`the spawn was refused: ${spawned.code} (refusedBy ${spawned.refusedBy}) ${spawned.message}`);
} else {
  const body = spawned.status === 200 ? spawned.json() : null;
  assert(spawned.status === 200, `the provider answered ${spawned.status}: ${spawned.text().slice(0, 300)}`);
  assert(BigInt(spawned.claim?.amount ?? 0) === HUB_PRICE, `the client paid the hub exactly ${spawned.claim?.amount} uUSDC`);
  if (body) {
    assert(body.workload_id === workloadId && body.role === 'standalone', `workload ${body.workload_id}, role ${body.role}`);
    assert(body.expires_at >= t0 + L.lease_interval_s && body.expires_at <= nowSec() + L.lease_interval_s,
      `expires_at = now + ${L.lease_interval_s} s`);
    access = body.access;
    assert(access?.host === '127.0.0.1' && Number.isInteger(access?.ssh_port), `access: ssh ${access?.host}:${access?.ssh_port}`);
  }
}

// ── 4. the pair on the host daemon ───────────────────────────────────────
step('4. on the host daemon: an unprivileged workload beside the provider\'s privileged dind sidecar, one cgroup unit');
let workload = null;
let sidecar = null;
if (access) {
  workload = await findWorkload(access.ssh_port);
  assert(workload !== null, workload ? `the workload is RUNNING: ${workload.line}` : `no toon-<id> container publishes ${access.ssh_port} -> 22/tcp`);
}
if (workload) {
  const name = workload.name;
  sidecar = `${name}-dind`;
  assert(exists('container', sidecar) && inspect(sidecar, '{{.State.Running}}') === 'true', `the sidecar ${sidecar} is running`);
  assert(inspect(sidecar, '{{.HostConfig.Privileged}}') === 'true' && inspect(sidecar, '{{.Config.Image}}') === DIND_IMAGE,
    `it is the one privileged container of the lease, and it runs the pinned dind image (the provider's own component)`);
  assert(inspect(name, '{{.HostConfig.Privileged}}') === 'false', 'the workload container is NOT privileged');
  const binds = inspect(name, '{{json .HostConfig.Binds}}');
  assert(!binds.includes('docker.sock') && binds.includes(`${name}-run:/var/run`) && !JSON.parse(binds).some((b) => b.startsWith('/')),
    `the workload mounts the lease's socket VOLUME at /var/run and no host path: ${binds}`);
  assert(!inspect(sidecar, '{{json .HostConfig.Binds}}').includes('/var/run/docker.sock'),
    'the sidecar does not mount the host daemon\'s socket either');
  for (const [kind, obj] of [['volume', `${name}-run`], ['volume', `${name}-docker`], ['network', `${name}-net`]]) {
    assert(exists(kind, obj), `${kind} ${obj} exists`);
  }
  const parents = [inspect(name, '{{.HostConfig.CgroupParent}}'), inspect(sidecar, '{{.HostConfig.CgroupParent}}')];
  assert(parents[0] === `${name}.slice` && parents[1] === `${name}.slice`, `both are under the lease's cgroup parent ${parents[0]}`);
  const [cpu, mem] = [readSlice(name, 'cpu.max'), readSlice(name, 'memory.max')];
  if (cpu === null) {
    bad(`${sliceOf(name)} is not readable on this host: the unit limit cannot be checked here`);
  } else {
    assert(cpu === `${A1.cpu_millicores * 100} 100000` && mem === String(A1.memory_mb * 1024 * 1024),
      `the slice carries the tier's limits as ONE UNIT: cpu.max "${cpu}" (${A1.cpu_millicores} millicores), memory.max ${mem} (${A1.memory_mb} MiB)`);
  }
}

// ── 5. the daemon, from inside, as the tenant ────────────────────────────
step('5. over SSH as the tenant: /var/run/docker.sock is the lease\'s own daemon, and it runs a container');
if (access) {
  const hostDaemonId = docker('info', '--format', '{{.ID}}').trim();
  const api = 'curl -sf --unix-socket /var/run/docker.sock';
  const script = [
    'echo "uid=$(id -u)"',
    'test -S /var/run/docker.sock && echo sock=yes || echo sock=no',
    'ls /var/run | tr "\\n" " "; echo',
    `echo "daemon=$(${api} http://localhost/info | sed 's/.*"ID":"\\([^"]*\\)".*/\\1/')"`,
    `echo "version=$(${api} http://localhost/version | sed 's/.*"Version":"\\([^"]*\\)".*/\\1/')"`,
    `${api} -X POST 'http://localhost/images/create?fromImage=hello-world&tag=latest' >/dev/null && echo pull=ok || echo pull=failed`,
    `cid=$(${api} -X POST -H 'Content-Type: application/json' http://localhost/containers/create -d '{"Image":"hello-world:latest"}' | sed 's/.*"Id":"\\([^"]*\\)".*/\\1/')`,
    `${api} -X POST http://localhost/containers/$cid/start && ${api} -X POST http://localhost/containers/$cid/wait >/dev/null`,
    `${api} 'http://localhost/containers/'$cid'/logs?stdout=1' | tr -c '[:print:]\\n' ' ' | grep -o 'Hello from Docker!' | head -1`,
  ].join('; ');
  const run = await sshRun(tenant, access, script);
  if (!run.ok) {
    bad(`ssh failed: ${run.err}\n${run.out}`);
  } else {
    const out = run.out;
    const field = (k) => out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '';
    ok(`ssh -p ${access.ssh_port} ${SSH_USER}@${access.host}, uid ${field('uid')}`);
    assert(field('uid') !== '0' && field('sock') === 'yes', `/var/run/docker.sock is a socket, usable by the tenant's non-root user (uid ${field('uid')})`);
    assert(field('daemon').length > 0 && field('daemon') !== hostDaemonId,
      `the daemon behind it (${field('version')}, id ${field('daemon').slice(0, 12)}…) is NOT the host daemon (${hostDaemonId.slice(0, 12)}…)`);
    assert(field('pull') === 'ok', 'it pulled hello-world — a nested pull is the lease\'s own egress');
    assert(out.includes('Hello from Docker!'), 'it created, started and ran the container: "Hello from Docker!"');
  }
}

// ── 6. the money ─────────────────────────────────────────────────────────
step("6. the connectors' books say the spawn was paid at the tier's price");
{
  let hub = hubBefore, provider = providerBefore;
  await waitFor(async () => {
    hub = clientBookTotal(await claims('relay-connector'));
    provider = peerBookTotal(await claims('provider-connector'), PROVIDER_CHANNEL);
    return hub - hubBefore >= HUB_PRICE && provider - providerBefore >= L.price;
  }, 15);
  assert(hub - hubBefore >= HUB_PRICE, `hub client book +${hub - hubBefore} uUSDC (>= ${HUB_PRICE})`);
  assert(provider - providerBefore >= L.price, `provider peer-book watermark +${provider - providerBefore} uUSDC (>= ${L.price})`);
}

// ── 7. the end of the lease takes everything with it ─────────────────────
step(`7. the tenant ends the lease: ${TERMINATE_ROUTE}, and nothing of it outlives it`);
if (!access) {
  bad('no lease to terminate');
} else {
  const t1 = Date.now();
  const ended = await send(TERMINATE_ROUTE, { request: leaseRequest(tenant, 'terminate', { workload_id: workloadId }) });
  const body = ended.fulfilled && ended.status === 200 ? ended.json() : null;
  assert(jstr(body?.state) === jstr({ ended: 'termination' }),
    `the provider answered ${ended.fulfilled ? ended.status : `${ended.code} (refusedBy ${ended.refusedBy}) ${ended.message ?? ''}`} ${jstr(body?.state)} after ${Date.now() - t1} ms — the whole teardown happens inside this request`);
  if (workload) {
    const name = workload.name;
    assert(await workloadGone(name, 30), `${name} is gone from the host daemon`);
    const gone = await waitFor(async () => (!exists('container', sidecar) && !exists('volume', `${name}-run`)
      && !exists('volume', `${name}-docker`) && !exists('network', `${name}-net`)) || null, 30);
    assert(gone === true, `the sidecar, both volumes and the network are gone`);
    // systemd collects the emptied slice on its own schedule, some seconds
    // after its last scope; the provider also asks for it to go.
    const sliceGone = await waitFor(async () => (!existsSync(sliceOf(name)) || null), 60);
    assert(sliceGone === true, `${sliceOf(name)} is gone`);
  }
}

done('a tenant bought the ci tier through the hub, found a Docker daemon of the lease\'s own at /var/run/docker.sock that was not the host\'s, pulled and ran a container with it as a non-root user, the pair was bounded as one cgroup unit at the tier\'s limits, the books grew by the price, and terminating the lease removed the workload, the sidecar, its volumes, its network and its slice.');
