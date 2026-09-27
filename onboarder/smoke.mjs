// `make smoke-x402`: a gasless x402 batch-settlement deposit, end to end, on
// the sandbox's own chain and through the sandbox's own Onboarder
// (toon-protocol/infra#23, connector ADR 0074).
//
// `node onboarder/smoke.mjs --devnet` runs the same path on the devnet: Base
// Sepolia, through https://onboard.devnet.toonprotocol.dev, with devnet USDC
// from the faucet, into a channel whose receiver is the devnet RELAY
// connector's EVM settlement address, read off its own `GET /ilp`. That is
// infra#23's acceptance check. It spends no ETH of the caller's (the Onboarder
// pays) and leaves a 5 USDC channel of faucet money behind.
//
// A fresh wallet holding USDC and NO ETH signs one ERC-3009 authorization. The
// Onboarder verifies it, relays the deposit and pays the gas, and the
// channel the deposit creates is then read back off the chain. The channel's
// receiver and receiverAuthorizer are the HUB connector's EVM settlement
// address, as ADR 0074 decision 2 requires of a channel a connector admits.
// Every payload is built by the published `@x402/evm` client, so this is what
// a stock x402 client does, not a TOON reimplementation of it.
//
// It also RUNS the question ADR 0074's first prerequisite could only answer by
// reading: whether a deposit carrying a ZERO voucher is accepted on a fresh
// channel. x402's spec contradicts itself on it and its reference facilitators
// split (TypeScript and Python refuse, Go accepts). This Onboarder is the
// TypeScript one, so the smoke asserts the refusal, and fails loudly if a
// package bump changes the answer, since a client written against the old
// answer would then be wrong.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toClientEvmSigner } from "@x402/evm";
import {
  computeChannelId,
  createBatchSettlementEIP3009DepositPayload,
} from "@x402/evm/batch-settlement/client";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVNET = process.argv.includes("--devnet");

// x402 deploys this at the same address on every chain; seed-x402.sh put it
// there on anvil.
const BATCH_SETTLEMENT = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003";
const DEPOSIT = 5_000_000n; // 5 USDC
const WITHDRAW_DELAY = 86_400; // ADR 0074's default minimum: one day

// Where each target's chain, Onboarder, USDC and receiver come from.
const TARGET = DEVNET
  ? {
      name: "Base Sepolia (devnet)",
      chainId: 84532,
      rpcUrl: process.env.EVM_RPC_URL ?? "https://sepolia.base.org",
      onboarderUrl: process.env.ONBOARDER_URL ?? "https://onboard.devnet.toonprotocol.dev",
      // Circle's FiatToken v2.2, the devnet USDC since connector#1337. The
      // faucet is its one minter.
      usdc: "0x0C996d7c934c79a6255254875607Fe69df25C0E1",
      faucetUrl: process.env.FAUCET_URL ?? "https://faucet.devnet.toonprotocol.dev",
      connectorUrl: process.env.CONNECTOR_URL ?? "https://proxy.relay.devnet.toonprotocol.dev",
    }
  : {
      name: "TOON sandbox anvil",
      chainId: 31337,
      rpcUrl: process.env.EVM_RPC_URL ?? "http://localhost:8545",
      onboarderUrl: process.env.ONBOARDER_URL ?? "http://localhost:4022",
      // Written by scripts/seed-x402.sh; see there for why it is where it is.
      usdc: "0x0A867CA0442383c2A89951244B955AA19b615b58",
      // anvil-mnemonic index 21, the FiatToken's minter.
      minterKey: "0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b",
    };
const NETWORK = `eip155:${TARGET.chainId}`;
const RPC_URL = TARGET.rpcUrl;
const ONBOARDER_URL = TARGET.onboarderUrl;
const USDC = TARGET.usdc;

const chain = defineChain({
  id: TARGET.chainId,
  name: TARGET.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const chainClient = createPublicClient({ chain, transport: http(RPC_URL) });
const usdcAbi = parseAbi([
  "function mint(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const settlementAbi = parseAbi([
  "function channels(bytes32) view returns (uint128 balance, uint128 totalClaimed)",
  "function getChannelId((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)) view returns (bytes32)",
]);

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function onboarder(path, body) {
  const res = await fetch(`${ONBOARDER_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// The receiving connector's EVM settlement address. On the sandbox, the hub's,
// from its committed throwaway key. On the devnet, the relay's, as its own
// `GET /ilp` publishes it for this chain and this token.
async function receiverAddress() {
  if (!DEVNET) {
    const hubKey = readFileSync(
      join(HERE, "..", "sandbox", "keys", "toon", "relay-connector", "settlement.key"),
      "utf8",
    ).trim();
    return privateKeyToAccount(`0x${hubKey.replace(/^0x/, "")}`).address;
  }
  const self = await fetch(`${TARGET.connectorUrl}/ilp`).then((res) => res.json());
  const evm = self.settlements?.find(
    (s) => s.chain === `evm:${TARGET.chainId}` && s.tokenAddress?.toLowerCase() === USDC.toLowerCase(),
  );
  if (!evm) throw new Error(`${TARGET.connectorUrl}/ilp publishes no evm:${TARGET.chainId} settlement in ${USDC}`);
  return getAddress(evm.settlementAddress);
}
const hub = await receiverAddress();
console.log(`${TARGET.name}: Onboarder ${ONBOARDER_URL}, receiver ${hub}`);

// Two deposits' worth of USDC for a fresh payer. The sandbox mints it; the
// devnet asks the faucet, which drips far more, then waits for it to land.
async function fund(address) {
  if (!DEVNET) {
    const minter = createWalletClient({ account: privateKeyToAccount(TARGET.minterKey), chain, transport: http(RPC_URL) });
    await chainClient.waitForTransactionReceipt({
      hash: await minter.writeContract({ address: USDC, abi: usdcAbi, functionName: "mint", args: [address, 2n * DEPOSIT] }),
    });
    return;
  }
  const res = await fetch(`${TARGET.faucetUrl}/api/base-sepolia/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!res.ok) throw new Error(`faucet: HTTP ${res.status} ${await res.text()}`);
  for (let i = 0; i < 40; i++) {
    if ((await chainClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [address] })) >= 2n * DEPOSIT) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`faucet: ${address} never received ${2n * DEPOSIT} µUSDC`);
}

