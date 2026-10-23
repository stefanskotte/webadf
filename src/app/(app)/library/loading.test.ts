import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LibraryLoading from './loading';

describe('LibraryLoading', () => {
  it('lays out the collections rail beside the grid, as the library page does', () => {
    const html = renderToStaticMarkup(createElement(LibraryLoading));
    // The page's own row (library/page.tsx): a column below md, rail + grid side by side from md up.
    expect(html).toContain('flex flex-col gap-4 md:flex-row md:items-start');
    // The rail's shape (collection-rail.tsx): full width below md, 224 px from md up.
    const rail = html.match(/<[^>]*data-testid="library-skeleton-rail"[^>]*>/)?.[0] ?? '';
    expect(rail).toContain('md:w-56');
    // The grid comes after the rail, in the flex-1 column.
    expect(html.indexOf('library-skeleton-rail')).toBeLessThan(html.indexOf('min-w-0 flex-1'));
  });
});
