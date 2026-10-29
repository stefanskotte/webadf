import { describe, expect, it } from 'vitest';
import type { RefusalCode } from './types';
import { refusalWords } from './words';
import { netEmpty } from './net-rules';

// The type system forces this to list every RefusalCode.
const ALL: Record<RefusalCode, true> = {
  not_found: true, read_only: true, mounted: true, disk_full: true, name_exists: true, bad_name: true,
  comment_too_long: true, cycle: true, no_filesystem: true, hfe_read_only: true, conflict: true,
  unsupported: true, blob_unavailable: true, failed: true,
  stash_full: true, too_large: true, archive_unreadable: true, not_a_disk_image: true, queue_full: true,
};

describe('refusalWords', () => {
  for (const code of Object.keys(ALL) as RefusalCode[]) {
    it(`${code} has words, with and without a detail`, () => {
      expect(refusalWords(code).trim().length).toBeGreaterThan(0);
      expect(refusalWords(code, 'some detail').trim().length).toBeGreaterThan(0);
    });
  }
  it('says the STASH: things (increment 2)', () => {
    expect(refusalWords('stash_full')).toBe('STASH: holds 500 files / 256 MB; delete some first.');
    expect(refusalWords('too_large')).toBe('That file is too large.');
    expect(refusalWords('too_large', 'at most 20 MB')).toBe('Too large — at most 20 MB.');
    expect(refusalWords('archive_unreadable')).toBe("Can't open this archive. You can still download it.");
    expect(refusalWords('not_a_disk_image')).toBe('Only disk images (ADF, ADZ, DMS, DMZ, HFE) go into the library.');
    expect(refusalWords('not_a_disk_image', 'notes.txt')).toBe('Not a disk image the library takes — notes.txt.');
    expect(refusalWords('read_only', 'archive')).toBe('Archives are read-only — copy files out of them.');
    expect(refusalWords('unsupported', 'still arriving from the Amiga')).toBe('That is still arriving from the Amiga.');
    expect(refusalWords('unsupported', netEmpty('mods/a.txt'))).toBe('mods/a.txt is empty — nothing was sent.');
  });
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
  it('Files 2: titles on the Library page, the library already, collections', () => {
    expect(refusalWords('unsupported', 'Rename or delete titles on the Library page')).toBe('Rename or delete titles on the Library page.');
    expect(refusalWords('unsupported', 'It is in the library already')).toBe('It is in the library already.');
    expect(refusalWords('unsupported', 'Collections hold titles, not folders')).toBe('Collections hold titles, not folders.');
    expect(refusalWords('unsupported', 'Open a disk or STASH: to make a folder in it')).toBe('Open a disk or STASH: to make a folder in it.');
    expect(refusalWords('name_exists', 'A collection with that name already exists')).toBe('A collection with that name already exists.');
    expect(refusalWords('bad_name', 'collection-too-long')).toBe('Collection names are at most 80 characters.');
  });
  it('says the NET: things (increment 3)', () => {
    expect(refusalWords('queue_full')).toBe("The board's queue holds 32 files / 16 MB; wait for it to empty or cancel some.");
    expect(refusalWords('unsupported', 'Files waiting for the Amiga cannot be copied out')).toBe('Files waiting for the Amiga cannot be copied out.');
    expect(refusalWords('unsupported', 'Files sent to the Amiga stay where they are — use Copy')).toBe('Files sent to the Amiga stay where they are — use Copy.');
    expect(refusalWords('read_only', 'Open a board to send files to it')).toBe('Open a board to send files to it.');
    expect(refusalWords('too_large', 'Big.bin is over 4 MB')).toBe('Too large — Big.bin is over 4 MB.');
  });
});
