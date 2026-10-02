// `make up-topology NODES="relay relay2 store" CHAINS=evm HS=relay`: the
// sandbox with only the nodes named, settling only on the chains named, and
// with the nodes in HS reached only over a hidden service.
//
//   node scripts/topology.mjs plan    what the selection runs, and nothing else
//   node scripts/topology.mjs gates   the Makefile checks its sibling checkouts need
//   node scripts/topology.mjs up      render, start, open the peerings, hide
//
// The selection comes from NODES, CHAINS and HS in the environment (the
// Makefile passes them) or from --nodes, --chains and --hs. scripts/lib/topology.mjs
// is the planner — which nodes exist, what each needs, how a chain is left out —
// and this file is everything that touches Docker.
//
// WHAT `up` DOES, in order:
//   1. renders the connector configs the selection changes (a chain taken
//      out; a node to be hidden, still on its compose name) and writes
//      conf/.rendered/topology.env and topology.json — the record
//      `make smoke-topology` reads, and the `--env-file` for driving compose
//      by hand;
//   2. removes every sandbox container the selection does not name, so what
//      runs afterwards is the topology and not the topology plus what the
//      last `make up*` left;
//   3. builds, starts the selection, and waits for the open-peerings job;
//   4. with HS: waits for the anon daemon's address, re-renders each hidden
//      node's config with its endpoint at that address, and restarts it. The
//      order is `make up-hs`'s, for its reason: a `POST /peers` dials what the
//      other node publishes, so the peerings are opened on compose names
//      first, and a runtime peering outlives the restart.
//
// A RELAY FOLLOWS ITS CONNECTOR through 3 and 4: its information document is
// its connector's self-description, re-read only every five minutes, so a
// connector that comes back on another config — recreated in 3, restarted in
// 4 — has its relay restarted behind it (`relaysBehind`, infra#51).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_KINDS, RENDER_DIR, hiddenEndpoint, planTopology, relaysBehind, renderConf } from './lib/topology.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = 'conf/.rendered/topology.env';
const RECORD_FILE = 'conf/.rendered/topology.json';

const say = (message) => console.log(message);
function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function selection(argv) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    nodes: flag('nodes') ?? process.env.NODES,
    chains: flag('chains') ?? process.env.CHAINS,
    hs: flag('hs') ?? process.env.HS,
  };
}

const USAGE = `usage: make up-topology NODES="<node> …" [CHAINS="evm solana"] [HS="<node> …"]

  NODES   ${Object.entries(NODE_KINDS).map(([name, kind]) => `${name.padEnd(10)}${kind.what}`).join('\n          ')}
  CHAINS  the chains the nodes settle on: evm, solana, or both (the default)
  HS      relay nodes to reach only over a .anyone hidden service (dials the REAL Anyone network)

  make up-topology NODES=relay                                a connector and a relay
  make up-topology NODES="relay relay2 store" CHAINS=evm       two relay nodes and a store, on anvil alone
  make up-topology NODES=relay CHAINS=solana HS=relay          one relay node, hidden, on Solana alone`;

function plan(argv) {
  try {
    return planTopology(selection(argv));
  } catch (e) {
    die(`${e.message}\n\n${USAGE}`);
  }
}

