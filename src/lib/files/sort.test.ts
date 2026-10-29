import { describe, expect, it } from 'vitest';
import type { EntryKind, FsEntry } from './types';
import { nextSort, phoneSortAfter, sortFsEntries, type FilesSort, type FilesSortKey } from './sort';

const e = (name: string, kind: EntryKind, o: Partial<FsEntry> = {}): FsEntry => ({
  name, kind, path: `LIBRARY:/${name}`, size: null, date: null, protection: null, comment: null, marks: [], ...o,
});

const mixed: FsEntry[] = [
  e('b.txt', 'file', { size: 10, date: '2020-01-02T00:00:00Z', protection: '----rwed' }),
  e('Zdir', 'dir', { date: '2020-01-01T00:00:00Z' }),
  e('a.txt', 'file', { size: 30, date: '2020-01-03T00:00:00Z', protection: '----r-ed' }),
  e('adir', 'dir', { date: '2020-01-04T00:00:00Z' }),
  e('Some Title', 'title'),
  e('Disk 1', 'disk'),
];
const isFolder = (x: FsEntry) => x.kind !== 'file';

describe('sortFsEntries', () => {
  const keys: FilesSortKey[] = ['name', 'size', 'protection', 'date'];
  for (const key of keys) for (const dir of ['asc', 'desc'] as const) {
    it(`folders first under ${key} ${dir}`, () => {
      const out = sortFsEntries(mixed, { key, dir });
      expect(out).toHaveLength(mixed.length);
      const firstFile = out.findIndex((x) => !isFolder(x));
      expect(out.slice(0, firstFile).every(isFolder)).toBe(true);
      expect(out.slice(firstFile).every((x) => !isFolder(x))).toBe(true);
    });
  }

  it('does not mutate its input', () => {
    const copy = [...mixed];
    sortFsEntries(mixed, { key: 'name', dir: 'desc' });
    expect(mixed).toEqual(copy);
  });

  it('names are case-insensitive and numeric-aware', () => {
    const out = sortFsEntries([e('Disk 10', 'file'), e('disk 2', 'file'), e('Disk 1', 'file')], { key: 'name', dir: 'asc' });
    expect(out.map((x) => x.name)).toEqual(['Disk 1', 'disk 2', 'Disk 10']);
    const desc = sortFsEntries(out, { key: 'name', dir: 'desc' });
    expect(desc.map((x) => x.name)).toEqual(['Disk 10', 'disk 2', 'Disk 1']);
  });

  it('size and date sort within the files, ties break by name asc', () => {
    const files = [e('c', 'file', { size: 5 }), e('a', 'file', { size: 5 }), e('b', 'file', { size: 9 })];
    expect(sortFsEntries(files, { key: 'size', dir: 'asc' }).map((x) => x.name)).toEqual(['a', 'c', 'b']);
    expect(sortFsEntries(files, { key: 'size', dir: 'desc' }).map((x) => x.name)).toEqual(['b', 'a', 'c']);
    const dated = sortFsEntries(mixed, { key: 'date', dir: 'desc' }).filter((x) => x.kind === 'file');
    expect(dated.map((x) => x.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('null sizes, dates and protections sort as the smallest', () => {
    const files = [e('x', 'file', { size: 1 }), e('y', 'file')];
    expect(sortFsEntries(files, { key: 'size', dir: 'asc' }).map((x) => x.name)).toEqual(['y', 'x']);
  });

  it('protection sorts by the string', () => {
    const out = sortFsEntries(mixed, { key: 'protection', dir: 'asc' }).filter((x) => x.kind === 'file');
    expect(out.map((x) => x.name)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('nextSort', () => {
  it('the same key flips direction', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'date', dir: 'desc' }, 'date')).toEqual({ key: 'date', dir: 'asc' });
  });
  it('a new key starts asc, date and size start desc', () => {
    const cur: FilesSort = { key: 'name', dir: 'desc' };
    expect(nextSort(cur, 'protection')).toEqual({ key: 'protection', dir: 'asc' });
    expect(nextSort(cur, 'size')).toEqual({ key: 'size', dir: 'desc' });
    expect(nextSort(cur, 'date')).toEqual({ key: 'date', dir: 'desc' });
    expect(nextSort({ key: 'size', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });
});

describe('phoneSortAfter', () => {
  it('steps Name ▲ → Name ▼ → Date ▼ → Date ▲ → Size ▼ → Size ▲ and round again', () => {
    const seen: string[] = [];
    let cur: FilesSort = { key: 'name', dir: 'asc' };
    for (let i = 0; i < 7; i++) { seen.push(`${cur.key} ${cur.dir}`); cur = phoneSortAfter(cur); }
    expect(seen).toEqual(['name asc', 'name desc', 'date desc', 'date asc', 'size desc', 'size asc', 'name asc']);
  });
  it('a sort the phone does not offer (Protection) goes back to Name ▲', () => {
    expect(phoneSortAfter({ key: 'protection', dir: 'desc' })).toEqual({ key: 'name', dir: 'asc' });
  });
});
