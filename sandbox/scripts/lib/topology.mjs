// A TOPOLOGY: which nodes the sandbox runs, which chains they settle on, and
// which of them are reached only over a hidden service. `make up-topology
// NODES="relay relay2 store" CHAINS=evm HS=relay` is the entry point, and
// scripts/topology.mjs the driver; this file is the pure half — the selection
// turned into compose profiles, rendered configs and the environment compose
// reads — so that it can be tested without a stack.
//
// HOW A SELECTION BECOMES CONTAINERS. docker-compose.yml gives every service
// one profile per NODE it belongs to and per CHAIN it exists for, beside the
// aggregate profiles (`full`, `payments`, `credentials`). A topology is the
// union of its nodes' and chains' profiles, plus `topology` (the open-peerings
// job) and `hidden` (the anon daemons) — so nothing outside the selection is
// rendered, and a dependency on a chain the selection leaves out is
// `required: false` in the compose file and simply not waited for.
//
// HOW A CHAIN IS LEFT OUT. A connector settles on every chain its config has
// a `[settlement.*]` table for, and there is no environment layer, so a node
// on one chain is the committed config with the other table removed — a
// rendered copy under conf/.rendered/topology/, mounted through that
// connector's `*_CONNECTOR_CONF` variable. The committed file stays the one
// source of truth; with both chains selected it is mounted as it is.

export const CHAINS = ['evm', 'solana'];

/** Where the rendered configs go, relative to sandbox/. Wiped by `make clean`. */
export const RENDER_DIR = 'conf/.rendered/topology';

// The nodes a topology can name. Per node:
//   connector  its connector's compose service (its config is
//              conf/connector-<node>.toml, its keys keys/toon/<connector>/)
//   confVar    the variable docker-compose.yml mounts that config through
//   port       where the host reaches its client edge
//   chains     'any', or the exact set it settles on whatever is selected
//   needs      nodes it cannot run without
//   gates      Makefile targets that check a sibling checkout it builds from
//   infra      chains its APP reads, which therefore run even when no node
//              settles on them (the profile wiring is in docker-compose.yml)
//   hsPort     the virtual port conf/anonrc publishes it on, if it can be hidden
//   relay      the Nostr relay behind it — the compose service of the node's
//              own name: the ILP address a write to it is paid at, the one a
//              subscription to its live feed is paid at (infra#53), the host
//              port its free reads are published on (and, hidden, the virtual
//              port conf/anonrc publishes them on), and the variable
//              docker-compose.yml reads its env file through
export const NODE_KINDS = {
  relay: {
    connector: 'relay-connector', confVar: 'RELAY_CONNECTOR_CONF', port: 3200, chains: 'any',
    hsPort: 3200, relay: { address: 'g.toon.relay', subscribe: 'g.toon.relay.subscribe', readPort: 7100, envVar: 'RELAY_ENV' },
    what: 'the hub: a relay behind a connector, and the payer of every peering',
  },
  relay2: {
    connector: 'relay2-connector', confVar: 'RELAY2_CONNECTOR_CONF', port: 3290, chains: 'any',
    hsPort: 3290, relay: { address: 'g.toon.relay2', subscribe: 'g.toon.relay2.subscribe', readPort: 7110, envVar: 'RELAY2_ENV' },
    what: 'a second relay behind its own connector, peered to the hub when both run',
  },
  store: {
    connector: 'store-connector', confVar: 'STORE_CONNECTOR_CONF', port: 3210, chains: 'any',
    gates: ['require-store-context'], infra: ['solana'],
    what: 'the blob store, with the AR.IO gateway and Turbo bundler it uploads to',
  },
  gas: {
    connector: 'gas-connector', confVar: 'GAS_CONNECTOR_CONF', port: 3220, chains: 'any',
    infra: ['evm', 'solana'],
    what: 'the gas station',
  },
  provider: {
    connector: 'provider-connector', confVar: 'PROVIDER_CONNECTOR_CONF', port: 3240, chains: 'any',
    needs: ['relay'], gates: ['require-provider-publisher'],
    what: 'the compute provider and its directory publisher',
  },
  provider2: {
    connector: 'provider2-connector', confVar: 'PROVIDER2_CONNECTOR_CONF', port: 3250, chains: 'any',
    needs: ['relay'], gates: ['require-provider-publisher'],
    what: 'the second compute provider and its directory publisher',
  },
  anytoon: {
    connector: 'anytoon-connector', confVar: 'ANYTOON_CONNECTOR_CONF', port: 3230, chains: ['evm'],
    gates: ['require-anytoon-context'],
    what: 'the Anyone credentials issuer path, paid in ANYONE on anvil',
  },
  dealer: {
    connector: 'dealer-connector', port: 3270, chains: ['evm', 'solana'],
    needs: ['relay', 'anytoon'],
    what: 'the Dealer: µUSDC in on Solana, ANYONE out on anvil',
  },
};

