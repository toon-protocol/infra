// The facilitator's configuration, read from the environment once at start.
//
// With nothing set it is the SANDBOX's facilitator: anvil, chain 31337, and
// the key seed-x402.sh funds. Pointed at a real network (the devnet runs it
// against Base Sepolia, toon-protocol/infra#23), it FAILS CLOSED: off the
// sandbox chain there is no default RPC and no default key, because a
// facilitator that fell back to anvil's public test key would be signing with a
// key the whole world holds, and one that fell back to `http://anvil:8545`
// would advertise a network it cannot reach.
//
//   X402_NETWORK                      CAIP-2, eip155:<chain id>; default eip155:31337
//   EVM_RPC_URL                       default http://anvil:8545, sandbox only
//   FACILITATOR_EVM_PRIVATE_KEY       the gas payer's key, 0x-hex, or
//   FACILITATOR_EVM_PRIVATE_KEY_FILE  a file holding it (preferred off the sandbox:
//                                     a mounted file stays out of `docker inspect`)
//   PORT                              default 4022, x402's own facilitator default
//
// Pure — `readFile` is passed in — so config.test.mjs needs no filesystem.

export const SANDBOX_NETWORK = "eip155:31337";
export const SANDBOX_RPC_URL = "http://anvil:8545";
// anvil-mnemonic index 22, 0x08135Da0A343E492FA2d4282F2AE34c6c5CC1BbE, which
// scripts/seed-x402.sh funds. A public test key: valid on the sandbox only.
export const SANDBOX_KEY = "0x224b7eb7449992aac96d631d9677f7bf5888245eef6d6eeda31e62d2f29a83e4";

export function readConfig(env, readFile) {
  const network = env.X402_NETWORK ?? SANDBOX_NETWORK;
  const match = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (!match) {
    throw new Error(`X402_NETWORK must be eip155:<chain id>, not ${JSON.stringify(network)}`);
  }
  const sandbox = network === SANDBOX_NETWORK;

  const rpcUrl = env.EVM_RPC_URL ?? (sandbox ? SANDBOX_RPC_URL : undefined);
  if (!rpcUrl) {
    throw new Error(`EVM_RPC_URL must be set for ${network}; only the sandbox defaults it`);
  }

  if (env.FACILITATOR_EVM_PRIVATE_KEY && env.FACILITATOR_EVM_PRIVATE_KEY_FILE) {
    throw new Error("set FACILITATOR_EVM_PRIVATE_KEY or FACILITATOR_EVM_PRIVATE_KEY_FILE, not both");
  }
  let key = env.FACILITATOR_EVM_PRIVATE_KEY_FILE
    ? String(readFile(env.FACILITATOR_EVM_PRIVATE_KEY_FILE)).trim()
    : env.FACILITATOR_EVM_PRIVATE_KEY;
  if (!key) {
    if (!sandbox) {
      throw new Error(
        `FACILITATOR_EVM_PRIVATE_KEY or FACILITATOR_EVM_PRIVATE_KEY_FILE must be set for ${network}; ` +
          "only the sandbox has a default key",
      );
    }
    key = SANDBOX_KEY;
  }
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("the facilitator key must be 32 bytes of hex");
  }

  return {
    network,
    chainId: Number(match[1]),
    rpcUrl,
    privateKey: key,
    port: Number(env.PORT ?? 4022),
  };
}
