// A payment-channels Channel account, read off the validator (infra#39).
//
// Every Solana channel in the sandbox lives in solana-foundation's
// payment-channels (connector ADR 0075). Its Channel account is 256 bytes:
// status at 3 (0 = Open), the deposit a u64 at 12, then the payer, the payee,
// the authorized signer and the mint as 32-byte keys at 88, 120, 152 and 184 —
// the offsets connector_settlement_solana::batch::wire reads. The one reader
// the open-peerings job and the smokes share, so the layout lives in one place.
// Dependency-free: the open-peerings job imports it inside the sandbox image.

export const PAYMENT_CHANNELS_PROGRAM = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';
export const USDC_MINT = 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58enc(buf) {
  let v = 0n;
  for (const b of buf) v = v * 256n + BigInt(b);
  let out = '';
  while (v > 0n) { out = B58[Number(v % 58n)] + out; v /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** The account at `account` as `{ owner, size, status, deposit, payer, payee, authorizedSigner, mint }`, or null. */
export async function readSolanaChannel(rpcUrl, account) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [account, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  const { result } = await res.json();
  if (!result?.value) return null;
  const data = Buffer.from(result.value.data[0], 'base64');
  if (data.length !== 256) return { owner: result.value.owner, size: data.length };
  return {
    owner: result.value.owner,
    size: data.length,
    status: data[3],
    deposit: data.readBigUInt64LE(12),
    payer: b58enc(data.subarray(88, 120)),
    payee: b58enc(data.subarray(120, 152)),
    authorizedSigner: b58enc(data.subarray(152, 184)),
    mint: b58enc(data.subarray(184, 216)),
  };
}
