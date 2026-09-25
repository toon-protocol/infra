// The guard on the edge's deploy bundle.
//
// It reads the REAL files, not fixtures: a fixture would keep passing while the
// shipped artifact regressed. Every expected value is a literal declared here
// and never read back out of the file under test, so a reverted fix fails this
// suite instead of quietly agreeing with itself. It has no dependencies, like
// the gateway's copy (gateway/deploy/bundle.test.mjs): a regex over the real
// bytes catches the regressions a parse would.
//
//   node --test edge/deploy/
//
// What it holds still, and why:
//   * THE CONTRACT: every hostname a node on this host serves maps to exactly
//     the alias and port that node's shared-edge overlay joins its own
//     `edge-<node>` network under,
//     and no hostname is served that is not in the contract. Four other repos
//     implement the far side of this table; a typo here is an outage there.
//   * the five per-node networks are created HERE, under their literal
//     names, Caddy joins all five, and no flat network joins the nodes;
//   * the Caddy image is pinned by digest, because the Porkbun key lives in it;
//   * the wildcard is issued over DNS-01 through Porkbun, keys from the env;
//   * the per-node rules the old nginx/Caddy fronts applied beyond plain
//     proxying: /admin, body limits, CORS, the gateway's TLS upstream;
//   * exposure: only 80/443 are published, and only by Caddy;
//   * a memory limit, because one leak on a shared host takes down five nodes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, name), 'utf8');

const sites = read('caddy/sites.caddy');

// ── The contract (infra#24; the per-node overlays join under these) ─────────
const ZONE = 'toonprotocol.dev';
const CONTRACT = {
  // relay — ports from relay/deploy/Caddyfile
  [`proxy.relay.devnet.${ZONE}`]: 'relay-proxy:3000',
  [`relay-ws.devnet.${ZONE}`]: 'relay-ws:7100',
  // store — store/deploy/nginx/node.conf.template
  [`proxy.ario.devnet.${ZONE}`]: 'store-proxy:4000',
  [`dvm.devnet.${ZONE}`]: 'store-dvm:3400',
  // gas — gas-station/deploy/nginx/node.conf.template
  [`proxy.gas.devnet.${ZONE}`]: 'gas-proxy:4000',
  [`gas.devnet.${ZONE}`]: 'gas-web:3400',
  // gateway — gateway/deploy/nginx/node.conf.template; the workload hop is TLS
  [`gw.devnet.${ZONE}`]: 'https://gateway-gw:8443',
  [`*.gw.devnet.${ZONE}`]: 'https://gateway-gw:8443',
  [`proxy.gateway.devnet.${ZONE}`]: 'gateway-proxy:4000',
  // faucet — connector/infra/linode-faucet/nginx/node.conf.template
  [`faucet.devnet.${ZONE}`]: 'faucet:3500',
};

/**
 * The top-level site blocks of a Caddyfile: each one's addresses and body.
 * Snippets — `(name) { ... }` — are not sites and are skipped. A block opens
 * on a line that ends in `{` at column 0 and closes on a `}` at column 0,
 * which is how every block in this bundle is written (caddy fmt's shape).
 */
function siteBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^([^\s#(}][^{]*)\{\s*$/);
    if (!open) continue;
    const end = lines.findIndex((l, j) => j > i && /^\}\s*$/.test(l));
    assert.ok(end > i, `site at line ${i + 1} never closes`);
    blocks.push({
      addresses: open[1].trim().split(/[\s,]+/).filter(Boolean),
      body: lines.slice(i + 1, end).join('\n'),
    });
    i = end;
  }
  return blocks;
}

/** The single upstream a site body proxies its non-special traffic to. */
function upstreamsOf(body) {
  // A `reverse_proxy /path ...` or `reverse_proxy @matcher ...` is a path
  // rule, held still by its own test below, and not the site's upstream.
  return [...body.matchAll(/^\s*reverse_proxy\s+(?![/@])(\S+)/gm)].map((m) => m[1]);
}

const blocks = siteBlocks(sites);

