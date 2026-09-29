// An x402BatchSettlement channel, read off anvil (infra#42).
//
// The EVM half of scripts/lib/solana-channel.mjs: the contract sits at its
// canonical address (scripts/seed-x402.sh), and `channels(id)` answers what
// the channel holds and what has been claimed from it. The open-peerings job
// and the smokes share it.
import { Interface } from 'ethers';

export const X402_BATCH_SETTLEMENT = '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
const X402 = new Interface(['function channels(bytes32) view returns (uint128 balance, uint128 totalClaimed)']);

/** The channel `id` as `{ balance, totalClaimed }`; an unknown id reads as zeros. */
export async function readEvmChannel(rpcUrl, id) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: X402_BATCH_SETTLEMENT, data: X402.encodeFunctionData('channels', [id]) }, 'latest'] }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(`channels(${id}) -> ${error.message}`);
  const [balance, totalClaimed] = X402.decodeFunctionResult('channels', result);
  return { balance, totalClaimed };
}
