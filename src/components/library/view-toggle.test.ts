import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewToggle } from './view-toggle';

describe('ViewToggle', () => {
  it('is a segmented control: aria-pressed drives the look, no inline colours', () => {
    const html = renderToStaticMarkup(createElement(ViewToggle, { mode: 'table', view: { kind: 'all' } }));
    expect(html).toMatch(/^<div class="seg" role="group" aria-label="View">/);
    const links = html.match(/<a [^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a).toContain('class="seg-item seg-item--icon h-10 w-11 text-[11px] sm:h-8 sm:w-9"');
      expect(a).not.toContain('style=');
    }
    expect(links[0]).toContain('aria-label="Grid view"');
    expect(links[0]).toContain('aria-pressed="false"');
    expect(links[1]).toContain('aria-label="Table view"');
    expect(links[1]).toContain('aria-pressed="true"');
  });
});
