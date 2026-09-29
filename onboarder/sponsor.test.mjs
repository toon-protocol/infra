// The ERC-20 approval sponsor: it funds the approval's sender with exactly what
// it lacks, broadcasts the approval as signed, waits, then sends the deposit —
// and refuses, before sending anything, every approval it cannot be sure of.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFunctionData,
  encodeFunctionResult,
  maxUint256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  approvalSponsor,
  DEFAULT_MAX_APPROVAL_GAS,
  DEFAULT_MAX_FEE_PER_GAS,
  GAS_PRICE_ORACLE,
} from "./sponsor.mjs";

const PAYER = privateKeyToAccount(`0x${"11".repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${"22".repeat(32)}`);
const TOKEN = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const DEPOSIT = { to: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003", data: "0xdeadbeef" };
const LIMITS = { chainId: 84532, sponsoredTokens: [TOKEN] };
const APPROVE = parseAbi(["function approve(address,uint256) returns (bool)"]);

function signedApproval(overrides = {}, account = PAYER) {
  return account.signTransaction({
    chainId: 84532,
    to: TOKEN,
    data: encodeFunctionData({ abi: APPROVE, args: [PERMIT2, maxUint256] }),
    nonce: 0,
    gas: DEFAULT_MAX_APPROVAL_GAS,
    maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: 100_000_000n,
    type: "eip1559",
    ...overrides,
  });
}

/**
 * A chain that records what was sent, in order. With `lag`, it answers like a
 * load-balanced RPC: for `lag` reads after a transaction lands, a read is
 * served by a backend that has not seen it yet, and a transaction that depends
 * on it is refused there.
 */
function fakeChain({ balance = 0n, feeEstimate = 200_000_000n, nonce = 0, approveOk = true, l1Fee, lag = 0, refuseRaw = 0 } = {}) {
  const log = [];
  let n = 0;
  /** What each address holds on chain, and what a lagging backend still shows. */
  const held = new Map();
  const seen = new Map();
  const holds = (a) => held.get(a.toLowerCase()) ?? balance;
  let balanceLag = 0;
  let approved = false;
  let allowanceLag = 0;
  const hash = () => `0x${(++n).toString(16).padStart(64, "0")}`;
  return {
    log,
    /** The sender spends its ETH elsewhere. */
    setBalance: (address, value) => held.set(address.toLowerCase(), value),
    estimateFeesPerGas: async () => ({ maxFeePerGas: feeEstimate, maxPriorityFeePerGas: 1n }),
    getTransactionCount: async () => nonce,
    getCode: async ({ address }) =>
      address === GAS_PRICE_ORACLE && l1Fee !== undefined ? "0x60" : undefined,
    readContract: async ({ functionName }) => {
      if (functionName !== "allowance") return l1Fee;
      if (allowanceLag > 0) {
        allowanceLag--;
        return 0n;
      }
      return approved ? maxUint256 : 0n;
    },
    call: async () => {
      if (!approveOk) throw new Error("execution reverted");
      return { data: encodeFunctionResult({ abi: APPROVE, functionName: "approve", result: true }) };
    },
    getBalance: async ({ address }) => {
      log.push(["getBalance", address]);
      if (balanceLag > 0) {
        balanceLag--;
        return seen.get(address.toLowerCase()) ?? balance;
      }
      seen.set(address.toLowerCase(), holds(address));
      return holds(address);
    },
    sendTransaction: async (args) => {
      if (args.value === undefined && allowanceLag > 0) {
        throw new Error("execution reverted: a backend that has not seen the approval");
      }
      const h = hash();
      log.push(["sendTransaction", args, h]);
      if (args.value !== undefined) {
        seen.set(args.to.toLowerCase(), holds(args.to));
        held.set(args.to.toLowerCase(), holds(args.to) + args.value);
        balanceLag = lag;
      }
      return h;
    },
    sendRawTransaction: async ({ serializedTransaction }) => {
      if (balanceLag > 0) throw new Error("insufficient funds for gas * price + value");
      if (refuseRaw-- > 0) throw new Error("insufficient funds for gas * price + value");
      const h = hash();
      log.push(["sendRawTransaction", serializedTransaction, h]);
      // The approval spends its sender's ETH: all of it, at worst.
      const tx = parseTransaction(serializedTransaction);
      const sender = await recoverTransactionAddress({ serializedTransaction });
      const cost = tx.gas * tx.maxFeePerGas;
      held.set(sender.toLowerCase(), holds(sender) > cost ? holds(sender) - cost : 0n);
      approved = true;
      allowanceLag = lag;
      return h;
    },
    waitForTransactionReceipt: async ({ hash: h }) => {
      log.push(["wait", h]);
      return { status: "success" };
    },
  };
}
const sent = (chain) => chain.log.filter((e) => e[0] !== "getBalance" && e[0] !== "wait");
const fundings = (chain) => chain.log.filter((e) => e[0] === "sendTransaction" && e[1].value !== undefined);

test("funds a payer holding no ETH with the approval's worst-case fee, then broadcasts it, then deposits", async () => {
  const chain = fakeChain();
  const raw = await signedApproval();
  const hashes = await approvalSponsor(chain, LIMITS)([raw, DEPOSIT]);

  assert.deepEqual(
    chain.log.map((e) => e[0]),
    ["getBalance", "sendTransaction", "wait", "getBalance", "sendRawTransaction", "wait", "sendTransaction"],
  );
  const funding = chain.log[1][1];
  assert.equal(funding.to.toLowerCase(), PAYER.address.toLowerCase());
  assert.equal(funding.value, DEFAULT_MAX_APPROVAL_GAS * DEFAULT_MAX_FEE_PER_GAS);
  assert.equal(chain.log[4][1], raw);
  assert.deepEqual(chain.log[6][1], { to: DEPOSIT.to, data: DEPOSIT.data });
  assert.deepEqual(hashes, [chain.log[4][2], chain.log[6][2]]);
});

test("funds only the shortfall, and nothing when the payer already holds enough", async () => {
  const need = DEFAULT_MAX_APPROVAL_GAS * DEFAULT_MAX_FEE_PER_GAS;
  const partial = fakeChain({ balance: need - 5n });
  await approvalSponsor(partial, LIMITS)([await signedApproval(), DEPOSIT]);
  assert.equal(partial.log[1][1].value, 5n);

  const enough = fakeChain({ balance: need });
  await approvalSponsor(enough, LIMITS)([await signedApproval(), DEPOSIT]);
  assert.deepEqual(sent(enough).map((e) => e[0]), ["sendRawTransaction", "sendTransaction"]);
});

test("adds the L1 data fee, with a margin, on an OP-stack chain such as Base", async () => {
  const chain = fakeChain({ l1Fee: 400n });
  await approvalSponsor(chain, LIMITS)([await signedApproval(), DEPOSIT]);
  assert.equal(chain.log[1][1].value, DEFAULT_MAX_APPROVAL_GAS * DEFAULT_MAX_FEE_PER_GAS + 500n);
});

for (const [why, overrides, chainOptions, pattern] of [
  ["another chain's approval", { chainId: 1 }, {}, /chain 84532/],
  ["a token it does not sponsor", { to: "0x0000000000000000000000000000000000000abc" }, {}, /sponsors no approval/],
  ["more gas than allowed", { gas: DEFAULT_MAX_APPROVAL_GAS + 1n }, {}, /at most/],
  ["a higher fee than allowed", { maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS + 1n }, {}, /at most/],
  ["an approval that also moves ETH", { value: 1n }, {}, /moves no ETH/],
  ["a nonce other than the sender's next", { nonce: 5 }, { nonce: 4 }, /next nonce/],
  ["an approval that would revert", {}, { approveOk: false }, /would not succeed/],
]) {
  test(`refuses, sending nothing, ${why}`, async () => {
    const chain = fakeChain(chainOptions);
    await assert.rejects(approvalSponsor(chain, LIMITS)([await signedApproval(overrides), DEPOSIT]), pattern);
    assert.deepEqual(sent(chain), []);
  });
}

test("sponsors nothing when no token is configured", async () => {
  const chain = fakeChain();
  await assert.rejects(
    approvalSponsor(chain, { chainId: 84532 })([await signedApproval(), DEPOSIT]),
    /sponsors no approval/,
  );
  assert.deepEqual(sent(chain), []);
});

test("funds each sender once, however many requests arrive at the same time", async () => {
  const chain = fakeChain();
  const sponsor = approvalSponsor(chain, LIMITS);
  const raw = await signedApproval();
  const results = await Promise.allSettled([sponsor([raw, DEPOSIT]), sponsor([raw, DEPOSIT]), sponsor([raw, DEPOSIT])]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(fundings(chain).length, 1);
  // …and never again later.
  await assert.rejects(sponsor([raw, DEPOSIT]), /already/);
  // Another sender is its own case.
  await sponsor([await signedApproval({}, OTHER), DEPOSIT]);
  assert.equal(fundings(chain).length, 2);
});

test("a refusal before anything is sent leaves the sender free to try again", async () => {
  const chain = fakeChain({ nonce: 1 });
  const sponsor = approvalSponsor(chain, LIMITS);
  await assert.rejects(sponsor([await signedApproval({ nonce: 0 }), DEPOSIT]), /next nonce/);
  await sponsor([await signedApproval({ nonce: 1 }), DEPOSIT]);
  assert.equal(fundings(chain).length, 1);
});

test("admits a fee above the configured cap while the chain's own fee estimate is that high", async () => {
  const chain = fakeChain({ feeEstimate: 1_200_000_000n });
  const raw = await signedApproval({ maxFeePerGas: 1_436_582_285n });
  await approvalSponsor(chain, LIMITS)([raw, DEPOSIT]);
  assert.equal(chain.log[1][1].value, DEFAULT_MAX_APPROVAL_GAS * 1_436_582_285n);

  const quiet = fakeChain({ feeEstimate: 200_000_000n });
  await assert.rejects(approvalSponsor(quiet, LIMITS)([raw, DEPOSIT]), /at most/);
});

// A public RPC such as sepolia.base.org is load-balanced: a receipt from one
// backend says nothing about what the next request's backend has seen. Seen on
// Base Sepolia (toon-client#695): the approval, relayed straight after its
// funding's receipt, was refused "insufficient funds" by a backend a block
// behind — and the payer, funded, could not be served again.
const FAST = { ...LIMITS, visibleWithinMs: 1_000, pollIntervalMs: 1 };

test("waits until the RPC shows the funding before broadcasting the approval", async () => {
  const chain = fakeChain({ lag: 3 });
  const raw = await signedApproval();
  const hashes = await approvalSponsor(chain, FAST)([raw, DEPOSIT]);
  assert.equal(sent(chain).find((e) => e[0] === "sendRawTransaction")[1], raw);
  assert.equal(hashes.length, 2);
});

test("waits until the RPC shows the approval before sending the deposit", async () => {
  const chain = fakeChain({ balance: DEFAULT_MAX_APPROVAL_GAS * DEFAULT_MAX_FEE_PER_GAS, lag: 3 });
  await approvalSponsor(chain, FAST)([await signedApproval(), DEPOSIT]);
  assert.deepEqual(sent(chain).map((e) => e[0]), ["sendRawTransaction", "sendTransaction"]);
});

test("says so, naming what it waited for, when the RPC never shows the funding", async () => {
  const chain = fakeChain({ lag: 1_000_000 });
  await assert.rejects(
    approvalSponsor(chain, { ...FAST, visibleWithinMs: 20 })([await signedApproval(), DEPOSIT]),
    /funding .* landed, but the RPC did not show it/,
  );
});

test("a payer funded once whose approval never went out is served again, and not funded twice", async () => {
  const chain = fakeChain({ refuseRaw: 1 });
  const sponsor = approvalSponsor(chain, FAST);
  await assert.rejects(sponsor([await signedApproval(), DEPOSIT]), /insufficient funds/);
  assert.equal(fundings(chain).length, 1);
  // The funding is still with the payer; only the relay failed.
  await sponsor([await signedApproval(), DEPOSIT]);
  assert.equal(fundings(chain).length, 1);
  assert.equal(sent(chain).filter((e) => e[0] === "sendRawTransaction").length, 1);
});

test("still funds each sender at most once: a funded payer that has spent the funding is refused", async () => {
  const chain = fakeChain({ refuseRaw: 1 });
  const sponsor = approvalSponsor(chain, FAST);
  await assert.rejects(sponsor([await signedApproval(), DEPOSIT]), /insufficient funds/);
  chain.setBalance(PAYER.address, 0n);
  await assert.rejects(sponsor([await signedApproval(), DEPOSIT]), /sponsored already/);
  assert.equal(fundings(chain).length, 1);
});
