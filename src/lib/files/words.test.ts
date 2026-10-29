import { describe, expect, it } from 'vitest';
import type { RefusalCode } from './types';
import { refusalWords } from './words';

// The type system forces this to list every RefusalCode.
const ALL: Record<RefusalCode, true> = {
  not_found: true, read_only: true, mounted: true, disk_full: true, name_exists: true, bad_name: true,
  comment_too_long: true, cycle: true, no_filesystem: true, hfe_read_only: true, conflict: true,
  unsupported: true, blob_unavailable: true, failed: true,
};

describe('refusalWords', () => {
  for (const code of Object.keys(ALL) as RefusalCode[]) {
    it(`${code} has words, with and without a detail`, () => {
      expect(refusalWords(code).trim().length).toBeGreaterThan(0);
      expect(refusalWords(code, 'some detail').trim().length).toBeGreaterThan(0);
    });
  }
  it('says the specific things', () => {
    expect(refusalWords('disk_full', 'needs 10 KB, 4 KB free')).toBe('Not enough room on the disk — needs 10 KB, 4 KB free');
    expect(refusalWords('read_only', 'mounted on "A500 bench"')).toBe('This disk is in a drive (mounted on "A500 bench"). Eject it to change it.');
    expect(refusalWords('conflict')).toBe('The disk changed — the pane has been refreshed.');
    expect(refusalWords('cycle')).toBe('A folder cannot go inside itself.');
    expect(refusalWords('bad_name')).toBe('AmigaDOS names are at most 30 characters, without : or /.');
    expect(refusalWords('comment_too_long')).toBe('Comments are at most 79 characters.');
    expect(refusalWords('hfe_read_only')).toBe('HFE disks are read-only.');
    expect(refusalWords('no_filesystem')).toBe('This disk has no AmigaDOS filesystem.');
  });
  it('reads naturally without a detail', () => {
    expect(refusalWords('disk_full')).toBe('Not enough room on the disk.');
    expect(refusalWords('read_only')).toBe('This disk is in a drive. Eject it to change it.');
  });
  it('bad_name for a comment says so', () => {
    expect(refusalWords('bad_name', 'comment')).toMatch(/comment/i);
  });
  it('name_exists details', () => {
    expect(refusalWords('name_exists')).toMatch(/already/i);
    expect(refusalWords('name_exists', 'same file')).toMatch(/same file/i);
    expect(refusalWords('name_exists', 'two sources share a name')).toMatch(/same name/i);
  });
  it('read_only reads the engine\'s reason, not just a mount', () => {
    expect(refusalWords('read_only', 'hfe_read_only')).toBe('HFE disks are read-only.');
    expect(refusalWords('read_only', 'no_filesystem')).toBe('This disk has no AmigaDOS filesystem.');
    expect(refusalWords('read_only', 'something_else')).toBe('This disk is read-only.');
  });
  it('a copied-but-not-removed move says so, then the removal\'s reason', () => {
    const d = 'copied, but the original could not be removed';
    expect(refusalWords('conflict', d)).toBe('Copied, but the original could not be removed — The disk changed — the pane has been refreshed.');
    expect(refusalWords('read_only', d)).toBe('Copied, but the original could not be removed — This disk is in a drive. Eject it to change it.');
  });
  it('bad_name details', () => {
    expect(refusalWords('bad_name', 'empty')).toBe('Type a name.');
    expect(refusalWords('bad_name', 'too-long')).toBe('AmigaDOS names are at most 30 characters.');
    expect(refusalWords('bad_name', 'bad-char')).toBe('Names cannot contain : or /, or characters an Amiga cannot show.');
  });
});
