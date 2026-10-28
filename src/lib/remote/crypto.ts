// The recipient's copy of a share token, sealed at rest (spec §4.1, §5: "encrypted at the recipient, never sent to a
// browser"). SERVER ONLY. AES-256-GCM under a key derived (HKDF) from BETTER_AUTH_SECRET, so self-hosters need no
// new setting. Format: 'v1.' + base64url(iv 12 | ciphertext | tag 16). Rotating BETTER_AUTH_SECRET makes every
// sealed token unreadable: openToken throws, and the library has to be added again. The remote library's id is bound
// in as additional authenticated data, so a sealed value copied onto another library's row does not open there.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(env: { readonly [k: string]: string | undefined } = process.env): Buffer {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set: share tokens cannot be sealed');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'webadf-share-token', 32));
}

export function sealToken(plain: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}

/** The plain token. Throws on a wrong format, a tampered value, a different secret or a different `aad`. */
export function openToken(sealed: string, aad: string): string {
  if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) throw new Error('sealed token: unknown format');
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('sealed token: too short');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const d = createDecipheriv('aes-256-gcm', key(), iv, { authTagLength: TAG_BYTES });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
