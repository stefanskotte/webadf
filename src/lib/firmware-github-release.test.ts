import { describe, it, expect } from 'vitest';
import { githubReleasePlan, isTestBuild, assertSameBytes, installAssetName, checkInstallUf2 } from './firmware-github-release';

const base = {
  version: '1.8.1+g1f343d5', semver: '1.8.1', sequence: 50, sha256: 'a'.repeat(64),
  signature: 'c2ln', signingKeyId: 'wf-123', notes: 'TLS heap relief',
};

describe('the GitHub release for a published firmware version', () => {
  it('is tagged fw-<semver> and carries the signed manifest', () => {
    const p = githubReleasePlan(base);
    expect(p.publish).toBe(true);
    if (!p.publish) return;
    expect(p.tag).toBe('fw-1.8.1');
    expect(p.title).toBe('Firmware 1.8.1');
    expect(p.body).toContain('1.8.1+g1f343d5');
    expect(p.body).toContain('TLS heap relief');
    expect(p.manifest).toMatchObject({ sha256: base.sha256, signature: 'c2ln', sequence: 50, signingKeyId: 'wf-123' });
  });

  it('never publishes a TEST build', () => {
    expect(isTestBuild('TEST build: DF1 on by default')).toBe(true);
    expect(isTestBuild('a release')).toBe(false);
    expect(isTestBuild(null)).toBe(false);
    expect(githubReleasePlan({ ...base, notes: 'TEST build: bench only' }).publish).toBe(false);
  });

  it('refuses a semver that is not three numbers', () => {
    expect(githubReleasePlan({ ...base, semver: '1.8' }).publish).toBe(false);
  });

  it('works without notes', () => {
    const p = githubReleasePlan({ ...base, notes: null });
    expect(p.publish).toBe(true);
  });

  it('refuses to attach bytes that are not the published ones', () => {
    expect(() => assertSameBytes('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
    expect(() => assertSameBytes('a'.repeat(64), 'b'.repeat(64))).toThrow(/not the published one/);
  });

  it('names the single first-install UF2 by semver and tells the user to drag it', () => {
    expect(installAssetName('1.8.1')).toBe('wifi-floppy-install-1.8.1.uf2');
    const p = githubReleasePlan(base);
    if (!p.publish) throw new Error('expected a publish plan');
    expect(p.installAsset).toBe('wifi-floppy-install-1.8.1.uf2');
    expect(p.body).toMatch(/First install \(bench-verification pending\): hold BOOTSEL/);
    expect(p.body).toContain('drag wifi-floppy-install-1.8.1.uf2');
    expect(p.body).toMatch(/never offered over the air/);
    // The manifest still describes only the signed OTA image.
    expect(p.manifest).toMatchObject({ file: 'wifi_floppy.bin' });
  });
});

const ABS = 0xe48bff57;
function block(addr: number, n: number, total: number, payload: Buffer, family = ABS): Buffer {
  const b = Buffer.alloc(512);
  b.writeUInt32LE(0x0a324655, 0); b.writeUInt32LE(0x9e5d5157, 4); b.writeUInt32LE(0x2000, 8);
  b.writeUInt32LE(addr, 12); b.writeUInt32LE(256, 16); b.writeUInt32LE(n, 20); b.writeUInt32LE(total, 24);
  b.writeUInt32LE(family, 28); payload.copy(b, 32, 0, 256); b.writeUInt32LE(0x0ab16f30, 508);
  return b;
}
function installUf2(version: string, opts: { family?: number; lastAddr?: number } = {}): Buffer {
  // The version straddles a page boundary on purpose: the check must join pages.
  const image = Buffer.alloc(512, 0x11);
  Buffer.from(version, 'ascii').copy(image, 256 - 5);
  return Buffer.concat([
    block(0x10000000, 0, 5, Buffer.alloc(256, 0xd3)),
    block(0x10001000, 1, 5, Buffer.alloc(256, 0xff)),
    block(0x10008000, 2, 5, image.subarray(0, 256)),
    block(0x10008100, 3, 5, image.subarray(256), opts.family ?? ABS),
    block(opts.lastAddr ?? 0x10408000, 4, 5, Buffer.alloc(256, 0xff)),
  ]);
}

describe('checkInstallUf2', () => {
  it('accepts an all-absolute UF2 below the settings sectors that carries the version', () => {
    expect(checkInstallUf2(installUf2('1.8.1+g1f343d5'), '1.8.1+g1f343d5')).toBeNull();
  });
  it('refuses a stale file whose image is another version', () => {
    expect(checkInstallUf2(installUf2('1.8.0+gaaaaaaa'), '1.8.1+g1f343d5')).toMatch(/version/);
  });
  it('refuses a block in another family', () => {
    expect(checkInstallUf2(installUf2('1.8.1+g1', { family: 0xe48bff59 }), '1.8.1+g1')).toMatch(/absolute/);
  });
  it('refuses a block in the top-of-flash settings sectors (the E10 block, or worse)', () => {
    expect(checkInstallUf2(installUf2('1.8.1+g1', { lastAddr: 0x10ffff00 }), '1.8.1+g1')).toMatch(/settings sectors/);
    expect(checkInstallUf2(installUf2('1.8.1+g1', { lastAddr: 0x10ffb000 }), '1.8.1+g1')).toMatch(/settings sectors/);
    expect(checkInstallUf2(installUf2('1.8.1+g1', { lastAddr: 0x10ffaf00 }), '1.8.1+g1')).toBeNull();
  });
  it('refuses something that is not a UF2', () => {
    expect(checkInstallUf2(Buffer.alloc(100), 'x')).toMatch(/not a UF2/);
    expect(checkInstallUf2(Buffer.alloc(512), 'x')).toMatch(/magic/);
  });
});
