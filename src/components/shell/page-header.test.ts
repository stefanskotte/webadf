import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageHeader } from './page-header';

describe('PageHeader flush (C5 spec §1.3)', () => {
  it('drops only the outer gutter', () => {
    const flush = renderToStaticMarkup(createElement(PageHeader, { title: 'Settings', eyebrow: 'Your account', size: 'lg', flush: true, help: 'preferences' }));
    const normal = renderToStaticMarkup(createElement(PageHeader, { title: 'Settings', eyebrow: 'Your account', size: 'lg' }));
    expect(normal).toContain('px-4 pb-5 pt-6 sm:px-7');
    expect(flush).not.toContain('pt-6');
    expect(flush).not.toContain('sm:px-7');
    expect(flush).toContain('tabindex="-1"');
    expect(flush).toContain('data-testid="help-tip-preferences"');
    expect(flush).toContain('sm:text-[44px]');
  });
});

describe('PageHeader subtitleFont and the h1 ring (C6 spec §1.4, Rulings 4, 5)', () => {
  const r = (p: { subtitleFont?: 'mono' | 'sans' } = {}) =>
    renderToStaticMarkup(createElement(PageHeader, { title: 'Scan', size: 'lg', subtitle: 'A sentence.', ...p }));
  it('mono by default; sans is Geist 14 px in --muted', () => {
    expect(r()).toContain('class="mt-1 font-mono text-[13px]"');
    const sans = r({ subtitleFont: 'sans' });
    expect(sans).toContain('class="mt-1 text-[14px]" style="color:var(--muted)"');
    expect(sans).not.toContain('font-mono');
  });
  it('the h1 shows a visible ring when focused (it is only ever focused by script)', () => {
    const html = r();
    expect(html).not.toContain('focus:outline-none');
    expect(html).toContain('rounded-[6px] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)');
    expect(html).toContain('tabindex="-1"');
  });
});
