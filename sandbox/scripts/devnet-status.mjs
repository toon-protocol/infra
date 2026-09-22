#!/usr/bin/env node
// The public TOON devnet, read from outside it.
//
//   node scripts/devnet-status.mjs            (or: make devnet-status)
//
// Every check here is FREE and unauthenticated. It opens no channel, signs
// nothing and holds no key, so it can be run from anywhere by anyone — which
// is the point: it answers "is the devnet up, and what does it sell today?"
// without needing a funded wallet, and a funded wallet is the one thing a
// newcomer does not have.
//
// It is not a smoke test. `make smoke-*` proves the paid path against the
// local sandbox, where the money is a committed throwaway. This proves the
// REACHABILITY and the DIRECTORY of the real devnet:
//
//   * every node's `GET /ilp` — the routes it terminates, their prices, and
//     the settlement identities a payer would open a channel against. That
//     document is the authority on all of it (connector ADR 0050, ND-07): the
//     connector proved each settlement fact against a live chain at boot, so
//     nothing here is read from a constant;
//   * the Workload Gateway's answer to a hostname it holds no grant for,
//     which is a 503 `no_grant` and is the healthy, empty state — it proves
//     the gateway answered and dialled nobody (spec §12.3);
//   * the Provider Directory on the relay: each provider's Profile (10432),
//     its Listings (30432) and its Liveness (10433). Relay reads are free.
//
// Exit 0 if every node answered. A node that is down, or a provider that has
// stopped publishing, is printed and exits 1 — that is the failure this exists
// to name, and "the console shows an empty provider list" is how it otherwise
// gets noticed.
//
// IT IMPORTS NOTHING. `fetch` and `WebSocket` are both globals on the Node
// this repository targets, and a probe of the public devnet that needs an
// `npm install` first is one nobody runs from a fresh machine — which is
// exactly the machine it is most useful on.

const DEVNET = {
  relayRead: 'wss://relay-ws.devnet.toonprotocol.dev',
  nodes: [
    { name: 'store', url: 'https://proxy.ario.devnet.toonprotocol.dev' },
    { name: 'relay', url: 'https://proxy.relay.devnet.toonprotocol.dev' },
    { name: 'gas', url: 'https://proxy.gas.devnet.toonprotocol.dev' },
    { name: 'provider', url: 'https://proxy.provider.devnet.toonprotocol.dev' },
    { name: 'workload-gateway', url: 'https://proxy.gateway.devnet.toonprotocol.dev' },
  ],
  // A label under the gateway's domain that is certainly not a workload: a
  // canonical one is 52 base32 characters, and a handover's readable `name`
  // would have to have been asked for.
  gatewayProbe: 'https://not-a-workload.gw.devnet.toonprotocol.dev/',
  providerHealth: 'https://provider.devnet.toonprotocol.dev/health',
};

// The directory kinds, and the label every TOON directory event carries.
const K_PROFILE = 10432;
const K_LIVENESS = 10433;
const K_LISTING = 30432;
const LABEL = 'toon.network';

const TIMEOUT_MS = 15_000;

let failures = 0;
const ok = (line) => console.log(`  ok   ${line}`);
const bad = (line) => {
  failures += 1;
  console.log(`  FAIL ${line}`);
};

async function getJson(url) {
  const answer = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  return answer.json();
}

async function describeNode({ name, url }) {
  let self;
  try {
    self = await getJson(`${url}/ilp`);
  } catch (e) {
    bad(`${name.padEnd(17)} ${url}/ilp — ${e.message}`);
    return null;
  }
  const routes = (self.routes ?? [])
    .map((r) => `${r.prefix}@${r.price}${r.pricePerKib ? `+${r.pricePerKib}/KiB` : ''}`)
    .join(' ');
  ok(`${name.padEnd(17)} ${(self.ilpAddresses ?? []).join(',')}`);
  console.log(`       routes      ${routes || '(none)'}`);
  for (const s of self.settlements ?? []) {
    console.log(`       settles on  ${s.chain} as ${s.settlementAddress}`);
  }
  console.log(`       seals to    ${self.edgeIdentity?.publicKey?.slice(0, 22)}…`);
  return self;
}

