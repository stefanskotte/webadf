import { describe, it, expect } from 'vitest';
import { resolveFrom, fromQuery, libraryTrail } from '@/lib/trail';

const mine = [{ id: 'col_a', name: 'Demos' }, { id: 'col_b', name: 'Workbench' }];

describe('resolveFrom', () => {
  it('resolves one of my own collections', () => {
    expect(resolveFrom('col_a', mine)).toEqual({ id: 'col_a', name: 'Demos' });
  });

  it('refuses an id that is not mine, rather than naming it', () => {
    // THE LEAK THIS PREVENTS. collection_games carries no org_id, so an
    // unchecked id would put another tenant's collection NAME on the page --
    // a cross-tenant disclosure through a breadcrumb.
    expect(resolveFrom('col_someone_else', mine)).toBeNull();
  });

  it('degrades to nothing for an unknown or absent id, never throwing', () => {
    expect(resolveFrom('col_deleted', mine)).toBeNull();
    expect(resolveFrom(undefined, mine)).toBeNull();
    expect(resolveFrom('', mine)).toBeNull();
  });
});

describe('fromQuery', () => {
  it('carries a collection, and encodes it', () => {
    expect(fromQuery('col_a')).toBe('?from=col_a');
    expect(fromQuery('a b&c')).toBe('?from=a%20b%26c');
  });

  it('carries nothing when there is nothing to carry', () => {
    expect(fromQuery(null)).toBe('');
    expect(fromQuery(undefined)).toBe('');
  });
});

describe('libraryTrail', () => {
  it('is just Library when no collection is known', () => {
    expect(libraryTrail(null)).toEqual([{ label: 'Library', href: '/library' }]);
  });

  it('keeps Library first AND clickable inside a collection', () => {
    // A collection is a view of the library, not a replacement for it:
    // someone who filtered their way in still wants the way out.
    const trail = libraryTrail({ id: 'col_a', name: 'Demos' });
    expect(trail).toEqual([
      { label: 'Library', href: '/library' },
      { label: 'Demos', href: '/library?collection=col_a' },
    ]);
  });

  it('encodes a collection id with awkward characters', () => {
    expect(libraryTrail({ id: 'a b', name: 'X' })[1].href).toBe('/library?collection=a%20b');
  });
});
