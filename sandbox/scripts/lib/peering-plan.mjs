// The pure decisions the open-peerings job makes from scripts/peerings.mjs.
// Everything that touches a node or a chain is in scripts/open-peerings.mjs;
// this file only turns the table into request bodies and figures, so the
// arithmetic can be tested without a stack.
import { CHANNEL_TARGET, OPEN_DEPOSIT } from '../peerings.mjs';

/**
 * Whether `side` of a peering writes `POST /peers` at all. The payer always
 * does. The payee does unless the peering is `payeeBinds: false` — the
 * Dealer's to anytoon (infra ADR 0003), where binding the dealer's voucher
 * signer would turn its vouchers into a PEER's, and a peer-role arrival tells
 * anytoon's claim minter nobody paid (connector ADR 0040).
 */
export function binds(peering, side) {
  return side === 'payer' || peering.payeeBinds !== false;
}

/** What the payer keeps behind its channel: the peering's own, or 100 USDC. */
export const targetOf = (peering) => peering.target ?? CHANNEL_TARGET;

/**
 * The `POST /peers` body one side of a peering sends.
 *
 * The PAYEE goes first and names the payer: it reads the payer's
 * self-description, binds the payer's voucher signer to the peering (so the
 * payer's very first voucher arrives in the PEER role) and opens its own
 * channel back toward the payer — the other half of every peering, opened at
 * the minimum and never paid on, with no fee and the default cap because
 * nothing is forwarded that way. The PAYER then names the payee and opens the
 * channel that carries traffic, with the whole target behind it.
 */
export function peerBody(peering, side, nodes) {
  const payer = side === 'payer';
  return JSON.stringify({
    id: peering.id,
    url: nodes[payer ? peering.payee : peering.payer].url,
    fee: payer ? peering.fee : 0,
    // 0 keeps the connector's default cap (one USDC at six decimals), far
    // above any single packet a USDC peering here sends. An 18-decimal leg
    // names its own: that default is 1e-12 ANYONE, and every forward onto it
    // would refuse T04.
    max_packet_amount: payer ? (peering.max_packet_amount ?? 0) : 0,
    chain: peering.chain,
    // JSON numbers: the connector reads them as u128. Every figure in the
    // table (1e18, 1e19 included) is one a double holds exactly.
    deposit: Number(payer ? targetOf(peering) : OPEN_DEPOSIT),
  });
}

/** What `POST /channels/:id/fund` must add — it takes an INCREMENT. */
export function topUp(collateral, target) {
  return collateral < target ? target - collateral : 0n;
}

/**
 * Splits the table by what this compose profile runs. `payments` runs the hub
 * and both providers but no store or gas station; a peering whose far side
 * does not exist here is skipped by name rather than failed.
 */
export function presentPeerings(peerings, present) {
  const run = [];
  const skipped = [];
  for (const peering of peerings) {
    (present.has(peering.payer) && present.has(peering.payee) ? run : skipped).push(peering);
  }
  return { run, skipped };
}

/**
 * The TERMINATED routes of a connector config — `[[routes]]` rows with a
 * `handler_url` — as `{ prefix, price }`. A reader for the one shape the
 * sandbox's committed configs write (a quoted prefix, and a price that is an
 * integer or an inline `{ base, per_kib }` table), not a TOML parser.
 */
export function readTerminatedRoutes(toml) {
  const routes = [];
  for (const block of toml.split(/^\[\[routes\]\]\s*$/m).slice(1)) {
    const row = block.split(/^\[/m)[0];
    const prefix = row.match(/^prefix\s*=\s*"([^"]+)"/m)?.[1];
    if (!prefix || !/^handler_url\s*=/m.test(row)) continue;
    const flat = row.match(/^price\s*=\s*(\d+)\s*$/m);
    const metered = row.match(/^price\s*=\s*\{\s*base\s*=\s*(\d+)\s*,\s*per_kib\s*=\s*(\d+)\s*\}/m);
    const price = flat ? Number(flat[1]) : metered ? { base: Number(metered[1]), per_kib: Number(metered[2]) } : undefined;
    if (price === undefined) throw new Error(`route ${prefix} has a price this reader does not know`);
    routes.push({ prefix, price });
  }
  return routes;
}
