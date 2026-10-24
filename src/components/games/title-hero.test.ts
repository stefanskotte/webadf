import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TitleHero } from './title-hero';

const base = {
  id: 'g1', title: 'Some Title', year: null as number | null, publisher: null as string | null,
  kind: null as string | null, diskCount: 1, cover: null as { url: string } | null,
  formats: ['adf'], hasHd: false, authored: false, mounted: null as string | null, setLabel: 'Unidentified',
};
const render = (over: Partial<typeof base> = {}) =>
  renderToStaticMarkup(createElement(TitleHero, { ...base, ...over, editSlot: null, coverSlot: null, identifySlot: null }));

describe('TitleHero', () => {
  it('shows Year and Publisher with a dash when unknown, and no kind pill', () => {
    const html = render();
    expect(html).toContain('data-testid="title-pill-year"');
    expect(html).toMatch(/data-testid="title-pill-year"[^>]*>Year —</);
    expect(html).toMatch(/data-testid="title-pill-publisher"[^>]*>Publisher —</);
    expect(html).not.toContain('title-pill-kind');
    expect(html).not.toContain('title-pill-drive');
  });

  it('shows known values and the kind pill', () => {
    const html = render({ year: 1991, publisher: 'Team 17', kind: 'Game', diskCount: 2 });
    expect(html).toMatch(/data-testid="title-pill-kind"[^>]*>Game</);
    expect(html).toMatch(/>Year 1991</);
    expect(html).toMatch(/>Publisher Team 17</);
    expect(html).toMatch(/data-testid="title-pill-disks"[^>]*>2 disks</);
  });

  it('draws game-cover only with a cover, otherwise the disk icon', () => {
    expect(render()).not.toContain('data-testid="game-cover"');
    expect(render()).toContain('<svg');
    const withCover = render({ cover: { url: '/api/images/abc' } });
    expect(withCover).toContain('data-testid="game-cover"');
    expect(withCover).toContain('alt="Some Title cover"');
  });

  it('shows the drive pill when a disk is held', () => {
    expect(render({ mounted: 'DF0 · ADF' })).toMatch(/data-testid="title-pill-drive"[^>]*>[^<]*(<[^>]*>)*DF0 · ADF/);
  });
});
