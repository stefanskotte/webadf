import { describe, it, expect } from 'vitest';
import {
  resolveLibraryView, viewHref, viewParam, isCurrentView, resolveViewMode, viewModeHref,
  UNCATEGORIZED, ALL_TITLES, RESERVED_COLLECTION_IDS,
} from './library-view';

const KNOWN = ['c-1', 'c-2'];

describe('resolveLibraryView', () => {
  it('lands on Uncategorized when no collection is named', () => {
    // The library is an inbox: what has not been filed is what you are shown.
    expect(resolveLibraryView(undefined, KNOWN)).toEqual({ kind: 'uncategorized' });
  });

  it('resolves the two reserved words', () => {
    expect(resolveLibraryView(UNCATEGORIZED, KNOWN)).toEqual({ kind: 'uncategorized' });
    expect(resolveLibraryView(ALL_TITLES, KNOWN)).toEqual({ kind: 'all' });
  });

  it('only accepts a collection id this org actually owns', () => {
    expect(resolveLibraryView('c-1', KNOWN)).toEqual({ kind: 'collection', id: 'c-1' });
    // collection_games has no org_id of its own, so an id that was not proven
    // to belong here must never reach the query layer.
    expect(resolveLibraryView('someone-elses', KNOWN)).toEqual({ kind: 'all' });
  });

  it('treats a stale link as the whole library, not an error or an empty page', () => {
    expect(resolveLibraryView('deleted-collection', KNOWN)).toEqual({ kind: 'all' });
  });

  it('ignores a repeated parameter rather than picking one arbitrarily', () => {
    expect(resolveLibraryView(['c-1', 'c-2'], KNOWN)).toEqual({ kind: 'uncategorized' });
  });
});

describe('viewHref', () => {
  it('drops the parameter for the landing view, so /library is canonical', () => {
    expect(viewHref({ kind: 'uncategorized' })).toBe('/library');
  });

  it('names the other views explicitly', () => {
    expect(viewHref({ kind: 'all' })).toBe(`/library?collection=${ALL_TITLES}`);
    expect(viewHref({ kind: 'collection', id: 'c-1' })).toBe('/library?collection=c-1');
  });

  it('preserves every other parameter, so switching view keeps the grid/table toggle', () => {
    const p = new URLSearchParams('view=table&q=lemmings');
    expect(viewHref({ kind: 'collection', id: 'c-2' }, p))
      .toBe('/library?view=table&q=lemmings&collection=c-2');
    // ...including on the way back to the landing, where the parameter is
    // removed rather than set to a sentinel.
    expect(viewHref({ kind: 'uncategorized' }, p)).toBe('/library?view=table&q=lemmings');
  });

  it('drops ?page=: another view starts at its first page (library paging)', () => {
    const p = new URLSearchParams('view=table&collection=c-1&page=3');
    expect(viewHref({ kind: 'collection', id: 'c-2' }, p)).toBe('/library?view=table&collection=c-2');
    expect(viewHref({ kind: 'all' }, p)).toBe('/library?view=table&collection=all');
  });

  it('round-trips through viewParam', () => {
    for (const v of [{ kind: 'uncategorized' }, { kind: 'all' }, { kind: 'collection', id: 'c-1' }] as const) {
      expect(resolveLibraryView(viewParam(v) ?? undefined, KNOWN)).toEqual(v);
    }
  });
});

describe('isCurrentView', () => {
  it('distinguishes the two reserved views from each other', () => {
    expect(isCurrentView({ kind: 'all' }, { kind: 'uncategorized' })).toBe(false);
    expect(isCurrentView({ kind: 'uncategorized' }, { kind: 'uncategorized' })).toBe(true);
  });

  it('compares collections by id', () => {
    expect(isCurrentView({ kind: 'collection', id: 'c-1' }, { kind: 'collection', id: 'c-1' })).toBe(true);
    expect(isCurrentView({ kind: 'collection', id: 'c-1' }, { kind: 'collection', id: 'c-2' })).toBe(false);
  });
});

describe('reserved ids', () => {
  it('names both words, so collection creation can refuse them', () => {
    expect(RESERVED_COLLECTION_IDS).toContain(UNCATEGORIZED);
    expect(RESERVED_COLLECTION_IDS).toContain(ALL_TITLES);
  });
});

describe('resolveViewMode', () => {
  it('takes ?view= when it names a view, and the person\'s preference otherwise', () => {
    expect(resolveViewMode('table', 'grid')).toBe('table');
    expect(resolveViewMode('grid', 'table')).toBe('grid');
    expect(resolveViewMode(undefined, 'table')).toBe('table');
    expect(resolveViewMode(undefined, 'grid')).toBe('grid');
    // Junk or a repeated parameter is no choice at all, so the preference holds.
    expect(resolveViewMode('list', 'table')).toBe('table');
    expect(resolveViewMode(['table', 'grid'], 'grid')).toBe('grid');
  });
});

describe('viewModeHref', () => {
  it('switches grid/table and keeps the collection being viewed', () => {
    expect(viewModeHref({ kind: 'collection', id: 'c-1' }, 'table')).toBe('/library?view=table&collection=c-1');
    expect(viewModeHref({ kind: 'all' }, 'grid')).toBe('/library?view=grid&collection=all');
    expect(viewModeHref({ kind: 'uncategorized' }, 'table')).toBe('/library?view=table');
  });

  it('keeps every other parameter and replaces an old view', () => {
    const p = new URLSearchParams('view=grid&q=lemmings&collection=c-1');
    expect(viewModeHref({ kind: 'collection', id: 'c-1' }, 'table', p)).toBe('/library?view=table&q=lemmings&collection=c-1');
  });

  it('keeps the page when it is named: grid and table show the same titles', () => {
    expect(viewModeHref({ kind: 'collection', id: 'c-1' }, 'grid', undefined, 3)).toBe('/library?view=grid&collection=c-1&page=3');
    expect(viewModeHref({ kind: 'all' }, 'table', undefined, 1)).toBe('/library?view=table&collection=all');
  });
});
