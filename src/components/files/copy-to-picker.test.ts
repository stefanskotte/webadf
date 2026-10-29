import { describe, it, expect } from 'vitest';
import type { FsEntry, Listing } from '@/lib/files/types';
import { pickReason, placesIn } from './copy-to-picker';

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

});
