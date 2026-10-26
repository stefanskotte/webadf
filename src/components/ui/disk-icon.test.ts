import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiskIcon } from './disk-icon';

const render = (props: Parameters<typeof DiskIcon>[0]) => renderToStaticMarkup(createElement(DiskIcon, props));

describe('DiskIcon', () => {
  it('draws the board shape at its size, decorative, in the body colour', () => {
    const html = render({ color: 'cream', size: 96, set: 'Empty', title: 'New box' });
    expect(html).toMatch(/^<div[^>]*aria-hidden="true"/);
    expect(html).toContain('width:96px;height:98px');
    expect(html).toContain('drop-shadow(0 5px 8px rgba(36,33,27,0.22))');
    expect(html).toContain('viewBox="0 0 106 108"');
    expect(html).toContain('d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" fill="#E2D9C6"');
    expect(html).toContain('>Empty</span>');
    expect(html).toContain('>New box</span>');
  });

  it('draws no colour stripe on the label (operator 2026-10-25: it serves no purpose)', () => {
    for (const size of [24, 96, 160]) {
      const html = render({ size, set: 'Set', title: 'Title' });
      for (const c of ['#D9453A', '#EE8A2A', '#4F9D4A', '#2F6FB5']) expect(html).not.toContain(c);
    }
  });

  it('defaults to a single black 160 px disk with no HD, WP, stack or badge', () => {
    const html = render({});
    expect(html).toContain('width:160px;height:163px');
    expect(html).toContain('fill="#232326"');
    // The back disk is hidden, the HD hole and text are hidden, and the WP tab is the back colour.
    expect(html).toMatch(/<g transform="translate\(6 0\)" opacity="0">/);
    expect(html).toContain('<rect x="92" y="91" width="5" height="6" rx="0.8" fill="#0E0E10" opacity="0">');
    expect(html).toMatch(/<text[^>]*opacity="0"[^>]*>HD<\/text>/);
    expect(html).toContain('<rect x="3" y="91" width="5" height="6" rx="0.8" fill="#3A3A3F">');
    expect(html).not.toContain('DF0');
  });

  it('shows the stack, HD, write-protect tab and DF0 badge when asked', () => {
    const html = render({ stack: 3, hd: true, wp: true, mounted: true });
    expect(html).toMatch(/<g transform="translate\(6 0\)" opacity="1">/);
    expect(html).toContain('<rect x="92" y="91" width="5" height="6" rx="0.8" fill="#0E0E10" opacity="1">');
    expect(html).toMatch(/<text[^>]*opacity="0.85"[^>]*>HD<\/text>/);
    expect(html).toContain('<rect x="3" y="91" width="5" height="6" rx="0.8" fill="#0E0E10">');
    expect(html).toContain('DF0</span>');
  });

  it('drops the set and title below 72 px', () => {
    const html = render({ size: 48, set: 'Workbench', title: 'Install' });
    expect(html).not.toContain('Workbench');
    expect(html).not.toContain('Install');
  });

  it('gives each instance its own gradient ids, and points its fills at them', () => {
    const html = renderToStaticMarkup(createElement('div', null, createElement(DiskIcon, {}), createElement(DiskIcon, {})));
    const ids = [...html.matchAll(/<linearGradient id="(wfSheen[^"]*)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(id).not.toContain(':');
      expect(html).toContain(`fill="url(#${id})"`);
    }
    const metal = [...html.matchAll(/<linearGradient id="(wfMetal[^"]*)"/g)].map((m) => m[1]);
    expect(metal[0]).not.toBe(metal[1]);
    expect(html).toContain(`fill="url(#${metal[0]})"`);
  });

  it('uses the app font tokens', () => {
    const html = render({});
    expect(html).toContain('font-family:var(--font-mono)');
    expect(html).toContain('font-family:var(--font-display)');
    expect(html).toContain('font-family="var(--font-sans)"');
  });

  it('names the drive that holds the disk on its badge, DF0 by default', () => {
    expect(render({ mounted: true })).toContain('DF0</span>');
    const df1 = render({ mounted: true, drive: 'DF1' });
    expect(df1).toContain('DF1</span>');
    expect(df1).not.toContain('DF0');
    expect(render({ drive: 'DF1' })).not.toContain('DF1');
  });
});
