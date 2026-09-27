// The guard on the Onboarder's devnet deploy bundle (infra#23).
//
// Like edge/deploy/bundle.test.mjs, it reads the REAL files, and every
// expected value is a literal declared here, never read back out of the file
// under test.
//
//   node --test onboarder/deploy/
//
// What it holds still, and why:
//   * the far side of the edge's contract: the service joins `edge-onboarder`,
//     external, under the alias `onboarder`, and listens on 4022;
//   * the network: Base Sepolia, eip155:84532, written here and not in .env;
//   * the key: from a file only, never an environment value, never committed;
//   * the image is pinned by digest, as the edge's is;
//   * exposure: nothing is published on the host; the edge is the only way in;
//   * a memory limit, because one leak on the shared host takes down every node;
//   * GitOps: its own units and lock, and a health wait that means something.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, name), 'utf8');
const readRepo = (path) => readFileSync(join(HERE, '..', '..', path), 'utf8');

const IMAGE = 'ghcr.io/toon-protocol/onboarder';
const NETWORK = 'edge-onboarder';
const ALIAS = 'onboarder';
const PORT = 4022;
const KEY_IN_CONTAINER = '/run/secrets/onboarder.key';

// Code only: comment-only lines explain, and must not satisfy or trip these.
const compose = () => read('docker-compose.yml').replace(/^\s*#.*\n/gm, '');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

describe('the far side of the edge contract', () => {
  it(`joins ${NETWORK}, external, under the alias ${ALIAS}`, () => {
    assert.match(compose(), new RegExp(`^      ${NETWORK}:\\n        aliases: \\[${ALIAS}\\]$`, 'm'));
    const top = compose().slice(compose().indexOf('\nnetworks:'));
    assert.match(top, new RegExp(`^  ${NETWORK}:\\n    external: true\\n    name: ${NETWORK}$`, 'm'));
  });

  it('keeps its own default network, and joins no node\'s', () => {
    assert.match(compose(), /^      default: \{\}$/m);
    const joined = [...compose().matchAll(/^    name: (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(joined, [NETWORK]);
  });

  it(`is what the edge routes onboard.devnet to: ${ALIAS}:${PORT}`, () => {
    // The edge's own test holds its side; this holds that both sides agree.
    assert.match(readRepo('edge/deploy/caddy/sites.caddy'), new RegExp(`reverse_proxy ${ALIAS}:${PORT} `));
    assert.match(compose(), new RegExp(`PORT: '${PORT}'`));
  });

  it('publishes nothing on the host: the edge is the only way in', () => {
    assert.doesNotMatch(compose(), /^\s+ports:/m);
  });
});

describe('what it serves', () => {
  it('Base Sepolia, fixed in the bundle rather than left to .env', () => {
    assert.match(compose(), /X402_NETWORK: eip155:84532$/m);
    assert.doesNotMatch(read('.env.example'), /^X402_NETWORK=/m);
  });

  it('requires an RPC URL from .env, which may carry an API key', () => {
    assert.match(compose(), /EVM_RPC_URL: \$\{EVM_RPC_URL:\?/);
    assert.match(read('.env.example'), /^EVM_RPC_URL=https:\/\//m);
  });
});

describe('the key', () => {
  it('is read from a mounted file, never passed as a value', () => {
    assert.match(compose(), new RegExp(`ONBOARDER_EVM_PRIVATE_KEY_FILE: ${escapeRegExp(KEY_IN_CONTAINER)}$`, 'm'));
    assert.match(compose(), new RegExp(`- \\./onboarder\\.key:${escapeRegExp(KEY_IN_CONTAINER)}:ro$`, 'm'));
    assert.doesNotMatch(compose(), /ONBOARDER_EVM_PRIVATE_KEY:/);
    assert.doesNotMatch(read('.env.example'), /PRIVATE_KEY/);
  });

  it('is gitignored, with .env and the apply marker', () => {
    const rows = read('.gitignore').split('\n').map((r) => r.trim());
    for (const row of ['onboarder.key', '.env', '.applied', '!.env.example']) assert.ok(rows.includes(row), row);
  });

  it('must exist before an apply, or Docker would bind-mount a new empty directory in its place', () => {
    assert.match(read('auto-apply.sh'), /\[ ! -f onboarder\.key \]/);
  });
});

describe('the image', () => {
  it('is pinned by digest, because the key is handed to it', () => {
    assert.match(compose(), new RegExp(`^\\s+image: ${escapeRegExp(IMAGE)}@sha256:[0-9a-f]{64}$`, 'm'));
    assert.doesNotMatch(compose(), /^\s+build:/m);
  });

  it('is what CI builds and pushes, from onboarder/', () => {
    const workflow = readRepo('.github/workflows/onboarder-image.yml');
    assert.ok(workflow.includes(IMAGE), 'the workflow pushes some other image');
    assert.match(workflow, /context: onboarder$/m);
    assert.match(workflow, /node --test onboarder\/config\.test\.mjs onboarder\/deploy\/bundle\.test\.mjs/);
  });

  it('keeps the bundle out of the image', () => {
    const ignored = readRepo('onboarder/.dockerignore').split('\n').map((r) => r.trim());
    assert.ok(ignored.includes('deploy'));
  });

  it('refuses the placeholder digest by name', () => {
    assert.match(read('auto-apply.sh'), /onboarder@sha256:0\\\{64\\\}/);
  });
});

describe('on a shared host', () => {
  it('carries a memory limit, and caps the V8 heap under it', () => {
    assert.match(compose(), /^\s+mem_limit: 128m$/m);
    assert.match(compose(), /NODE_OPTIONS: --max-old-space-size=\d+$/m);
  });

  it('healthchecks /health on 127.0.0.1, which fails when the gas payer holds no ETH', () => {
    assert.match(compose(), new RegExp(`http://127\\.0\\.0\\.1:${PORT}/health`));
    assert.doesNotMatch(compose(), /localhost/);
  });
});

describe('GitOps', () => {
  it('runs as toon-auto-apply-onboarder, from this bundle', () => {
    assert.match(read('toon-auto-apply-onboarder.service'), /^ExecStart=\/root\/infra\/onboarder\/deploy\/auto-apply\.sh$/m);
    assert.match(read('toon-auto-apply-onboarder.timer'), /^Unit=toon-auto-apply-onboarder\.service$/m);
    assert.match(read('README.md'), /toon-auto-apply-onboarder\.service toon-auto-apply-onboarder\.timer/);
  });

  it('shares /root/infra with the edge\'s apply, so both lock the checkout around git, dirty check included, and only there', () => {
    const script = read('auto-apply.sh');
    assert.match(script, /^exec 8>\/var\/lock\/toon-infra-checkout\.lock$/m);
    const locked = script.indexOf('flock -w 120 8');
    const unlocked = script.indexOf('flock -u 8');
    assert.ok(locked > 0 && locked < script.indexOf('git diff --quiet'), 'the dirty check is outside the lock');
    assert.ok(unlocked > script.indexOf('git merge --ff-only') && unlocked < script.indexOf('docker compose'));
  });

  it('takes its own lock, so it neither blocks nor is blocked by the edge or a node', () => {
    assert.match(read('auto-apply.sh'), /^exec 9>\/var\/lock\/toon-auto-apply-onboarder\.lock$/m);
  });

  it('retries an apply that failed after the fast-forward', () => {
    const script = read('auto-apply.sh');
    assert.match(script, /APPLIED_MARKER=/);
    assert.match(script, /\[ "\$LOCAL" = "\$REMOTE" \] && \[ "\$APPLIED" = "\$REMOTE" \]/);
  });

  it('waits for the onboarder to be healthy before it records an apply', () => {
    const script = read('auto-apply.sh');
    assert.match(script, /ps -q onboarder/);
    assert.ok(script.indexOf('= healthy') < script.indexOf('> "$APPLIED_MARKER"'));
  });
});
