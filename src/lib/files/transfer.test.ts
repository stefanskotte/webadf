import { describe, it, expect } from 'vitest';
import { clashGroups, downloadHref } from './transfer';
import type { FsEntry } from './types';

describe('clashGroups', () => {
  const src = ['A', 'B', 'C'];
  it('one answer for all is one request with every source', () => {
    expect(clashGroups(src, ['A', 'B'], { A: 'replace', B: 'replace' })).toEqual([{ onClash: 'replace', sources: src }]);
    expect(clashGroups(src, ['A'], { A: 'skip' })).toEqual([{ onClash: 'skip', sources: src }]);
  });
  it('mixed answers: one request per answer, skipped left out, clash-free with the first', () => {
    expect(clashGroups(src, ['A', 'B'], { A: 'keep-both', B: 'replace' }))
      .toEqual([{ onClash: 'keep-both', sources: ['A', 'C'] }, { onClash: 'replace', sources: ['B'] }]);
    expect(clashGroups(src, ['A', 'B'], { A: 'skip', B: 'replace' })).toEqual([{ onClash: 'replace', sources: ['B', 'C'] }]);
  });
});

describe('downloadHref', () => {
  const e = (name: string, kind: FsEntry['kind']): FsEntry => ({ name, kind, path: `LIBRARY:/g/d/${name}`, size: null, date: null, protection: null, comment: null, marks: [] });
  it('one file by path', () => {
    expect(downloadHref([e('ReadMe', 'file')], 'Disk 1')).toBe('/api/files/download?path=LIBRARY%3A%2Fg%2Fd%2FReadMe');
  });
  it('one archive is one file too, never zipped (increment 2)', () => {
    expect(downloadHref([e('t.zip', 'archive')], 'STASH:')).toBe('/api/files/download?path=LIBRARY%3A%2Fg%2Fd%2Ft.zip');
  });
  it('several, or a folder, as a zip named after the folder', () => {
    const q = new URLSearchParams(downloadHref([e('A', 'file'), e('S', 'dir')], 'Disk 1').split('?')[1]);
    expect(q.getAll('paths')).toEqual(['LIBRARY:/g/d/A', 'LIBRARY:/g/d/S']);
    expect(q.get('name')).toBe('Disk 1');
    expect(new URLSearchParams(downloadHref([e('S', 'dir')], 'C').split('?')[1]).getAll('paths')).toEqual(['LIBRARY:/g/d/S']);
  });
});