/** A snippet's body: `(name) {` at column 0 to the next `}` at column 0. */
function snippetBody(name) {
  const m = sites.match(new RegExp(`^\\(${name}\\) \\{\\n([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(m, `no snippet (${name})`);
  return m[1];
}
const siteFor = (host) => blocks.find((b) => b.addresses.includes(host));

describe('the contract: every hostname on the host, and where it goes', () => {
  for (const [host, upstream] of Object.entries(CONTRACT)) {
    it(`${host} -> ${upstream}`, () => {
      const site = siteFor(host);
      assert.ok(site, `no site block serves ${host}`);
      assert.deepEqual(upstreamsOf(site.body), [upstream]);
    });
  }

  it('serves no hostname outside the contract', () => {
    const served = blocks.flatMap((b) => b.addresses).sort();
    assert.deepEqual(served, Object.keys(CONTRACT).sort());
  });

  it('serves each hostname exactly once', () => {
    const served = blocks.flatMap((b) => b.addresses);
    assert.equal(new Set(served).size, served.length);
  });
});

// ── What the old fronts did beyond plain proxying ───────────────────────────
// Each row cites the file the rule was carried over from. The nginx fronts
// applied every rule to the whole server block, i.e. to both of a node's names.
const STORE = ['proxy.ario.devnet', 'dvm.devnet'].map((h) => `${h}.${ZONE}`);
const GAS = ['proxy.gas.devnet', 'gas.devnet'].map((h) => `${h}.${ZONE}`);
const GW_EDGE = `proxy.gateway.devnet.${ZONE}`;
const GW_WORKLOADS = `gw.devnet.${ZONE}`; // the block that also holds *.gw
const FAUCET = `faucet.devnet.${ZONE}`;
const RELAY = [`proxy.relay.devnet.${ZONE}`, `relay-ws.devnet.${ZONE}`];

// client_max_body_size, from each node's nginx `location /`. nginx's `m` is
// MiB, so these are written in Caddy's binary units.
const BODY_LIMITS = {
  [STORE[0]]: '4MiB',
  [STORE[1]]: '4MiB',
  [GAS[0]]: '512KiB',
  [GAS[1]]: '512KiB',
  [GW_EDGE]: '1MiB',
  [GW_WORKLOADS]: '64MiB',
  [FAUCET]: '1MiB',
};

// limit_req: `rate=200r/s burst=400` on store, gas and gateway, `rate=30r/s
// burst=60` on the faucet. A sliding window of `burst` events per 2s keeps
// both the burst and the average rate.
const RATE_LIMITS = {
  [STORE[0]]: 400,
  [STORE[1]]: 400,
  [GAS[0]]: 400,
  [GAS[1]]: 400,
  [GW_EDGE]: 400,
  [GW_WORKLOADS]: 400,
  [FAUCET]: 60,
};

const body = (host) => siteFor(host).body;

describe('/admin is never reachable from outside', () => {
  // `location ^~ /admin { return 404; }` in the store, gas and gateway fronts.
  for (const host of [...STORE, ...GAS, GW_EDGE]) {
    it(`${host} answers 404 for /admin*`, () => {
      assert.match(body(host), /^\s*respond \/admin\* 404$/m);
    });
  }
});

describe('request body limits', () => {
  for (const [host, size] of Object.entries(BODY_LIMITS)) {
    it(`${host} caps a body at ${size}`, () => {
      assert.match(body(host), new RegExp(`request_body\\s*\\{\\s*max_size ${size}\\s*\\}`));
    });
  }

  it('leaves the relay unlimited, as its own Caddyfile did', () => {
    for (const host of RELAY) assert.doesNotMatch(body(host), /request_body/);
  });
});

describe('rate limits', () => {
  for (const [host, events] of Object.entries(RATE_LIMITS)) {
    it(`${host} allows ${events} events per client per 2s`, () => {
      assert.match(body(host), new RegExp(`^\\s*import rate_limited(?:_except)? \\S+ ${events}\\b`, 'm'));
    });
  }

  it('gives every site its own zone, because caddy-ratelimit requires unique zone names', () => {
    const zones = [...sites.matchAll(/^\s*import rate_limited(?:_except)? (\S+) \d+/gm)].map((m) => m[1]);
    assert.equal(zones.length, Object.keys(RATE_LIMITS).length);
    assert.equal(new Set(zones).size, zones.length);
  });

  it('keys on the client address over a 2s window', () => {
    assert.match(sites, /key \{remote_host\}/);
    assert.match(sites, /window 2s/);
  });

  it('never limits the faucet health probe', () => {
    // `location = /health` in the faucet front carried no limit_req.
    assert.match(body(FAUCET), /^\s*import rate_limited_except \S+ 60 \/health$/m);
    assert.match(sites, /not path \{args\[2\]\}/);
  });

  it('leaves the relay unlimited, as its own Caddyfile did', () => {
    for (const host of RELAY) assert.doesNotMatch(body(host), /rate_limit/);
  });
});

describe('CORS on /ilp/identity', () => {
  // `location = /ilp/identity` in the store and gas fronts: always the
  // connector, on either of the node's names, with the console's origin.
  for (const [host, connector] of [
    [STORE[0], 'store-proxy:4000'],
    [STORE[1], 'store-proxy:4000'],
    [GAS[0], 'gas-proxy:4000'],
    [GAS[1], 'gas-proxy:4000'],
  ]) {
    it(`${host} answers it from ${connector}, with the console's origin`, () => {
      const b = body(host);
      assert.match(b, /^\s*import ilp_identity_cors$/m);
      assert.match(b, new RegExp(`reverse_proxy /ilp/identity ${connector.replace('.', '\\.')}$`, 'm'));
    });
  }

  it('sends the console\'s origin, and appends Vary after the upstream\'s headers', () => {
    const snippet = snippetBody('ilp_identity_cors');
    assert.match(snippet, /header \/ilp\/identity \{/);
    assert.match(snippet, /^\s*defer$/m);
    assert.match(snippet, /Access-Control-Allow-Origin "https:\/\/proxy\.devnet\.toonprotocol\.dev"/);
    assert.match(snippet, /^\s*\+Vary Origin$/m);
  });
});

describe('the gateway', () => {
  it('reaches its workload listener over TLS, named `gateway`, unverified (nginx proxy_ssl_*)', () => {
    const b = body(GW_WORKLOADS);
    assert.match(b, /tls_insecure_skip_verify/);
    assert.match(b, /tls_server_name gateway$/m);
  });

  it('passes the visitor\'s Host to the gateway, which keys everything off it', () => {
    // nginx: `proxy_set_header Host $host`. Caddy passes Host through to a
    // plain-HTTP upstream, but REWRITES it to the upstream's address for an
    // HTTPS one, so the gateway would see `gateway-gw` for every workload and
    // answer no_grant. Found by test/smoke.sh.
    assert.match(body(GW_WORKLOADS), /^\s*header_up Host \{host\}$/m);
  });

  it('leaves X-Forwarded-Proto to Caddy, which sets it to https', () => {
    assert.doesNotMatch(sites, /header_up\s+X-Forwarded-Proto/i);
  });

  it('touches Host nowhere else: every other upstream is plain HTTP and gets it untouched', () => {
    assert.equal([...sites.matchAll(/header_up\s+Host/gi)].length, 1);
  });
});

describe('a reload does not drop open WebSockets', () => {
  it('every upstream keeps its streams open across a config reload', () => {
    // nginx's reload let old workers drain; Caddy's closes streams at once
    // unless told otherwise.
    const proxies = [...sites.matchAll(/^\s*reverse_proxy\s(?!\/)/gm)].length;
    const delayed = [...sites.matchAll(/^\s*stream_close_delay 5m$/gm)].length;
    assert.ok(proxies > 0);
    assert.equal(delayed, proxies);
  });
});

// ── The Caddy process, the image and the compose project ────────────────────
const REPO = join(HERE, '..', '..');
const readRepo = (path) => readFileSync(join(REPO, path), 'utf8');
const IMAGE = 'ghcr.io/toon-protocol/edge-caddy';

describe('certificates', () => {
  const caddyfile = () => read('caddy/Caddyfile');

  it('validates over DNS-01 through Porkbun, with the keys read from the environment at runtime', () => {
    // A wildcard is issued over DNS-01 only. Global, so every other name is
    // issued the same way and before its DNS record is flipped to this host.
    assert.match(caddyfile(), /acme_dns porkbun \{\s*api_key \{env\.PORKBUN_API_KEY\}\s*api_secret_key \{env\.PORKBUN_SECRET_KEY\}\s*\}/);
  });

  it('serves exactly the shared site table', () => {
    assert.match(caddyfile(), /^import sites\.caddy$/m);
    assert.doesNotMatch(caddyfile(), /reverse_proxy/);
  });

  it('speaks h1 and h2, as the nginx fronts did, and advertises no h3 that 443/udp would not carry', () => {
    assert.match(caddyfile(), /protocols h1 h2$/m);
  });

  it('the local smoke test swaps ACME for the internal CA and nothing else', () => {
    const test = read('test/Caddyfile');
    assert.match(test, /^\s*local_certs$/m);
    assert.doesNotMatch(test, /acme_dns|porkbun/);
    assert.match(test, /^import \/etc\/caddy\/sites\.caddy$/m);
    assert.doesNotMatch(test, /reverse_proxy/);
  });
});

/** Escape every RegExp metacharacter, so a literal can sit inside a pattern. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

describe('the image', () => {
  it('is pinned by digest, because the Porkbun key passes through it', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, new RegExp(`^\\s+image: ${escapeRegExp(IMAGE)}@sha256:[0-9a-f]{64}$`, 'm'));
    assert.doesNotMatch(compose, /^\s+build:/m);
  });

  it('is built from the stock Caddy builder with exactly the two plugins, each pinned', () => {
    const dockerfile = readRepo('edge/Dockerfile');
    assert.match(dockerfile, /--with github\.com\/caddy-dns\/porkbun@v\d+\.\d+\.\d+/);
    assert.match(dockerfile, /--with github\.com\/mholt\/caddy-ratelimit@[0-9a-f]{40}/);
    assert.equal([...dockerfile.matchAll(/--with /g)].length, 2);
    for (const from of dockerfile.matchAll(/^FROM (\S+)/gm)) {
      assert.match(from[1], /^caddy:[\w.-]+@sha256:[0-9a-f]{64}$/, `${from[1]} is not a pinned stock caddy image`);
    }
  });

  it('is what CI builds and pushes', () => {
    const workflow = readRepo('.github/workflows/edge-image.yml');
    assert.ok(workflow.includes(IMAGE), 'the workflow pushes some other image');
    assert.match(workflow, /context: edge$/m);
    assert.match(workflow, /node --test edge\/deploy\/bundle\.test\.mjs/);
  });
});

// One network per node (contract v2): only the edge reaches a node, so no node
// can reach another's connector /admin or the gateway's handover door. A node's
// overlay joins its own network, `external`, and nothing else of the edge's.
const NODE_NETWORKS = ['edge-relay', 'edge-store', 'edge-gas', 'edge-gateway', 'edge-faucet'];

// Every file in the bundle, for the checks that must hold across all of them.
const BUNDLE_FILES = [
  'docker-compose.yml', 'caddy/Caddyfile', 'caddy/sites.caddy', 'README.md', '.env.example',
  'auto-apply.sh', 'toon-auto-apply-edge.service', 'toon-auto-apply-edge.timer',
  'test/smoke.sh', 'test/docker-compose.edge.yml', 'test/docker-compose.stub-store.yml', 'test/docker-compose.stub-gateway.yml', 'test/Caddyfile',
];

describe('the compose project', () => {
  // Code only: comment-only lines explain, and must not satisfy or trip these.
  const compose = () => read('docker-compose.yml').replace(/^\s*#.*\n/gm, '');

  it('creates one network per node, each under its literal name', () => {
    const top = compose().slice(compose().indexOf('\nnetworks:'));
    for (const net of NODE_NETWORKS) {
      assert.match(top, new RegExp(`^  ${net}:\\n    name: ${net}$`, 'm'), `${net} is not created with a fixed name`);
    }
    // Created HERE. A node's overlay declares its network external; this one
    // must not, or nothing on the host creates them.
    assert.doesNotMatch(top, /external/);
    assert.deepEqual([...top.matchAll(/^    name: (\S+)$/gm)].map((m) => m[1]).sort(), [...NODE_NETWORKS].sort());
  });

  it('joins Caddy to all five, and to nothing else', () => {
    const caddy = compose().slice(compose().indexOf('  caddy:'), compose().indexOf('\nnetworks:'));
    const joined = [...caddy.slice(caddy.indexOf('    networks:')).matchAll(/^      - (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(joined.sort(), [...NODE_NETWORKS].sort());
  });

  it('names no flat `edge` network anywhere in the bundle any more', () => {
    for (const name of BUNDLE_FILES) {
      const text = read(name);
      // Indented: a network's `name:`. (Column 0 is the compose PROJECT name,
      // which is `edge` and is not a network.)
      assert.doesNotMatch(text, /^[ \t]+name: edge[ \t]*$/m, `${name} names a network \`edge\``);
      assert.doesNotMatch(text, /network[s]? `edge`|`edge` network|network inspect edge\b/, `${name} mentions the flat \`edge\` network`);
    }
  });

  it('publishes 80 and 443 and nothing else', () => {
    const publishes = [...compose().matchAll(/^\s+- '([^']*\d+:\d+[^']*)'/gm)].map((m) => m[1]);
    assert.deepEqual(publishes.sort(), ['443:443', '80:80']);
  });

  it('carries a memory limit, and tells the Go runtime about it', () => {
    assert.match(compose(), /^\s+mem_limit: \d+m$/m);
    assert.match(compose(), /GOMEMLIMIT: \S+MiB/);
  });

  it('mounts the config DIRECTORY, so a git checkout replacing a file is seen', () => {
    // A single-file bind mount pins the inode; git writes a new one.
    assert.match(compose(), /- \.\/caddy:\/etc\/caddy:ro$/m);
  });

  it('keeps certificates on a named volume, so a recreate re-issues nothing', () => {
    assert.match(compose(), /- caddy_data:\/data$/m);
  });

  it('requires both Porkbun keys and never carries a value for them', () => {
    assert.match(compose(), /PORKBUN_API_KEY: \$\{PORKBUN_API_KEY:\?/);
    assert.match(compose(), /PORKBUN_SECRET_KEY: \$\{PORKBUN_SECRET_KEY:\?/);
  });

  it('healthchecks on 127.0.0.1, never localhost', () => {
    assert.match(compose(), /http:\/\/127\.0\.0\.1:2019\//);
    assert.doesNotMatch(compose(), /localhost/);
  });
});

describe('nothing secret is committable', () => {
  it('gitignores .env and keeps .env.example', () => {
    const rows = read('.gitignore').split('\n').map((r) => r.trim());
    assert.ok(rows.includes('.env'));
    assert.ok(rows.includes('!.env.example'));
  });

  it('ships an .env.example with both Porkbun keys present and empty', () => {
    for (const name of ['PORKBUN_API_KEY', 'PORKBUN_SECRET_KEY']) {
      assert.match(read('.env.example'), new RegExp(`^${name}=$`, 'm'));
    }
  });
});

describe('GitOps', () => {
  it('runs as toon-auto-apply-edge, the per-node unit name every bundle on the host uses', () => {
    const service = read('toon-auto-apply-edge.service');
    assert.match(service, /^ExecStart=\/root\/infra\/edge\/deploy\/auto-apply\.sh$/m);
    assert.match(read('toon-auto-apply-edge.timer'), /^Unit=toon-auto-apply-edge\.service$/m);
    assert.match(read('README.md'), /toon-auto-apply-edge\.service toon-auto-apply-edge\.timer/);
    for (const name of BUNDLE_FILES) {
      assert.doesNotMatch(read(name), /toon-edge-auto-apply/, `${name} still names the old units`);
    }
  });

  it('takes its own lock, so it neither blocks nor is blocked by a node applying', () => {
    assert.match(read('auto-apply.sh'), /^exec 9>\/var\/lock\/toon-auto-apply-edge\.lock$/m);
  });

  it('lets docker compose read COMPOSE_FILE from .env, passing no -f when it is set', () => {
    // Contract v2 §3: never parse COMPOSE_FILE; an explicit -f would override
    // it and silently drop an overlay.
    const script = read('auto-apply.sh');
    assert.match(script, /grep -q '\^\[\[:space:\]\]\*COMPOSE_FILE=' \.env/);
    assert.match(script, /COMPOSE=\(\)/);
    assert.match(script, /COMPOSE=\(-f docker-compose\.yml\)/);
  });

  it('retries an apply that failed after the fast-forward, instead of reporting green from then on', () => {
    // "Nothing new upstream" is not "applied": the script records the commit
    // it last applied successfully and compares HEAD against that too.
    const script = read('auto-apply.sh');
    assert.match(script, /APPLIED_MARKER=/);
    assert.match(script, /\[ "\$LOCAL" = "\$REMOTE" \] && \[ "\$APPLIED" = "\$REMOTE" \]/);
    assert.ok(read('.gitignore').split('\n').some((row) => row.trim() === '.applied'));
  });

  it('reloads Caddy rather than restarting it, and refuses the placeholder digest', () => {
    const script = read('auto-apply.sh');
    assert.match(script, /caddy reload --config \/etc\/caddy\/Caddyfile/);
    assert.match(script, /PLACEHOLDER/);
  });
});
