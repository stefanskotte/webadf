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
    expect(html.match(/h-\[19\.5px\]/g)?.length).toBe(2);
    expect(html).toContain('h-[42px] w-[420px] max-w-full');
    expect(html).toContain('rounded-[16px]');
    expect(html.match(/data-skeleton-row/g)?.length).toBe(6);
  });
  it("is not PageSkeleton (its md header bones would jump when the 44 px heading lands)", () => {
    expect(html).not.toContain('sm:h-[34px]');
  });
});

describe('Overview loading frame (C6 Task 7)', () => {
  it('reserves the two wrapped subtitle lines below lg and one line from lg', async () => {
    const { default: OverviewLoading } = await import('./admin/(overview)/loading');
    const html = renderToStaticMarkup(createElement(OverviewLoading));
    expect(html).toContain('mt-1 h-[42px] lg:h-[21px] w-72');
    expect(html).toContain('h-[42px] w-[420px] max-w-full');   // the tabs bone is unchanged
  });
});
