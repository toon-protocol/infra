// The WORKLOAD GATEWAY side of the sandbox's host-run tooling (TOON_Network
// Milestone 5, spec §12): the values `make up-gateway` runs the gateway with,
// the hostname a workload id derives, and a request that arrives at the
// gateway under a hostname of our choosing.
//
// scripts/lib/provider-smoke.mjs is the same idea for the PROVIDER — the
// sandbox's committed addresses and the ceremony every smoke repeats — and
// this file is its counterpart rather than an extension of it, because a
// gateway is not a provider: it holds no lease, sells nothing and is asked
// nothing over ILP (spec §12). scripts/grant.mjs and scripts/smoke-milestone5.mjs
// both read it, so the canonical label a grant PRINTS and the one a smoke
// ASKS FOR are one function and can never drift.
//
// Nothing here asserts anything; every function returns what it found.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getPublicKey } from 'nostr-tools/pure';
import { ROOT } from './provider-smoke.mjs';

// The sandbox gateway's HOST-side listeners: docker-compose.yml publishes the
// container's 8080 at 3280 (plain) and 8443 at 3443 (TLS, with the committed
// self-signed wildcard below). Its own connector's client edge is 3260 — an
// ILP identity that terminates NO paid route (ADR 0013, README §6.9).
export const GATEWAY_HTTP_PORT = Number(process.env.GATEWAY_HTTP_PORT ?? 3280);
export const GATEWAY_HTTPS_PORT = Number(process.env.GATEWAY_HTTPS_PORT ?? 3443);
export const GATEWAY_EDGE = process.env.GATEWAY_EDGE_URL ?? 'http://localhost:3260';
const GATEWAY_CONF = join(ROOT, 'conf', 'workload-gateway.conf');
const GATEWAY_TLS_CERT = join(ROOT, 'conf', 'workload-gateway-tls', 'gw.localhost.crt');
/** Mirrored from the provider's src/nostr/kinds.rs, as provider-smoke.mjs mirrors the rest: the Gateway Grant (spec §3.1.3). */
export const K_GATEWAY_GRANT = 30438;

/** A `KEY=value` line out of conf/workload-gateway.conf, or throw naming it. */
function gatewayConf(key) {
  const text = readFileSync(GATEWAY_CONF, 'utf8');
  const value = text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
  if (!value) throw new Error(`conf/workload-gateway.conf has no ${key} line`);
  return value;
}
/** The sandbox gateway's public key: what `make up-gateway` runs it with, and what a grant names. */
export const gatewayPubkey = () =>
  getPublicKey(Uint8Array.from(Buffer.from(gatewayConf('GATEWAY_SECRET_KEY'), 'hex')));
/** The sandbox gateway's domain: `gw.localhost`. */
export const gatewayDomain = () => gatewayConf('GATEWAY_DOMAIN').toLowerCase();

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
