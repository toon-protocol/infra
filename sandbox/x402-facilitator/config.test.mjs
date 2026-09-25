// The facilitator's configuration: the sandbox's values by default, and a real
// network only when every value that must not default is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, SANDBOX_KEY } from "./config.mjs";

const KEY = `0x${"ab".repeat(32)}`;
const noFiles = () => {
  throw new Error("no file expected");
};

test("with nothing set it is the sandbox: anvil, chain 31337, the funded default key", () => {
  const config = readConfig({}, noFiles);
  assert.equal(config.network, "eip155:31337");
  assert.equal(config.chainId, 31337);
  assert.equal(config.rpcUrl, "http://anvil:8545");
  assert.equal(config.privateKey, SANDBOX_KEY);
  assert.equal(config.port, 4022);
});

test("a real network is read from X402_NETWORK, with its chain id", () => {
  const config = readConfig(
    { X402_NETWORK: "eip155:84532", EVM_RPC_URL: "https://sepolia.base.org", FACILITATOR_EVM_PRIVATE_KEY: KEY },
    noFiles,
  );
  assert.equal(config.network, "eip155:84532");
  assert.equal(config.chainId, 84532);
  assert.equal(config.rpcUrl, "https://sepolia.base.org");
  assert.equal(config.privateKey, KEY);
});

test("off the sandbox chain the anvil key is never a default", () => {
  assert.throws(
    () => readConfig({ X402_NETWORK: "eip155:84532", EVM_RPC_URL: "https://sepolia.base.org" }, noFiles),
    /FACILITATOR_EVM_PRIVATE_KEY/,
  );
});

test("off the sandbox chain the anvil RPC is never a default", () => {
  assert.throws(
    () => readConfig({ X402_NETWORK: "eip155:84532", FACILITATOR_EVM_PRIVATE_KEY: KEY }, noFiles),
    /EVM_RPC_URL/,
  );
});

test("a key is read from a file, trimmed, with or without its 0x", () => {
  const files = { "/run/secrets/gas.key": `${"cd".repeat(32)}\n` };
  const config = readConfig(
    {
      X402_NETWORK: "eip155:84532",
      EVM_RPC_URL: "https://sepolia.base.org",
      FACILITATOR_EVM_PRIVATE_KEY_FILE: "/run/secrets/gas.key",
    },
    (path) => files[path],
  );
  assert.equal(config.privateKey, `0x${"cd".repeat(32)}`);
});

test("a key given twice is refused rather than one silently winning", () => {
  assert.throws(
    () =>
      readConfig(
        { FACILITATOR_EVM_PRIVATE_KEY: KEY, FACILITATOR_EVM_PRIVATE_KEY_FILE: "/k" },
        () => KEY,
      ),
    /both/,
  );
});

test("a key that is not 32 bytes of hex is refused", () => {
  assert.throws(() => readConfig({ FACILITATOR_EVM_PRIVATE_KEY: "0x1234" }, noFiles), /32 bytes/);
});

test("a network that is not eip155:<chain id> is refused", () => {
  for (const network of ["base-sepolia", "eip155:", "eip155:abc", "solana:devnet"]) {
    assert.throws(() => readConfig({ X402_NETWORK: network }, noFiles), /eip155:<chain id>/, network);
  }
});
