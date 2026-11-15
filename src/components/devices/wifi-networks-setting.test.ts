import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceListItem } from '@/lib/queries';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { WifiNetworksSetting } from './wifi-networks-setting';

const NOW = 1_800_000_000_000;
const HOME = '486f6d65', PHONE = '50686f6e65';   // Home, Phone
const board = (over: Partial<DeviceListItem> = {}) => ({
  id: 'd1', name: 'Bench', firmwareVersion: '1.26.0', macAddress: '28:cd:c1:0a:ee:7f',
  lastSeenAt: new Date(NOW - 5_000), mountedSha256: null,
  wifiNets: [HOME, PHONE], wifiCurrent: 0, wifiSetupUntil: null,
  wifiSeq: 0, wifiOp: 'none', wifiOpSsid: null, wifiAck: null, wifiResult: null, ...over,
}) as unknown as DeviceListItem;
const render = (d: DeviceListItem) => renderToStaticMarkup(createElement(WifiNetworksSetting, { device: d, serverNow: NOW }));

describe('WifiNetworksSetting', () => {
  it('lists the saved networks with both states and a Remove for the one not in use', () => {
    const html = render(board());
    expect(html).toContain('Wi-Fi networks');
    expect(html).toContain('data-state="ready"');
    expect(html).toMatch(/data-testid="wifi-net-state-d1-486f6d65"[^>]*>Connected now</);
    expect(html).toMatch(/data-testid="wifi-net-state-d1-50686f6e65"[^>]*>Saved</);
    expect(html).not.toContain(`wifi-remove-d1-${HOME}`);
    expect(html).toContain(`wifi-remove-d1-${PHONE}`);
    expect(html).toContain('aria-label="Remove Phone"');
    expect(html).toContain('passwords stay on the board');
  });

  it('shows the setup page closed with Add a network, and its ten minutes', () => {
    const html = render(board());
    expect(html).toMatch(/data-testid="wifi-setup-d1"[^>]*>Setup page: closed</);
    expect(html).toContain('data-testid="wifi-add-d1"');
    expect(html).toContain('opens the board&#x27;s setup page for 10 minutes');
    expect(html).not.toContain('wifi-steps-d1');
  });

  it('shows it open until a time, with the steps naming the setup network, and Close', () => {
    const html = render(board({ wifiSetupUntil: new Date(NOW + 9 * 60_000) }));
    expect(html).toMatch(/Setup page: open until \d/);
    expect(html).toContain('data-testid="wifi-close-d1"');
    expect(html).not.toContain('data-testid="wifi-add-d1"');
    expect(html).toContain('wifi-floppy-EE7F (password wififloppy)');
    expect(html).toContain('http://192.168.4.1');
    expect(html).toContain('goes back to “Home”');
  });

  it('waits for the board after a request, with Cancel', () => {
    const html = render(board({ wifiSeq: 2, wifiOp: 'remove', wifiOpSsid: PHONE, wifiAck: 1 }));
    expect(html).toContain('data-testid="wifi-pending-d1"');
    expect(html).toContain('Waiting for the board…');
    expect(html).toContain('data-testid="wifi-cancel-d1"');
    expect(html).toMatch(/data-testid="wifi-add-d1"[^>]*disabled=""|disabled=""[^>]*data-testid="wifi-add-d1"/);
  });

  it('says what the board did', () => {
    const html = render(board({ wifiSeq: 2, wifiOp: 'remove', wifiOpSsid: PHONE, wifiAck: 2, wifiResult: 'disk' }));
    expect(html).toContain('data-testid="wifi-outcome-d1"');
    expect(html).toContain('Could not remove “Phone”: a disk is in the drive');
  });

  it('blocks Add with the reason: a disk in the drive, offline, or four saved', () => {
    expect(render(board({ mountedSha256: 'a'.repeat(64) }))).toContain('Eject the disk first');
    expect(render(board({ lastSeenAt: new Date(NOW - 10 * 60_000) }))).toContain('The board is offline.');
    // Four saved: Add still works (a password can change), and says so.
    const full = render(board({ wifiNets: [HOME, PHONE, '41', '42'] }));
    expect(full).toContain('4 saved, the most the board holds: you can change a password');
    expect(full).not.toMatch(/data-testid="wifi-add-d1"[^>]*disabled/);
  });

  it('older firmware: one line, no controls', () => {
    const html = render(board({ wifiNets: null }));
    expect(html).toContain('data-state="old_firmware"');
    expect(html).toContain('does not report its Wi-Fi networks. Update the firmware');
    expect(html).not.toMatch(/data-testid="wifi-(add|remove|close|cancel)-/);
    expect(render(board({ wifiNets: null, firmwareVersion: null }))).toContain('Shown once the board reports its firmware.');
  });
});
