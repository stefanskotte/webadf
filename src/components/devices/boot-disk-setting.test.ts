import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeviceListItem } from '@/lib/queries';
import { BootDiskSetting } from './boot-disk-setting';

const board = (over: Partial<DeviceListItem> = {}) => ({
  id: 'd1', bootDisk: 'last', bootDiskCapable: true, firmwareVersion: '1.21.1', ...over,
}) as unknown as DeviceListItem;
const render = (d: DeviceListItem) => renderToStaticMarkup(createElement(BootDiskSetting, {
  device: d, value: d.bootDisk as 'last' | 'empty', onChange: () => {}, error: null,
}));
const radios = (html: string) => [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);

describe('BootDiskSetting tab stop', () => {
  it('puts the one tab stop on the checked radio', () => {
    const stops = radios(render(board())).filter((b) => b.includes('tabindex="0"'));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain('boot-disk-d1-last');
  });

  it('moves the tab stop to an enabled radio when the checked one is disabled', () => {
    // Stored No disk, but the board now reports firmware below 1.18.1.
    const html = render(board({ bootDisk: 'empty', bootDiskCapable: false, firmwareVersion: '1.18.0' }));
    const rs = radios(html);
    expect(rs.find((b) => b.includes('boot-disk-d1-empty'))).toMatch(/\sdisabled=""/);
    const stops = rs.filter((b) => b.includes('tabindex="0"') && !/\sdisabled=""/.test(b));
    expect(stops).toHaveLength(1);
    expect(rs.filter((b) => b.includes('tabindex="0"'))).toHaveLength(1);
  });
});
