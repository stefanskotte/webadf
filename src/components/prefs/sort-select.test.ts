import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SortSelect } from './sort-select';
import { BROWSE_SORT_OPTIONS, DEFAULT_PREFS } from '@/lib/user-prefs-schema';

describe('SortSelect bare (C5 spec §1.4)', () => {
  const html = renderToStaticMarkup(createElement(SortSelect, {
    bare: true, labelledBy: 'lbl', describedBy: 'hint', options: BROWSE_SORT_OPTIONS, value: DEFAULT_PREFS.browse.sort,
    onChange: () => {}, testId: 'pref-browse-sort',
  }));
  it('renders only the select, labelled and described by the caller', () => {
    expect(html.startsWith('<select')).toBe(true);
    expect(html).not.toContain('<label');
    expect(html).toContain('aria-labelledby="lbl"');
    expect(html).toContain('aria-describedby="hint"');
    expect(html).toContain('data-testid="pref-browse-sort"');
  });
  it("takes the board's 36 px look, full width below sm", () => {
    expect(html).toContain('h-9 w-full min-w-[180px] rounded-[10px]');
    expect(html).toContain('sm:w-auto');
  });
});
