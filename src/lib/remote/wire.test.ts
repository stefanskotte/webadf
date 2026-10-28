import { describe, it, expect } from 'vitest';
import { checkFiles, checkLibrary, checkTitleDetail, checkTitlesPage } from './wire';

const SHA = 'a'.repeat(64);
const title = {
  id: 't1', title: 'Lemmings', year: 1991, publisher: 'Psygnosis', kind: 'Game', diskCount: 1,
  hasCover: false, coverDigest: null, collectionIds: ['c1'],
};
const disk = { id: 'd1', name: 'Disk 1', diskNo: 1, sizeBytes: 901120, sha256: SHA, imageFormat: 'adf', extractable: false, updatedAt: '2026-10-28T10:00:00.000Z' };

describe('checkLibrary', () => {
  it('passes a good answer through', () => {
    const lib = { name: "Rob's", collections: [{ id: 'c1', name: 'Games', titles: 3 }], titles: 3, disks: 4 };
    expect(checkLibrary(lib)).toEqual(lib);
  });
  it('null for what is not a library; bad collections dropped', () => {
    expect(checkLibrary(null)).toBeNull();
    expect(checkLibrary({ name: 1, collections: [] })).toBeNull();
    expect(checkLibrary({ name: 'x', collections: 'no' })).toBeNull();
    expect(checkLibrary({ name: 'x', collections: [{ id: '../x', name: 'a' }, { id: 'c2', name: 'B' }] }))
      .toEqual({ name: 'x', collections: [{ id: 'c2', name: 'B', titles: 0 }], titles: 0, disks: 0 });
  });
});

describe('checkTitlesPage', () => {
  it('keeps good titles, drops bad ones, strips control characters', () => {
    const p = checkTitlesPage({ titles: [title, { id: 5 }, { ...title, id: 't2', title: 'A\u0000B' }], nextCursor: 'n' });
    expect(p?.titles.map((t) => [t.id, t.title])).toEqual([['t1', 'Lemmings'], ['t2', 'A B']]);
    expect(p?.nextCursor).toBe('n');
  });
  it('a junk cover digest is no digest', () => {
    expect(checkTitlesPage({ titles: [{ ...title, hasCover: true, coverDigest: '"><x' }] })?.titles[0].coverDigest).toBeNull();
  });
  it('null when titles is missing', () => expect(checkTitlesPage({ nextCursor: null })).toBeNull());
});

describe('checkTitleDetail', () => {
  it('orders disks by number and drops malformed ones', () => {
    const d = checkTitleDetail({ title, disks: [{ ...disk, id: 'd2', diskNo: 2 }, disk, { ...disk, id: 'd3', sha256: 'zz' }] });
    expect(d?.disks.map((x) => x.id)).toEqual(['d1', 'd2']);
  });
  it('null without a title', () => expect(checkTitleDetail({ disks: [] })).toBeNull());
});

describe('checkFiles', () => {
  it('a tree, nested', () => {
    const f = checkFiles({
      volume: { filesystem: 'OFS', intl: false, dirc: false, name: 'Work', createdAt: null, modifiedAt: null },
      root: [{ name: 'c', kind: 'dir', sizeBytes: 0, modifiedAt: null, protection: '----rwed', comment: null,
        children: [{ name: 'dir', kind: 'file', sizeBytes: 12, modifiedAt: '2026-01-01T00:00:00Z', protection: '', comment: 'x' }] }],
      usage: null,
    });
    expect(f && 'root' in f && f.root[0].children?.[0].name).toBe('dir');
  });
  it('unreadable passes as a reason', () => expect(checkFiles({ unreadable: 'no filesystem' })).toEqual({ unreadable: 'no filesystem' }));
  it('null for junk', () => expect(checkFiles({ root: 'x' })).toBeNull());
});
