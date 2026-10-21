import { describe, it, expect } from 'vitest';
import { tableRows } from './library-table';

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
