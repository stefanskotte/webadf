import { describe, it, expect } from 'vitest';
import { diffTrees, sectorSummary } from './diff';
import type { AdfEntry } from '@/lib/adffs';

const file = (name: string, sizeBytes = 10, block = 100): AdfEntry => ({
  name, kind: 'file', block, sizeBytes, modifiedAt: new Date(0), protection: '----rwed',
  comment: null, children: [],
});
const dir = (name: string, children: AdfEntry[], block = 200): AdfEntry => ({
  name, kind: 'dir', block, sizeBytes: 0, modifiedAt: new Date(0), protection: '----rwed',
  comment: null, children,
});

describe('diffTrees', () => {
  it('finds nothing between identical trees', () => {
    const t = [file('A'), dir('D', [file('B')])];
    expect(diffTrees(t, t)).toEqual([]);
  });

  it('reports an added file by its full path', () => {
    expect(diffTrees([dir('D', [])], [dir('D', [file('NEW')])]))
      .toEqual([{ path: 'D/NEW', kind: 'added', isDir: false }]);
  });

  it('reports a removed file, and a removed directory as one entry', () => {
    const before = [dir('D', [file('B')]), file('A')];
    expect(diffTrees(before, [file('A')])).toEqual([
      { path: 'D', kind: 'removed', isDir: true },
      { path: 'D/B', kind: 'removed', isDir: false },
    ]);
  });

  it('calls a file changed when its size, its date or its block moved', () => {
    expect(diffTrees([file('A', 10)], [file('A', 20)])[0].kind).toBe('changed');
    const moved = { ...file('A'), block: 999 };
    expect(diffTrees([file('A')], [moved])[0].kind).toBe('changed');
    const touched = { ...file('A'), modifiedAt: new Date(5_000) };
    expect(diffTrees([file('A')], [touched])[0].kind).toBe('changed');
  });

  it('is stable: removed, then changed, then added, each alphabetical', () => {
    const before = [file('GONE'), file('SAME', 1), file('EDIT', 1)];
    const after = [file('SAME', 1), file('EDIT', 2), file('ADDED')];
    expect(diffTrees(before, after).map((c) => `${c.kind}:${c.path}`))
      .toEqual(['removed:GONE', 'changed:EDIT', 'added:ADDED']);
  });

  it('treats a name that changed kind as a removal and an addition', () => {
    const changes = diffTrees([file('X')], [dir('X', [])]);
    expect(changes.map((c) => c.kind).sort()).toEqual(['added', 'removed']);
  });

  it('summarises sectors for a disk with no readable filesystem', () => {
    expect(sectorSummary(1)).toBe('1 sector changed');
    expect(sectorSummary(12)).toBe('12 sectors changed');
  });
});
