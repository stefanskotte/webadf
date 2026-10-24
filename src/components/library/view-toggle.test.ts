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
      expect(a).toContain('class="seg-item seg-item--icon h-10 w-11 sm:h-8 sm:w-9"');
      expect(a).not.toContain('text-[11px]');
      expect(a).not.toContain('style=');
    }
    // The glyphs are 16px SVGs, hidden from assistive tech (the links carry aria-labels), not text characters.
    const svgs = html.match(/<svg [^>]*>/g) ?? [];
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) {
      expect(svg).toContain('width="16"');
      expect(svg).toContain('aria-hidden="true"');
    }
    expect(html).not.toMatch(/[▦☰]/);
    expect(links[0]).toContain('aria-label="Grid view"');
    expect(links[0]).toContain('aria-pressed="false"');
    expect(links[1]).toContain('aria-label="Table view"');
    expect(links[1]).toContain('aria-pressed="true"');
  });
});
