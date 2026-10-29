import { describe, it, expect } from 'vitest';
import { holdsFiles, addToLibraryReason, offersUndo, placeOf } from './pane-rules';
import type { FsEntry, Listing } from './types';

const L = (path: string, extra: Partial<Listing> = {}): Listing => ({ path, crumbs: [], entries: [], writable: true, readOnlyReason: null, disk: null, meta: '', ...extra });
const E = (name: string, kind: FsEntry['kind'] = 'file', extra: Partial<FsEntry> = {}): FsEntry => ({ name, kind, path: `STASH:/${name}`, size: 1, date: null, protection: null, comment: null, marks: [], ...extra });
const disk = { diskId: 'd1', label: 'Disk 1' } as NonNullable<Listing['disk']>;

describe('holdsFiles', () => {
  it('is true in STASH: and inside a disk, false above the disks', () => {
    expect(holdsFiles(L('STASH:'))).toBe(true);
    expect(holdsFiles(L('STASH:/a.lha/x', { writable: false, readOnlyReason: 'archive' }))).toBe(true);
    expect(holdsFiles(L('LIBRARY:/g1/d1', { disk }))).toBe(true);
    expect(holdsFiles(L('LIBRARY:/g1'))).toBe(false);
    expect(holdsFiles(L('LIBRARY:'))).toBe(false);
    expect(holdsFiles(null)).toBe(false);
  });
});

describe('addToLibraryReason', () => {
  it('asks for disk images only, outside archives', () => {
    expect(addToLibraryReason(L('STASH:'), [])).toBe('Select something first');
    expect(addToLibraryReason(L('STASH:'), [E('Game.adf'), E('Two.DMS')])).toBeNull();
    expect(addToLibraryReason(L('STASH:'), [E('Game.adf'), E('ReadMe')])).toMatch(/Select disk images/);
    expect(addToLibraryReason(L('STASH:'), [E('Mods', 'dir')])).toMatch(/Select disk images/);
    expect(addToLibraryReason(L('STASH:/x.zip', { writable: false, readOnlyReason: 'archive' }), [E('Game.adf')])).toBe('Copy it out of the archive first');
  });
  it('a disk image still arriving, or one that failed, is not yet a file to add', () => {
    expect(addToLibraryReason(L('STASH:'), [E('Game.adf', 'file', { marks: ['arriving 45%'] })])).toMatch(/Select disk images/);
    expect(addToLibraryReason(L('STASH:'), [E('Game.adf', 'file', { marks: ['failed — damaged on the way'] })])).toMatch(/Select disk images/);
  });
  it('only in STASH:', () => {
    expect(addToLibraryReason(L('LIBRARY:/g1/d1', { disk }), [E('Game.adf')])).toBe('Open STASH: to add its disk images to the library');
    expect(addToLibraryReason(null, [E('Game.adf')])).toBe('Open STASH: to add its disk images to the library');
  });
});

describe('offersUndo (STASH: keeps no versions)', () => {
  it('a copy into a disk can be undone; anything that changes STASH: cannot', () => {
    expect(offersUndo('copy', ['STASH:/a.txt'], 'LIBRARY:/g/d')).toBe(true);
    expect(offersUndo('copy', ['LIBRARY:/g/d/a'], 'LIBRARY:/g/d2')).toBe(true);
    expect(offersUndo('copy', ['LIBRARY:/g/d/a'], 'STASH:')).toBe(false);
    expect(offersUndo('move', ['STASH:/a.txt'], 'LIBRARY:/g/d')).toBe(false);
    expect(offersUndo('move', ['LIBRARY:/g/d/a'], 'STASH:/Mods')).toBe(false);
    expect(offersUndo('move', ['LIBRARY:/g/d/a'], 'LIBRARY:/g/d2')).toBe(true);
  });
});

describe('placeOf', () => {
  it('names a disk by its label, STASH: as itself, else the other side', () => {
    expect(placeOf(L('LIBRARY:/g1/d1', { disk }))).toBe('Disk 1');
    expect(placeOf(L('STASH:/Mods'))).toBe('STASH:');
    expect(placeOf(L('LIBRARY:'))).toBe('the other side');
    expect(placeOf(null)).toBe('the other side');
  });
});
