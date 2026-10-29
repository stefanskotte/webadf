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

describe('diskRelative and withAddedIn (Files Task 9b; Files 2 R2: read under the listing\'s diskBase)', () => {
  it('a path inside the disk, from the disk root, also through a collection', () => {
    expect(diskRelative('LIBRARY:/g/d/Docs/Read me', 'LIBRARY:/g/d')).toBe('Docs/Read me');
    expect(diskRelative('LIBRARY:/c1/g1/d1/C/Assign', 'LIBRARY:/c1/g1/d1')).toBe('C/Assign');
    expect(diskRelative('LIBRARY:/c1/g1/d1', 'LIBRARY:/c1/g1/d1')).toBe('');
  });
  it('null outside the disk, without a base, and for a sibling whose name starts the same', () => {
    expect(diskRelative('LIBRARY:/g1/d10/x', 'LIBRARY:/g1/d1')).toBeNull();
    expect(diskRelative('LIBRARY:/g1/d1/x', null)).toBeNull();
    expect(diskRelative('LIBRARY:/g1/d1/x', undefined)).toBeNull();
    expect(diskRelative('STASH:/x', 'LIBRARY:/g1/d1')).toBeNull();
  });
  it('marks the entries the History says a version added, by their path under the base', () => {
    const out = withAddedIn([entry('LIBRARY:/g/d/Docs/A'), entry('LIBRARY:/g/d/Docs/B')], new Map([['Docs/B', 2], ['A', 1]]), 'LIBRARY:/g/d');
    expect(out.map((e) => e.addedIn ?? null)).toEqual([null, 2]);
    expect(withAddedIn([entry('LIBRARY:/c1/g1/d1/C/Assign')], new Map([['C/Assign', 3]]), 'LIBRARY:/c1/g1/d1')[0].addedIn).toBe(3);
  });
  it('no marks leaves the entries as they were', () => {
    const list = [entry('LIBRARY:/g/d/A')];
    expect(withAddedIn(list, new Map(), 'LIBRARY:/g/d')).toBe(list);
  });
});
