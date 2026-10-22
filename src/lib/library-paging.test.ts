import { describe, it, expect } from 'vitest';
import { resolvePage, pageWindow, pageHref, librarySubtitle } from './library-paging';

describe('resolvePage', () => {
  it('splits the titles into pages of the chosen size', () => {
    expect(resolvePage('2', 100, 48)).toEqual({ page: 2, pages: 3, offset: 48, limit: 48 });
    expect(resolvePage('3', 100, 48)).toEqual({ page: 3, pages: 3, offset: 96, limit: 48 });
  });

  it('is page 1 when the address names none, or names junk', () => {
    for (const raw of [undefined, '', 'abc', '0', '-2', '1.5', ['2', '3']]) {
      expect(resolvePage(raw, 100, 48).page).toBe(1);
    }
  });

  it('a page past the end shows the last one', () => {
    expect(resolvePage('9', 100, 48)).toEqual({ page: 3, pages: 3, offset: 96, limit: 48 });
  });

  it('an empty view still has one page', () => {
    expect(resolvePage('4', 0, 24)).toEqual({ page: 1, pages: 1, offset: 0, limit: 24 });
  });

  it("'all' is one page with no limit", () => {
    expect(resolvePage('3', 500, 'all')).toEqual({ page: 1, pages: 1, offset: 0, limit: null });
  });
});

describe('pageWindow', () => {
  it('lists every page when there are few', () => {
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the first, the last and the neighbours of the current page, with gaps between', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 'gap', 20]);
    expect(pageWindow(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap', 19, 20]);
  });

  it('never leaves a gap of one page: it shows that page instead', () => {
    expect(pageWindow(4, 9)).toEqual([1, 2, 3, 4, 5, 'gap', 9]);
  });

  it('a single page is no pager at all', () => {
    expect(pageWindow(1, 1)).toEqual([]);
  });
});

describe('pageHref', () => {
  it('sets the page and keeps the view, the collection and anything else', () => {
    expect(pageHref(new URLSearchParams('view=table&collection=abc'), 3)).toBe('/library?view=table&collection=abc&page=3');
  });

  it('page 1 is the address without ?page=', () => {
    expect(pageHref(new URLSearchParams('view=grid&page=4'), 1)).toBe('/library?view=grid');
    expect(pageHref(new URLSearchParams(''), 1)).toBe('/library');
  });
});

// Final review M3: the root's count is the inbox, and says so; the plurals are right.
describe('librarySubtitle', () => {
  it('names the inbox at the root, and counts plainly elsewhere', () => {
    expect(librarySubtitle({ titles: 3, disks: 5 }, 'uncategorized')).toBe('3 uncategorized titles · 5 disks');
    expect(librarySubtitle({ titles: 300, disks: 1200 }, 'all')).toBe('300 titles · 1,200 disks');
    expect(librarySubtitle({ titles: 2, disks: 2 }, 'collection')).toBe('2 titles · 2 disks');
  });

  it('one is singular', () => {
    expect(librarySubtitle({ titles: 1, disks: 1 }, 'uncategorized')).toBe('1 uncategorized title · 1 disk');
    expect(librarySubtitle({ titles: 1, disks: 0 }, 'all')).toBe('1 title · 0 disks');
  });
});
