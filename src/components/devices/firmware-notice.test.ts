import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FirmwareNotice } from './firmware-notice';

const latest = { version: '1.21.1+gabc123', notes: 'Fixes the watchdog.', security: false } as never;
const render = (props: Partial<Parameters<typeof FirmwareNotice>[0]>) => renderToStaticMarkup(
  createElement(FirmwareNotice, { behind: 1, total: 1, latest, security: false, ...props }));
const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('FirmwareNotice', () => {
  it('says the firmware is available and how many boards are behind', () => {
    const html = render({});
    expect(html).toContain('aria-label="Firmware update"');
    expect(html).toContain('data-testid="firmware-notice"');
    expect(text(html)).toContain('Firmware 1.21.1+gabc123 is available · 1 of 1 device is behind');
    expect(text(html)).toContain('Fixes the watchdog.');
  });

  it('says Security update for a security release, and pluralises', () => {
    const t = text(render({ security: true, behind: 2, total: 3 }));
    expect(t).toContain('Security update 1.21.1+gabc123 is available · 2 of 3 devices are behind');
  });

  it('draws the action only with oneName, and names the board', () => {
    expect(render({})).not.toContain('firmware-notice-update');
    const html = render({ oneName: 'A500 study', onUpdateOne: () => {} });
    expect(html).toContain('data-testid="firmware-notice-update"');
    expect(text(html)).toContain('Update A500 study');
  });

  it('draws nothing when no board is behind', () => {
    expect(render({ behind: 0 })).toBe('');
  });
});
