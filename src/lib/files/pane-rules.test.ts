import { describe, it, expect } from 'vitest';
import { unsettled, holdsFiles, addToLibraryReason, offersUndo, placeOf, exactPlaceOf, acceptsCopies, netBoardOf, copyOutReason, deleteWords, netReadOnly, failedReason, FAILED_ROW, deleteText, deleteWhere, netVolumeReason, insideDiskPlace, diskPlace, isDiskCrumb, upCrumb, landedPath } from './pane-rules';
import { NET_OPEN_VOLUME, NET_READ_ONLY } from './net-rules';
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
  it('a disk image already in the library is not added again', () => {
    expect(addToLibraryReason(L('STASH:'), [E('Old.adf', 'file', { marks: ['in the library'] })])).toBe('Already in the library');
    expect(addToLibraryReason(L('STASH:'), [E('Game.adf'), E('Old.adf', 'file', { marks: ['in the library'] })])).toBe('Already in the library');
    expect(addToLibraryReason(L('STASH:'), [E('New.adf')])).toBeNull();
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

describe('exactPlaceOf: where Create SysConf will write', () => {
  const crumbs = (...labels: string[]) => labels.map((label) => ({ label, path: label }));
  it('an Amiga volume by its Amiga path', () => {
    expect(exactPlaceOf(L('NET:/w1/Work/Devs', { crumbs: crumbs('NET:', 'A500', 'Work:', 'Devs'),
      net: { board: 'w1', boardName: 'A500', volume: 'Work', amigaPath: 'Work:Devs', readAt: 1, cut: false, browse: null, write: null } }))).toBe('Work:Devs');
  });
  it('a disk by its label and the drawers below it', () => {
    expect(exactPlaceOf(L('LIBRARY:/g1/d1/Devs/Sub', { disk, crumbs: crumbs('LIBRARY:', 'Title', disk.label, 'Devs', 'Sub') }))).toBe(`${disk.label}/Devs/Sub`);
    expect(exactPlaceOf(L('LIBRARY:/g1/d1', { disk, crumbs: crumbs('LIBRARY:', 'Title', disk.label) }))).toBe(disk.label);
  });
  it('a STASH: folder by its path', () => {
    expect(exactPlaceOf(L('STASH:/Boot', {}))).toBe('STASH:/Boot');
  });
});

describe("insideDiskPlace: what the phone's Add files button names", () => {
  const crumbs = (...labels: string[]) => labels.map((label) => ({ label, path: label }));
  const titled = { ...disk, title: 'Empty' };
  it('the title and the disk, then the folders shown', () => {
    expect(insideDiskPlace(L('LIBRARY:/g1/d1', { disk: titled, crumbs: crumbs('LIBRARY:', 'Empty', 'Disk 1') }))).toBe('Empty · Disk 1');
    expect(insideDiskPlace(L('LIBRARY:/g1/d1/Docs/Sub', { disk: titled, crumbs: crumbs('LIBRARY:', 'Empty', 'Disk 1', 'Docs', 'Sub') })))
      .toBe('Empty · Disk 1/Docs/Sub');
  });
  it('a label that already names the title alone', () => {
    const own = { ...disk, title: 'Turrican', label: 'Turrican (Disk 1)' };
    expect(insideDiskPlace(L('LIBRARY:/g1/d1/C', { disk: own, crumbs: crumbs('LIBRARY:', 'Turrican', 'Turrican (Disk 1)', 'C') })))
      .toBe('Turrican (Disk 1)/C');
  });
  it('null outside a disk', () => {
    expect(insideDiskPlace(L('STASH:'))).toBeNull();
    expect(insideDiskPlace(L('LIBRARY:/g1'))).toBeNull();
    expect(insideDiskPlace(null)).toBeNull();
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
  // A board's queue is its Queue folder since NET: volumes (spec 2026-10-30 §4.3).
  const board = (extra: Partial<Listing> = {}) => L('NET:/b1/Queue', { crumbs: [{ label: 'NET:', path: 'NET:' }, { label: 'A500 bench', path: 'NET:/b1' },
    { label: 'Queue', path: 'NET:/b1/Queue' }],
    queue: { deviceId: 'b1', files: 0, bytes: 0 }, ...extra });
  const net = () => L('NET:', { writable: false, readOnlyReason: 'Open a board to send files to it' });
  const row = (marks: string[]) => E('a.txt', 'file', { path: 'NET:/b1/Queue/t1', marks });

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
    expect(netBoardOf(L('NET:/b1'))).toBeNull();
    expect(netBoardOf(L('NET:/b1/Work'))).toBeNull();
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
    expect(offersUndo('copy', ['LIBRARY:/g/d/a'], 'NET:/b1/Queue')).toBe(false);
    expect(offersUndo('copy', ['STASH:/a'], 'NET:/b1/Queue')).toBe(false);
  });

  it('netReadOnly: nothing in NET: is renamed, protected or commented', () => {
    expect(netReadOnly(board())).toBe(true);
    expect(netReadOnly(L('STASH:'))).toBe(false);
  });
});

describe('NET: volumes (spec 2026-10-30 §5)', () => {
  const net = { board: 'b1', boardName: 'A500', volume: 'Work', amigaPath: 'Work:Programs', readAt: null, cut: false, browse: null };
  const volume = L('NET:/b1/Work/Programs', { writable: false, readOnlyReason: NET_READ_ONLY, net });
  const boardRoot = L('NET:/b1', { writable: false, readOnlyReason: NET_OPEN_VOLUME, net: { ...net, volume: null, amigaPath: null } });
  it('a volume that cannot be written to: every command that writes says why', () => {
    expect(netVolumeReason(volume)).toBe('Read-only for now');
    expect(netVolumeReason(boardRoot)).toBeNull();
    expect(netVolumeReason(L('NET:/b1/Queue'))).toBeNull();
    expect(netVolumeReason(L('STASH:'))).toBeNull();
    expect(netVolumeReason(null)).toBeNull();
  });
  it('copies come out of a volume, never out of the queue (R5); the board itself is a list of places', () => {
    expect(copyOutReason(volume)).toBeNull();
    expect(copyOutReason(L('NET:/b1/Queue'))).toBe('Files waiting for the Amiga cannot be copied out');
    expect(copyOutReason(boardRoot)).toBe('Open a volume or Queue');
  });
  it('nothing lands in a volume or on the board root', () => {
    expect(acceptsCopies(volume)).toBe(false);
    expect(acceptsCopies(boardRoot)).toBe(false);
    expect(holdsFiles(volume)).toBe(false);
  });
});

// NET: volumes phase 2 (spec 2026-10-31 §4.1-4.2): a volume of a board that can write takes every change.
describe('NET: volumes, writable (phase 2)', () => {
  const net = { board: 'b1', boardName: 'A500', volume: 'Work', amigaPath: 'Work:Programs', readAt: null, cut: false, browse: null, write: null };
  const writable = L('NET:/b1/Work/Programs', { writable: true, readOnlyReason: null, net });
  const off = L('NET:/b1/Work/Programs', { writable: false, readOnlyReason: 'Writing is off in Transfer', net: { ...net, write: 'Writing is off in Transfer' } });
  it('a writable volume takes copies and its rows are not queue rows; one that cannot says why', () => {
    expect(netVolumeReason(writable)).toBeNull();
    expect(netVolumeReason(off)).toBe('Writing is off in Transfer');
    expect(acceptsCopies(writable)).toBe(true);
    expect(acceptsCopies(off)).toBe(false);
    expect(netReadOnly(writable)).toBe(false);
    expect(netReadOnly(L('NET:/b1/Queue'))).toBe(true);
  });
  it('a delete on the Amiga always asks, names what goes, and says it cannot be undone', () => {
    const vE = (name: string, kind: FsEntry['kind'] = 'file') => E(name, kind, { path: `NET:/b1/Work/${name}` });
    expect(deleteWhere(writable)).toBe('AMIGA');
    expect(deleteText([vE('ReadMe')], 'AMIGA')).toBe('Delete “ReadMe” from the Amiga? This cannot be undone.');
    expect(deleteText([vE('Old', 'dir')], 'AMIGA')).toBe('Delete the drawer “Old” and everything in it from the Amiga? This cannot be undone.');
    expect(deleteText([vE('a'), vE('B', 'dir'), vE('C', 'dir')], 'AMIGA'))
      .toBe('Delete 3 items (2 drawers, with everything in them) from the Amiga? This cannot be undone.');
    expect(deleteText([vE('a'), vE('b')], 'AMIGA')).toBe('Delete 2 items from the Amiga? This cannot be undone.');
    expect(deleteText([vE('a'), vE('B', 'dir')], 'AMIGA')).toBe('Delete 2 items (1 drawer, with everything in it) from the Amiga? This cannot be undone.');
  });
});

describe('LIBRARY: above the disks (Files 2 §3.2)', () => {
  it('deleting collections says their titles stay; a shelf is named by its crumb', () => {
    const c = (n: string) => E(n, 'collection');
    expect(deleteText([c('Demos')], 'LIBRARY:')).toBe('Delete the collection “Demos”? Its titles stay in the library.');
    expect(deleteText([c('Demos'), c('Games')], 'LIBRARY:')).toBe('Delete 2 collections? Their titles stay in the library.');
    expect(deleteWhere({ ...L('LIBRARY:'), library: { level: 'root', collectionId: null } })).toBe('LIBRARY:');
    expect(deleteWhere({ ...L('LIBRARY:/g1/d1', { disk }), library: { level: 'disk', collectionId: null } })).toBe(disk);
    expect(placeOf({ ...L('LIBRARY:/c1'), crumbs: [{ label: 'LIBRARY:', path: 'LIBRARY:' }, { label: 'Demos', path: 'LIBRARY:/c1' }], library: { level: 'collection', collectionId: 'c1' } })).toBe('Demos');
    expect(placeOf({ ...L('LIBRARY:'), crumbs: [{ label: 'LIBRARY:', path: 'LIBRARY:' }], library: { level: 'root', collectionId: null } })).toBe('LIBRARY:');
  });
  it('filing may take a disk image the library already has (R4); Add to library still says so', () => {
    expect(addToLibraryReason(L('STASH:'), [E('Old.adf', 'file', { marks: ['in the library'] })], { filing: true })).toBeNull();
    expect(addToLibraryReason(L('STASH:'), [E('Old.adf', 'file', { marks: ['in the library'] })])).toBe('Already in the library');
  });
});

describe('unsettled: a pane on its way to another place', () => {
  const listing = { path: 'NET:/b/Work' } as Listing;
  it('is unsettled only while loading another place than its listing', () => {
    expect(unsettled({ loading: true, listing, path: 'NET:/b/Work/Monkey' })).toBe(true);
    expect(unsettled({ loading: false, listing, path: 'NET:/b/Work/Monkey' })).toBe(false);   // clears itself
    expect(unsettled({ loading: true, listing, path: 'NET:/b/Work' })).toBe(false);           // a refresh of the same place
    expect(unsettled({ loading: true, listing: null, path: 'NET:/b/Work' })).toBe(false);     // nothing to aim at
  });
});

describe('diskPlace: a disk, and a folder in it, as the drop review names its destination', () => {
  it('the title and the label, then the folder; a label that names its title alone', () => {
    expect(diskPlace({ title: 'Empty', label: 'Disk 1' })).toBe('Empty · Disk 1');
    expect(diskPlace({ title: 'Empty', label: 'Disk 1' }, 'Docs/Sub')).toBe('Empty · Disk 1/Docs/Sub');
    expect(diskPlace({ title: 'Turrican', label: 'Turrican (Disk 1)' }, 'C')).toBe('Turrican (Disk 1)/C');
    expect(diskPlace({ title: '', label: 'Disk 1' })).toBe('Disk 1');
  });
});

describe('isDiskCrumb: the crumb that is the disk image itself', () => {
  it("is the crumb at the listing's diskBase, and no other", () => {
    const l = L('LIBRARY:/g1/d1/Docs', { disk, diskBase: 'LIBRARY:/g1/d1' });
    expect(isDiskCrumb(l, 'LIBRARY:/g1/d1')).toBe(true);
    expect(isDiskCrumb(l, 'LIBRARY:/g1/d1/Docs')).toBe(false);
    expect(isDiskCrumb(l, 'LIBRARY:/g1')).toBe(false);
    expect(isDiskCrumb(L('LIBRARY:/g1'), 'LIBRARY:/g1')).toBe(false);
    expect(isDiskCrumb(null, 'LIBRARY:/g1/d1')).toBe(false);
  });
});

describe('a title with one disk opens straight into it (ruling 2026-11-16)', () => {
  const root = { label: 'LIBRARY:', path: 'LIBRARY:' };
  const title = { label: 'Mouseski Keyboard', path: 'LIBRARY:/g', through: true };
  const diskCrumb = { label: 'Mouseski Keyboard', path: 'LIBRARY:/g/d' };
  const atDisk = L('LIBRARY:/g/d', { crumbs: [root, title, diskCrumb], diskBase: 'LIBRARY:/g/d' });
  it('upCrumb passes over the title: up from the disk is LIBRARY: or the collection', () => {
    expect(upCrumb(atDisk.crumbs)).toEqual(root);
    expect(upCrumb([root, { label: 'C', path: 'LIBRARY:/c' }, { ...title, path: 'LIBRARY:/c/g' }, { ...diskCrumb, path: 'LIBRARY:/c/g/d' }])?.path).toBe('LIBRARY:/c');
    expect(upCrumb([...atDisk.crumbs, { label: 'Docs', path: 'LIBRARY:/g/d/Docs' }])).toEqual(diskCrumb);
  });
  it('upCrumb keeps a multi-disk title, and is null at a root', () => {
    expect(upCrumb([root, { label: 'Gods', path: 'LIBRARY:/g' }, { label: 'Disk 2', path: 'LIBRARY:/g/d2' }])?.path).toBe('LIBRARY:/g');
    expect(upCrumb([root])).toBeNull();
    expect(upCrumb([])).toBeNull();
  });
  it('landedPath: asked for the title, the pane is at its disk', () => {
    expect(landedPath('LIBRARY:/g', atDisk)).toBe('LIBRARY:/g/d');
    expect(landedPath('LIBRARY:/g/', atDisk)).toBe('LIBRARY:/g/d');
    expect(landedPath('LIBRARY:/g/d', atDisk)).toBe('LIBRARY:/g/d');
  });
  it('landedPath: a folder inside the disk is not the title\'s place, though its crumbs pass the title (review 2026-11-16)', () => {
    const atDisk2 = L('LIBRARY:/g/d', { crumbs: [root, title, diskCrumb], diskBase: 'LIBRARY:/g/d' });
    expect(landedPath('LIBRARY:/g', atDisk2)).toBe('LIBRARY:/g/d');
    const sub = L('LIBRARY:/g/d/Sub', { crumbs: [root, title, diskCrumb, { label: 'Sub', path: 'LIBRARY:/g/d/Sub' }], diskBase: 'LIBRARY:/g/d' });
    expect(landedPath('LIBRARY:/g', sub)).toBe('LIBRARY:/g');
  });
  it('landedPath: any other answer is where it asked', () => {
    expect(landedPath('LIBRARY:/x', atDisk)).toBe('LIBRARY:/x');
    const multi = L('LIBRARY:/g/d', { crumbs: [root, { label: 'Gods', path: 'LIBRARY:/g' }, diskCrumb] });
    expect(landedPath('LIBRARY:/g', multi)).toBe('LIBRARY:/g');
  });
});
