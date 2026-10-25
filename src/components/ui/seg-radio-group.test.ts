import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SegRadioGroup } from './seg-radio-group';

const OPTIONS = [{ value: 'grid', label: 'Grid' }, { value: 'table', label: 'Table' }] as const;
const render = (value: string) => renderToStaticMarkup(createElement(SegRadioGroup<string>, {
  value, options: OPTIONS, onChange: () => {}, 'aria-labelledby': 'lbl', 'aria-describedby': 'hint', testId: 'pref-library-view',
}));

describe('SegRadioGroup (C5 spec §1.1)', () => {
  it('is a labelled .seg--sm radiogroup that names its value', () => {
    const html = render('table');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-labelledby="lbl"');
    expect(html).toContain('aria-describedby="hint"');
    expect(html).toContain('data-testid="pref-library-view"');
    expect(html).toContain('data-value="table"');
    expect(html).toMatch(/class="seg seg--sm flex-wrap"/);
  });
  it('one radio per option, checked by value, the only tab stop on the checked one', () => {
    const html = render('table');
    expect(html.match(/role="radio"/g)?.length).toBe(2);
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="pref-library-view-table"/);
    expect(html).toMatch(/aria-checked="false"[^>]*tabindex="-1"[^>]*data-testid="pref-library-view-grid"/);
    expect(html).toMatch(/tabindex="0"[^>]*data-testid="pref-library-view-table"/);
  });
  it('no checked radio: the first is the tab stop', () => {
    expect(render('nope')).toMatch(/tabindex="0"[^>]*data-testid="pref-library-view-grid"/);
  });
});
