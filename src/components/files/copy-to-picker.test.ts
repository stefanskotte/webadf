import { describe, it, expect } from 'vitest';
import type { FsEntry, Listing } from '@/lib/files/types';
import { hereLabel, pickReason, placesIn } from './copy-to-picker';

const entry = (name: string, kind: FsEntry['kind']): FsEntry => ({
  name, kind, path: `LIBRARY:/g/d/${name}`, size: kind === 'file' ? 10 : null, date: null, protection: null, comment: null, marks: [],
});
const disk = {
  diskId: 'd', gameId: 'g', title: 'SysInfo', label: 'Disk 1', filesystem: 'FFS', hd: false, volumeName: 'SI', holder: null,
  usedBytes: 0, freeBytes: 0, totalBytes: 0, tosecName: null,
} as unknown as NonNullable<Listing['disk']>;
const listing = (o: Partial<Listing>): Listing => ({
  path: 'LIBRARY:/g/d', crumbs: [{ label: 'LIBRARY:', path: 'LIBRARY:' }], entries: [], writable: true, readOnlyReason: null,
  disk, meta: '', ...o,
});

describe('CopyToPicker (Files increment 1, Task 10)', () => {
  it('only a writable folder inside a disk or in STASH: takes the copy', () => {
    expect(pickReason('copy', listing({}))).toBeNull();
    expect(pickReason('copy', listing({ disk: null }))).toBe('Open a disk or STASH: to copy into it');
    expect(pickReason('move', listing({ disk: null }))).toBe('Open a disk or STASH: to move into it');
    expect(pickReason('copy', listing({ path: 'STASH:/Mods', disk: null }))).toBeNull();
    expect(pickReason('copy', listing({ path: 'STASH:/t.zip', disk: null, writable: false, readOnlyReason: 'archive' })))
      .toBe('Archives are read-only — copy files out of them.');
    expect(pickReason('copy', listing({ writable: false, readOnlyReason: 'write_protected' }))).toMatch(/\S/);
    expect(pickReason('copy', null)).toBeNull();   // still loading: no reason yet, and Copy here stays off
  });

  it('offers the folders, titles and disks to go into, by name, never the files or archives', () => {
    const l = listing({ entries: [entry('zeta', 'dir'), entry('ReadMe', 'file'), entry('Alpha', 'dir'), entry('Disk 2', 'disk'), entry('t.zip', 'archive')] });
    expect(placesIn(l).map((e) => e.name)).toEqual(['Alpha', 'Disk 2', 'zeta']);
  });

  it('NET: boards are places; inside one, Copy sends and Move is refused (increment 3, Task 2)', () => {
    const board = listing({ path: 'NET:/b1/Queue', disk: null, queue: { deviceId: 'b1', files: 0, bytes: 0 } });
    expect(pickReason('copy', board)).toBeNull();
    expect(pickReason('move', board)).toBe('Files sent to the Amiga stay where they are — use Copy');
    expect(pickReason('copy', listing({ path: 'NET:', disk: null, writable: false, readOnlyReason: 'Open a board to send files to it' })))
      .toBe('Open a board to send files to it');
    const boards = listing({ path: 'NET:', disk: null, entries: [{ ...entry('A500', 'board'), path: 'NET:/b1' }] });
    expect(placesIn(boards).map((e) => e.kind)).toEqual(['board']);
    expect(hereLabel('copy', board)).toBe('Send here');
    expect(hereLabel('copy', listing({}))).toBe('Copy here');
    expect(hereLabel('move', listing({}))).toBe('Move here');
  });

  it('a filing picks a shelf by the manager\'s rule (Files 2)', () => {
    const root = listing({ path: 'LIBRARY:', disk: null, writable: false, library: { level: 'root', collectionId: null } });
    expect(pickReason('move', root, () => null)).toBeNull();
    expect(pickReason('copy', root, () => 'It is in the library already')).toBe('It is in the library already');
    expect(pickReason('copy', root, () => undefined)).toBe('Open a disk or STASH: to copy into it');
    expect(pickReason('copy', root)).toBe('Open a disk or STASH: to copy into it');
    expect(pickReason('copy', null, () => 'x')).toBeNull();
  });

  it('collections come first in the Library\'s order, then the rest by name (D10)', () => {
    const c = (name: string) => ({ ...entry(name, 'collection'), path: `LIBRARY:/${name}` });
    const l = listing({ path: 'LIBRARY:', disk: null, entries: [c('Zeta'), c('Alpha'), entry('Bravo', 'title'), entry('Able', 'title')] });
    expect(placesIn(l).map((e) => e.name)).toEqual(['Zeta', 'Alpha', 'Able', 'Bravo']);
  });
});
