import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceListItem } from '@/lib/queries';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
import { BoardSettings } from './board-settings';

const board = (over: Partial<DeviceListItem> = {}) => ({
  id: 'd1', name: 'Bench', firmwareVersion: '1.21.1', bootDisk: 'last', bootDiskCapable: true,
  nfcReader: 'present', i2cAddrs: [0x28, 0x3c], ...over,
}) as unknown as DeviceListItem;
const render = (d: DeviceListItem) => renderToStaticMarkup(createElement(BoardSettings, { device: d }));

describe('BoardSettings trigger', () => {
  it('renders a closed Board settings button that opens a dialog, and no dialog', () => {
    const html = render(board());
    expect(html).toContain('data-testid="board-settings-d1"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('Board settings');
    expect(html).not.toContain('board-settings-dialog');
    expect(html).not.toContain('boot-disk-d1');
  });

  it('shows the attention dot only when the NFC line is not OK', () => {
    expect(render(board())).not.toContain('board-settings-attention-d1');
    const bad = render(board({ nfcReader: 'absent', i2cAddrs: [0x3c] }));
    expect(bad).toContain('data-testid="board-settings-attention-d1"');
    expect(bad).toContain(': needs attention');
  });

  it('shows no dot when the board sends no scan, since nothing is known to be wrong', () => {
    expect(render(board({ nfcReader: null, i2cAddrs: null }))).not.toContain('board-settings-attention-d1');
  });
});
