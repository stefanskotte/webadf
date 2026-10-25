import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AdminLoading from './loading';

describe('AdminLoading (C6 spec §1.7, Ruling 37)', () => {
  const html = renderToStaticMarkup(createElement(AdminLoading));
  it('keeps page-skeleton and the status wrapper', () => {
    expect(html).toContain('data-testid="page-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading…');
  });
  it("draws the admin frame: an lg head, the tabs bone, one card of six rows", () => {
    expect(html).toContain('h-[30px] w-56 sm:h-[44px]');
    expect(html).toContain('h-[42px] w-[420px] max-w-full');
    expect(html).toContain('rounded-[16px]');
    expect(html.match(/data-skeleton-row/g)?.length).toBe(6);
  });
  it("is not PageSkeleton (its md header bones would jump when the 44 px heading lands)", () => {
    expect(html).not.toContain('sm:h-[34px]');
  });
});
