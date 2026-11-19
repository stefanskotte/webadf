import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeviceListItem } from '@/lib/queries';
import type { OrigDriveMode } from '@/lib/orig-drive';
import { OrigDriveSetting } from './orig-drive-setting';
import { DriveNumbersSetting } from './drive-numbers-setting';

const board = (over: Partial<DeviceListItem> = {}) => ({
  id: 'd1', driveBase: 1, secondDrive: 'off', origDrive: 'auto', origDriveVersion: 1, origDriveAppliedVersion: 1,
  origDriveReported: 'auto', origDriveCapable: true, origDrivePresent: true, origDriveActive: true,
  ...over,
}) as unknown as DeviceListItem;
const render = (d: DeviceListItem, value: OrigDriveMode = d.origDrive) =>
  renderToStaticMarkup(createElement(OrigDriveSetting, { device: d, value, onChange: () => {}, error: null }));

describe('OrigDriveSetting (rev C, 2026-11-19)', () => {
  it('is hidden on a board without the expander', () => {
    expect(render(board({ origDriveCapable: false }))).toBe('');
  });

  it('is a radiogroup of Auto and Off, with the hint, the status and when it applies', () => {
    const html = render(board());
    const ids = [...html.matchAll(/data-testid="orig-drive-d1-(auto|off)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['auto', 'off']);
    expect(html).toContain('data-value="auto"');
    expect(html).toContain('In use as DF0');
    expect(html).toContain('Applies the next time the Amiga is switched on.');
    expect(html).toContain('becomes DF0');
    expect(html).not.toContain('orig-drive-pending-d1');
  });

  it('says what the board found, in words, for each state', () => {
    expect(render(board({ origDriveActive: false, origDrivePresent: false }))).toContain('No drive found at power-on');
    expect(render(board({ origDriveActive: false, origDriveReported: 'off', origDrive: 'off' }))).toContain('>Off</span>');
  });

  it('shows the pending state while the board has not taken the saved version', () => {
    const html = render(board({ origDrive: 'off', origDriveVersion: 2, origDriveAppliedVersion: 1 }));
    expect(html).toContain('orig-drive-pending-d1');
    expect(html).toContain('Waiting for the board');
  });
});

describe('Drive numbers while the original drive is DF0', () => {
  const renderBase = (d: DeviceListItem) =>
    renderToStaticMarkup(createElement(DriveNumbersSetting, { device: d, value: d.driveBase, onChange: () => {}, error: null }));

  it('disables every option and says why', () => {
    const html = renderBase(board());
    const rs = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);
    expect(rs).toHaveLength(4);
    for (const r of rs) expect(r).toMatch(/\sdisabled=""/);
    expect(html).toContain('The original drive is DF0, so the board is DF1 + DF2.');
  });

  it('is enabled when the original drive is not in use', () => {
    const html = renderBase(board({ origDriveActive: false, driveBase: 0 }));
    expect(html).not.toMatch(/role="radio"[^>]*\sdisabled=""/);
    expect(html).not.toContain('drive-base-locked-d1');
  });
});
