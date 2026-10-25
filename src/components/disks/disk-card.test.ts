import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiskCard, type DiskCardProps } from './disk-card';
import type { VolumeResult, VolumeUsage } from '@/lib/adffs';

const okVolume = { ok: true, rootBlock: 880, truncated: false, warnings: [], root: [
  { name: 'C', kind: 'dir', block: 881, sizeBytes: 0, modifiedAt: null, protection: '----rwed', comment: null,
    children: [{ name: 'Dir', kind: 'file', block: 882, sizeBytes: 9, modifiedAt: null, protection: '----rwed',
      comment: null, children: [] }] },
], volume: { name: 'Workbench3.1', filesystem: 'FFS', intl: false, dirc: false,
  createdAt: new Date('1994-07-06T00:00:00Z'), modifiedAt: new Date('2026-09-27T10:00:00Z') } } as unknown as VolumeResult;
const usage: VolumeUsage = { totalBlocks: 1760, usedBlocks: 4, freeBlocks: 1756, totalBytes: 901_120,
  usedBytes: 2048, freeBytes: 899_072, percentUsed: 0 };
const base: DiskCardProps = { diskId: 'd1', filename: 'wb.adf', title: 'Workbench3.1', color: 'black', hd: false,
  writeProtected: true, badge: null, volume: okVolume, usage, sizeBytes: 901_120, rootBlock: 880, holder: null,
  light: 'none', actions: 'ACTIONS' };
const html = (o: Partial<DiskCardProps> = {}) => renderToStaticMarkup(createElement(DiskCard, { ...base, ...o }));

describe('DiskCard (spec §2)', () => {
  it('is the Disk section with one h1, a focus target, and the title block as volume-header', () => {
    const h = html();
    expect(h).toMatch(/<section[^>]*aria-label="Disk"[^>]*data-testid="disk-card"/);
    expect(h.match(/<h1/g)?.length).toBe(1);
    expect(h).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Workbench3.1<\/h1>/i);
    expect(h).toMatch(/data-testid="volume-header"[\s\S]*<h1/);
    expect(h).toContain('>wb.adf<');
  });
  it('shows the facts: FFS, density, whole-tree counts in folders, the modified date', () => {
    const h = html();
    expect(h).toContain('>FFS<');
    expect(h).toContain('>DD · 880 KB<');
    expect(h).toContain('1 file · 1 folder');
    expect(h).toContain('Modified 2026-09-27');
  });
  it('keeps A5 usage words in volume-usage-text and draws a meter', () => {
    const h = html();
    const text = h.match(/data-testid="volume-usage-text"[^>]*>([\s\S]*?)<\/div>/)![1].replace(/<[^>]+>/g, '');
    expect(text).toBe('2 KB used of 880 KB · 878 KB free');
    expect(h).toMatch(/role="meter"[^>]*aria-label="Disk space used"/);
    expect(h).toContain('data-testid="volume-usage-meter"');
  });
  it('says the bitmap is unknown instead of a meter', () => {
    const h = html({ usage: null });
    expect(h).toContain('data-testid="volume-usage-unknown"');
    expect(h).not.toContain('role="meter"');
  });
  it('the drive light says Not in a drive in words, with its state', () => {
    const h = html();
    expect(h).toMatch(/data-testid="drive-light"[^>]*data-state="none"/);
    expect(h).toMatch(/data-testid="holder-d1"[^>]*>Not in a drive</);
    expect(h).toContain('data-testid="disk-mount-bar"');
    expect(h).toContain('ACTIONS');
  });
  it('offers the whole-disk Download on the existing route', () => {
    expect(html()).toMatch(/<a[^>]*href="\/api\/disks\/d1\/adf"[^>]*aria-label="Download wb.adf"[^>]*data-testid="download-d1"/);
  });
  it('with no filesystem: no volume-header, the filename as h1, a No filesystem pill', () => {
    const h = html({ volume: { ok: false, reason: 'no-dos-signature' } as VolumeResult, title: 'wb.adf', usage: null });
    expect(h).not.toContain('data-testid="volume-header"');
    expect(h).toContain('>No filesystem<');
  });
});
