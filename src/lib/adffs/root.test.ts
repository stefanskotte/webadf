import { describe, it, expect } from 'vitest';
import { readBoot } from './boot';
import { readRoot } from './root';
import { syntheticVolume } from './synthetic';
import { BLOCK_BYTES, ROOT_BLOCK } from './constants';

const volumeOf = (adf: Uint8Array) => readRoot(adf, readBoot(adf)!);

describe('readRoot', () => {
  it('reads the volume name', () => {
    expect(volumeOf(syntheticVolume({ volumeName: 'Workbench3.1' }))!.name)
      .toBe('Workbench3.1');
  });

  it('carries the boot flags through onto the volume', () => {
    const v = volumeOf(syntheticVolume({ filesystem: 'FFS', intl: true }))!;
    expect(v.filesystem).toBe('FFS');
    expect(v.intl).toBe(true);
  });

  it('decodes the volume dates', () => {
    expect(volumeOf(syntheticVolume())!.modifiedAt).toBeInstanceOf(Date);
  });

  it('REJECTS a block whose checksum is wrong, however plausible it looks', () => {
    // D-3-1, and the reason this rule exists. All four Project-X disks have
    // type 2 and secondary type 1 at block 880 -- they pass every structural
    // check -- but store ASCII "1111" where the checksum belongs, because the
    // block is game data. Without this the reader reports a filesystem with a
    // blank volume name on a cracked game.
    expect(volumeOf(syntheticVolume({ breakRootChecksum: true }))).toBeNull();
  });

  it('accepts a volume whose BOOT checksum is broken', () => {
    // D-3-2. 30 of the 49 readable archive disks are exactly this shape.
    expect(volumeOf(syntheticVolume({ breakBootChecksum: true }))).not.toBeNull();
  });

  it('rejects a block with the wrong primary type', () => {
    const adf = syntheticVolume();
    adf.set([0, 0, 0, 9], ROOT_BLOCK * BLOCK_BYTES);
    expect(volumeOf(adf)).toBeNull();
  });

  it('rejects a block with the wrong secondary type', () => {
    const adf = syntheticVolume();
    adf.set([0, 0, 0, 7], ROOT_BLOCK * BLOCK_BYTES + 508);
    expect(volumeOf(adf)).toBeNull();
  });

  it('rejects an all-zero image without throwing', () => {
    const adf = new Uint8Array(BLOCK_BYTES * 1760);
    expect(readBoot(adf)).toBeNull();
    // readRoot takes a BootInfo, not the missing boot block itself, because
    // readVolume only ever calls it after readBoot has already succeeded.
    // The all-zero root block still fails readRoot on its own terms (wrong
    // type, then a bad checksum), so a placeholder BootInfo is enough to
    // exercise that path here without throwing.
    const boot = { filesystem: 'OFS' as const, intl: false, dirc: false };
    expect(() => readRoot(adf, boot)).not.toThrow();
    expect(readRoot(adf, boot)).toBeNull();
  });
});
