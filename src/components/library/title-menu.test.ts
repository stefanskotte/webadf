import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GameListItem } from '@/lib/queries';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

const { TitleMenu } = await import('./title-menu');

const game: GameListItem = {
  id: 'g1', title: 'Lemmings', year: 1991, publisher: 'Psygnosis', diskCount: 1, coverAssetId: null,
  authored: false, diskId: 'd1', holderName: null, coverUrl: null, kind: 'Game', sizeBytes: 901120,
  sha256Prefix: null, hasHd: false,
};

describe('TitleMenu', () => {
  it('renders, closed, only its ⋯ trigger: the test id, a menu popup, and the title in its name', () => {
    const html = renderToStaticMarkup(createElement(TitleMenu, { game, fob: null, drives: null }));
    const button = html.match(/<button [^>]*>/)?.[0] ?? '';
    expect(button).toContain('data-testid="title-menu-g1"');
    expect(button).toContain('aria-haspopup="menu"');
    expect(button).toContain('aria-label="More actions for Lemmings"');
    // Closed: no popup, no item, no dialog in the markup.
    expect(html).not.toContain('title-menu-panel');
    expect(html).not.toContain('delete-game-g1');
    expect(html).not.toContain('role="dialog"');
    expect(html.match(/<button /g)).toHaveLength(1);
  });
});
