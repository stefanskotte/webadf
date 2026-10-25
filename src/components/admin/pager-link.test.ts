import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PagerLink } from './pager-link';

describe('PagerLink (C6 spec §3.3, §6.4, Ruling 12)', () => {
  it('a page to go to is a 32 px link carrying its test id', () => {
    const html = renderToStaticMarkup(createElement(PagerLink, { href: '/admin/users?page=2', label: 'Next', testId: 'x-next' }));
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/admin/users?page=2"');
    expect(html).toContain('data-testid="x-next"');
    expect(html).toContain('h-8');
    expect(html).toContain('>Next</a>');
  });
  it('an end is an aria-disabled span of the same size, with no test id (admin-firmware counts the id as absent)', () => {
    const html = renderToStaticMarkup(createElement(PagerLink, { href: null, label: 'Newer', testId: 'fw-page-newer' }));
    expect(html).toMatch(/^<span /);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('data-testid');
    expect(html).toContain('background:var(--surface-2)');
    expect(html).toContain('color:var(--muted-2)');
    expect(html).toContain('>Newer</span>');
  });
});
