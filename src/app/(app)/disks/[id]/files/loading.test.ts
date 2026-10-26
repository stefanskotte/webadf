import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DiskFilesLoading from './loading';

describe('DiskFilesLoading (spec 8.1)', () => {
  const html = renderToStaticMarkup(createElement(DiskFilesLoading));
  it('is the disk-files-skeleton page skeleton', () => {
    expect(html).toContain('data-testid="disk-files-skeleton"');
    expect(html).toContain('role="status"');
  });
  it('holds a disk-card bone, then files and history bones in two columns from xl', () => {
    expect(html).toContain('data-skeleton-disk');
    expect(html).toContain('xl:grid-cols-[minmax(0,1fr)_380px]');
    expect(html.match(/data-skeleton-row/g)?.length).toBe(8);
    expect(html.match(/data-skeleton-version/g)?.length).toBe(5);
    expect(html.indexOf('data-skeleton-disk')).toBeLessThan(html.indexOf('data-skeleton-row'));
    expect(html.indexOf('data-skeleton-row')).toBeLessThan(html.indexOf('data-skeleton-version'));
  });
  it('has no page header bones: the real page starts at its breadcrumb, so nothing jumps when it lands', () => {
    // PageSkeleton's HeaderSkeleton (eyebrow, 34 px title, subtitle) has no counterpart on the disk page.
    expect(html).not.toContain('h-[26px]');
    expect(html).not.toContain('sm:h-[34px]');
    expect(html.match(/pt-6/g)?.length).toBe(1);   // only the page body's own top padding
  });
  it('uses the page\'s base single column below xl, so a long row cannot widen it', () => {
    expect(html).toContain('grid-cols-[minmax(0,1fr)]');
  });
  it('below lg the disk bone is the stacked Disk card: a 56 px disk beside a 26 px heading, then the space bar (C7 spec §8)', () => {
    const disk = html.slice(html.indexOf('data-skeleton-disk'), html.indexOf('grid-cols-[minmax(0,1fr)]'));
    expect(disk).toContain('h-14 w-14 shrink-0 sm:h-[76px] sm:w-[76px]');
    expect(disk).toContain('h-[27px] w-1/2 sm:h-[36px]');
    expect(disk.indexOf('h-14 w-14')).toBeLessThan(disk.indexOf('h-2 w-full'));
  });
});
