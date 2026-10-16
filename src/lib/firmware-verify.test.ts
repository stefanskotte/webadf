import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { firmwareManifest } from './firmware-manifest';
import { parseReleaseManifest, verifyRelease, type ReleaseManifest } from './firmware-verify';
import { signingKeyId } from '../../scripts/firmware-signing-key';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const testId = signingKeyId(publicKey);
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
const keys = { [testId]: raw };
const bin = Buffer.from('a firmware image');
const sha = createHash('sha256').update(bin).digest('hex');
function make(over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const m = { version: '9.9.9+gabc', semver: '9.9.9', sequence: 90, file: 'wifi_floppy.bin', sha256: sha,
    signingKeyId: testId, signatureFormat: 2, signature: '', ...over };
  const msg = firmwareManifest({ version: m.version, sequence: m.sequence, sha256: m.sha256, sizeBytes: bin.length });
  return { ...m, signature: over.signature ?? sign(null, Buffer.from(msg, 'ascii'), privateKey).toString('base64') };
}

describe('verifyRelease', () => {
  it('accepts a correctly signed release', () => { expect(verifyRelease(make(), bin, keys)).toBeNull(); });
  it('refuses a .bin that is not the manifest\'s', () => {
    expect(verifyRelease(make(), Buffer.from('other'), keys)).toMatch(/sha256/);
  });
  it('refuses a signature over another sequence', () => {
    const m = make(); expect(verifyRelease({ ...m, sequence: 91 }, bin, keys)).toMatch(/signature/);
  });
  it('refuses an unknown key', () => { expect(verifyRelease(make({ signingKeyId: 'wf-0000000000000000' }), bin, keys)).toMatch(/unknown signing key/); });
  it('refuses another signature format', () => { expect(verifyRelease(make({ signatureFormat: 1 }), bin, keys)).toMatch(/signatureFormat/); });
  it('refuses another file', () => { expect(verifyRelease(make({ file: 'wifi_floppy_install.bin' }), bin, keys)).toMatch(/wifi_floppy.bin/); });
});

describe('the real fw-1.13.0 release', () => {
  const REAL_SIZE = 636624; // byte size of the fw-1.13.0 release's wifi_floppy.bin asset
  it('verifies with the boards\' key (signature over version, sequence, sha256, size)', async () => {
    const m = parseReleaseManifest(JSON.parse(readFileSync('src/lib/__fixtures__/fw-1.13.0-manifest.json', 'utf8')));
    if (typeof m === 'string') throw new Error(m);
    const { publicKeyFor } = await import('./firmware-keys');
    const { verify } = await import('node:crypto');
    const msg = firmwareManifest({ version: m.version, sequence: m.sequence, sha256: m.sha256, sizeBytes: REAL_SIZE });
    expect(verify(null, Buffer.from(msg, 'ascii'), publicKeyFor(m.signingKeyId)!, Buffer.from(m.signature, 'base64'))).toBe(true);
  });
});

describe('parseReleaseManifest', () => {
  it('refuses a manifest missing fields', () => { expect(parseReleaseManifest({ version: 'x' })).toMatch(/manifest/); });
  it('keeps optional notes and security', () => {
    const m = parseReleaseManifest({ ...make(), notes: 'n', security: true });
    expect(typeof m !== 'string' && m.notes === 'n' && m.security === true).toBe(true);
  });
});
