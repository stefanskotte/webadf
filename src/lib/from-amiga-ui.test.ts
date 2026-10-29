import { describe, it, expect } from 'vitest';
import { DISK_IMAGE_PATTERN } from '@/lib/archive/disk-image';
import { LIBRARY_EXT, cardUploadLine, libraryEligible, uploadFailureText } from './from-amiga-ui';

describe('from the Amiga: the rules that outlived the Upload page', () => {
  it("offers Add to library for the library's extensions and sizes only", () => {
    expect(LIBRARY_EXT.source).toBe(DISK_IMAGE_PATTERN.source);
    expect(libraryEligible('Games/Lemmings.ADF', 901_120)).toBe(true);
    expect(libraryEligible('x.hfe', 2_000_000)).toBe(true);
    expect(libraryEligible('x.adf', 2_621_441)).toBe(false);
    expect(libraryEligible('x.dms', 4_000_000)).toBe(true);
    expect(libraryEligible('x.lha', 1000)).toBe(false);
    expect(libraryEligible('adf', 1000)).toBe(false);
    expect(libraryEligible('x.adf', 0)).toBe(false);
  });
  it('says why a failed file did not arrive', () => {
    expect(uploadFailureText('crc')).toMatch(/damaged on the way/);
    expect(uploadFailureText('expired')).toMatch(/24 hours/);
    expect(uploadFailureText('zzz')).toMatch(/did not arrive whole/);
    expect(uploadFailureText(null)).toMatch(/did not arrive whole/);
  });
  it("the device card's line: files from the Amiga, or the update a Network board needs", () => {
    expect(cardUploadLine(2, '1.19.0+gabc', true)).toEqual({ text: '2 files from the Amiga', href: true });
    expect(cardUploadLine(1, '1.19.0+gabc', false)).toEqual({ text: '1 file from the Amiga', href: true });
    expect(cardUploadLine(undefined, '1.18.2', true)).toEqual({ text: 'Update to 1.19.0 to send files from the Amiga', href: false });
    expect(cardUploadLine(undefined, null, true)).toEqual({ text: 'Update to 1.19.0 to send files from the Amiga', href: false });
    expect(cardUploadLine(undefined, '1.18.2', false)).toBeNull();
    expect(cardUploadLine(0, '1.19.0+gabc', true)).toBeNull();
    expect(cardUploadLine(0, '1.19.0+gabc', false)).toBeNull();
  });
});