// 1. /supported offers batch-settlement here, and offers no receiverAuthorizer.
const supported = await onboarder("/supported");
const kind = supported.kinds.find((k) => k.scheme === "batch-settlement" && k.network === NETWORK);
check(`the Onboarder offers batch-settlement on ${NETWORK}`, Boolean(kind));
check(
  "the Onboarder offers no receiverAuthorizer (ADR 0074 decision 5)",
  kind && !kind.extra?.receiverAuthorizer,
  JSON.stringify(kind?.extra ?? null),
);

// 2. A fresh payer: USDC, and not one wei of ETH.
const payer = privateKeyToAccount(generatePrivateKey());
await fund(payer.address);
check("the payer holds no ETH", (await chainClient.getBalance({ address: payer.address })) === 0n);

const signer = toClientEvmSigner(payer, chainClient);
const requirements = {
  scheme: "batch-settlement",
  network: NETWORK,
  amount: "1",
  asset: USDC,
  payTo: hub,
  maxTimeoutSeconds: 300,
  extra: { receiverAuthorizer: hub, withdrawDelay: WITHDRAW_DELAY, name: "USDC", version: "2" },
};
const configFor = (salt) => ({
  payer: payer.address,
  payerAuthorizer: payer.address,
  receiver: hub,
  receiverAuthorizer: hub,
  token: USDC,
  withdrawDelay: WITHDRAW_DELAY,
  salt,
});
const deposit = (config, maxClaimable) =>
  createBatchSettlementEIP3009DepositPayload(signer, 2, requirements, config, DEPOSIT.toString(), maxClaimable);

// 3. A zero voucher on a fresh channel's deposit: refused by this Onboarder.
const zeroConfig = configFor(`0x${"00".repeat(31)}01`);
const zero = await deposit(zeroConfig, "0");
const zeroVerdict = await onboarder("/verify", {
  paymentPayload: { x402Version: 2, accepted: requirements, ...zero },
  paymentRequirements: requirements,
});
check(
  "a zero voucher on a fresh deposit is refused (ADR 0074 prerequisite 1, now run)",
  zeroVerdict.isValid === false,
  zeroVerdict.invalidReason ?? "accepted",
);

// 4. A one-unit voucher: verified, settled, and the channel exists on chain.
const config = configFor(`0x${"00".repeat(31)}02`);
const channelId = computeChannelId(config, NETWORK);
check(
  "the client's channelId is the contract's getChannelId",
  channelId === (await chainClient.readContract({ address: BATCH_SETTLEMENT, abi: settlementAbi, functionName: "getChannelId", args: [config] })),
  channelId,
);
const one = await deposit(config, "1");
const body = { paymentPayload: { x402Version: 2, accepted: requirements, ...one }, paymentRequirements: requirements };
const verdict = await onboarder("/verify", body);
check("a one-unit voucher on a fresh deposit verifies", verdict.isValid === true, [verdict.invalidReason, verdict.invalidMessage].filter(Boolean).join(": "));
const settled = await onboarder("/settle", body);
check("the Onboarder settles the deposit", settled.success === true, settled.transaction ?? settled.errorReason);

const [balance, totalClaimed] = await chainClient.readContract({
  address: BATCH_SETTLEMENT,
  abi: settlementAbi,
  functionName: "channels",
  args: [channelId],
});
check("the channel holds the deposit on chain", balance === DEPOSIT, `balance ${balance}`);
check("nothing is claimed yet", totalClaimed === 0n, `totalClaimed ${totalClaimed}`);
check("the payer still holds no ETH", (await chainClient.getBalance({ address: payer.address })) === 0n);

// 5. Solana, sandbox only: payment-channels is loaded, at its canonical id, and
// executable. (Solana has no Onboarder, so the devnet run has nothing to add.)
if (!DEVNET) {
  const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
  const program = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: ["CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX", { encoding: "base64" }],
    }),
  }).then((res) => res.json());
  check(
    "payment-channels (CHNLx…) is an executable program on the validator",
    program.result?.value?.executable === true,
    program.error?.message ?? "",
  );
}

console.log(failures === 0 ? "\nsmoke-x402: all checks passed" : `\nsmoke-x402: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
