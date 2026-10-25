import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import UploadLoading from './loading';

describe('UploadLoading (spec 6.4)', () => {
  const html = renderToStaticMarkup(createElement(UploadLoading));
  it('is the upload-skeleton page skeleton', () => {
    expect(html).toContain('data-testid="upload-skeleton"');
    expect(html).toContain('role="status"');
  });
  it('holds two dashed card bones side by side from lg, then a list bone with four row bones', () => {
    expect(html).toContain('lg:grid-cols-2');
    expect(html.match(/data-skeleton-card/g)?.length).toBe(2);
    expect(html).toContain('dashed');
    expect(html.match(/data-skeleton-row/g)?.length).toBe(4);
    expect(html.indexOf('data-skeleton-card')).toBeLessThan(html.indexOf('data-skeleton-row'));
  });
  it('uses a 44 px heading bone first', () => {
    expect(html).toMatch(/class="[^"]*\bh-11\b/);
    expect(html.search(/\bh-11\b/)).toBeLessThan(html.indexOf('data-skeleton-card'));
  });
});
