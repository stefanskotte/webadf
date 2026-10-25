import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DevicesLoading from './loading';

describe('DevicesLoading (spec 9.2)', () => {
  const html = renderToStaticMarkup(createElement(DevicesLoading));

  it('is the devices-skeleton page skeleton', () => {
    expect(html).toContain('data-testid="devices-skeleton"');
    expect(html).toContain('role="status"');
  });

  it('holds a card-shaped bone with a 340x176 tile bone, a 28 px name bone, four cells and a 96 px drive-box bone', () => {
    expect(html).toContain('rounded-[20px]');
    expect(html).toMatch(/h-\[176px\]/);
    expect(html).toMatch(/w-\[340px\]/);
    expect(html).toMatch(/class="[^"]*\bh-7\b/);
    expect(html).toMatch(/h-\[96px\]/);
    expect(html.match(/data-skeleton-cell/g)?.length).toBe(4);
  });

  it('adds a 360 px dashed aside bone from lg', () => {
    const aside = html.match(/<[^>]*data-testid="devices-skeleton-aside"[^>]*>/)?.[0] ?? '';
    expect(aside).toContain('hidden');
    expect(aside).toContain('lg:block');
    expect(aside).toContain('dashed');
    expect(html).toContain('lg:grid-cols-[minmax(0,1fr)_360px]');
  });

  it('uses a 44 px heading bone and a subtitle bone before the card', () => {
    expect(html).toMatch(/class="[^"]*\bh-11\b/);
    expect(html.search(/\bh-11\b/)).toBeLessThan(html.indexOf('rounded-[20px]'));
  });
});
