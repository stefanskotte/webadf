import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LibrarySelectionProvider, useLibrarySelection } from './selection-provider';
import { SelectToggle } from './select-toggle';

const html = (canSelect = true) => renderToStaticMarkup(createElement(LibrarySelectionProvider,
  { viewKey: 'all', pageTitles: [{ id: 'g1', title: 'Lemmings', year: 1991, diskCount: 1 }], canSelect },
  createElement(SelectToggle)));

describe('SelectToggle (spec §1.1)', () => {
  it('is one .seg icon button the size of the Grid/Table toggle, named, titled and unpressed', () => {
    const button = html().match(/<button [^>]*>/)?.[0] ?? '';
    expect(html()).toMatch(/^<div class="seg">/);
    expect(button).toContain('data-testid="library-select-toggle"');
    expect(button).toContain('aria-label="Select titles"');
    expect(button).toContain('title="Select titles"');
    expect(button).toContain('aria-pressed="false"');
    expect(button).toContain('class="seg-item seg-item--icon h-10 w-11 sm:h-8 sm:w-9"');
    expect(button).not.toContain('disabled');
    expect(html()).toMatch(/<svg [^>]*aria-hidden="true"/);
  });

  it('outside a provider the selection reads as off, so the grid and table work anywhere', () => {
    function Probe() { return createElement('span', null, String(useLibrarySelection().selecting)); }
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>false</span>');
  });
});
