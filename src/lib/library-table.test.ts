import { describe, it, expect } from 'vitest';
import { tableRows, emptyTableNote, titleMeta } from './library-table';

const A = { id: 'c-a', name: 'Demos' };
const B = { id: 'c-b', name: 'Games' };
const g1 = { id: 'g-1' };
const g2 = { id: 'g-2' };

describe('tableRows', () => {
  it('at the library root: one folder per collection, in their own order, then the uncategorized titles', () => {
    expect(tableRows({ kind: 'uncategorized' }, [B, A], [g1, g2])).toEqual([
      { kind: 'folder', collection: B },
      { kind: 'folder', collection: A },
      { kind: 'title', game: g1 },
      { kind: 'title', game: g2 },
    ]);
  });

  it('the folders are on the first page only, like a file browser listing folders first (library paging)', () => {
    expect(tableRows({ kind: 'uncategorized' }, [B, A], [g1, g2], { firstPage: false })).toEqual([
      { kind: 'title', game: g1 },
      { kind: 'title', game: g2 },
    ]);
    expect(tableRows({ kind: 'uncategorized' }, [A], [g1], { firstPage: true })[0]).toEqual({ kind: 'folder', collection: A });
  });

  it('the up row is on every page', () => {
    expect(tableRows({ kind: 'collection', id: 'c-a' }, [A], [g2], { firstPage: false })).toEqual([{ kind: 'up' }, { kind: 'title', game: g2 }]);
  });

  it('an empty inbox still shows the folders, and no collections shows only the titles', () => {
    expect(tableRows({ kind: 'uncategorized' }, [A], [])).toEqual([{ kind: 'folder', collection: A }]);
    expect(tableRows({ kind: 'uncategorized' }, [], [g1])).toEqual([{ kind: 'title', game: g1 }]);
    expect(tableRows({ kind: 'uncategorized' }, [], [])).toEqual([]);
  });

  it('inside a collection: up to the library first, then its titles, and no folders', () => {
    expect(tableRows({ kind: 'collection', id: 'c-a' }, [A, B], [g2, g1])).toEqual([
      { kind: 'up' },
      { kind: 'title', game: g2 },
      { kind: 'title', game: g1 },
    ]);
    // An empty collection is still somewhere you can leave.
    expect(tableRows({ kind: 'collection', id: 'c-a' }, [A], [])).toEqual([{ kind: 'up' }]);
  });

  it('All titles: up to the library, then every title flat', () => {
    expect(tableRows({ kind: 'all' }, [A, B], [g1, g2])).toEqual([
      { kind: 'up' },
      { kind: 'title', game: g1 },
      { kind: 'title', game: g2 },
    ]);
  });
});

describe('emptyTableNote', () => {
  it('says a collection is empty and how to fill it', () => {
    expect(emptyTableNote({ kind: 'collection', id: 'c1' }, 0)).toMatch(/no titles in this collection/i);
  });
  it('says the library is empty in All titles', () => {
    expect(emptyTableNote({ kind: 'all' }, 0)).toMatch(/no titles yet/i);
    // The Upload page retired (Files increment 3): the note points at the Library's own Add disks.
    expect(emptyTableNote({ kind: 'all' }, 0)).toBe('No titles yet. Drop disks anywhere on this page, or use Add disks.');
  });
  it('is null when there are titles, and at the root (folders or the empty-library state speak there)', () => {
    expect(emptyTableNote({ kind: 'collection', id: 'c1' }, 2)).toBeNull();
    expect(emptyTableNote({ kind: 'uncategorized' }, 0)).toBeNull();
  });
});

describe('titleMeta (C7 spec §4.3, Plan ruling)', () => {
  const g = { kind: 'Game', year: 1991, publisher: 'Team 17', diskCount: 2, sizeBytes: 1_802_240, hasHd: false };
  it('joins the hidden columns with " · ", in column order', () => {
    expect(titleMeta(g)).toBe('Game · 1991 · Team 17 · 2 disks · 1.72 MB');
  });
  it('skips what is unknown, and says 1 disk and HD in words', () => {
    expect(titleMeta({ ...g, kind: null, year: null, publisher: null, diskCount: 1, sizeBytes: 901_120 })).toBe('1 disk · 880 KB');
    expect(titleMeta({ ...g, hasHd: true })).toBe('Game · 1991 · Team 17 · 2 disks · 1.72 MB HD');
  });
});
