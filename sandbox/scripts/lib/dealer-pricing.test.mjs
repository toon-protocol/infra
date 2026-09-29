// The Dealer's price arithmetic (infra#42, connector ADR 0071): what a µUSDC
// amount forwards as ANYONE, at the worst rate the sandbox's market can show
// and at a rate the dealer reports on GET /rates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dealtRate, forwarded, readSpread, worstRate } from './dealer-pricing.mjs';

// conf/amm-topology.conf and the dealer's [rate_guards], as committed.
const MARKET = {
  anyoneTick: 93931, // ANYONE per WETH, ln(12000)/ln(1.0001)
  bandTicks: 200,
  wethUsdcTick: 196256, // WETH per µUSDC, 1e18 / 3e9
  spread: { numerator: 30, denominator: 10000 },
};
const FEE = 400_000_000_000_000n; // 0.0004 ANYONE
const BUNDLE = 40_000_000_000_000_000n; // 0.04 ANYONE

test('the worst rate is the mid less the driver band and the spread, about 3.908e12', () => {
  const worst = worstRate(MARKET);
  const value = Number(worst.num) / Number(worst.den);
  assert.ok(Math.abs(value - 3.908e12) / 3.908e12 < 0.001, `${worst.num}/${worst.den}`);
  assert.equal(typeof worst.num, 'bigint');
});

test('at the worst rate, 10900 µUSDC still buys a bundle and 110 still clears the fee', () => {
  const worst = worstRate(MARKET);
  assert.ok(forwarded(10_900n, worst, FEE) >= BUNDLE);
  assert.ok(forwarded(110n, worst, FEE) >= 0n);
});

test('10 µUSDC, the old key-document margin, does not cover the fee', () => {
  assert.ok(forwarded(10n, worstRate(MARKET), FEE) < 0n);
});

test('the dealt rate composes the par leg with the ANYONE quote read backwards, less the spread', () => {
  const rows = [
    { from: 'solana:H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H', to: 'evm:0xusdc', rate: { numerator: '1', denominator: '1' } },
    // 1 ANYONE base unit is worth 1/4e12 µUSDC: ANYONE at 0.25 USDC.
    { from: 'evm:0xanyone', to: 'evm:0xusdc', rate: { numerator: '1', denominator: '4000000000000' } },
  ];
  const rate = dealtRate(rows, {
    from: 'solana:H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H',
    to: 'evm:0xANYONE',
    numeraire: 'evm:0xUSDC',
    spread: MARKET.spread,
  });
  // 10000 µUSDC at 4e12 less 0.3% is 3.988e16 ANYONE base units.
  assert.equal(forwarded(10_000n, rate, 0n), 39_880_000_000_000_000n);
});

test('the dealt rate is null while either leg is missing', () => {
  assert.equal(dealtRate([], { from: 'solana:x', to: 'evm:a', numeraire: 'evm:u', spread: MARKET.spread }), null);
});

test('the spread is read from [rate_guards], not from a per-pair override', () => {
  const toml = `
[[rates]]
spread = { numerator = 0, denominator = 1 }

[rate_guards]
spread = { numerator = 30, denominator = 10000 }
ttl_secs = 120
`;
  assert.deepEqual(readSpread(toml), { numerator: 30, denominator: 10000 });
  assert.equal(readSpread('[[rates]]\nspread = { numerator = 0, denominator = 1 }\n'), null);
});
