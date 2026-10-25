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
  it("is the page's grid: five nav bones from lg, a heading, four cards, the first with four rows", () => {
    expect(html).toContain('lg:grid-cols-[240px_minmax(0,860px)]');
    expect(html.match(/data-skeleton-nav/g)?.length).toBe(5);
    expect(html.match(/data-skeleton-card/g)?.length).toBe(4);
    expect(html.match(/data-skeleton-row/g)?.length).toBe(4);
    expect(html).toContain('h-[30px]');
    expect(html).toContain('sm:h-[44px]');
  });
  it('has no outer page-header bones (the heading is in the main column)', () => {
    expect(html).not.toContain('sm:h-[34px]');
    expect(html.match(/pt-6/g)?.length).toBe(1);
  });
});
