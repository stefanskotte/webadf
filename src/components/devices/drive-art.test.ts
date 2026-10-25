import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ART_W, DriveArt, GLASS_W, glassHeight } from './drive-art';

const render = (props: Partial<Parameters<typeof DriveArt>[0]> = {}) =>
  renderToStaticMarkup(createElement(DriveArt, { name: 'A500', online: true, hasDisk: true, tall: false, ...props }));

describe('DriveArt', () => {
  it('draws the case tall enough for the doubled glass: 304 x 155 for 128x32, 304 x 200 for 128x64', () => {
    expect(render()).toContain('viewBox="0 0 304 155"');
    expect(render({ tall: true })).toContain('viewBox="0 0 304 200"');
  });

  it('gives the glass 180 of the 304 units (twice the old 90), and its band ends above the bezel', () => {
    expect(GLASS_W).toBe(180);
    expect(GLASS_W / ART_W).toBeGreaterThan(0.59);
    // glass top 11 + its height must stay clear of the bezel, which starts at 40 + the case's extra height
    expect(11 + glassHeight(false)).toBeLessThanOrEqual(40 + 23);
    expect(11 + glassHeight(true)).toBeLessThanOrEqual(40 + 68);
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
