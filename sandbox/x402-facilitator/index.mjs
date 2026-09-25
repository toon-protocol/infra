// The sandbox's x402 facilitator (toon-protocol/infra#23, connector ADR 0074),
// and the devnet's.
//
// A stock facilitator, not a TOON one: it is the published `@x402/core` and
// `@x402/evm` packages, wired the way x402's own e2e facilitator wires them
// (x402 `e2e/facilitators/typescript/index.ts` at 0cb1a1f0), reduced to one
// scheme on one network — `batch-settlement`, on the local anvil
// (`eip155:31337`) by default, or on whatever `X402_NETWORK` names (the devnet
// runs it on Base Sepolia, `eip155:84532`). On anvil it works unmodified because
// `seed-x402.sh` put the contracts at the addresses `@x402/evm` hardcodes; on
// Base Sepolia x402 deployed them there itself.
//
// The devnet runs this rather than x402.org's hosted facilitator for the
// reasons in connector `docs/research/x402-devnet-facilitators.md`: the hosted
// one runs this same code, carries a "testing only" disclaimer and one shared
// signer, and has not been seen relaying a batch-settlement deposit.
//
// It relays a client's deposit and pays the gas for it, and that is all a
// TOON connector ever asks of it. It deliberately advertises NO
// `receiverAuthorizer`: ADR 0074 decision 5 — a receiverAuthorizer can refund
// a connector's earned-but-unclaimed value to the payer, so a connector
// always names its own. x402.org's hosted facilitator advertises none on Base
// Sepolia either, so a client written against it sees the same `/supported`.
//
// Configuration is environment only, read by config.mjs, which says what each
// variable means. With nothing set it is the sandbox's facilitator, so the
// compose service needs to set nothing; off the sandbox chain there is no
// default RPC and no default key, and it refuses to start without them.
import { readFileSync } from "node:fs";
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { createWalletClient, defineChain, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readConfig } from "./config.mjs";

const {
  network: NETWORK,
  chainId: CHAIN_ID,
  rpcUrl: RPC_URL,
  privateKey: PRIVATE_KEY,
  port: PORT,
} = readConfig(process.env, (path) => readFileSync(path, "utf8"));

const chain = defineChain({
  id: CHAIN_ID,
  name: NETWORK,
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

// Healthy means three things, each of which would otherwise surface only as a
// failed deposit: the RPC is the chain X402_NETWORK names (a Base Sepolia
// facilitator pointed at a mainnet RPC would advertise one network and settle
// on another), the settlement contract is on it (an anvil whose seed has not
// landed), and the gas payer holds gas to pay with (a devnet key nobody funded).
app.get("/health", async (_req, res) => {
  try {
    const rpcChainId = await client.getChainId();
    if (rpcChainId !== CHAIN_ID) {
      throw new Error(`EVM_RPC_URL serves chain ${rpcChainId}, not ${NETWORK}`);
    }
    const code = await client.getCode({ address: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" });
    if (!code || code === "0x") throw new Error("x402BatchSettlement is not on the chain");
    const gas = await client.getBalance({ address: account.address });
    if (gas === 0n) throw new Error(`the gas payer ${account.address} holds no ETH`);
    res.json({ status: "ok", network: NETWORK, facilitator: account.address, gasWei: gas.toString() });
  } catch (error) {
    res.status(503).json({ status: "unavailable", error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`x402 facilitator: batch-settlement on ${NETWORK} via ${RPC_URL}, port ${PORT}`);
  console.log(`  gas paid by ${account.address}; no receiverAuthorizer offered`);
});
