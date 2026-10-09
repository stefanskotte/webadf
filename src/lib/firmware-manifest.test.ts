import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  firmwareManifest, refuseReleaseImage, refuseRegistryArtifact, refuseInstallImage, FIRMWARE_MAX_BYTES,
} from '@/lib/firmware-manifest';

const realInfo = readFileSync(join(__dirname, '__fixtures__', 'picotool-info-release.txt'), 'utf8');
// picotool info -a of a real wifi_floppy_install.bin (1.9.0+gbd3a756): no tbyb line at all.
const installInfo = readFileSync(join(__dirname, '__fixtures__', 'picotool-info-install.txt'), 'utf8');
const bytes = Buffer.from('image');

describe('firmwareManifest', () => {
  it('is exactly the spec text, no trailing newline', () => {
    expect(firmwareManifest({ version: '1.2.0+gabc1234', sequence: 7, sha256: 'ab'.repeat(32), sizeBytes: 1068032 }))
      .toBe(`webadf-fw-v1\n1.2.0+gabc1234\n7\n${'ab'.repeat(32)}\n1068032`);
  });
});

describe('refuseReleaseImage', () => {
  it('accepts the real TBYB, hashed build output', () => {
    expect(refuseReleaseImage(realInfo, 533624, bytes)).toBeNull();
  });
  it('refuses an image that is not TBYB -- it would boot unconditionally and never revert', () => {
    expect(refuseReleaseImage(realInfo.replace(/tbyb:.*\n/g, ''), 533624, bytes)).toMatch(/TBYB/);
  });
  it('refuses an image with no hash for the boot ROM to check', () => {
    expect(refuseReleaseImage(realInfo.replace(/^.*hash.*$/gim, ''), 533624, bytes)).toMatch(/hash/);
  });
  it('refuses an image whose hash does not verify', () => {
    expect(refuseReleaseImage(realInfo.replace(/verified/g, 'incorrect'), 533624, bytes)).toMatch(/hash/);
  });
  it('refuses anything over 2 MB', () => {
    expect(refuseReleaseImage(realInfo, FIRMWARE_MAX_BYTES + 1, bytes)).toMatch(/2 MB/);
  });
  it('refuses a build with the debug-only firmware command compiled in', () => {
    expect(refuseReleaseImage(realInfo, 533624, Buffer.from('xx fwdbg xx'))).toMatch(/debug/);
  });
  it('refuses a build with DF1 on by default unless the notes say TEST build', () => {
    const df1 = Buffer.from('xx wf-df1-default-on xx');
    expect(refuseReleaseImage(realInfo, 533624, df1)).toMatch(/DF1/);
    expect(refuseReleaseImage(realInfo, 533624, df1, 'a release')).toMatch(/DF1/);
    expect(refuseReleaseImage(realInfo, 533624, df1, 'TEST build: DF1 bench')).toBeNull();
  });
});

describe('the first-install image never reaches the registry (OTA)', () => {
  it('refuseReleaseImage refuses the real install image: it is not TBYB', () => {
    expect(refuseReleaseImage(installInfo, 603312, bytes)).toMatch(/TBYB/);
  });
  it('only wifi_floppy.bin is a registry artifact', () => {
    expect(refuseRegistryArtifact('/x/wifi-floppy/firmware/build/wifi_floppy.bin')).toBeNull();
    expect(refuseRegistryArtifact('/x/build/wifi_floppy_install.bin')).toMatch(/USB-only/);
    expect(refuseRegistryArtifact('/x/build/wifi-floppy-install.uf2')).toMatch(/only wifi_floppy.bin/);
    expect(refuseRegistryArtifact('C:\\build\\wifi_floppy_install.bin')).toMatch(/only wifi_floppy.bin/);
  });
  it('refuseInstallImage wants the opposite of a release: hashed, NOT TBYB', () => {
    expect(refuseInstallImage(installInfo)).toBeNull();
    expect(refuseInstallImage(realInfo)).toMatch(/TBYB/);
    expect(refuseInstallImage(installInfo.replace(/verified/g, 'incorrect'))).toMatch(/hash/);
  });
});
