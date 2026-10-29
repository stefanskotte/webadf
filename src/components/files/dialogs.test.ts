import { describe, it, expect } from 'vitest';
import type { FsEntry } from '@/lib/files/types';
import { deleteText, deleteWhat } from './dialogs';

const file = (name: string): FsEntry => ({ name, kind: 'file', path: `LIBRARY:/g/d/${name}`, size: 1, date: null,
  protection: '----rwed', comment: null, marks: [] });
const dir = (name: string, files: number, folders: number): FsEntry => ({ ...file(name), kind: 'dir', size: null,
  inside: { files, folders } });

describe('deleteWhat', () => {
  it('names one file', () => expect(deleteWhat([file('ReadMe')])).toBe('“ReadMe”'));
  it('names an empty folder alone', () => expect(deleteWhat([dir('S', 0, 0)])).toBe('“S”'));
  it('names a folder and what is in it', () => {
    expect(deleteWhat([dir('C', 2, 0)])).toBe('“C” and the 2 files in it');
    expect(deleteWhat([dir('C', 1, 1)])).toBe('“C” and the 1 file and 1 folder in it');
  });
  it('counts a selection with everything inside its folders', () => {
    expect(deleteWhat([dir('C', 2, 0), file('ReadMe')])).toBe('3 files and 1 folder');
    expect(deleteWhat([file('a'), file('b')])).toBe('2 files');
    expect(deleteWhat([dir('A', 0, 1), dir('B', 0, 0)])).toBe('3 folders');
  });
});

describe('deleteText (increment 2 ruling 8)', () => {
  it('a disk keeps the old version; STASH: has none, so it says it cannot be undone', () => {
    expect(deleteText([file('ReadMe')], { title: 'SysInfo', label: 'Disk 1' }))
      .toBe('Delete “ReadMe” from SysInfo · Disk 1? A new version keeps the old ones.');
    expect(deleteText([file('a'), dir('B', 0, 0)], 'STASH:')).toBe('Delete 2 items from STASH:? This cannot be undone.');
    expect(deleteText([file('a')], 'STASH:')).toBe('Delete “a” from STASH:? This cannot be undone.');
  });
});

describe('deleteText in NET: (increment 3, Task 2)', () => {
  it('says what is cancelled and what is cleared, with no promise of versions', () => {
    const row = (marks: string[]): FsEntry => ({ ...file('a.txt'), path: 'NET:/b1/t', marks });
    expect(deleteText([row(['Waiting']), row(['Delivered · saved as a.txt'])], 'NET:')).toBe('Cancel 1 waiting file and clear 1 finished?');
  });
});
