import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FilesLoading from './loading';

describe('FilesLoading (Files spec §5.1)', () => {
  const html = renderToStaticMarkup(createElement(FilesLoading));
  it('is the files-skeleton status', () => {
    expect(html).toContain('data-testid="files-skeleton"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading…');
  });
  it("is the manager's grid: two pane bones with the action column between them", () => {
    expect(html.match(/data-skeleton-pane/g)?.length).toBe(2);
    expect(html.match(/data-skeleton-actions/g)?.length).toBe(1);
    expect(html).toContain('lg:grid-cols-[minmax(0,1fr)_92px_minmax(0,1fr)]');
    const [first, second] = [...html.matchAll(/data-skeleton-pane/g)].map((m) => m.index!);
    const actions = html.indexOf('data-skeleton-actions');
    expect(first).toBeLessThan(actions);
    expect(actions).toBeLessThan(second);
  });
});
