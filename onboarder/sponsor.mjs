// The ERC-20 approval sponsor: what lets a wallet holding a token WITHOUT
// ERC-3009 and no ETH open an x402 batch-settlement channel (x402's
// `erc20ApprovalGasSponsoring` extension).
//
// Such a deposit goes through Permit2, which can only move the token once the
// payer has sent `approve(Permit2, …)` — a transaction of its own, and so gas
// the payer does not have. The client therefore signs that approval without
// sending it, and the facilitator is asked to put it on chain before the
// deposit. `@x402/evm` validates the signed approval (its target, its selector,
// its spender and its sender) and then hands this signer the pair
// `[signedApproval, deposit]` to execute. It ships no signer of its own.
//
// Sequentially, then:
//   1. fund the approval's sender with exactly what it lacks for the approval's
//      worst-case fee, `gas × maxFeePerGas`, and wait for that to land;
//   2. broadcast the payer's signed approval as-is, and wait for it;
//   3. send the deposit from the Onboarder's own key, and return both hashes.
//
// x402.org's hosted facilitator advertises this extension and was seen
// broadcasting the approval WITHOUT step 1 (connector ADR 0074, prerequisite
// 2), which fails for exactly the wallet the extension exists for. Step 1 is
// the point.
//
// What it gives away is bounded: an approval asking for more than
// `maxApprovalGas` gas, or a fee above both `maxFeePerGas` and twice what this
// Onboarder itself estimates the chain's fee to be now, is refused before
// anything is sent. So one sponsored approval costs at most the gas limit times
// the larger of the two (0.00007 ETH at the defaults on a quiet chain), and the
// edge rate-limits `/settle`. The estimate is what keeps an honest client —
// which estimates the same way — from being refused by a flat cap when fees
// are up.
import { parseTransaction, recoverTransactionAddress } from "viem";

// x402's own client signs the approval with a 70,000 gas limit and, when it
// cannot estimate fees, a 1 gwei cap (`ERC20_APPROVE_GAS_LIMIT`,
// `DEFAULT_MAX_FEE_PER_GAS` in @x402/evm 2.27.0). The defaults admit exactly that.
export const DEFAULT_MAX_APPROVAL_GAS = 70_000n;
export const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000n;

/**
 * @param chain  what the signer needs of the chain: `estimateFeesPerGas`, `getBalance`,
 *   `sendTransaction` (from the Onboarder's key), `sendRawTransaction` and
 *   `waitForTransactionReceipt` — a viem wallet client extended with public
 *   actions has all four.
 * @param limits `{ maxApprovalGas, maxFeePerGas }`, both bigint.
 * @returns x402's `sendTransactions(transactions)`.
 */
export function approvalSponsor(chain, limits = {}) {
  const maxGas = limits.maxApprovalGas ?? DEFAULT_MAX_APPROVAL_GAS;
  const maxFee = limits.maxFeePerGas ?? DEFAULT_MAX_FEE_PER_GAS;

  async function landed(hash, what) {
    const receipt = await chain.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what} ${hash} reverted`);
  }

  async function sponsorAndSend(raw) {
    const tx = parseTransaction(raw);
    const gas = tx.gas;
    const fee = tx.maxFeePerGas ?? tx.gasPrice;
    if (gas === undefined || fee === undefined) {
      throw new Error("a sponsored approval must name its gas limit and fee");
    }
    if (gas > maxGas) {
      throw new Error(`a sponsored approval may use at most ${maxGas} gas, not ${gas}`);
    }
    const estimate = (await chain.estimateFeesPerGas()).maxFeePerGas;
    const allowed = 2n * estimate > maxFee ? 2n * estimate : maxFee;
    if (fee > allowed) {
      throw new Error(`a sponsored approval may pay at most ${allowed} wei per gas, not ${fee}`);
    }
    if (tx.value !== undefined && tx.value !== 0n) {
      throw new Error("a sponsored approval moves no ETH");
    }
    const sender = await recoverTransactionAddress({ serializedTransaction: raw });
    const needed = gas * fee;
    const held = await chain.getBalance({ address: sender });
    if (held < needed) {
      const funding = await chain.sendTransaction({ to: sender, value: needed - held });
      await landed(funding, "funding the approval's gas");
    }
    const hash = await chain.sendRawTransaction({ serializedTransaction: raw });
    await landed(hash, "the sponsored approval");
    return hash;
  }

  return async function sendTransactions(transactions) {
    const hashes = [];
    for (const [i, request] of transactions.entries()) {
      if (typeof request === "string") {
        hashes.push(await sponsorAndSend(request));
        continue;
      }
      const hash = await chain.sendTransaction({
        to: request.to,
        data: request.data,
        ...(request.gas !== undefined ? { gas: request.gas } : {}),
      });
      // The caller waits on the last one itself; anything before it must land
      // first, or the next would be simulated against a chain without it.
      if (i < transactions.length - 1) await landed(hash, "transaction");
      hashes.push(hash);
    }
    return hashes;
  };
}
