// PROTOTYPE — throwaway. Generates:
//   keys/admin.json     64-byte solana keypair (upgrade authority + protocol authority + buyer)
//   keys/treasury.json  64-byte solana keypair (treasury ATA owner)
//   genesis/name-registry.json  pre-created NameRegistry account for --account genesis load
// Prints the pubkeys + the NameRegistry PDA that must appear in docker-compose.yml.
import { createKeyPairSignerFromBytes, getProgramDerivedAddress, getAddressEncoder } from '@solana/kit';
import { createHash, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const ARNS_PROGRAM_ID = '6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp'; // staging/devnet id, reused locally

function genKeypairBytes() {
  // seed -> pkcs8 -> derive public key; solana format is seed||pub (64 bytes)
  const seed = randomBytes(32);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const pub = spki.subarray(spki.length - 32);
  return Buffer.concat([seed, pub]);
}

mkdirSync('keys', { recursive: true });
mkdirSync('genesis', { recursive: true });

for (const name of ['admin', 'treasury']) {
  const path = `keys/${name}.json`;
  if (!existsSync(path)) writeFileSync(path, JSON.stringify([...genKeypairBytes()]));
}
const admin = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync('keys/admin.json'))));
const treasury = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync('keys/treasury.json'))));

// NameRegistry PDA + genesis account (mirrors programs/ario-arns/tests/integration.rs:
// zero-copy account preloaded with just the anchor discriminator; header zeroed).
const [registryPda] = await getProgramDerivedAddress({
  programAddress: ARNS_PROGRAM_ID,
  seeds: [Buffer.from('name_registry')],
});
const SIZE = 48 + 50_000 * 40; // NameRegistry::bytes_for_capacity(INITIAL_CAPACITY) = 2_000_048
const data = Buffer.alloc(SIZE);
createHash('sha256').update('account:NameRegistry').digest().copy(data, 0, 0, 8);
const accountJson = {
  pubkey: registryPda,
  account: {
    lamports: 15_000_000_000, // > rent-exempt minimum (~13.93 SOL) for 2MB
    data: [data.toString('base64'), 'base64'],
    owner: ARNS_PROGRAM_ID,
    executable: false,
    rentEpoch: 0,
    space: SIZE,
  },
};
writeFileSync('genesis/name-registry.json', JSON.stringify(accountJson));

console.log('admin pubkey     :', admin.address);
console.log('treasury pubkey  :', treasury.address);
console.log('name registry PDA:', registryPda, `(${SIZE} bytes)`);
