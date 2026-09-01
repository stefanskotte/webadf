import { describe, it, expect } from 'vitest';
import { readBoot } from './boot';
import { syntheticVolume } from './synthetic';

describe('readBoot', () => {
  it('reads a plain OFS volume', () => {
    expect(readBoot(syntheticVolume({ filesystem: 'OFS' })))
      .toEqual({ filesystem: 'OFS', intl: false, dirc: false });
  });

  it('reads the FFS flag', () => {
    expect(readBoot(syntheticVolume({ filesystem: 'FFS' }))!.filesystem).toBe('FFS');
  });

  it('reads INTL and DIRC independently of the filesystem bit', () => {
    // 6 archive disks are INTL; none are DIRC. Both are read anyway, because
    // INTL changes the hash function and DIRC is reported to the operator.
    const b = readBoot(syntheticVolume({ filesystem: 'FFS', intl: true, dirc: true }))!;
    expect(b).toEqual({ filesystem: 'FFS', intl: true, dirc: true });
  });

  it('returns null without a DOS signature', () => {
    expect(readBoot(syntheticVolume({ noSignature: true }))).toBeNull();
  });

  it('IGNORES a broken boot checksum', () => {
    // D-3-2, and this is the common case rather than an edge case: only 19
    // of the 49 readable archive disks have a valid boot checksum. Enforcing
    // it would discard 61% of what this reader exists to read.
    const b = readBoot(syntheticVolume({ filesystem: 'FFS', breakBootChecksum: true }));
    expect(b).toEqual({ filesystem: 'FFS', intl: false, dirc: false });
  });

  it('returns null for an image too short to hold a boot block', () => {
    expect(readBoot(new Uint8Array(16))).toBeNull();
  });
});
