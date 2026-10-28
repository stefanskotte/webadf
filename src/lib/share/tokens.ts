import { randomBytes, createHash } from 'node:crypto';

/** Share API protocol version, exchanged at claim and sent on every response. */
export const SHARE_PROTOCOL = 1;

export function hashSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function mint(prefix: string): { plaintext: string; hash: string } {
  const plaintext = prefix + randomBytes(32).toString('base64url');
  return { plaintext, hash: hashSecret(plaintext) };
}

/** One-time claim code, shown once to the owner. */
export function mintClaimCode() { return mint('wfsc_'); }
/** Long-lived bearer token handed to the claiming instance. */
export function mintShareToken() { return mint('wfst_'); }