// ── Docker ────────────────────────────────────────────────────────────────
// Every compose call carries the plan's environment: the profiles, and the
// config each connector mounts. A call without it would render a different
// project and recreate what this one started.
let composeEnv = process.env;
function compose(args, { capture = false } = {}) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: ROOT, env: composeEnv, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? '');
    die(`docker compose ${args.join(' ')} failed (exit ${result.status}).`);
  }
  return capture ? result.stdout.trim() : '';
}
const inspect = (id, format) => {
  try {
    return execFileSync('docker', ['inspect', '-f', format, id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const containerOf = (service) => compose(['ps', '-a', '-q', service], { capture: true }).split('\n')[0];

async function waitHealthy(services, minutes, why) {
  for (const service of services) {
    for (let i = 0; ; i++) {
      const id = containerOf(service);
      if (id && inspect(id, '{{.State.Health.Status}}') === 'healthy') break;
      if (i >= minutes * 12) die(`${service} never became healthy after ~${minutes} minutes.${why ? `\n${why}` : ''}\n  docker compose --profile '*' logs --tail 80 ${service}`);
      await sleep(5000);
    }
    say(`  ${service}: healthy`);
  }
}

async function waitCompleted(service, minutes) {
  for (let i = 0; ; i++) {
    const id = containerOf(service);
    const state = id ? inspect(id, '{{.State.Status}} {{.State.ExitCode}}') : '';
    if (state === 'exited 0') break;
    if (state.startsWith('exited')) {
      spawnSync('docker', ['logs', '--tail', '30', id], { stdio: 'inherit' });
      die(`${service} failed (${state}); its last lines are above.`);
    }
    if (i >= minutes * 12) die(`${service} did not finish in ~${minutes} minutes.\n  docker compose --profile '*' logs --tail 80 ${service}`);
    await sleep(5000);
  }
  say(`  ${service}: done`);
}

// ── Rendering ─────────────────────────────────────────────────────────────
// IN PLACE, never by rename: each file is bind-mounted into a connector as a
// single file, and a mount follows the inode it was given. Returns the
// connectors whose file was there already and now says something else —
// compose compares the mount's PATH, which has not changed, so a connector
// still running on the old contents has to be restarted by name.
function render(topology, address) {
  mkdirSync(join(ROOT, RENDER_DIR), { recursive: true });
  const changed = [];
  for (const entry of topology.renders) {
    const target = join(ROOT, entry.target);
    const text = renderConf(readFileSync(join(ROOT, entry.source), 'utf8'), entry, address);
    if (existsSync(target) && readFileSync(target, 'utf8') !== text) changed.push(NODE_KINDS[entry.node].connector);
    writeFileSync(target, text);
  }
  return changed;
}

function record(topology, address) {
  const hidden = Object.fromEntries(topology.hidden.map((node) => [node, address ? hiddenEndpoint(address, NODE_KINDS[node].hsPort) : null]));
  writeFileSync(join(ROOT, ENV_FILE), [
    '# GENERATED by scripts/topology.mjs — the environment the running topology',
    '# was started with. To drive compose by hand against it:',
    `#   docker compose --env-file ${ENV_FILE} ps`,
    ...Object.entries(topology.env).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n'));
  writeFileSync(join(ROOT, RECORD_FILE), `${JSON.stringify({
    nodes: topology.nodes, chains: topology.chains, chainsOf: topology.chainsOf, hidden, address: address ?? null, profiles: topology.profiles,
  }, null, 2)}\n`);
}

function describe(topology) {
  say(`topology: ${topology.nodes.join(' + ')}, settling on ${topology.chains.join(' and ')}${topology.hidden.length > 0 ? `, ${topology.hidden.join(' and ')} hidden` : ''}`);
  for (const node of topology.nodes) {
    const kind = NODE_KINDS[node];
    say(`  ${node.padEnd(10)}${kind.connector} at http://localhost:${kind.port}, on ${topology.chainsOf[node].join(' + ')} — ${kind.what}`);
  }
  for (const note of topology.notes) say(`  note: ${note}`);
}

// ── Commands ──────────────────────────────────────────────────────────────
async function up(topology) {
  describe(topology);
  composeEnv = { ...process.env, ...topology.env };

  const rerendered = render(topology, undefined);
  record(topology, undefined);

  const wanted = new Set(compose(['config', '--services'], { capture: true }).split('\n').filter(Boolean));
  const extra = compose(['--profile', '*', 'ps', '-a', '--services'], { capture: true }).split('\n').filter((s) => s && !wanted.has(s));
  if (extra.length > 0) {
    say(`\nremoving what this topology does not name: ${extra.join(', ')}`);
    compose(['--profile', '*', 'rm', '-sf', ...extra]);
  }
  // A connector whose rendered config changed under it (another selection of
  // chains, or a node that was hidden and no longer is) starts again on it.
  const stale = rerendered.filter((connector) => containerOf(connector));
  if (stale.length > 0) {
    say(`\nrecreating on a re-rendered config: ${stale.join(', ')}`);
    compose(['rm', '-sf', ...stale]);
  }

  // Build first, then start without --build: a rebuilt anon image would
  // recreate the daemon and throw away its circuits (see `make up-hs`).
  say('');
  compose(['build']);
  // A relay that stays up while its connector is replaced — removed above, or
  // recreated by compose because it now mounts another file — would go on
  // publishing what the old one said: it starts again behind the new one.
  const relayConnectors = topology.nodes.filter((node) => NODE_KINDS[node].relay).map((node) => NODE_KINDS[node].connector);
  const containers = () => Object.fromEntries([...relayConnectors, ...relaysBehind(relayConnectors)].map((service) => [service, containerOf(service)]));
  const before = containers();
  compose(['up', '-d']);
  const after = containers();
  const outlived = relaysBehind(relayConnectors.filter((connector) => after[connector] !== before[connector]))
    .filter((relay) => before[relay] && after[relay] === before[relay]);
  if (outlived.length > 0) {
    say(`\nrestarting behind a new connector: ${outlived.join(', ')}`);
    compose(['restart', ...outlived]);
  }
  say('\nwaiting for the peerings');
  await waitCompleted('open-peerings', 10);

  let address;
  if (topology.hidden.length > 0) {
    say('\nwaiting for the anon daemons to bootstrap against the REAL Anyone network.');
    say('a minute or two is normal; a cold volume takes longer.');
    await waitHealthy(['anon', 'anon-client'], 5, '  This is usually the Anyone network rather than this sandbox: the daemon has to reach\n  real directory authorities and real relays.');
    address = compose(['exec', '-T', 'anon', 'cat', '/var/lib/anon/hidden_service/hostname'], { capture: true });
    if (!/^[a-z2-7]{56}\.anyone$/.test(address)) die(`the anon daemon's hostname file holds '${address}', which is not a .anyone address.`);
    // Each hidden node, on its hidden endpoint from here on. A restart, not a
    // recreate: the file it mounts is the one just rewritten.
    render(topology, address);
    record(topology, address);
    const connectors = topology.hidden.map((node) => NODE_KINDS[node].connector);
    compose(['restart', ...connectors]);
    await waitHealthy(connectors, 2);
    // And the relays behind them, once their connectors answer on the new
    // endpoint: restarted together, a relay could read the old one first.
    // (Guarded: a `restart` naming no service restarts every one.)
    const relays = relaysBehind(connectors);
    if (relays.length > 0) {
      compose(['restart', ...relays]);
      await waitHealthy(relays, 2);
    }
  }

  say('\nup.');
  for (const node of topology.hidden) {
    const kind = NODE_KINDS[node];
    say(`  ${node} is reached at ${hiddenEndpoint(address, kind.hsPort)}, through socks5h://127.0.0.1:${process.env.ANON_SOCKS_PORT ?? 19050}`);
  }
  say('  `make smoke-topology` pays every relay node on every chain it settles on.');
}

const [command = 'plan', ...argv] = process.argv.slice(2);
if (command === 'plan') {
  const topology = plan(argv);
  describe(topology);
  say(`  compose profiles: ${topology.profiles.join(', ')}`);
  for (const entry of topology.renders) {
    say(`  renders ${entry.target}${entry.strip.length > 0 ? ` without [settlement.${entry.strip.join('], [settlement.')}]` : ''}${entry.hsPort ? ', on its .anyone endpoint' : ''}`);
  }
} else if (command === 'gates') {
  say(plan(argv).gates.join(' '));
} else if (command === 'up') {
  await up(plan(argv));
} else {
  die(USAGE);
}
