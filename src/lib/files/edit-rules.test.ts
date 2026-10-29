import { describe, expect, it } from 'vitest';
import type { DiskInfo, FsEntry } from './types';
import { diskRelative, identityToConfirm, undoTarget, withAddedIn } from './edit-rules';

const disk = (diskId: string, tosecName: string | null): DiskInfo => ({
  diskId, gameId: 'g', title: 'T', label: 'Disk 1', filesystem: 'OFS', hd: false, usedBytes: 0, freeBytes: 0, totalBytes: 0,
  holder: null, imageFormat: 'adf', volumeName: 'V', sha256: 'a'.repeat(64), intl: false, tosecName,
});
const entry = (path: string): FsEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', path, size: 1, date: null, protection: null, comment: null, marks: [],
});

describe('undoTarget (Files Task 9b)', () => {
  it('one disk written: Undo puts back the version before the one this op saved', () => {
    expect(undoTarget([{ diskId: 'd1', seq: 4 }])).toEqual({ diskId: 'd1', seq: 4 });
  });
  it('two disks written (a move between disks): no Undo', () => {
    expect(undoTarget([{ diskId: 'd1', seq: 4 }, { diskId: 'd2', seq: 2 }])).toBeNull();
  });
  it('two versions of one disk: Undo of the last alone would not undo the op, so none', () => {
    expect(undoTarget([{ diskId: 'd1', seq: 4 }, { diskId: 'd1', seq: 5 }])).toBeNull();
  });
  it('nothing written, or a version 0 that has nothing before it: no Undo', () => {
    expect(undoTarget([])).toBeNull();
    expect(undoTarget([{ diskId: 'd1', seq: 0 }])).toBeNull();
  });
});

describe('identityToConfirm (Files Task 9b)', () => {
  it('asks for the first disk with a TOSEC identity not yet confirmed this visit', () => {
    const a = disk('a', null); const b = disk('b', 'Game (1990)(Pub).adf'); const c = disk('c', 'Other.adf');
    expect(identityToConfirm([a, b, c], new Set())).toBe(b);
    expect(identityToConfirm([a, b, c], new Set(['b']))).toBe(c);
    expect(identityToConfirm([a, b, c], new Set(['b', 'c']))).toBeNull();
  });
  it('a place that is not a disk asks nothing', () => {
    expect(identityToConfirm([null, undefined], new Set())).toBeNull();
  });
});

describe('diskRelative and withAddedIn (Files Task 9b)', () => {
  it('a LIBRARY: path inside a disk, from the disk root; above the disks, null', () => {
    expect(diskRelative('LIBRARY:/g/d/Docs/Read me')).toBe('Docs/Read me');
    expect(diskRelative('LIBRARY:/g/d')).toBe('');
    expect(diskRelative('LIBRARY:/g')).toBeNull();
  });
  it('marks the entries the History says a version added, by their path on the disk', () => {
    const out = withAddedIn([entry('LIBRARY:/g/d/Docs/A'), entry('LIBRARY:/g/d/Docs/B')], new Map([['Docs/B', 2], ['A', 1]]));
    expect(out.map((e) => e.addedIn ?? null)).toEqual([null, 2]);
  });
  it('no marks leaves the entries as they were', () => {
    const list = [entry('LIBRARY:/g/d/A')];
    expect(withAddedIn(list, new Map())).toBe(list);
  });
});
