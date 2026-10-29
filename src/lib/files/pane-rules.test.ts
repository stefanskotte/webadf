import { describe, it, expect } from 'vitest';
import { holdsFiles, addToLibraryReason, offersUndo, placeOf, acceptsCopies, netBoardOf, copyOutReason, deleteWords, netReadOnly, failedReason, FAILED_ROW } from './pane-rules';
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

describe('failedReason', () => {
  it('names a picked row that failed to arrive, and nothing else', () => {
    expect(failedReason([E('a.txt'), E('Bad.adf', 'file', { marks: ['from Bench', 'failed — damaged on the way: send it again'] })])).toBe(FAILED_ROW);
    expect(failedReason([E('a.txt', 'file', { marks: ['from Bench', 'arriving 40%'] }), E('Dir', 'dir')])).toBeNull();
    expect(failedReason([])).toBeNull();
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

describe('NET: in the panes (increment 3, Task 2)', () => {
  const board = (extra: Partial<Listing> = {}) => L('NET:/b1', { crumbs: [{ label: 'NET:', path: 'NET:' }, { label: 'A500 bench', path: 'NET:/b1' }],
    queue: { deviceId: 'b1', files: 0, bytes: 0 }, ...extra });
  const net = () => L('NET:', { writable: false, readOnlyReason: 'Open a board to send files to it' });
  const row = (marks: string[]) => E('a.txt', 'file', { path: 'NET:/b1/t1', marks });

  it('holdsFiles stays false in NET: (C2: no folders, no drag out, no STASH: commit); acceptsCopies takes a board', () => {
    expect(holdsFiles(board())).toBe(false);
    expect(holdsFiles(net())).toBe(false);
    expect(acceptsCopies(board())).toBe(true);
    expect(acceptsCopies(net())).toBe(false);
    expect(acceptsCopies(L('STASH:/Mods'))).toBe(true);
    expect(acceptsCopies(L('LIBRARY:/g1/d1', { disk }))).toBe(true);
    expect(acceptsCopies(L('LIBRARY:/g1'))).toBe(false);
    expect(acceptsCopies(null)).toBe(false);
    expect(netBoardOf(board())).toBe('b1');
    expect(netBoardOf(net())).toBeNull();
    expect(netBoardOf(L('STASH:'))).toBeNull();
  });

  it('copyOutReason: nothing leaves NET:', () => {
    expect(copyOutReason(board())).toBe('Files waiting for the Amiga cannot be copied out');
    expect(copyOutReason(net())).toBe('Files waiting for the Amiga cannot be copied out');
    expect(copyOutReason(L('STASH:'))).toBeNull();
    expect(copyOutReason(null)).toBeNull();
  });

  it('deleteWords counts what is cancelled (waiting or sending) and what is cleared', () => {
    expect(deleteWords([row(['Waiting']), row(['Sending 40 %']), row(['Delivered · saved as a.txt'])], board()))
      .toBe('Cancel 2 waiting files and clear 1 finished?');
    expect(deleteWords([row(['Waiting'])], board())).toBe('Cancel 1 waiting file?');
    expect(deleteWords([row(['Failed · disk full']), row(['Cancelled'])], board())).toBe('Clear 2 finished files?');
    expect(deleteWords([row(['Expired · the Amiga did not take it within 24 h'])], board())).toBe('Clear 1 finished file?');
    // Elsewhere, increment 1's and 2's words.
    expect(deleteWords([E('a')], L('STASH:'))).toBe('Delete “a” from STASH:? This cannot be undone.');
    expect(deleteWords([E('ReadMe')], L('LIBRARY:/g1/d1', { disk: { ...disk, title: 'SysInfo' } })))
      .toBe('Delete “ReadMe” from SysInfo · Disk 1? A new version keeps the old ones.');
  });

  it('a copy into NET: names the board, and offers no Undo', () => {
    expect(placeOf(board())).toBe('A500 bench');
    expect(offersUndo('copy', ['LIBRARY:/g/d/a'], 'NET:/b1')).toBe(false);
    expect(offersUndo('copy', ['STASH:/a'], 'NET:/b1')).toBe(false);
  });

  it('netReadOnly: nothing in NET: is renamed, protected or commented', () => {
    expect(netReadOnly(board())).toBe(true);
    expect(netReadOnly(L('STASH:'))).toBe(false);
  });
});
