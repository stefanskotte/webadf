import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyLibrary } from './title-controls';

describe('EmptyLibrary', () => {
  it('leads with the cream "New box" disk, then keeps its texts and link', () => {
    const html = renderToStaticMarkup(createElement(EmptyLibrary, { testId: 'game-grid' }));
    // The card itself is unchanged: glass-card with the view's own test id.
    expect(html).toMatch(/^<div class="glass-card [^"]*" data-testid="game-grid">/);
    // Its first child is the 96 px cream disk icon, decorative.
    const card = html.replace(/^<div[^>]*>/, '');
    expect(card).toMatch(/^<div aria-hidden="true" style="position:relative;width:96px;height:98px/);
    expect(card).toContain('fill="#E2D9C6"');
    expect(card).toContain('>Empty</span>');
    expect(card).toContain('>New box</span>');
    // Then the texts and the link, in order.
    const icon = card.indexOf('New box');
    expect(card.indexOf('No disks yet')).toBeGreaterThan(icon);
    expect(card.indexOf('webadf push')).toBeGreaterThan(card.indexOf('No disks yet'));
    expect(card).toContain('href="/ingest"');
    expect(card.indexOf('Add disks')).toBeGreaterThan(card.indexOf('webadf push'));
  });
});
