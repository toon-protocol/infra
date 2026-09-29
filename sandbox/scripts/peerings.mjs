// THE SANDBOX'S PEERINGS, and the hub's routes over them (infra#39).
//
// Every channel is an x402 batch-settlement channel (connector ADR 0075), and
// a peering is TWO of them, one opened by each node through its own signed
// `POST /peers` naming the other's self-description URL. An x402 channel is
// opened with a fresh salt, so its id is a fact of the run and no config file
// can name it: the peerings are written at runtime by the `open-peerings` init
// job (scripts/open-peerings.mjs), and so are the hub's forwarding routes,
// because a config file's route may only name a peer the same file declares
// (connector ADR 0034). Both land in each node's `runtime-peers.json`, under
// `state_dir`, so they survive a restart; the job re-runs cleanly on a
// healthy stack.
//
// This file is that job's whole input. scripts/lib/peering-plan.test.mjs
// holds every hub price below to the payee's committed config.

// The nodes that peer, by compose service. `url` is the self-description a
// PEER reads, which is why it is a compose-network name: a node dials the
// endpoints the other publishes, and each of these publishes exactly this
// origin (see the `[node]` block of its conf/connector-*.toml). `port` is
// where the host reaches the same node, for scripts/lib/sandbox-endpoints.mjs.
export const NODES = {
  'relay-connector': { url: 'http://relay-connector:3000/ilp', port: 3200 },
  'store-connector': { url: 'http://store-connector:3000/ilp', port: 3210 },
  'gas-connector': { url: 'http://gas-connector:3000/ilp', port: 3220 },
  'provider-connector': { url: 'http://provider-connector:3000/ilp', port: 3240 },
  'provider2-connector': { url: 'http://provider2-connector:3000/ilp', port: 3250 },
};

// What every channel is OPENED with, in 6-decimal USDC base units: 1 USDC,
// every node's `min_sponsored_deposit` (a Solana open below it is refused
// `deposit_below_minimum`). The payee's channel toward the payer — the other
// half of every peering, which nothing here ever pays on — stays at this.
export const OPEN_DEPOSIT = 1_000_000n;

// What the PAYER keeps behind its outbound channel: 100 USDC of HEADROOM —
// what the channel can still pay, which is how the payer's own GET /channels
// reports `collateral`, so each run of the job refills what was spent. A
// peering crossing is about 1000 base units, so this is a hundred thousand of
// them before collateral is the reason something fails. The hub holds 1000 USDC
// on Solana (scripts/seed-toon-solana.mjs), four peerings' worth and more.
export const CHANNEL_TARGET = 100_000_000n;

// `id` is each node's local label for the relation (nothing puts it on the
// wire), the same on both ends so `GET /peers` reads alike. `fee` is what the
// payer keeps per packet it carries, in the base units of the channel it pays
// from (connector ADR 0061). Every peering settles on SOLANA, in the mock USDC
// mint: the payer's channel is opened through the payee's sponsor endpoint,
// so the payee holds the `payee` and `rent_payer` seats (ADR 0075 decision 3).
//
// `routes` are the payer's forwarding rows, written with `POST /routes/peers`
// once the peering stands. ADR 0028 arithmetic: `price - fee` is what arrives,
// and it must be the payee's own price exactly.
export const PEERINGS = [
  {
    id: 'relay-store',
    payer: 'relay-connector',
    payee: 'store-connector',
    chain: 'solana',
    fee: 100,
    // The store charges {base=1000, per_kib=10}: base 1100 - 100 == 1000 at
    // every payload size, and the per-KiB part is forwarded untouched.
    routes: [{ prefix: 'g.toon.store', price: { base: 1100, per_kib: 10 } }],
  },
  {
    id: 'relay-gas',
    payer: 'relay-connector',
    payee: 'gas-connector',
    chain: 'solana',
    fee: 100,
    routes: [{ prefix: 'g.toon.gastation', price: 1100 }],
  },
  {
    id: 'relay-provider',
    payer: 'relay-connector',
    payee: 'provider-connector',
    chain: 'solana',
    fee: 100,
    routes: providerRoutes('g.toon.provider', { ci: true }),
  },
  {
    // THE SECOND PROVIDER (TOON_Network #34): a separate peering on a separate
    // channel, because it is a separate payee — a Standby Set spans the two.
    id: 'relay-provider2',
    payer: 'relay-connector',
    payee: 'provider2-connector',
    chain: 'solana',
    fee: 100,
    routes: providerRoutes('g.toon.provider2', { ci: false }),
  },
];

// A provider's rows are GENERATED on its own side (`toon-provider routes`,
// pasted into conf/connector-provider*.toml): spawn and extend at the listing
// price, the `warm` tier's standby pair at its standby price, and four FREE
// provider-wide rows. The hub charges each plus the fee.
//
// THE FREE ROWS COST 100 HERE, NOT 0: this hop subtracts its fee from what the
// packet carries, so a 0 would forward a negative amount and refuse R01 every
// honest request. 100 - 100 == 0 arrives, which is what a free route asks for.
// Every row is written out because prefix matching is longest-wins and
// `g.toon.provider` itself is not a route.
function providerRoutes(address, { ci }) {
  const rows = [
    [`${address}.basic.v1.spawn`, 1100],
    [`${address}.basic.v1.extend`, 1100],
    // The sandbox-only `smoke` listing (30 s Lease Interval), `make smoke-m1`.
    [`${address}.smoke.v1.spawn`, 1100],
    [`${address}.smoke.v1.extend`, 1100],
    // `ci` (spec Appendix A.1) is sold by the first provider only.
    ...(ci
      ? [
          [`${address}.ci.v1.spawn`, 5100],
          [`${address}.ci.v1.extend`, 5100],
        ]
      : []),
    // `warm` prices Warm Standbys (spec §7): the running pair at the full
    // price, the standby pair at the standby price (400) + the fee.
    [`${address}.warm.v1.spawn`, 1100],
    [`${address}.warm.v1.extend`, 1100],
    [`${address}.warm.v1.standby`, 500],
    [`${address}.warm.v1.standby.extend`, 500],
    [`${address}.availability`, 100],
    [`${address}.status`, 100],
    [`${address}.terminate`, 100],
    [`${address}.rotate`, 100],
  ];
  return rows.map(([prefix, price]) => ({ prefix, price }));
}
