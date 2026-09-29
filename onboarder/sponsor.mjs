// The ERC-20 approval sponsor: what lets a wallet holding a token WITHOUT
// ERC-3009 and no ETH open an x402 batch-settlement channel (x402's
// `erc20ApprovalGasSponsoring` extension; toon-protocol/toon-client#695).
//
// Such a deposit goes through Permit2, which can only move the token once the
// payer has sent `approve(Permit2, …)`: a transaction of its own, and so gas
// the payer does not have. The client therefore signs that approval without
// sending it, and the facilitator is asked to put it on chain before the
// deposit. `@x402/evm` checks the signed approval's target, selector, spender
// and sender, then hands this signer `[signedApproval, deposit]` to execute. It
// ships no signer of its own.
//
// Sequentially, then:
//   1. fund the approval's sender with exactly what it lacks for the approval's
//      worst-case cost (its fee, plus the L1 data fee on an OP-stack chain such
//      as Base), and wait for that to land;
//   2. broadcast the payer's signed approval as-is, and wait for it;
//   3. send the deposit from the Onboarder's own key, and return both hashes.
//
// x402.org's hosted facilitator advertises this extension and was seen
// broadcasting the approval WITHOUT step 1 (connector ADR 0074, prerequisite
// 2), which fails for exactly the wallet the extension exists for.
//
// Step 1 gives ETH to a stranger before anything it paid for exists, so it is
// guarded. Funding is refused, before anything is sent, unless the approval:
//   - is for a token on `sponsoredTokens` (the tokens the operator's connectors
//     are paid in; none configured sponsors nothing), so a throwaway token
//     cannot be used;
//   - is for this chain, at the sender's next nonce, and succeeds when
//     simulated, so it can land once funded;
//   - asks for at most `maxApprovalGas` gas, at a fee no higher than the larger
//     of `maxFeePerGas` and twice this Onboarder's own current estimate;
//   - comes from a sender this Onboarder has never funded before. A payer
//     approves Permit2 once, for the maximum. The sender is claimed before the
//     first await, so concurrent requests cannot each be funded.
// What is left exposed is at most one approval's fee per fresh wallet holding
// a sponsored token, and the edge rate-limits `/settle`.
import { decodeFunctionResult, parseAbi, parseTransaction, recoverTransactionAddress } from "viem";

// x402's own client signs the approval with a 70,000 gas limit and, when it
// cannot estimate fees, a 1 gwei cap (`ERC20_APPROVE_GAS_LIMIT`,
// `DEFAULT_MAX_FEE_PER_GAS` in @x402/evm 2.27.0). The defaults admit exactly that.
export const DEFAULT_MAX_APPROVAL_GAS = 70_000n;
export const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000n;

/** The OP-stack L1 fee oracle, at the same predeploy address on every OP chain. */
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const APPROVE_ABI = parseAbi(["function approve(address,uint256) returns (bool)"]);

/**
 * @param chain  what the signer needs of the chain — a viem wallet client
 *   extended with public actions has all of it: `estimateFeesPerGas`,
 *   `getBalance`, `getTransactionCount`, `getCode`, `readContract`, `call`,
 *   `sendTransaction` (from the Onboarder's key), `sendRawTransaction` and
 *   `waitForTransactionReceipt`.
 * @param limits `{ chainId, sponsoredTokens, maxApprovalGas, maxFeePerGas }`.
 * @returns x402's `sendTransactions(transactions)`.
 */
export function approvalSponsor(chain, limits) {
  const chainId = limits.chainId;
  const sponsored = new Set((limits.sponsoredTokens ?? []).map((t) => t.toLowerCase()));
  const maxGas = limits.maxApprovalGas ?? DEFAULT_MAX_APPROVAL_GAS;
  const maxFee = limits.maxFeePerGas ?? DEFAULT_MAX_FEE_PER_GAS;
  /** Senders funded, or being funded: each at most once. */
  const funded = new Set();

  async function landed(hash, what) {
    const receipt = await chain.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what} ${hash} reverted`);
  }

  async function l1Fee(raw) {
    const code = await chain.getCode({ address: GAS_PRICE_ORACLE });
    if (!code || code === "0x") return 0n;
    const fee = await chain.readContract({
      address: GAS_PRICE_ORACLE,
      abi: ORACLE_ABI,
      functionName: "getL1Fee",
      args: [raw],
    });
    // The oracle prices the next block; a quarter more covers a moving L1.
    return (fee * 5n) / 4n;
  }

  /** Every check that needs no ETH to have moved, in order of cost. */
  async function vet(raw, tx, sender) {
    const next = await chain.getTransactionCount({ address: sender, blockTag: "pending" });
    if (tx.nonce !== next) {
      throw new Error(`a sponsored approval must use ${sender}'s next nonce, ${next}, not ${tx.nonce}`);
    }
    let ok;
    try {
      const result = await chain.call({ account: sender, to: tx.to, data: tx.data });
      ok = decodeFunctionResult({ abi: APPROVE_ABI, functionName: "approve", data: result.data });
    } catch (error) {
      throw new Error(`the approval would not succeed: ${error instanceof Error ? error.message : error}`);
    }
    if (ok !== true) throw new Error("the approval would not succeed: approve returned false");
  }

  async function sponsorAndSend(raw) {
    const tx = parseTransaction(raw);
    const gas = tx.gas;
    const fee = tx.maxFeePerGas ?? tx.gasPrice;
    if (gas === undefined || fee === undefined || tx.nonce === undefined) {
      throw new Error("a sponsored approval must name its gas limit, fee and nonce");
    }
    if (tx.chainId !== chainId) {
      throw new Error(`a sponsored approval must be for chain ${chainId}, not ${tx.chainId}`);
    }
    if (!tx.to || !sponsored.has(tx.to.toLowerCase())) {
      throw new Error(`this Onboarder sponsors no approval of ${tx.to}`);
    }
    if (gas > maxGas) {
      throw new Error(`a sponsored approval may use at most ${maxGas} gas, not ${gas}`);
    }
    if (tx.value !== undefined && tx.value !== 0n) {
      throw new Error("a sponsored approval moves no ETH");
    }

    const sender = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
    // Claimed with no await between the check and the add, so a concurrent
    // request for the same sender is refused rather than funded again.
    if (funded.has(sender)) {
      throw new Error(`${sender} has had its Permit2 approval sponsored already`);
    }
    funded.add(sender);
    try {
      const estimate = (await chain.estimateFeesPerGas()).maxFeePerGas;
      const allowed = 2n * estimate > maxFee ? 2n * estimate : maxFee;
      if (fee > allowed) {
        throw new Error(`a sponsored approval may pay at most ${allowed} wei per gas, not ${fee}`);
      }
      await vet(raw, tx, sender);
    } catch (error) {
      // Nothing was sent: the sender may come back with a better approval.
      funded.delete(sender);
      throw error;
    }

    const needed = gas * fee + (await l1Fee(raw));
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
