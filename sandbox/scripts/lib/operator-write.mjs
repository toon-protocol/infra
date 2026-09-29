// Signs one operator write (connector ADR 0008) the way the connector's own
// docs/operators/sign-write.sh does: RFC 9421 over exactly `@method`, `@path`
// and `content-digest`, `alg="ed25519"`, `keyid` = the signer's ed25519 public
// key in hex, and an RFC 9530 sha-256 Content-Digest of the body. The node
// refuses any other covered set, and remembers an accepted signature until its
// `expires`, so a write is never replayed.
//
// A JS port rather than a shell-out because the open-peerings job runs in the
// sandbox's node image, which has no bash-and-openssl toolchain; the unit test
// holds it byte for byte to a vector sign-write.sh produced.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

// The fixed ASN.1 shell every PKCS#8 ed25519 private key wears; the 32-byte
// seed follows it. sign-write.sh builds the same DER.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKey(key) {
  const seed = String(key).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(seed)) {
    throw new Error('an operator write key must be 64 hex characters (32 bytes), as keys/toon/<node>/operator-send.key is');
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
}

/** The value a node's `write_keys` allowlist holds for this key. */
export function keyIdFor(key) {
  const der = createPublicKey(privateKey(key)).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('hex');
}

/**
 * The three headers a node's verifier checks, lowercase-keyed.
 * `created` defaults to now; `expiresIn` is seconds past it.
 */
export function signWrite({ key, method, path, body = '', created = Math.floor(Date.now() / 1000), expiresIn = 60 }) {
  const secret = privateKey(key);
  const keyid = keyIdFor(key);
  const contentDigest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
  const params = `("@method" "@path" "content-digest");created=${created};expires=${created + expiresIn};keyid="${keyid}";alg="ed25519"`;
  const base = [
    `"@method": ${method.toUpperCase()}`,
    `"@path": ${path}`,
    `"content-digest": ${contentDigest}`,
    `"@signature-params": ${params}`,
  ].join('\n');
  const signature = sign(null, Buffer.from(base), secret).toString('base64');
  return {
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${signature}:`,
    'content-digest': contentDigest,
  };
}
