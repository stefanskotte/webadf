import { describe, it, expect } from 'vitest';
import { collectionNameProblem, SHELF_WORDS, MAKEDIR_IN_DISK, filingReason, shelfOf, shelfOfRow, shelfReasons } from './shelf-rules';
import type { FsEntry, Listing } from './types';

describe('collection names (Files 2 R3: the Library\'s 1-80 characters, trimmed)', () => {
  it('refuses empty and over-long names, takes anything else', () => {
    expect(collectionNameProblem('   ')).toBe('empty');
    expect(collectionNameProblem('x'.repeat(81))).toBe('collection-too-long');
    expect(collectionNameProblem(`  ${'x'.repeat(80)}  `)).toBeNull();
    expect(collectionNameProblem('Demos: 1993/94')).toBeNull();
  });
});

describe('the words a shelf refusal carries (D13)', () => {
  it('a folder made in a title\'s disk list says where folders go, as a sentence of its own', () => {
    expect(MAKEDIR_IN_DISK).toBe('Open a disk or STASH: to make a folder in it');
    expect(SHELF_WORDS).toContain(MAKEDIR_IN_DISK);
  });
});

const E = (name: string, kind: FsEntry['kind'], path: string, o: Partial<FsEntry> = {}): FsEntry =>
  ({ name, kind, path, size: kind === 'file' ? 901120 : null, date: null, protection: null, comment: null, marks: [], ...o });
const L = (path: string, library?: Listing['library'], o: Partial<Listing> = {}): Listing =>
  ({ path, crumbs: [], entries: [], writable: false, readOnlyReason: null, disk: null, meta: '', ...(library ? { library } : {}), ...o });
const root = L('LIBRARY:', { level: 'root', collectionId: null });
const demos = L('LIBRARY:/c1', { level: 'collection', collectionId: 'c1' });
const games = L('LIBRARY:/c2', { level: 'collection', collectionId: 'c2' });
const stash = L('STASH:', undefined, { writable: true });
const title = E('SysInfo', 'title', 'LIBRARY:/c1/g1');
const diskList = L('LIBRARY:/g1/d1', { level: 'disk', collectionId: null });

describe('filing (Files 2 §3.2, R5)', () => {
  it('a shelf is the root or a collection; a collection row names its collection', () => {
    expect(shelfOf(root)).toEqual({ collectionId: null });
    expect(shelfOf(demos)).toEqual({ collectionId: 'c1' });
    expect(shelfOf(L('LIBRARY:/g1', { level: 'title', collectionId: null }))).toBeNull();
    expect(shelfOf(stash)).toBeNull();
    expect(shelfOf(null)).toBeNull();
    expect(shelfOfRow(E('Games', 'collection', 'LIBRARY:/c2'))).toEqual({ collectionId: 'c2' });
    expect(shelfOfRow(title)).toBeNull();
  });
  it('titles go to another collection by Copy or Move; to the root only by Move out of a collection', () => {
    expect(filingReason('move', demos, [title], shelfOf(games))).toBeNull();
    expect(filingReason('copy', demos, [title], shelfOf(games))).toBeNull();
    expect(filingReason('move', demos, [title], shelfOf(root))).toBeNull();
    expect(filingReason('copy', demos, [title], shelfOf(root))).toBe('It is in the library already');
    expect(filingReason('move', root, [E('Loose', 'title', 'LIBRARY:/g3')], shelfOf(root))).toBe('It is in the library already');
    expect(filingReason('move', demos, [title], null)).toBe('Open LIBRARY: or a collection to file titles');
    expect(filingReason('copy', root, [E('Games', 'collection', 'LIBRARY:/c2')], shelfOf(demos))).toBe('A collection cannot go inside another');
  });
  it('D11: onto the collection they are in already is offered; the server skips them and says so', () => {
    expect(filingReason('move', demos, [title], shelfOf(demos))).toBeNull();
    expect(filingReason('copy', root, [E('Loose', 'title', 'LIBRARY:/g3')], shelfOfRow(E('Demos', 'collection', 'LIBRARY:/c1')))).toBeNull();
  });
  it('disk images from STASH: go onto a shelf, also one already in the library; other files do not', () => {
    expect(filingReason('copy', stash, [E('Game.adf', 'file', 'STASH:/Game.adf')], shelfOf(demos))).toBeNull();
    expect(filingReason('copy', stash, [E('Old.adf', 'file', 'STASH:/Old.adf', { marks: ['in the library'] })], shelfOf(root))).toBeNull();
    expect(filingReason('copy', stash, [E('ReadMe', 'file', 'STASH:/ReadMe', { size: 5 })], shelfOf(root)))
      .toBe('Select disk images (ADF, ADZ, DMS, DMZ, HFE) to add them');
    expect(filingReason('copy', L('LIBRARY:/g1/d1', { level: 'disk', collectionId: null }, { writable: true }),
      [E('ReadMe', 'file', 'LIBRARY:/g1/d1/ReadMe')], shelfOf(root))).toBe('Only titles, and disk images from STASH:, go into the library here');
    expect(filingReason('copy', L('LIBRARY:/g1', { level: 'title', collectionId: null }), [E('Disk 1', 'disk', 'LIBRARY:/g1/d1')], shelfOf(root)))
      .toBe('Only titles, and disk images from STASH:, go into the library here');
  });
  it('nothing picked, or no shelf on either side: not a filing', () => {
    expect(filingReason('copy', demos, [], shelfOf(games))).toBeUndefined();
    expect(filingReason('copy', stash, [E('a', 'file', 'STASH:/a')], null)).toBeUndefined();
    // Collections picked with nowhere to file them: the file rules answer, not "inside another".
    expect(filingReason('copy', root, [E('Games', 'collection', 'LIBRARY:/c2')], null)).toBeUndefined();
  });
});

describe('collection commands (§3.2)', () => {
  it('Makedir on the root, Rename one collection, Delete collections; titles and disks are the Library page\'s', () => {
    expect(shelfReasons(root, [])).toEqual({ makedir: null, rename: 'Select one item to rename it', delete: 'Select something first' });
    expect(shelfReasons(root, [E('Demos', 'collection', 'LIBRARY:/c1')])).toEqual({ makedir: null, rename: null, delete: null });
    expect(shelfReasons(root, [E('Demos', 'collection', 'LIBRARY:/c1'), E('Loose', 'title', 'LIBRARY:/g3')]))
      .toEqual({ makedir: null, rename: 'Select one item to rename it', delete: 'Rename or delete titles on the Library page' });
    expect(shelfReasons(demos, [title])).toEqual({ makedir: 'Collections hold titles, not folders', rename: 'Rename or delete titles on the Library page', delete: 'Rename or delete titles on the Library page' });
    expect(shelfReasons(L('LIBRARY:/g1', { level: 'title', collectionId: null }), [E('Disk 1', 'disk', 'LIBRARY:/g1/d1')]))
      .toEqual({ makedir: 'Open a disk or STASH: to make a folder in it', rename: 'Rename or delete titles on the Library page', delete: 'Rename or delete titles on the Library page' });
    expect(shelfReasons(stash, [])).toBeNull();
    expect(shelfReasons(diskList, [])).toBeNull();
  });
});
