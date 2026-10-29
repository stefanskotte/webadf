// src/lib/files/stash-paths.test.ts
import { describe, it, expect } from 'vitest';
import { amigaDateText, dateOfAmigaText, stashTree, stashFind, rowsUnder, uniqueStashPath, keepBothName, planStashBatches } from './stash-paths';

describe('Amiga date text', () => {
  it('round-trips to the tick and matches what the board sends', () => {
    const d = new Date(Date.UTC(2026, 9, 29, 12, 34, 56, 780));
    expect(dateOfAmigaText(amigaDateText(d))!.toISOString()).toBe('2026-10-29T12:34:56.780Z');
    expect(dateOfAmigaText('17000.600.0')!.toISOString()).toBe('2024-07-18T10:00:00.000Z');
  });
  it('refuses junk and out-of-range values', () => {
    for (const s of ['', '1.2', 'a.b.c', '1.1440.0', '1.0.3000']) expect(dateOfAmigaText(s), s).toBeNull();
  });
});

const r = (path: string, kind: 'file' | 'dir' = 'file') => ({ path, kind });

describe('stashTree', () => {
  it('builds implicit folders and finds case-insensitively', () => {
    const t = stashTree([r('Mods/a.mod'), r('Mods/Old/b.mod'), r('ReadMe'), r('Empty', 'dir')]);
    expect(t.children.map((c) => [c.name, c.kind, c.row])).toEqual([['Mods', 'dir', null], ['ReadMe', 'file', 2], ['Empty', 'dir', 3]]);
    expect(stashFind(t, ['mods', 'old', 'B.MOD'])!.row).toBe(1);
    expect(rowsUnder(stashFind(t, ['Mods'])!).sort()).toEqual([0, 1]);
    expect(stashFind(t, ['ReadMe', 'x'])).toBeNull();
  });
  it('builds a 4000-member tree in well under a second, distinct names and twins alike', () => {
    for (const rows of [Array.from({ length: 4000 }, (_, i) => r(`Dir/f${i}.txt`)), Array.from({ length: 4000 }, () => r('Dir/same.txt'))]) {
      const t0 = performance.now();
      const t = stashTree(rows);
      expect(performance.now() - t0).toBeLessThan(1000);
      const names = t.children[0].children.map((c) => c.name.toLowerCase());
      expect([names.length, new Set(names).size]).toEqual([4000, 4000]);
    }
    expect(stashTree([r('a.txt'), r('A.TXT'), r('a.txt')]).children.map((c) => c.name)).toEqual(['a.txt', 'A_1.TXT', 'a_2.txt']);
  });
  it('the tree names legacy twins apart: the oldest keeps the name', () => {
    const t = stashTree([r('ReadMe'), r('readme'), r('Mods'), r('Mods/a.mod')]);
    expect(t.children.map((c) => [c.name, c.row])).toEqual([['ReadMe', 0], ['readme_1', 1], ['Mods', 2], ['Mods_1', null]]);
    expect(stashFind(t, ['Mods_1', 'a.mod'])!.row).toBe(3);
  });
  it('a dir row for a folder that also has files is that folder', () => {
    const t = stashTree([r('S', 'dir'), r('S/Startup')]);
    expect(t.children).toHaveLength(1);
    expect(t.children[0]).toMatchObject({ name: 'S', kind: 'dir', row: 0 });
  });
});

describe('uniqueStashPath', () => {
  const rows = [r('ReadMe'), r('Mods/a.mod'), r('Tools', 'dir')];
  it('keeps a free path and joins an existing folder in its own spelling', () => {
    expect(uniqueStashPath(rows, 'New.txt')).toBe('New.txt');
    expect(uniqueStashPath(rows, 'mods/b.mod')).toBe('Mods/b.mod');
  });
  it('renames a clashing leaf, and a folder segment that clashes with a file', () => {
    expect(uniqueStashPath(rows, 'readme')).toBe('readme_1');
    expect(uniqueStashPath(rows, 'ReadMe/x.txt')).toBe('ReadMe_1/x.txt');
    expect(uniqueStashPath(rows, 'Mods')).toBe('Mods_1');
  });
  it('keepBothName numbers before the extension', () => {
    expect(keepBothName('a.txt', () => false)).toBe('a_1.txt');
  });
});

describe('planStashBatches', () => {
  const MB = 1024 * 1024;
  const f = (path: string, mb: number) => ({ path, kind: 'file' as const, sizeBytes: Math.round(mb * MB) });
  it('keeps a folder in one batch and packs tops up to 64 MB', () => {
    // (The brief's 30 MB files are over the 20 MB a file: three of 19 MB make the 57 MB folder.)
    const { batches, refused } = planStashBatches([f('A/1', 19), f('A/2', 19), f('A/3', 19), f('b', 10), f('c', 10)]);
    expect(batches.map((b) => b.map((x) => x.path))).toEqual([['A/1', 'A/2', 'A/3'], ['b', 'c']]);
    expect(refused).toEqual([]);
  });
  it('refuses a file over 20 MB and a folder over 64 MB, and packs at most 200 entries', () => {
    const { batches, refused } = planStashBatches([f('big.iso', 21), f('F/a', 19), f('F/b', 19), f('F/c', 19), f('F/d', 19),
      ...Array.from({ length: 250 }, (_, i) => f(`t${i}`, 0.001))]);
    expect(refused).toEqual([{ path: 'big.iso', why: 'too_large' }, { path: 'F', why: 'folder_too_large' }]);
    expect(batches.map((b) => b.length)).toEqual([200, 50]);
  });
  it('refuses a single folder of more than 200 entries (ruling 12), counting the folder itself', () => {
    const dir = (path: string) => ({ path, kind: 'dir' as const, sizeBytes: 0 });
    const big = [dir('Big'), ...Array.from({ length: 200 }, (_, i) => f(`Big/${i}`, 0))];
    const fits = [dir('Fits'), ...Array.from({ length: 199 }, (_, i) => f(`Fits/${i}`, 0))];
    const { batches, refused } = planStashBatches([...big, ...fits, f('x', 1)]);
    expect(refused).toEqual([{ path: 'Big', why: 'folder_too_many' }]);
    expect(batches.map((b) => b.length)).toEqual([200, 1]);
  });
  it('takes empty files and empty folders, and keeps the rest of a folder when one file in it is too large', () => {
    const { batches, refused } = planStashBatches([f('README', 0), { path: 'Empty', kind: 'dir', sizeBytes: 0 },
      { path: 'D', kind: 'dir', sizeBytes: 0 }, f('D/huge', 25), f('D/ok', 1)]);
    expect(refused).toEqual([{ path: 'D/huge', why: 'too_large' }]);
    expect(batches.map((b) => b.map((x) => x.path))).toEqual([['README', 'Empty', 'D', 'D/ok']]);
  });
});