const words = (value) => String(value ?? '').split(/[\s,]+/).filter(Boolean);
const unique = (list) => [...new Set(list)];

/**
 * The relay services behind `connectors`. A relay publishes what its connector
 * says about itself and re-reads it only every five minutes, so a connector
 * started again on another config — a chain taken out, a hidden endpoint —
 * takes its relay with it, or the relay's information document names the old
 * one until the next read (infra#51).
 */
export const relaysBehind = (connectors) => Object.keys(NODE_KINDS)
  .filter((node) => NODE_KINDS[node].relay && connectors.includes(NODE_KINDS[node].connector));

/**
 * The URL a subscriber dials `node`'s relay at: its published read port, or —
 * hidden, `address` being the daemon's — its virtual read port there. The
 * relay checks NIP-98 `u` and NIP-42 `relay` against this URL's host, so it is
 * told it as TOON_RELAY_URL, and a relay told another URL refuses every
 * subscriber who dials the one it is actually reached at (infra#53).
 */
export const relayUrl = (node, address) => `ws://${address ?? 'localhost'}:${NODE_KINDS[node].relay.readPort}`;

/** A relay's committed env file, relative to sandbox/. */
export const committedRelayEnv = (node) => `conf/${node}.conf`;
/** The same env as a topology renders it, relative to sandbox/. */
export const renderedRelayEnv = (node) => `${RENDER_DIR}/${node}.conf`;

/** A connector's committed config, relative to sandbox/. */
export const committedConf = (node) => `conf/connector-${node}.toml`;
/** The same config as a topology renders it, relative to sandbox/. */
export const renderedConf = (node) => `${RENDER_DIR}/connector-${node}.toml`;

/**
 * A selection, validated and turned into what the driver runs. `nodes`,
 * `chains` and `hs` are the Makefile's NODES, CHAINS and HS: names separated
 * by spaces or commas. CHAINS defaults to both; HS to nothing.
 *
 * Throws one Error naming every problem with the selection, so a typo and a
 * missing dependency are fixed in one round rather than two.
 */
