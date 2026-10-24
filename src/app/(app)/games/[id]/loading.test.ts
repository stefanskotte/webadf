import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GameLoading from './loading';

describe('GameLoading', () => {
  const html = renderToStaticMarkup(createElement(GameLoading));

  it('is the title-skeleton status region', () => {
    expect(html).toContain('data-testid="title-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
  });

  it('is hero-shaped: a 260x240 art bone, a 48 px heading bone, a pill row and a 360 px box', () => {
    expect(html).toContain('w-[260px]');
    expect(html).toContain('h-[240px]');
    expect(html).toContain('h-12');           // 48 px heading
    expect(html).toContain('data-skeleton-pills');
    expect(html).toContain('w-[360px]');
    expect(html).toContain('lg:flex-row');    // beside the art from lg, as the hero is
  });

  it('then two disk-row bones, and uses no id a real page uses', () => {
    expect(html.match(/data-skeleton-disk-row/g)?.length).toBe(2);
    expect(html).not.toContain('data-testid="title-hero"');
    expect(html).not.toContain('data-testid="breadcrumb"');
  });
});
