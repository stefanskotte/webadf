import { describe, it, expect } from 'vitest';
import { searchKindWord, searchTitleSub, searchEmptyText } from '@/lib/search-look';

const t = (o: Partial<Parameters<typeof searchTitleSub>[0]> = {}) =>
  ({ kind: null, authored: false, year: null, publisher: null, diskCount: 1, collections: [], ...o });

describe('search rows (C5 spec §5.4, Ruling 25)', () => {
  it('the kind word: the kind, else Made here, else Unidentified', () => {
    expect(searchKindWord({ kind: 'Game', authored: true })).toBe('Game');
    expect(searchKindWord({ kind: null, authored: true })).toBe('Made here');
    expect(searchKindWord({ kind: null, authored: false })).toBe('Unidentified');
    expect(searchKindWord({})).toBe('Unidentified');   // an older server sends neither
  });
  it("a title's sub line leads with the kind, then year, publisher, disks, where it lives", () => {
    expect(searchTitleSub(t({ kind: 'Game', year: 1991, publisher: 'Psygnosis', diskCount: 2, collections: ['Shelf', 'Faves'] })))
      .toBe('Game · 1991 · Psygnosis · 2 disks · in Shelf, Faves');
    expect(searchTitleSub(t())).toBe('Unidentified · 1 disk · Uncategorized');
    expect(searchTitleSub(t({ publisher: '', collections: null }))).toBe('Unidentified · 1 disk');
  });
  it('the empty line names what was searched (Ruling 28)', () => {
    expect(searchEmptyText('zool')).toBe('Nothing in your library or Help matches “zool”.');
  });
});
