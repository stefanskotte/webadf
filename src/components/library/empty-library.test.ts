import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyLibrary } from './title-controls';

/** The card's markup after its opening tag, and the opening tag itself. */
function render(props: Parameters<typeof EmptyLibrary>[0]) {
  const html = renderToStaticMarkup(createElement(EmptyLibrary, props));
  return { html, open: html.match(/^<div[^>]*>/)?.[0] ?? '', card: html.replace(/^<div[^>]*>/, '') };
}

describe('EmptyLibrary', () => {
  it('the library variant: the cream "Your library" disk, then its texts and link, in order', () => {
    const { open, card } = render({ testId: 'game-grid' });
    // The view's own test id, the state marker, and the board's dashed surface card.
    expect(open).toContain('data-testid="game-grid"');
    expect(open).toContain('data-empty="library"');
    expect(open).toContain('border:1px dashed var(--line-strong)');
    expect(open).toContain('background:var(--surface)');
    // Its first child is the 96 px cream disk icon, decorative.
    expect(card).toMatch(/^<div aria-hidden="true" style="position:relative;width:96px;height:98px/);
    expect(card).toContain('fill="#E2D9C6"');
    expect(card).toContain('>Your library</span>');
    expect(card).toContain('>Empty</span>');
    // Then the texts and the link.
    expect(card.indexOf('No disks yet')).toBeGreaterThan(card.indexOf('Empty'));
    expect(card.indexOf('Drop ADFs on the Upload page, or fetch one from a URL.')).toBeGreaterThan(card.indexOf('No disks yet'));
    expect(card).toContain('href="/ingest"');
    expect(card.indexOf('Add disks')).toBeGreaterThan(card.indexOf('fetch one from a URL.'));
    expect(card).not.toContain('webadf push');
  });

  it('the collection variant: the "Empty / New box" disk, its own words and an Upload disks link', () => {
    const { open, card } = render({ testId: 'game-grid', variant: 'collection' });
    expect(open).toContain('data-testid="game-grid"');
    expect(open).toContain('data-empty="collection"');
    expect(card).toMatch(/^<div aria-hidden="true" style="position:relative;width:96px;height:98px/);
    expect(card).toContain('>Empty</span>');
    expect(card).toContain('>New box</span>');
    expect(card.indexOf('Nothing in this collection yet')).toBeGreaterThan(card.indexOf('New box'));
    expect(card.indexOf('Drag titles here, or move them from a title’s ⋯ menu.'))
      .toBeGreaterThan(card.indexOf('Nothing in this collection yet'));
    expect(card).toContain('href="/ingest"');
    expect(card.indexOf('Upload disks')).toBeGreaterThan(card.indexOf('menu.'));
    expect(card).not.toContain('No disks yet');
  });
});
