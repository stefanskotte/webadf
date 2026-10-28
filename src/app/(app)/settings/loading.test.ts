import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsLoading from './loading';

describe('SettingsLoading (C5 spec §2.7)', () => {
  const html = renderToStaticMarkup(createElement(SettingsLoading));
  it('is the settings-skeleton status', () => {
    expect(html).toContain('data-testid="settings-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading…');
  });
  it("is the Account tab's grid: four nav bones from lg and four cards, the first with four rows", () => {
    expect(html).toContain('lg:grid-cols-[240px_minmax(0,860px)]');
    expect(html.match(/data-skeleton-nav/g)?.length).toBe(4);
    expect(html.match(/data-skeleton-card/g)?.length).toBe(4);
    expect(html.match(/data-skeleton-row/g)?.length).toBe(4);
  });
  it('has no heading bones (the layout draws the heading and the tabs)', () => {
    expect(html).not.toContain('h-[30px]');
    expect(html.match(/pt-6/g)?.length).toBe(1);
  });
});
