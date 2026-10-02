// The topology planner (`make up-topology`): a selection of nodes, chains and
// hidden nodes turned into compose profiles, rendered configs and environment.
//
// The tests that matter most are the ones against the COMMITTED files. A node
// a topology can name has to exist in docker-compose.yml under its own
// profile, mount its config through the variable the planner sets, and have a
// config the planner can take a chain out of — and none of that is checked by
// anything until someone runs the selection that needs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODES } from '../peerings.mjs';
import {
  CHAINS, NODE_KINDS, committedConf, planTopology, publishEndpoint, relaysBehind, renderConf, renderedConf, stripSettlement,
} from './topology.mjs';

const sandbox = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const compose = sandbox('docker-compose.yml');
// One service's block of docker-compose.yml: from its name to the next one.
function service(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `docker-compose.yml has no service ${name}`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const profilesOf = (name) => service(name).match(/^ {4}profiles: \[([^\]]*)\]/m)[1].split(',').map((p) => p.trim().replace(/'/g, ''));

test('a connector and a relay: one node, both chains, nothing rendered', () => {
  const plan = planTopology({ nodes: 'relay' });
  assert.deepEqual(plan.nodes, ['relay']);
  assert.deepEqual(plan.chains, ['evm', 'solana']);
  assert.deepEqual(plan.profiles, ['topology', 'evm', 'solana', 'relay']);
  assert.deepEqual(plan.renders, []);
  assert.deepEqual(plan.env, { COMPOSE_PROFILES: 'topology,evm,solana,relay' });
});

test('two relay nodes and a store on EVM alone: each mounts its config without Solana', () => {
  const plan = planTopology({ nodes: 'relay relay2 store', chains: 'evm' });
  assert.deepEqual(plan.profiles, ['topology', 'evm', 'relay', 'relay2', 'store']);
  assert.deepEqual(plan.renders.map((r) => [r.node, r.strip]), [['relay', ['solana']], ['relay2', ['solana']], ['store', ['solana']]]);
  assert.equal(plan.env.RELAY_CONNECTOR_CONF, './conf/.rendered/topology/connector-relay.toml');
  assert.equal(plan.env.RELAY2_CONNECTOR_CONF, './conf/.rendered/topology/connector-relay2.toml');
  assert.equal(plan.env.STORE_CONNECTOR_CONF, './conf/.rendered/topology/connector-store.toml');
  assert.deepEqual(plan.gates, ['require-store-context']);
  // The store's ArNS half reads the validator whatever the nodes settle on.
  assert.ok(plan.notes.some((n) => n.startsWith('solana-validator runs')), plan.notes.join('; '));
});

test('names are separated by spaces or commas, and CHAINS keeps a fixed order', () => {
  const plan = planTopology({ nodes: 'relay2,relay', chains: 'solana, evm' });
  assert.deepEqual(plan.nodes, ['relay2', 'relay']);
  assert.deepEqual(plan.chains, ['evm', 'solana']);
});

test('a hidden relay node is rendered even on both chains, and adds the daemons', () => {
  const plan = planTopology({ nodes: 'relay', hs: 'relay' });
  assert.deepEqual(plan.profiles, ['topology', 'evm', 'solana', 'relay', 'hidden']);
  assert.deepEqual(plan.renders, [{ node: 'relay', source: 'conf/connector-relay.toml', target: 'conf/.rendered/topology/connector-relay.toml', strip: [], hsPort: 3200 }]);
});

test('the providers on EVM alone point their publishers at anvil', () => {
  const evm = planTopology({ nodes: 'relay provider provider2', chains: 'evm' });
  assert.equal(evm.env.PUBLISHER_CHAIN, 'evm');
  assert.equal(evm.env.PUBLISHER_RPC_URL, 'http://anvil:8545');
  const both = planTopology({ nodes: 'relay provider' });
  assert.equal(both.env.PUBLISHER_CHAIN, undefined);
});

test('a node with a fixed set of chains keeps it, and is never rendered for it', () => {
  const plan = planTopology({ nodes: 'relay anytoon dealer' });
  assert.deepEqual(plan.chainsOf, { relay: ['evm', 'solana'], anytoon: ['evm'], dealer: ['evm', 'solana'] });
  assert.deepEqual(plan.renders, []);
});

test('every problem with a selection is named at once', () => {
  const refuse = (selection, ...patterns) => assert.throws(() => planTopology(selection), (e) => {
    for (const pattern of patterns) assert.match(e.message, pattern);
    return true;
  });
  refuse({}, /NODES names no node/);
  refuse({ nodes: 'relay hub' }, /'hub' is not a node/);
  refuse({ nodes: 'relay', chains: 'base' }, /'base' is not a chain/);
  refuse({ nodes: 'provider' }, /provider needs relay/);
  refuse({ nodes: 'relay dealer', chains: 'evm' }, /dealer needs anytoon/, /CHAINS must include solana/);
  refuse({ nodes: 'relay anytoon', chains: 'solana' }, /anytoon settles on evm/);
  refuse({ nodes: 'relay', hs: 'relay2' }, /HS names relay2, which is not in NODES/);
  refuse({ nodes: 'relay store', hs: 'store' }, /HS cannot hide store/);
  refuse({ nodes: 'relay provider', hs: 'relay' }, /HS=relay cannot run with provider/);
});

// ── against the committed files ─────────────────────────────────────────────

test('every node has its own compose profile, on its connector and nowhere it should not be', () => {
  for (const [node, kind] of Object.entries(NODE_KINDS)) {
    assert.ok(profilesOf(kind.connector).includes(node), `${kind.connector} is not on profile '${node}'`);
    assert.ok(NODES[kind.connector], `scripts/peerings.mjs does not know ${kind.connector}`);
    assert.equal(NODES[kind.connector].port, kind.port, `${node}: the host port`);
    assert.match(service(kind.connector), new RegExp(`- '${kind.port}:3000'`), `${kind.connector} publishes ${kind.port}`);
  }
  // No profile name doubles as a chain or an aggregate.
  for (const taken of [...CHAINS, 'topology', 'hidden', 'full', 'payments', 'credentials', 'hs', 'gateway']) {
    assert.equal(NODE_KINDS[taken], undefined, `'${taken}' is both a node and another profile`);
  }
});

test('the chains, the peering job and the daemons are on the profiles the planner selects', () => {
  assert.ok(profilesOf('anvil').includes('evm') && profilesOf('onboarder').includes('evm'));
  assert.ok(profilesOf('solana-validator').includes('solana') && profilesOf('seed-toon-solana').includes('solana'));
  assert.ok(profilesOf('open-peerings').includes('topology'));
  for (const daemon of ['hs-ingress', 'anon', 'anon-client']) assert.ok(profilesOf(daemon).includes('hidden'), daemon);
  // A chain an app reads runs with that node, whatever is settled on.
  for (const [node, kind] of Object.entries(NODE_KINDS)) {
    for (const chain of kind.infra ?? []) {
      assert.ok(profilesOf(chain === 'evm' ? 'anvil' : 'solana-validator').includes(node), `${chain} does not run with ${node}`);
    }
  }
});

test('the second relay node is on no aggregate profile', () => {
  assert.deepEqual(profilesOf('relay2'), ['relay2']);
  assert.deepEqual(profilesOf('relay2-connector'), ['relay2']);
});

test('a connector the planner renders mounts its config through the planner’s variable', () => {
  for (const [node, kind] of Object.entries(NODE_KINDS)) {
    if (!kind.confVar) continue;
    assert.ok(service(kind.connector).includes(`\${${kind.confVar}:-./${committedConf(node)}}:/app/config/connector.toml:ro`),
      `${kind.connector} does not mount \${${kind.confVar}:-./${committedConf(node)}}`);
  }
});

test('a connector that can leave a chain out does not hard-depend on it', () => {
  for (const kind of Object.values(NODE_KINDS).filter((k) => k.chains === 'any')) {
    const block = service(kind.connector);
    for (const dep of ['anvil', 'solana-validator', 'seed-toon-solana']) {
      assert.match(block, new RegExp(`\\n {6}${dep}:\\n {8}condition: service_\\w+\\n {8}required: false`), `${kind.connector} -> ${dep}`);
    }
  }
});

test('either chain can be taken out of every any-chain node’s committed config', () => {
  for (const [node, kind] of Object.entries(NODE_KINDS).filter(([, k]) => k.chains === 'any')) {
    const toml = sandbox(committedConf(node));
    for (const chain of CHAINS) {
      const other = CHAINS.find((c) => c !== chain);
      const out = stripSettlement(toml, chain);
      assert.doesNotMatch(out, new RegExp(`^\\[settlement\\.${chain}`, 'm'), `${node}: [settlement.${chain}] is still there`);
      assert.match(out, new RegExp(`^\\[settlement\\.${other}\\]$`, 'm'), `${node}: [settlement.${other}] went with it`);
      assert.match(out, new RegExp(`^\\[settlement\\.${other}\\.key\\]$`, 'm'), `${node}: the ${other} key went with it`);
      // Everything that is not that chain's table or its comments survives.
      for (const table of ['[signer]', '[node]', '[operator]']) assert.ok(out.includes(`\n${table}\n`), `${node}: ${table} is gone`);
      assert.equal((out.match(/^\[\[routes\]\]$/gm) ?? []).length, (toml.match(/^\[\[routes\]\]$/gm) ?? []).length, `${node}: a route went with it`);
      // Values, not prose: a header comment may still name the other chain.
      const values = out.split('\n').filter((line) => !line.startsWith('#')).join('\n');
      assert.doesNotMatch(values, chain === 'solana' ? /solana-validator|settlement-solana\.key/ : /anvil|onboarder|settlement\.key"/, `${node}: a ${chain} value is left behind`);
    }
  }
});

test('conf/anonrc publishes every port a hidden node is reached on, and hs-ingress forwards it', () => {
  const anonrc = sandbox('conf/anonrc');
  const ingress = service('hs-ingress');
  const forwards = (port, target) => {
    assert.match(anonrc, new RegExp(`^HiddenServicePort ${port} 127\\.0\\.0\\.1:${port}$`, 'm'), `conf/anonrc has no virtual port ${port}`);
    assert.ok(ingress.includes(`TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr TCP:${target}`), `hs-ingress does not forward ${port} to ${target}`);
  };
  for (const kind of Object.values(NODE_KINDS).filter((k) => k.hsPort)) {
    forwards(kind.hsPort, `${kind.connector}:3000`);
    forwards(kind.relay.readPort, `${kind.connector.replace('-connector', '')}:7100`);
  }
  forwards(8545, 'anvil:8545');
  forwards(8899, 'solana-validator:8899');
  forwards(8900, 'solana-validator:8900');
});

// ── rendering ───────────────────────────────────────────────────────────────

const SAMPLE = `state_dir = "/app/state"

# What this node says about itself.
[node]
addresses = ["g.x"]
http_endpoint = "http://x-connector:3000/ilp"

# ── Settlement ──
# EVM: the FiatToken.
[settlement.evm]
rpc_url = "http://anvil:8545"
# a comment inside the table
facilitator_url = "http://onboarder:4022"

[settlement.evm.key]
key_file = "/app/data/settlement.key"

# Solana: the mock mint.
[settlement.solana]
rpc_url = "http://solana-validator:8899"

[settlement.solana.key]
key_file = "/app/data/settlement-solana.key"

# ── Operator surface ──
[operator]
bearer_token_file = "/app/data/operator-bearer.token"
`;

test('a table goes with its key, its own comments and the comments on top of it', () => {
  const noSolana = stripSettlement(SAMPLE, 'solana');
  assert.ok(!noSolana.includes('Solana: the mock mint') && !noSolana.includes('solana-validator'));
  assert.ok(noSolana.includes('# ── Operator surface ──\n[operator]'), 'the next table kept its own comment');
  assert.ok(noSolana.includes('facilitator_url'), 'the other chain is untouched');

  const noEvm = stripSettlement(SAMPLE, 'evm');
  assert.ok(!noEvm.includes('anvil') && !noEvm.includes('a comment inside the table') && !noEvm.includes('facilitator_url'));
  assert.ok(noEvm.includes('# Solana: the mock mint.\n[settlement.solana]'), 'the next table kept its own comment');
  assert.throws(() => stripSettlement(noEvm, 'evm'), /no \[settlement\.evm\] table/);
});

test('a hidden node publishes its virtual port on the daemon’s address, once there is one', () => {
  const address = `${'a'.repeat(56)}.anyone`;
  const entry = { node: 'relay', strip: ['solana'], hsPort: 3200 };
  const before = renderConf(SAMPLE, entry, undefined);
  assert.ok(before.includes('http_endpoint = "http://x-connector:3000/ilp"'), 'on its compose name until the address exists');
  assert.doesNotMatch(before, /^\[settlement\.solana\]$/m);
  const after = renderConf(SAMPLE, entry, address);
  assert.ok(after.includes(`http_endpoint = "http://${address}:3200/ilp"`));
  assert.match(after, /^# GENERATED by scripts\/topology\.mjs/);
  assert.throws(() => publishEndpoint('[node]\n', 'http://x/ilp'), /no \[node\] http_endpoint/);
});

test('a rendered config lands beside the others, under the directory `make clean` wipes', () => {
  assert.equal(renderedConf('relay2'), 'conf/.rendered/topology/connector-relay2.toml');
  assert.equal(committedConf('relay2'), 'conf/connector-relay2.toml');
  assert.ok(sandbox(committedConf('relay2')).includes('g.toon.relay2'));
});

// A relay's information document is its connector's self-description, read
// every five minutes (infra#51): the driver restarts a relay with its
// connector, and names it by the node's own name.
test('a connector started again takes the relay behind it, and only that one', () => {
  assert.deepEqual(relaysBehind(['relay-connector']), ['relay']);
  assert.deepEqual(relaysBehind(['store-connector', 'relay2-connector']), ['relay2']);
  assert.deepEqual(relaysBehind(['relay2-connector', 'relay-connector']), ['relay', 'relay2']);
  assert.deepEqual(relaysBehind(['store-connector', 'gas-connector']), []);
});

test('every relay node’s relay is the compose service of its own name, on its profile, with its own env', () => {
  for (const [node, kind] of Object.entries(NODE_KINDS).filter(([, k]) => k.relay)) {
    const block = service(node);
    assert.match(block, new RegExp(`profiles: \\[[^\\]]*'${node}'`), `${node} is not on profile ${node}`);
    assert.match(block, new RegExp(`- conf/${node}\\.conf\\n`), `${node} does not read conf/${node}.conf`);
    assert.match(block, new RegExp(`'${kind.relay.readPort}:7100'`), `${node} does not publish its reads on ${kind.relay.readPort}`);
  }
});
