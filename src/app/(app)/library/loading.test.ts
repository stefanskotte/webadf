import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LibraryLoading from './loading';

describe('LibraryLoading', () => {
  it('lays out the collections as the page does: a chip row below md, the 240 px rail beside the grid from md', () => {
    const html = renderToStaticMarkup(createElement(LibraryLoading));
    // The page's own row (library/page.tsx): a column below md, rail + grid side by side from md up.
    expect(html).toContain('flex flex-col gap-4 md:flex-row md:items-start');
    // Below md (C7 spec §4.2): one 44 px chip row.
    const chips = html.match(/<[^>]*data-testid="library-skeleton-chips"[^>]*>/)?.[0] ?? '';
    expect(chips).toContain('md:hidden');
    expect(chips).toContain('pb-1');   // the real row's 4 px under the chips, so nothing jumps
    const chipHtml = html.slice(html.indexOf('library-skeleton-chips'), html.indexOf('library-skeleton-rail'));
    expect(chipHtml.match(/h-11/g)?.length).toBe(4);
    // From md: the rail's shape (collection-rail.tsx), 240 px with six 38 px row bones.
    const rail = html.match(/<[^>]*data-testid="library-skeleton-rail"[^>]*>/)?.[0] ?? '';
    expect(rail).toContain('md:w-60');
    expect(rail).toContain('hidden');
    expect(rail).toContain('md:flex');
    const railHtml = html.slice(html.indexOf('library-skeleton-rail'), html.indexOf('min-w-0 flex-1'));
    expect(railHtml.match(/h-\[38px\]/g)?.length).toBe(6);
    expect(html.indexOf('library-skeleton-rail')).toBeLessThan(html.indexOf('min-w-0 flex-1'));
  });

  it('draws cards as the grid does: 4 / 5 art, two text bones and a footer bone, five across from md', () => {
    const html = renderToStaticMarkup(createElement(LibraryLoading));
    expect(html).toContain('sm:grid-cols-3 md:grid-cols-5');
    expect(html.match(/aspect-ratio:4 ?\/ ?5/g)?.length).toBe(10);
    expect(html).not.toContain('1.23');
    expect(html.match(/data-card-footer-bone/g)?.length).toBe(10);
  });
});
