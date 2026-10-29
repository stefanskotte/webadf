import { describe, it, expect } from 'vitest';
import type { FsEntry } from '@/lib/files/types';
import { deleteWhat } from './dialogs';

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
