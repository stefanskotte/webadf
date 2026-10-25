import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DriveArt } from './drive-art';

const render = (props: Partial<Parameters<typeof DriveArt>[0]> = {}) =>
  renderToStaticMarkup(createElement(DriveArt, { name: 'A500', online: true, hasDisk: true, tall: false, ...props }));

describe('DriveArt', () => {
  it('draws the 128x32 case at 304 x 132 and the 128x64 case 21 units taller', () => {
    expect(render()).toContain('viewBox="0 0 304 132"');
    expect(render({ tall: true })).toContain('viewBox="0 0 304 153"');
  });

  it('names the board, its status and the drive in the aria-label', () => {
    expect(render()).toContain('role="img"');
    expect(render()).toContain('aria-label="A500, online, disk in drive"');
    expect(render({ online: false, hasDisk: false })).toContain('aria-label="A500, offline, drive empty"');
  });

  it('gives two renders different gradient ids', () => {
    const ids = (html: string) => [...html.matchAll(/id="([^"]*Case[^"]*)"/g)].map((m) => m[1]);
    // renderToStaticMarkup restarts useId per call, so render two siblings in one tree.
    const both = renderToStaticMarkup(createElement('div', null,
      createElement(DriveArt, { name: 'a', online: true, hasDisk: true, tall: false }),
      createElement(DriveArt, { name: 'b', online: true, hasDisk: true, tall: false })));
    const found = ids(both);
    expect(found).toHaveLength(2);
    expect(found[0]).not.toBe(found[1]);
  });

  it('colours the LED from the online token or the danger token', () => {
    expect(render()).toContain('var(--online-dot)');
    expect(render({ online: false })).toContain('var(--danger-fg)');
  });

  it('shows the disk sliver only while a disk is in or on its way', () => {
    expect(render({ hasDisk: true })).toContain('data-sliver="1"');
    expect(render({ hasDisk: false })).toContain('data-sliver="0"');
  });
});
