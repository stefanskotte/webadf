import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { FIRMWARE_PUBLIC_KEYS, publicKeyFor } from './firmware-keys';
import { signingKeyId } from '../../scripts/firmware-signing-key';

describe('firmware public keys', () => {
  it('match the key compiled into the firmware (fw_pubkey.h)', () => {
    const h = readFileSync('wifi-floppy/firmware/src/fw_pubkey.h', 'utf8');
    const id = /FW_PUBKEY_ID "([^"]+)"/.exec(h)![1];
    const bytes = [...h.matchAll(/0x([0-9a-f]{2})/gi)].map((m) => m[1].toLowerCase()).join('');
    expect(FIRMWARE_PUBLIC_KEYS[id]).toBe(bytes);
  });
  it('match the committed PEM and its id', () => {
    for (const id of Object.keys(FIRMWARE_PUBLIC_KEYS)) {
      const pem = readFileSync(`wifi-floppy/firmware/keys/${id}.pem`, 'utf8');
      const fromPem = createPublicKey(pem).export({ format: 'der', type: 'spki' });
      expect(publicKeyFor(id)!.export({ format: 'der', type: 'spki' }).equals(fromPem)).toBe(true);
      expect(signingKeyId(publicKeyFor(id)!)).toBe(id);
    }
  });
  it('knows nothing else', () => { expect(publicKeyFor('wf-0000000000000000')).toBeNull(); });
});