/** Every event matching `filter`, from one relay, over one short subscription. */
function readRelay(url, filter) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const events = [];
    const id = `devnet-status-${Math.random().toString(36).slice(2, 10)}`;
    const done = (fn, arg) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      fn(arg);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`no EOSE from ${url} in ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );
    socket.addEventListener('error', () => done(reject, new Error(`could not reach ${url}`)));
    socket.addEventListener('open', () => socket.send(JSON.stringify(['REQ', id, filter])));
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message[0] === 'EVENT' && message[1] === id) events.push(message[2]);
      if (message[0] === 'EOSE' && message[1] === id) done(resolve, events);
      if (message[0] === 'CLOSED' && message[1] === id) done(reject, new Error(message[2] ?? 'CLOSED'));
    });
  });
}

const tag = (event, name) => event.tags.find((t) => t[0] === name)?.[1];

async function directory() {
  console.log('\nThe Provider Directory, read off the relay (free):');
  let profiles;
  try {
    profiles = await readRelay(DEVNET.relayRead, { kinds: [K_PROFILE], '#L': [LABEL], limit: 50 });
  } catch (e) {
    bad(`relay read ${DEVNET.relayRead} — ${e.message}`);
    return;
  }
  if (profiles.length === 0) {
    bad('no Provider Profile is published on this relay — nothing is for sale');
    return;
  }
  for (const profile of profiles) {
    let content = {};
    try {
      content = JSON.parse(profile.content);
    } catch {
      /* a Profile whose content is not JSON is still a Profile that exists */
    }
    ok(`provider ${profile.pubkey.slice(0, 16)}… ${content.name ?? '(unnamed)'}`);
    console.log(`       isolation   ${content.isolation ?? '?'}${content.hidden ? ' (hidden)' : ''}`);
    console.log(`       host        ${content.host ?? '(none — hidden)'}`);
    console.log(`       connector   ${content.connector_url ?? '?'}`);

    const [listings, liveness] = await Promise.all([
      readRelay(DEVNET.relayRead, { kinds: [K_LISTING], authors: [profile.pubkey], limit: 50 }).catch(() => []),
      readRelay(DEVNET.relayRead, { kinds: [K_LIVENESS], authors: [profile.pubkey], limit: 1 }).catch(() => []),
    ]);

    if (listings.length === 0) bad('       this provider publishes no Listing, so nothing of it can be bought');
    for (const listing of listings) {
      let l = {};
      try {
        l = JSON.parse(listing.content);
      } catch {
        /* as above */
      }
      const caps = (l.capabilities ?? []).join(',') || '—';
      console.log(
        `       listing     ${tag(listing, 'd') ?? '?'} v${l.version ?? '?'} ` +
          `${l.price ?? '?'}µUSDC/${l.lease_interval_s ?? '?'}s cap ${l.capacity ?? '?'} caps ${caps}` +
          (l.standby_price ? ` standby ${l.standby_price}` : ''),
      );
    }

    if (liveness.length === 0) {
      bad('       no Liveness — this provider reads as down');
    } else {
      const expires = Number(tag(liveness[0], 'expiration') ?? 0);
      const left = expires - Math.floor(Date.now() / 1000);
      if (left <= 0) bad(`       Liveness expired ${-left}s ago`);
      else ok(`       Liveness good for another ${left}s`);
    }
  }
}

console.log('The TOON devnet, from outside it. Nothing below costs anything.\n');
console.log('Nodes:');
for (const node of DEVNET.nodes) await describeNode(node);

console.log('\nThe provider app:');
try {
  const health = await getJson(DEVNET.providerHealth);
  ok(`GET ${DEVNET.providerHealth} — ${JSON.stringify(health)}`);
} catch (e) {
  bad(`GET ${DEVNET.providerHealth} — ${e.message}`);
}

console.log('\nThe Workload Gateway:');
try {
  const answer = await fetch(DEVNET.gatewayProbe, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const reason = answer.headers.get('toon-gateway-reason');
  // 503 `no_grant` IS the healthy answer for a hostname nobody handed over:
  // the gateway answered and dialled nobody. Anything else means either a
  // grant exists for a name that should have none, or something other than
  // the gateway answered.
  if (answer.status === 503 && reason === 'no_grant') {
    ok(`${DEVNET.gatewayProbe} — 503 no_grant, which is the healthy empty state`);
  } else {
    bad(`${DEVNET.gatewayProbe} — ${answer.status} ${reason ?? '(no toon-gateway-reason header)'}`);
  }
} catch (e) {
  bad(`${DEVNET.gatewayProbe} — ${e.message}`);
}

await directory();

console.log(failures === 0 ? '\nEverything answered.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
