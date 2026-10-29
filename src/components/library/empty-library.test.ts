import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => '/library' }));
const { EmptyLibrary } = await import('./title-controls');
const { LibraryIngestProvider } = await import('@/components/library-ingest/library-ingest-provider');

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
    expect(card.indexOf('Drop disks anywhere on this page, or use Add disks.')).toBeGreaterThan(card.indexOf('No disks yet'));
    // Outside the Library page's ingest provider it links to the menu's hash; on the page it is a button (below).
    expect(card).toContain('href="/library#add-disks"');
    expect(card.lastIndexOf('Add disks')).toBeGreaterThan(card.indexOf('or use Add disks.'));
    expect(card).not.toContain('Upload page');
    expect(card).not.toContain('webadf push');
  });

  it('the collection variant: the "Empty / New box" disk, its own words and an Add disks link', () => {
    const { open, card } = render({ testId: 'game-grid', variant: 'collection' });
    expect(open).toContain('data-testid="game-grid"');
    expect(open).toContain('data-empty="collection"');
    expect(card).toMatch(/^<div aria-hidden="true" style="position:relative;width:96px;height:98px/);
    expect(card).toContain('>Empty</span>');
    expect(card).toContain('>New box</span>');
    expect(card.indexOf('Nothing in this collection yet')).toBeGreaterThan(card.indexOf('New box'));
    expect(card.indexOf('Drag titles here, or move them from a title’s ⋯ menu.'))
      .toBeGreaterThan(card.indexOf('Nothing in this collection yet'));
    expect(card).toContain('href="/library#add-disks"');
    expect(card.indexOf('Add disks')).toBeGreaterThan(card.indexOf('menu.'));
    expect(card).not.toContain('Upload disks');
    expect(card).not.toContain('No disks yet');
  });

  it('on the Library page (inside its ingest provider) Add disks is a button that opens the header menu, no link', () => {
    const html = renderToStaticMarkup(createElement(LibraryIngestProvider, null, createElement(EmptyLibrary, { testId: 'game-grid' })));
    expect(html).toMatch(/<button type="button" data-testid="empty-add-disks"[^>]*>Add disks<\/button>/);
    expect(html).not.toContain('href=');
  });
});
