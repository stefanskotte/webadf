import { describe, it, expect } from 'vitest';
import { formatVolume, setVolumeName, usedBlocks, BITMAP_BLOCK, MAX_VOLUME_NAME } from './format';
import { readVolume } from './index';
import { BLOCK_BYTES, BLOCK_COUNT, ROOT_BLOCK } from './constants';

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const AT = new Date(Date.UTC(2026, 8, 3, 12, 0, 0));

describe('formatVolume', () => {
  it('produces an 880 KB image our own reader accepts', () => {
    for (const filesystem of ['OFS', 'FFS'] as const) {
      const adf = formatVolume({ filesystem, volumeName: 'Blank', now: AT });
      expect(adf.length).toBe(BLOCK_BYTES * BLOCK_COUNT);
      const v = readVolume(adf);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.volume.name).toBe('Blank');
      expect(v.volume.filesystem).toBe(filesystem);
      expect(v.root).toEqual([]);
      expect(v.warnings).toEqual([]);
    }
  });

  it('marks exactly the root and bitmap blocks as used', () => {
    // THE ASSERTION THE READER CANNOT MAKE. readVolume ignores the bitmap
    // entirely -- a disk with a completely wrong one reads perfectly and only
    // corrupts when a real Amiga writes to it. Everything else in this module
    // is checked by round-tripping; this is not, so it is checked directly.
    const adf = formatVolume({ filesystem: 'FFS', volumeName: 'Blank', now: AT });
    expect(usedBlocks(adf)).toEqual([ROOT_BLOCK, BITMAP_BLOCK]);
  });

  it('writes a bitmap checksum that sums the whole block to zero', () => {
    const adf = formatVolume({ filesystem: 'FFS', volumeName: 'Blank', now: AT });
    const bm = BITMAP_BLOCK * BLOCK_BYTES;
    let sum = 0;
    for (let o = bm; o < bm + BLOCK_BYTES; o += 4) sum = (sum + be32(adf, o)) >>> 0;
    expect(sum).toBe(0);
  });

  it('sets the filesystem and INTL flags in the boot block', () => {
    expect(formatVolume({ filesystem: 'OFS', volumeName: 'x' })[3]).toBe(0x00);
    expect(formatVolume({ filesystem: 'FFS', volumeName: 'x' })[3]).toBe(0x01);
    expect(formatVolume({ filesystem: 'OFS', volumeName: 'x', intl: true })[3]).toBe(0x02);
    expect(formatVolume({ filesystem: 'FFS', volumeName: 'x', intl: true })[3]).toBe(0x03);
  });

  it('points the boot block at the root and the root at the bitmap', () => {
    const adf = formatVolume({ filesystem: 'FFS', volumeName: 'x', now: AT });
    expect(be32(adf, 8)).toBe(ROOT_BLOCK);
    const root = ROOT_BLOCK * BLOCK_BYTES;
    expect(be32(adf, root + 312) | 0).toBe(-1);          // bm_flag: valid
    expect(be32(adf, root + 316)).toBe(BITMAP_BLOCK);
  });

  it('truncates an over-long volume name rather than refusing it', () => {
    const adf = formatVolume({ filesystem: 'FFS', volumeName: 'W'.repeat(60), now: AT });
    const v = readVolume(adf);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.volume.name).toBe('W'.repeat(MAX_VOLUME_NAME));
  });

  it('keeps a name the same length when it contains characters an Amiga has no byte for', () => {
    // Substituted, not dropped: a name must never come back shorter than the
    // one someone typed, or they cannot tell what happened to it.
    const adf = formatVolume({ filesystem: 'FFS', volumeName: 'Grüße☠', now: AT });
    const v = readVolume(adf);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.volume.name).toHaveLength(6);
    expect(v.volume.name.startsWith('Grüße')).toBe(true);
  });

  it('is deterministic for a given timestamp', () => {
    // Two disks formatted the same way must be byte-identical, or the same
    // blank disk would ingest as two different blobs.
    const a = formatVolume({ filesystem: 'FFS', volumeName: 'Same', now: AT });
    const b = formatVolume({ filesystem: 'FFS', volumeName: 'Same', now: AT });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('leaves every block but the root and bitmap zeroed', () => {
    // A blank disk that carried stale bytes would still read as empty, and
    // would ship whatever was in memory to a real Amiga.
    const adf = formatVolume({ filesystem: 'FFS', volumeName: 'Blank', now: AT });
    for (const block of [0, 1, 2, 879, 882, BLOCK_COUNT - 1]) {
      const o = block * BLOCK_BYTES;
      const slice = adf.subarray(o, o + BLOCK_BYTES);
      // Block 0 carries the DOS signature and root pointer; the rest of it,
      // and all of the others, must be zero.
      const from = block === 0 ? 12 : 0;
      expect(slice.subarray(from).every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe('setVolumeName', () => {
  it('renames without disturbing anything else on the disk', () => {
    const before = formatVolume({ filesystem: 'FFS', volumeName: 'Before', now: AT });
    const after = setVolumeName(before, 'After');
    const v = readVolume(after);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.volume.name).toBe('After');
    expect(v.volume.filesystem).toBe('FFS');
    // The bitmap is untouched -- a rename that reformatted would erase the
    // disk, and on a disk with files that is data loss rather than a bug.
    expect(usedBlocks(after)).toEqual(usedBlocks(before));
    // Every block except the root is byte-identical.
    const root = ROOT_BLOCK * BLOCK_BYTES;
    expect(Buffer.from(after.subarray(0, root)).equals(Buffer.from(before.subarray(0, root)))).toBe(true);
    expect(Buffer.from(after.subarray(root + BLOCK_BYTES)).equals(
      Buffer.from(before.subarray(root + BLOCK_BYTES)))).toBe(true);
  });

  it('leaves no tail of the previous name behind a shorter one', () => {
    const long = formatVolume({ filesystem: 'FFS', volumeName: 'Something Quite Long', now: AT });
    const short = setVolumeName(long, 'Ab');
    const root = ROOT_BLOCK * BLOCK_BYTES;
    expect(short[root + 432]).toBe(2);
    // The reader would not show it, but the bytes would still be on the disk.
    expect(short.subarray(root + 435, root + 464).every((b) => b === 0)).toBe(true);
  });

  it('returns new bytes rather than mutating, because blobs are immutable', () => {
    const before = formatVolume({ filesystem: 'FFS', volumeName: 'Before', now: AT });
    const copy = before.slice();
    setVolumeName(before, 'After');
    expect(Buffer.from(before).equals(Buffer.from(copy))).toBe(true);
  });
});
