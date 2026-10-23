import { describe, it, expect } from 'vitest';
import type { HistoryVersion } from './history';
import type { TreeChange } from './diff';
import { addedIn } from './added-in';

const v = (seq: number, changes: TreeChange[], source?: HistoryVersion['source']): HistoryVersion => ({
  seq, kind: 'delta', source: source ?? (seq === 0 ? 'original' : 'browser'), label: '', createdAt: new Date(0),
  imageSha256: '', sectorCount: 0, rewindOf: null, changes, sectorNote: null, isHead: false,
});
const add = (path: string, isDir = false): TreeChange => ({ path, kind: 'added', isDir });

describe('addedIn', () => {
  it('names the version that added each entry still on the disk, whatever order history arrives in', () => {
    const m = addedIn([v(3, [add('b.txt')]), v(2, [add('S', true), add('S/x')]), v(0, [])]);
    expect(Object.fromEntries(m)).toEqual({ 'b.txt': 3, S: 2, 'S/x': 2 });
  });

  it('an entry removed later loses its mark, and one added again takes the newer version', () => {
    const m = addedIn([
      v(1, [add('a'), add('gone')]),
      v(2, [{ path: 'a', kind: 'removed', isDir: false }, { path: 'gone', kind: 'removed', isDir: false }]),
      v(4, [add('a')]),
    ]);
    expect(Object.fromEntries(m)).toEqual({ a: 4 });
  });

  it('a changed file keeps the mark its add gave it, and gets none otherwise', () => {
    const m = addedIn([v(1, [add('a')]), v(2, [{ path: 'a', kind: 'changed', isDir: false }, { path: 'orig', kind: 'changed', isDir: false }])]);
    expect(Object.fromEntries(m)).toEqual({ a: 1 });
  });

  it('a restore (an Undo) puts back the mark an entry had, and gives none to what was on the original', () => {
    const del = (path: string): TreeChange => ({ path, kind: 'removed', isDir: false });
    const m = addedIn([
      v(1, [add('mine')]),
      v(2, [del('mine'), del('orig')]),
      v(3, [add('mine'), add('orig')], 'rewind'),
    ]);
    expect(Object.fromEntries(m)).toEqual({ mine: 1 });
  });
});
