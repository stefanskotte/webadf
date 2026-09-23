import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firmwareManifest, refuseReleaseImage, FIRMWARE_MAX_BYTES } from '@/lib/firmware-manifest';

const realInfo = readFileSync(join(__dirname, '__fixtures__', 'picotool-info-release.txt'), 'utf8');
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
});
