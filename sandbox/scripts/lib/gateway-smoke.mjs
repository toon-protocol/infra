// The WORKLOAD GATEWAY side of the sandbox's host-run tooling (TOON_Network
// Milestone 5 and 6, spec §12): the values `make up-gateway` runs the gateway
// and its connector with, the hostname a workload id derives, and a request
// that arrives at the gateway under a hostname of our choosing.
//
// scripts/lib/provider-smoke.mjs is the same idea for the PROVIDER — the
// sandbox's committed addresses and the ceremony every smoke repeats — and
// this file is its counterpart rather than an extension of it, because a
// gateway is not a provider: it holds no lease, sells nothing and is asked
// nothing over ILP but the one free handover route (spec §12).
// scripts/handover.mjs and the gateway smokes both read it, so the canonical
// label a handover PRINTS and the one a smoke ASKS FOR are one function and
// can never drift — and so are the route a handover is sealed to and the key
// it is sealed with.
//
// Nothing here asserts anything; every function returns what it found.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
// `ethers`, a DECLARED dependency of this sandbox (package.json), rather than
// @noble/curves — which is only hoisted here transitively through nostr-tools
// and would break this file the day that bump stops hoisting it.
import { SigningKey } from 'ethers';
import { ROOT } from './provider-smoke.mjs';

// The sandbox gateway's HOST-side listeners: docker-compose.yml publishes the
// container's 8080 at 3280 (plain) and 8443 at 3443 (TLS, with the committed
// self-signed wildcard below). Its own connector's client edge is 3260, where
// it terminates the ONE free route below (ADR 0013, README §6.9). Its
// GATEWAY_HANDOVER_PORT is published on no host port: a handover reaches the
// gateway through that connector or not at all.
export const GATEWAY_HTTP_PORT = Number(process.env.GATEWAY_HTTP_PORT ?? 3280);
export const GATEWAY_HTTPS_PORT = Number(process.env.GATEWAY_HTTPS_PORT ?? 3443);
export const GATEWAY_EDGE = process.env.GATEWAY_EDGE_URL ?? 'http://localhost:3260';
const GATEWAY_CONF = join(ROOT, 'conf', 'workload-gateway.conf');
const GATEWAY_CONNECTOR_CONF = join(ROOT, 'conf', 'connector-workload-gateway.toml');
const GATEWAY_CONNECTOR_SIGNER = join(ROOT, 'keys', 'toon', 'workload-gateway-connector', 'signer.key');
const GATEWAY_TLS_CERT = join(ROOT, 'conf', 'workload-gateway-tls', 'gw.localhost.crt');

/** A `KEY=value` line out of conf/workload-gateway.conf, or throw naming it. */
function gatewayConf(key) {
  const text = readFileSync(GATEWAY_CONF, 'utf8');
  const value = text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
  if (!value) throw new Error(`conf/workload-gateway.conf has no ${key} line`);
  return value;
}
/** The sandbox gateway's domain: `gw.localhost`. */
export const gatewayDomain = () => gatewayConf('GATEWAY_DOMAIN').toLowerCase();

// A GATEWAY HAS NO KEY, and there is no published Gateway Grant. Kind `30438`
// and `GATEWAY_SECRET_KEY` both went with Milestone 6 (TOON_Network #56, spec
// §12.1, ADR 0016, ADR 0017): a tenant chooses a gateway by sealing it a
// packet, and a gateway is named by the connector that packet was sealed to
// and by nothing else. So there is nothing here to export for either, and a
// smoke looking for a grant on a relay is looking for the thing this milestone
// removed.

/**
 * The route the sandbox gateway's connector terminates for a sealed Gateway
 * Handover and Gateway Withdrawal (spec §12.1, §12.7): the one `[[routes]]`
 * prefix in conf/connector-workload-gateway.toml, read from there so the
 * value a tenant seals to is the value the connector serves.
 */
