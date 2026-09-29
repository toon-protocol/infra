// The Dealer's price arithmetic (infra#42, infra ADR 0003, connector ADR 0071).
//
// The dealer is paid µUSDC at par over the hub's Solana channel and pays
// anytoon ANYONE on its own EVM channel, forwarding `floor(amount x rate) -
// fee` with the fee in ANYONE. Its route prices are static µUSDC figures, so
// each has to cover the WORST rate the sandbox's market can show. Pure: the
// peering-plan test holds the committed prices to `worstRate`, and
// scripts/smoke-toon.mjs holds them to the live `dealtRate` off GET /rates.
//
// A rate here is an exact fraction `{ num, den }` of bigints: ANYONE base
// units per µUSDC.

/**
 * The fewest ANYONE base units one µUSDC can buy while the swap driver is the
 * only thing trading: the ANYONE/WETH pool at the edge of its band where ANYONE
 * is dearest, the WETH/USDC pool at its pinned tick, less the dealer's spread.
 * A v3 tick is already `token1 per token0 in base units` (ADR 0071 decision 4),
 * so nothing rescales for decimals. Floating point, then fixed to a fraction:
 * it sizes a buffer, it converts no money.
 */
export function worstRate({ anyoneTick, bandTicks, wethUsdcTick, spread }) {
  const anyonePerWeth = 1.0001 ** (anyoneTick - bandTicks);
  const wethPerMicroUsdc = 1.0001 ** wethUsdcTick;
  const keep = 1 - Number(spread.numerator) / Number(spread.denominator);
  const SCALE = 1000;
  return { num: BigInt(Math.floor(anyonePerWeth * wethPerMicroUsdc * keep * SCALE)), den: BigInt(SCALE) };
}

/** What `amount` µUSDC forwards as, at `rate`, once the peering's `fee` is kept. */
export function forwarded(amount, rate, fee) {
  return (BigInt(amount) * rate.num) / rate.den - BigInt(fee);
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const rowFor = (rows, from, to) => rows.find((r) => same(r.from, from) && same(r.to, to));

/**
 * The rate the dealer deals `from -> to` at right now, off its own GET /rates.
 * Only DECLARED pairs are listed there — `from -> numeraire` (the static par
 * row) and `to -> numeraire` (the live quote) — so the pair the packets cross
 * is composed the way the connector composes it: the second leg read
 * backwards, and the spread taken once, on top. Null while either leg is
 * missing.
 */
export function dealtRate(rows, { from, to, numeraire, spread }) {
  const par = rowFor(rows, from, numeraire);
  const quote = rowFor(rows, to, numeraire);
  if (!par?.rate || !quote?.rate) return null;
  const sn = BigInt(spread.numerator);
  const sd = BigInt(spread.denominator);
  return {
    num: BigInt(par.rate.numerator) * BigInt(quote.rate.denominator) * (sd - sn),
    den: BigInt(par.rate.denominator) * BigInt(quote.rate.numerator) * sd,
  };
}

/** A connector config's `[rate_guards] spread`, as `{ numerator, denominator }`, or null. */
export function readSpread(toml) {
  const m = toml.match(/^\[rate_guards\][^[]*?^spread\s*=\s*\{\s*numerator\s*=\s*(\d+)\s*,\s*denominator\s*=\s*(\d+)\s*\}/ms);
  return m ? { numerator: Number(m[1]), denominator: Number(m[2]) } : null;
}
