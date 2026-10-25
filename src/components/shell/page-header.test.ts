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
