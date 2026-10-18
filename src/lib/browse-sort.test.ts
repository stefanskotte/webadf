import { describe, it, expect } from 'vitest';
import type { AdfEntry } from '@/lib/adffs';
import { sortEntries } from './browse-sort';

const e = (name: string, kind: 'file' | 'dir', sizeBytes = 0, modified: string | null = null): AdfEntry => ({
  name, kind, block: name.length, sizeBytes, modifiedAt: modified ? new Date(modified) : null,
  protection: '----rwed', comment: null, children: [],
});

const LIST = [
  e('zeta', 'file', 10, '2020-01-03'),
  e('Alpha', 'file', 300, null),
  e('s', 'dir', 0, '2020-01-09'),
  e('beta', 'file', 300, '2020-01-01'),
  e('C', 'dir', 0, '2020-01-02'),
];
const names = (l: AdfEntry[]) => l.map((x) => x.name);

describe('Browse sort', () => {
  it("defaults to today's order: folders first, then case-insensitive name", () => {
    expect(names(sortEntries(LIST))).toEqual(['C', 's', 'Alpha', 'beta', 'zeta']);
  });

  it('name Z-A reverses names but keeps folders first', () => {
    expect(names(sortEntries(LIST, { key: 'name', dir: 'desc' }))).toEqual(['s', 'C', 'zeta', 'beta', 'Alpha']);
  });

  it('size sorts files by bytes, ties by name', () => {
    expect(names(sortEntries(LIST, { key: 'size', dir: 'desc' }))).toEqual(['C', 's', 'Alpha', 'beta', 'zeta']);
    expect(names(sortEntries(LIST, { key: 'size', dir: 'asc' }))).toEqual(['C', 's', 'zeta', 'Alpha', 'beta']);
  });

  it('date sorts by modification time with an unknown date last either way', () => {
    expect(names(sortEntries(LIST, { key: 'date', dir: 'desc' }))).toEqual(['s', 'C', 'zeta', 'beta', 'Alpha']);
    expect(names(sortEntries(LIST, { key: 'date', dir: 'asc' }))).toEqual(['C', 's', 'beta', 'zeta', 'Alpha']);
  });

  it('does not reorder its input', () => {
    const copy = [...LIST];
    sortEntries(LIST, { key: 'size', dir: 'asc' });
    expect(LIST).toEqual(copy);
  });
});
