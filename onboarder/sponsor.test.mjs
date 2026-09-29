// The ERC-20 approval sponsor: it funds the approval's sender with exactly what
// it lacks, broadcasts the approval as signed, waits, then sends the deposit —
// and refuses an approval that would cost more than its limits allow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, maxUint256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approvalSponsor, DEFAULT_MAX_APPROVAL_GAS, DEFAULT_MAX_FEE_PER_GAS } from "./sponsor.mjs";

const PAYER = privateKeyToAccount(`0x${"11".repeat(32)}`);
const TOKEN = "0x49beE1Bca5d15Fb0963117923403F9498119a9Ce";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const DEPOSIT = { to: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003", data: "0xdeadbeef" };

function signedApproval(overrides = {}) {
  return PAYER.signTransaction({
    chainId: 84532,
    to: TOKEN,
    data: encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      args: [PERMIT2, maxUint256],
    }),
    nonce: 0,
    gas: DEFAULT_MAX_APPROVAL_GAS,
    maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: 100_000_000n,
    type: "eip1559",
    ...overrides,
  });
}

/** A chain that records what was sent, in order. */
function fakeChain({ balance = 0n, reverts = [], feeEstimate = 200_000_000n } = {}) {
  const log = [];
  let n = 0;
  const hash = () => `0x${(++n).toString(16).padStart(64, "0")}`;
  return {
    log,
    estimateFeesPerGas: async () => ({ maxFeePerGas: feeEstimate, maxPriorityFeePerGas: 1n }),
    getBalance: async ({ address }) => {
      log.push(["getBalance", address]);
      return balance;
    },
    sendTransaction: async (args) => {
      const h = hash();
      log.push(["sendTransaction", args, h]);
      return h;
    },
    sendRawTransaction: async ({ serializedTransaction }) => {
      const h = hash();
      log.push(["sendRawTransaction", serializedTransaction, h]);
      return h;
    },
    waitForTransactionReceipt: async ({ hash: h }) => {
      log.push(["wait", h]);
      return { status: reverts.includes(h) ? "reverted" : "success" };
    },
  };
}

test("funds a payer holding no ETH with the approval's worst-case fee, then broadcasts it, then deposits", async () => {
  const chain = fakeChain();
  const raw = await signedApproval();
  const hashes = await approvalSponsor(chain)([raw, DEPOSIT]);

  const kinds = chain.log.map((e) => e[0]);
  assert.deepEqual(kinds, [
    "getBalance",
    "sendTransaction", // the funding
    "wait",
    "sendRawTransaction", // the payer's own approval, as signed
    "wait",
    "sendTransaction", // the deposit
  ]);
  const funding = chain.log[1][1];
  assert.equal(funding.to, PAYER.address);
  assert.equal(funding.value, DEFAULT_MAX_APPROVAL_GAS * DEFAULT_MAX_FEE_PER_GAS);
  assert.equal(chain.log[3][1], raw);
  assert.deepEqual(chain.log[5][1], { to: DEPOSIT.to, data: DEPOSIT.data });
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], chain.log[3][2]);
  assert.equal(hashes[1], chain.log[5][2]);
});

test("funds only the shortfall, and nothing when the payer already holds enough", async () => {
  const need = DEFAULT_MAX_APPROVAL_GAS * DEFAULT_MAX_FEE_PER_GAS;
  const partial = fakeChain({ balance: need - 5n });
  await approvalSponsor(partial)([await signedApproval(), DEPOSIT]);
  assert.equal(partial.log[1][1].value, 5n);

  const enough = fakeChain({ balance: need });
  await approvalSponsor(enough)([await signedApproval(), DEPOSIT]);
  assert.deepEqual(
    enough.log.map((e) => e[0]),
    ["getBalance", "sendRawTransaction", "wait", "sendTransaction"],
  );
});

test("refuses, sending nothing, an approval asking for more gas or a higher fee than allowed", async () => {
  for (const overrides of [
    { gas: DEFAULT_MAX_APPROVAL_GAS + 1n },
    { maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS + 1n },
  ]) {
    const chain = fakeChain();
    await assert.rejects(approvalSponsor(chain)([await signedApproval(overrides), DEPOSIT]), /at most/);
    assert.equal(chain.log.filter((e) => e[0] !== "getBalance").length, 0);
  }
});

test("refuses an approval that also moves ETH", async () => {
  const chain = fakeChain();
  await assert.rejects(approvalSponsor(chain)([await signedApproval({ value: 1n }), DEPOSIT]), /moves no ETH/);
  assert.equal(chain.log.length, 0);
});

test("stops before the deposit when the approval reverts", async () => {
  const chain = fakeChain();
  // hashes run 1 (funding), 2 (approval): make the approval revert.
  const reverting = { ...chain, waitForTransactionReceipt: async ({ hash }) => ({ status: hash.endsWith("2") ? "reverted" : "success" }) };
  await assert.rejects(approvalSponsor(reverting)([await signedApproval(), DEPOSIT]), /approval .* reverted/);
  assert.equal(chain.log.filter((e) => e[0] === "sendTransaction").length, 1); // the funding only
});

test("honours configured limits", async () => {
  const chain = fakeChain();
  const raw = await signedApproval({ gas: 90_000n });
  await approvalSponsor(chain, { maxApprovalGas: 90_000n })([raw, DEPOSIT]);
  assert.equal(chain.log[1][1].value, 90_000n * DEFAULT_MAX_FEE_PER_GAS);
});

test("admits a fee above the configured cap while the chain's own fee estimate is that high", async () => {
  // A 1.4 gwei fee when the chain itself estimates 1.2 gwei is an honest one.
  const chain = fakeChain({ feeEstimate: 1_200_000_000n });
  const raw = await signedApproval({ maxFeePerGas: 1_436_582_285n });
  await approvalSponsor(chain)([raw, DEPOSIT]);
  assert.equal(chain.log[1][1].value, DEFAULT_MAX_APPROVAL_GAS * 1_436_582_285n);

  const quiet = fakeChain({ feeEstimate: 200_000_000n });
  await assert.rejects(approvalSponsor(quiet)([raw, DEPOSIT]), /at most/);
});
