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

describe('verifyRelease refuses what a board refuses', () => {
  const sigOf = () => make().signature;
  it('refuses a signature with trailing characters', () => {
    expect(verifyRelease(make({ signature: sigOf() + 'AAAA' }), bin, keys)).toMatch(/signature/);
    expect(verifyRelease(make({ signature: sigOf() + 'junk!!' }), bin, keys)).toMatch(/signature/);
  });
  it('refuses a signature with embedded whitespace', () => {
    const g = sigOf();
    expect(verifyRelease(make({ signature: g.slice(0, 10) + '\n' + g.slice(10) }), bin, keys)).toMatch(/signature/);
    expect(verifyRelease(make({ signature: g + '\n' }), bin, keys)).toMatch(/signature/);
  });
  it('refuses a version that could escape a path', () => {
    expect(verifyRelease(make({ version: '../x+g1', semver: '1.0.0' }), bin, keys)).toMatch(/version/);
    expect(verifyRelease(make({ version: '.1.0.0+g1', semver: '1.0.0' }), bin, keys)).toMatch(/version/);
    expect(verifyRelease(make({ version: '1.0.0+g1/x', semver: '1.0.0' }), bin, keys)).toMatch(/version/);
  });
  it('refuses a version over 64 characters', () => {
    const v = '1.0.0+g' + 'a'.repeat(60);
    expect(verifyRelease(make({ version: v, semver: '1.0.0' }), bin, keys)).toMatch(/version/);
  });
  it('refuses a version with no semver half, or a semver that is not its half', () => {
    expect(verifyRelease(make({ version: 'abc', semver: 'abc' }), bin, keys)).toMatch(/version/);
    expect(verifyRelease(make({ semver: '9.9.8' }), bin, keys)).toMatch(/semver/);
  });
  it('refuses sequence 0, negative, fractional, too large and unsafe', () => {
    for (const q of [0, -1, 1.5, 0x100000000, 1e21]) {
      expect(verifyRelease(make({ sequence: q }), bin, keys), String(q)).toMatch(/sequence/);
    }
  });
  it('accepts the largest sequence', () => {
    expect(verifyRelease(make({ sequence: 0xffffffff }), bin, keys)).toBeNull();
  });
  it('refuses an uppercase sha256 (boards accept lowercase only)', () => {
    expect(verifyRelease(make({ sha256: sha.toUpperCase() }), bin, keys)).toMatch(/sha256/);
  });
  it('does not lowercase a sha256 when parsing', () => {
    const m = parseReleaseManifest({ ...make(), sha256: sha.toUpperCase() });
    expect(typeof m === 'string' || m.sha256 === sha.toUpperCase()).toBe(true);
  });
  it('refuses an empty image', () => {
    expect(verifyRelease(make({ sha256: createHash('sha256').update('').digest('hex') }), Buffer.alloc(0), keys)).toMatch(/empty/);
  });
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

describe('verifyRelease refuses bench-only images regardless of notes', () => {
  function signed(image: Buffer) {
    const s = createHash('sha256').update(image).digest('hex');
    const m = { version: '9.9.9+gabc', semver: '9.9.9', sequence: 90, file: 'wifi_floppy.bin', sha256: s, signingKeyId: testId, signatureFormat: 2, signature: '' };
    const msg = firmwareManifest({ version: m.version, sequence: m.sequence, sha256: s, sizeBytes: image.length });
    return { ...m, signature: sign(null, Buffer.from(msg, 'ascii'), privateKey).toString('base64'), notes: 'TEST build' } as ReleaseManifest;
  }
  for (const [marker, re] of [['wf-df1-default-on', /DF1/], ['wf-pnet-loop-test', /PaulaNET loopback/], ['fwdbg', /WF_FW_DEBUG/]] as const) {
    it(`refuses an image carrying ${marker}, even with TEST build notes`, () => {
      const image = Buffer.concat([bin, Buffer.from(marker, 'ascii')]);
      expect(verifyRelease(signed(image), image, keys)).toMatch(re);
    });
  }
});
