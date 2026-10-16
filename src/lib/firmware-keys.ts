import { createPublicKey, type KeyObject } from 'node:crypto';

/**
 * The public key(s) boards verify firmware with (wifi-floppy/firmware/src/fw_pubkey.h), as data, so the
 * server can check an imported release exactly as a board will. firmware-keys.test.ts keeps it equal to
 * the header and the committed PEM. Adding a key here never lets a board accept anything.
 */
export const FIRMWARE_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  'wf-1138f25902223da4': '37cf2d17853e3ade30921a8561448108' + '90be17292920c674e38197636a6d694a',
};

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFor(id: string, keys: Readonly<Record<string, string>> = FIRMWARE_PUBLIC_KEYS): KeyObject | null {
  const hex = keys[id];
  if (!hex) return null;
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}
