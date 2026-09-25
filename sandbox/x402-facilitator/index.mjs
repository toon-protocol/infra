// The sandbox's x402 facilitator (toon-protocol/infra#23, connector ADR 0074).
//
// A stock facilitator, not a TOON one: it is the published `@x402/core` and
// `@x402/evm` packages, wired the way x402's own e2e facilitator wires them
// (x402 `e2e/facilitators/typescript/index.ts` at 0cb1a1f0), reduced to the one
// scheme and the one network the sandbox needs — `batch-settlement` on the
// local anvil, `eip155:31337`. It works unmodified because `seed-x402.sh` put
// the batch-settlement contracts at the addresses `@x402/evm` hardcodes.
//
// It relays a client's deposit and pays the gas for it, and that is all a
// TOON connector ever asks of it. It deliberately advertises NO
// `receiverAuthorizer`: ADR 0074 decision 5 — a receiverAuthorizer can refund
// a connector's earned-but-unclaimed value to the payer, so a connector
// always names its own. x402.org's hosted facilitator advertises none on Base
// Sepolia either, so a client written against it sees the same `/supported`.
//
// Configuration is environment only, and every variable has the sandbox's
// value as its default so the compose service needs to set nothing:
//   EVM_RPC_URL                    anvil, as the compose network sees it
//   FACILITATOR_EVM_PRIVATE_KEY    anvil-mnemonic index 22 — pays the gas; no
//                                  role. seed-x402.sh funds it.
//   PORT                           4022, x402's own facilitator default
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { createWalletClient, defineChain, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const NETWORK = "eip155:31337";
const RPC_URL = process.env.EVM_RPC_URL ?? "http://anvil:8545";
const PORT = Number(process.env.PORT ?? 4022);
// anvil-mnemonic index 22, 0x08135Da0A343E492FA2d4282F2AE34c6c5CC1BbE.
const PRIVATE_KEY =
  process.env.FACILITATOR_EVM_PRIVATE_KEY ??
  "0x224b7eb7449992aac96d631d9677f7bf5888245eef6d6eeda31e62d2f29a83e4";

const chain = defineChain({
  id: 31337,
  name: "TOON sandbox anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(PRIVATE_KEY);
const client = createWalletClient({ account, chain, transport: http(RPC_URL) }).extend(
  publicActions,
);

const signer = toFacilitatorEvmSigner({
  address: account.address,
  readContract: (args) => client.readContract({ ...args, args: args.args ?? [] }),
  verifyTypedData: (args) => client.verifyTypedData(args),
  writeContract: (args) => client.writeContract({ ...args, args: args.args ?? [] }),
  sendTransaction: (args) => client.sendTransaction(args),
  waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
  getCode: (args) => client.getCode(args),
});

// No second argument: no receiverAuthorizer is offered (see the header).
const facilitator = new x402Facilitator().register(
  NETWORK,
  new BatchSettlementEvmScheme(signer),
);

const app = express();
app.use(express.json({ limit: "1mb" }));

// POST /verify and POST /settle take `{ paymentPayload, paymentRequirements }`
// (x402 v2 §7). A failed check is a 200 carrying `isValid: false` /
// `success: false` with a reason, as the spec has it; only a request this
// service cannot even read is a 4xx, and only a fault of its own a 500.
for (const [path, run] of [
  ["/verify", (p, r) => facilitator.verify(p, r)],
  ["/settle", (p, r) => facilitator.settle(p, r)],
]) {
  app.post(path, async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body ?? {};
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    }
    try {
      res.json(await run(paymentPayload, paymentRequirements));
    } catch (error) {
      console.error(`${path} failed:`, error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));

// Healthy means the chain answers AND the settlement contract is on it: a
// facilitator in front of an anvil whose seed has not landed would advertise
// batch-settlement and then fail every deposit.
app.get("/health", async (_req, res) => {
  try {
    const code = await client.getCode({ address: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" });
    if (!code || code === "0x") throw new Error("x402BatchSettlement is not on the chain");
    res.json({ status: "ok", network: NETWORK, facilitator: account.address });
  } catch (error) {
    res.status(503).json({ status: "unavailable", error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`x402 facilitator: batch-settlement on ${NETWORK} via ${RPC_URL}, port ${PORT}`);
  console.log(`  gas paid by ${account.address}; no receiverAuthorizer offered`);
});