export function planTopology({ nodes, chains, hs } = {}) {
  const problems = [];
  const selected = unique(words(nodes));
  const settle = unique(words(chains).length > 0 ? words(chains) : CHAINS);
  const hidden = unique(words(hs));

  if (selected.length === 0) problems.push(`NODES names no node. Choose from: ${Object.keys(NODE_KINDS).join(', ')}.`);
  for (const node of selected) {
    if (!NODE_KINDS[node]) problems.push(`'${node}' is not a node. Choose from: ${Object.keys(NODE_KINDS).join(', ')}.`);
  }
  for (const chain of settle) {
    if (!CHAINS.includes(chain)) problems.push(`'${chain}' is not a chain. CHAINS is evm, solana or both.`);
  }
  const known = selected.filter((node) => NODE_KINDS[node]);
  const on = (chain) => settle.includes(chain);

  for (const node of known) {
    const kind = NODE_KINDS[node];
    for (const need of kind.needs ?? []) {
      if (!selected.includes(need)) problems.push(`${node} needs ${need} in NODES.`);
    }
    if (kind.chains !== 'any') {
      for (const chain of kind.chains) {
        if (!on(chain)) problems.push(`${node} settles on ${kind.chains.join(' and ')}, so CHAINS must include ${chain}.`);
      }
    }
  }

  for (const node of hidden) {
    if (!selected.includes(node)) problems.push(`HS names ${node}, which is not in NODES.`);
    else if (!NODE_KINDS[node]?.hsPort) {
      const can = Object.keys(NODE_KINDS).filter((n) => NODE_KINDS[n].hsPort).join(', ');
      problems.push(`HS cannot hide ${node}: conf/anonrc publishes no virtual port for it (it has one for: ${can}).`);
    }
  }
  if (hidden.includes('relay')) {
    for (const node of known.filter((n) => n === 'provider' || n === 'provider2')) {
      problems.push(`HS=relay cannot run with ${node}: its directory publisher pays the hub from the compose network, and a client dials the endpoint a node publishes — a .anyone address it has no proxy for.`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));

  // What each node settles on: the selection, or its own fixed set.
  const chainsOf = (node) => (NODE_KINDS[node].chains === 'any' ? CHAINS.filter(on) : NODE_KINDS[node].chains);

  // A config is rendered when a chain is taken out of it, or when the node is
  // hidden (its endpoint is rewritten once the address exists). Everything
  // else mounts the committed file, exactly as `make up` does.
  const renders = [];
  const env = {};
  for (const node of known) {
    const kind = NODE_KINDS[node];
    const strip = kind.chains === 'any' ? CHAINS.filter((chain) => !on(chain)) : [];
    if (strip.length === 0 && !hidden.includes(node)) continue;
    renders.push({ node, source: committedConf(node), target: renderedConf(node), strip, hsPort: hidden.includes(node) ? kind.hsPort : undefined });
    env[kind.confVar] = `./${renderedConf(node)}`;
  }
  // A hidden relay is dialled at the daemon's address, so it is told that URL
  // in an env file of its own; every other relay reads its committed one.
  const relayEnvs = [];
  for (const node of hidden.filter((n) => NODE_KINDS[n].relay)) {
    relayEnvs.push({ node, source: committedRelayEnv(node), target: renderedRelayEnv(node) });
    env[NODE_KINDS[node].relay.envVar] = `./${renderedRelayEnv(node)}`;
  }

  // The directory publishers pay the hub from a channel of their own, on
  // Solana wherever the hub settles there and on anvil otherwise.
  if (known.some((n) => n === 'provider' || n === 'provider2') && !on('solana')) {
    env.PUBLISHER_CHAIN = 'evm';
    env.PUBLISHER_RPC_URL = 'http://anvil:8545';
  }

  const profiles = ['topology', ...CHAINS.filter(on), ...known, ...(hidden.length > 0 ? ['hidden'] : [])];
  env.COMPOSE_PROFILES = profiles.join(',');

  const notes = [];
  for (const node of known) {
    for (const chain of NODE_KINDS[node].infra ?? []) {
      if (!on(chain)) notes.push(`${chain === 'evm' ? 'anvil' : 'solana-validator'} runs although no node settles on it: the ${node} app reads it.`);
    }
  }
  if (hidden.length > 0 && on('evm')) {
    notes.push('a client over the circuit pays its own EVM deposit gas (depositGas: \'self\'): the Onboarder is not published on the hidden service.');
  }

  return {
    nodes: known,
    chains: CHAINS.filter(on),
    hidden,
    chainsOf: Object.fromEntries(known.map((node) => [node, chainsOf(node)])),
    profiles,
    env,
    renders,
    relayEnvs,
    gates: unique(known.flatMap((node) => NODE_KINDS[node].gates ?? [])),
    notes: unique(notes),
  };
}

/**
 * `toml` without the `[settlement.<chain>]` table, its `.key` sub-table and
 * the comment block that sits directly on top of each — what a node that does
 * not settle on `chain` mounts. Throws if the table is not there: a config
 * that was never on the chain is a planner fault, not something to pass over.
 */
export function stripSettlement(toml, chain) {
  const header = new RegExp(`^\\[settlement\\.${chain}(\\.[a-z_]+)?\\]\\s*$`);
  const lines = toml.split('\n');
  // Where the comment block directly on top of the header at `i` starts.
  const leadIn = (i) => {
    let start = i;
    while (start > 0 && lines[start - 1].startsWith('#')) start -= 1;
    return start;
  };
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    let next = i + 1;
    while (next < lines.length && !lines[next].startsWith('[')) next += 1;
    // The table runs to the next header's own comment block, which stays.
    const end = next < lines.length ? leadIn(next) : next;
    for (let j = leadIn(i); j < end; j++) drop.add(j);
  }
  if (drop.size === 0) throw new Error(`no [settlement.${chain}] table to remove`);
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/** `toml` with its `[node] http_endpoint` pointed at `url`. */
export function publishEndpoint(toml, url) {
  if (!/^http_endpoint = /m.test(toml)) throw new Error('no [node] http_endpoint line to rewrite');
  return toml.replace(/^http_endpoint = .*$/m, `http_endpoint = "${url}"`);
}

/** The endpoint a hidden node publishes: its virtual port on the daemon's address. */
export const hiddenEndpoint = (address, hsPort) => `http://${address}:${hsPort}/ilp`;

/**
 * One rendered config. `address` is the daemon's `.anyone` address, known
 * only once it has bootstrapped: without it a hidden node is rendered on its
 * compose name, which is what its peers dial while the peerings are opened.
 */
export function renderConf(toml, { node, strip, hsPort }, address) {
  let text = toml;
  for (const chain of strip) text = stripSettlement(text, chain);
  const hidden = hsPort !== undefined && address !== undefined;
  if (hidden) text = publishEndpoint(text, hiddenEndpoint(address, hsPort));
  const changes = [
    ...strip.map((chain) => `[settlement.${chain}] removed`),
    ...(hidden ? [`[node] http_endpoint pointed at ${address}`] : []),
  ];
  return [
    '# GENERATED by scripts/topology.mjs — do not edit, do not commit.',
    `# ${committedConf(node)}${changes.length > 0 ? `, with ${changes.join(' and ')}` : ''}.`,
    '# Re-rendered on every `make up-topology`; wiped by `make clean`.',
    '',
    text,
  ].join('\n');
}

/**
 * A hidden relay's env file: the committed one with TOON_RELAY_URL pointed at
 * its virtual read port on `address`, the daemon's `.anyone` address. Without
 * an address it is the committed URL — what the relay is told until the
 * daemon has bootstrapped. Throws if the committed file sets no URL.
 */
export function renderRelayEnv(text, node, address) {
  if (!/^TOON_RELAY_URL=/m.test(text)) throw new Error(`${committedRelayEnv(node)} sets no TOON_RELAY_URL to rewrite`);
  const url = address === undefined ? text.match(/^TOON_RELAY_URL=(.*)$/m)[1] : relayUrl(node, address);
  return [
    '# GENERATED by scripts/topology.mjs — do not edit, do not commit.',
    `# ${committedRelayEnv(node)}${address === undefined ? '' : `, with TOON_RELAY_URL pointed at ${address}`}.`,
    '# Re-rendered on every `make up-topology`; wiped by `make clean`.',
    '',
    text.replace(/^TOON_RELAY_URL=.*$/m, `TOON_RELAY_URL=${url}`),
  ].join('\n');
}
