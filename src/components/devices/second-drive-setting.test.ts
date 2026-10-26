import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceListItem } from '@/lib/queries';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { SecondDriveSetting } from './second-drive-setting';

const board = (over: Partial<DeviceListItem> = {}) => ({
  id: 'd1', secondDrive: 'df1', secondDriveVersion: 1, secondDriveAppliedVersion: 1, secondDriveReported: 'df1',
  secondDriveCapable: true, secondDriveNetCapable: true, df1Sha256: null, df1DiskId: 'disk-1',
  df1PickSha256: null, df1PickTitle: 'Pick', df1PickDiskNo: 1, sel1Wired: true, df1Seen: false,
  netDriverSeenAt: null, netAmigaIp: null, netFramesIn: null, netFramesOut: null, firmwareVersion: '1.21.1',
  ...over,
}) as unknown as DeviceListItem;
const render = (d: DeviceListItem) => renderToStaticMarkup(createElement(SecondDriveSetting, { device: d, now: 0 }));

describe('SecondDriveSetting radiogroup', () => {
  it('is a radiogroup of four radios in board order, Any disk checked on a pick', () => {
    const html = render(board());
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-value="any"');
    const ids = [...html.matchAll(/data-testid="second-drive-d1-(off|df1|net|any)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['off', 'df1', 'net', 'any']);
    for (const t of ['Off', 'Next disk of the set', 'Network (PaulaNET)', 'Any disk']) expect(html).toContain(`>${t}</button>`);
    const checked = [...html.matchAll(/<button[^>]*aria-checked="true"[^>]*>/g)].map((m) => m[0]);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('second-drive-d1-any');
    expect(checked[0]).toContain('tabindex="0"');
    expect(html).not.toContain('<select');
  });

  it('disables Network and shows the note on a board that cannot', () => {
    const html = render(board({ secondDriveNetCapable: false }));
    const net = html.match(/<button[^>]*second-drive-d1-net[^>]*>/)![0];
    expect(net).toMatch(/\sdisabled=""/);
    expect(html).toContain('Network needs firmware 1.11.0 or newer');
    expect(html).toContain('second-drive-net-note-d1');
  });

  it('keeps exactly one enabled tab stop when the checked radio is disabled', () => {
    // Stored Network, but the board is no longer net-capable.
    const html = render(board({ secondDrive: 'net', secondDriveNetCapable: false }));
    const rs = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);
    expect(rs.find((b) => b.includes('second-drive-d1-net'))).toMatch(/\sdisabled=""/);
    expect(rs.filter((b) => b.includes('tabindex="0"'))).toHaveLength(1);
    expect(rs.filter((b) => b.includes('tabindex="0"') && !/\sdisabled=""/.test(b))).toHaveLength(1);
  });
});

describe('SecondDriveSetting below sm (C7 spec §6.2, Ruling 18)', () => {
  it('says the mode in one line and offers Change second drive, which controls the radiogroup', () => {
    const html = render(board({ secondDrive: 'net', secondDriveReported: 'net', df1DiskId: null }));
    expect(html).toMatch(/<span data-df1-mode="" class="[^"]*sm:hidden[^"]*"[^>]*>DF1 · Network \(PaulaNET\)<\/span>/);
    const btn = html.match(/<button[^>]*data-testid="df1-change-d1"[^>]*>[^<]*<\/button>/)![0];
    expect(btn).toContain('aria-expanded="false"');
    expect(btn).toContain('aria-controls="second-drive-group-d1"');
    expect(btn).toContain('sm:hidden');
    expect(btn).toContain('>Change second drive</button>');
    expect(html).toMatch(/<div[^>]*class="[^"]*max-sm:hidden[^"]*"[^>]*>\s*<div role="radiogroup"[^>]*id="second-drive-group-d1"/);
  });
});