export function handoverRoute() {
  const text = readFileSync(GATEWAY_CONNECTOR_CONF, 'utf8');
  const prefixes = [...text.matchAll(/^prefix\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  if (prefixes.length !== 1) {
    throw new Error(`conf/connector-workload-gateway.toml terminates ${prefixes.length} routes; expected exactly one, the handover's`);
  }
  return prefixes[0];
}

/**
 * The sandbox gateway connector's SEALING KEY — the 65-byte uncompressed
 * secp256k1 public key its `GET /ilp` reports, as 130 lowercase hex — derived
 * from the committed keys/toon/workload-gateway-connector/signer.key.
 *
 * DERIVED, NOT FETCHED, on purpose. A tenant pins a gateway connector's key
 * out of band exactly as it pins a Provider Profile's (ADR 0011): nothing on
 * the way to the gateway may name that key on its behalf, and the tenant tool
 * (provider/tools/grant) accordingly takes it as bytes and fetches nothing.
 * In this sandbox "out of band" is the committed key material itself, which
 * is why this reads the private key's file rather than asking :3260 — and why
 * a gateway connector whose key was regenerated is a gateway this returns the
 * right key for without anybody re-pasting a constant.
 */
export const gatewaySealKey = () =>
  new SigningKey(`0x${readFileSync(GATEWAY_CONNECTOR_SIGNER, 'utf8').trim()}`).publicKey.slice(2);

/**
 * The CANONICAL LABEL of spec §12.2: the lowercase, unpadded base32 (RFC 4648)
 * of the 32-byte workload id — 52 characters, where the same id's 64 hex
 * characters would not fit DNS's 63-character limit.
 *
 * DERIVED, NEVER ASSIGNED, which is the whole point: a tenant computes it from
 * the workload id it chose, and it is the same at every gateway holding the
 * grant. This is the gateway's own src/hostname.mjs written again on the
 * tenant's side, so a hostname printed here is the one the gateway serves.
 */
export function canonicalLabel(workloadId) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of Buffer.from(workloadId, 'hex')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Run `scripts/handover.mjs` — the sandbox's own tenant command (#62) — and
 * give back what it exited with and the JSON report it printed.
 *
 * THE COMMAND A DEVELOPER RUNS, not a second implementation of it. README §2's
 * walk-through and the two gateway smokes all go through this one script,
 * which goes through the tenant tool at provider/tools/grant, so the bytes a
 * smoke seals are the bytes that tool's own tests prove against the wire
 * fixtures, and a README that drifted from the smokes would fail one of them.
 *
 * `rootSecret` goes in the ENVIRONMENT and never on the command line, exactly
 * as the script's own usage says: argv is readable by every process on the
 * host. Everything else is flags — `--workload`, one `--standby` per member,
 * `--http-port`, `--expires-in` / `--expires-at`, `--name`, or `--withdraw`
 * with the moment the handover was derived for.
 *
 * Returns `{ status, report, stdout, stderr }`; `report` is null when the
 * script printed no JSON, which is what a refusal before sealing looks like.
 */
export function runHandover(args, { rootSecret, env = {} } = {}) {
  const ran = spawnSync(process.execPath, [join(ROOT, 'scripts', 'handover.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env, TOON_ROOT_SECRET: rootSecret },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  let report = null;
  try {
    report = JSON.parse(ran.stdout);
  } catch {
    report = null;
  }
  return { status: ran.status, report, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
}

/** The URLs a set of labels is served at under the sandbox gateway, plain listener first. */
export const urlsFor = (labels, domain) =>
  labels.flatMap((label) => [
    `http://${label}.${domain}:${GATEWAY_HTTP_PORT}/`,
    `https://${label}.${domain}:${GATEWAY_HTTPS_PORT}/`,
  ]);

/**
 * One request to the gateway AT a hostname — the `curl --resolve` of README §2,
 * in code.
 *
 * The connection goes to loopback and the HOSTNAME goes in the `Host` header,
 * which is what a gateway matches on (spec §12.2) and all that `*.gw.localhost`
 * resolving to loopback would have bought us. It is done this way rather than
 * with `fetch` because NODE'S `fetch` DROPS A USER-SET `Host`: it would ask
 * the gateway about `localhost` and be told `no_grant`, every time.
 *
 * Returns `{ status, headers, body }` — never throws for an HTTP status, since
 * a `503` with a reason is an answer this smoke reads rather than a failure.
 *
 * @param {string} hostname the name to ask under, e.g. `<label>.gw.localhost`
 * @param {{ path?: string, tls?: boolean, timeoutMs?: number, headers?: Record<string,string> }} options
 */
export function gatewayGet(hostname, { path = '/', tls = false, timeoutMs = 20_000, headers = {} } = {}) {
  const port = tls ? GATEWAY_HTTPS_PORT : GATEWAY_HTTP_PORT;
  return new Promise((resolve, reject) => {
    const send = tls ? httpsRequest : httpRequest;
    const req = send({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { host: `${hostname}:${port}`, ...headers },
      // NEVER POOLED. The gateway answers `Keep-Alive: timeout=5` and closes
      // an idle connection itself; node's default agent keeps one and would
      // send the next request down a socket the server had just closed, which
      // arrives here as `socket hang up` rather than as an answer. A smoke that
      // waits a minute between two questions must ask the second one on a fresh
      // connection, exactly as `curl` does.
      agent: false,
      // The dev certificate is self-signed for *.gw.localhost: trust exactly
      // it, and present the hostname in SNI so the gateway's TLS half sees the
      // same name its HTTP half will.
      ...(tls ? { ca: readFileSync(GATEWAY_TLS_CERT), servername: hostname } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from the gateway at ${hostname} in ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * The ONE refusal reason a gateway names for an answer (spec §12.3), out of
 * the `toon-gateway-reason` header; null for a 200.
 */
export const gatewayReason = (answer) => answer.headers['toon-gateway-reason'] ?? null;

/**
 * Is this answer the gateway refusing with `code`, ITS OWN way — a 503, the
 * reason in the header, AND the same code in a body that is spec §5's error
 * shape and nothing else (§12.3)?
 *
 * The header and the body have to agree, which is the whole reason this is one
 * function rather than two checks written out wherever a refusal is read: a
 * gateway that named a reason in one place and not the other would be a
 * gateway a tenant's parser could not trust either half of.
 */
export const gatewayRefused = (answer, code) =>
  answer.status === 503 && gatewayReason(answer) === code && errorBody(answer)?.error === code;

/**
 * What a gateway's own connector says it terminates, from its `GET /ilp`:
 * `{ ilpAddresses, routes, priced }`, where `priced` is the routes whose price
 * is not zero.
 *
 * ADR 0013 is why a smoke asks: a gateway holds no lease, buys nothing and
 * sells nothing, so the only route its connector terminates is the free door a
 * tenant seals a Gateway Handover or a Gateway Withdrawal to (spec §12.1,
 * §12.7). What that ought to be is the caller's to assert; this reads it.
 */
export async function gatewayConnector(edge = GATEWAY_EDGE) {
  const res = await fetch(`${edge}/ilp`);
  if (!res.ok) throw new Error(`${edge} GET /ilp -> ${res.status}`);
  const desc = await res.json();
  const routes = desc.routes ?? [];
  return { ilpAddresses: desc.ilpAddresses ?? [], routes, priced: routes.filter((r) => BigInt(r.price ?? 0) !== 0n) };
}

/**
 * What `traefik/whoami` says its own container is: the `Hostname:` line of its
 * answer, which docker sets per container.
 *
 * It is how the Milestone 5 smoke sees that a URL MOVED — the primary's copy
 * and the standby's copy of one image are two containers and say two different
 * things — and it is read out of the WORKLOAD'S OWN ANSWER, never out of a
 * gateway log. Null when the body is not a whoami answer.
 */
export const whoamiHostname = (body) => body.match(/^Hostname:\s*(\S+)\s*$/m)?.[1] ?? null;

/** One header of a whoami answer's echoed request, e.g. `X-Forwarded-Proto`; null when absent. */
export const whoamiHeader = (body, name) =>
  body.match(new RegExp(`^${name}:\\s*(.*)\\s*$`, 'mi'))?.[1]?.trim() ?? null;

/**
 * A gateway refusal's body, parsed and checked against spec §5's error shape —
 * `{ error, message }` and nothing else, which is the shape every provider
 * route answers a refusal in, so a tenant's tooling parses a gateway refusal
 * with the code it already has (spec §12.3).
 *
 * Returns `{ error, message }` when the body is exactly that, and null for
 * anything else — a body with a third key included, which is a body a tenant's
 * parser would have to be taught about.
 */
export function errorBody(answer) {
  let parsed;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  return Object.keys(parsed).sort().join() === 'error,message' ? parsed : null;
}
