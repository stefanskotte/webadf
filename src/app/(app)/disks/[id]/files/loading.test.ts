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
});
