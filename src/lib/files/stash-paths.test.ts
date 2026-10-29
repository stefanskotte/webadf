// src/lib/files/stash-paths.test.ts
import { describe, it, expect } from 'vitest';
import { amigaDateText, dateOfAmigaText, stashTree, stashFind, rowsUnder, uniqueStashPath, keepBothName } from './stash-paths';

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
