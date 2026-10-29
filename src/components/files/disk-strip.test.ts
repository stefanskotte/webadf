import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MountChoice } from '@/lib/mount-choice';
import type { DiskInfo, StripData } from '@/lib/files/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/files',
}));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {}, message: () => {} } }));

const { DiskStrip, driveChip, usageLine } = await import('./disk-strip');

const disk: DiskInfo = {
  diskId: 'd1', gameId: 'g1', title: 'SysInfo', label: 'Disk 1', filesystem: 'OFS', hd: false,
  usedBytes: 857 * 1024, freeBytes: 23 * 1024, totalBytes: 880 * 1024,
  holder: null, imageFormat: 'adf', volumeName: 'SysInfo', sha256: 'a'.repeat(64), intl: false, tosecName: null,
};

const board = (o: Partial<MountChoice> = {}): MountChoice => ({
  id: 'b1', name: 'A500 bench', state: 'empty', holding: null, isThisDisk: false, action: 'mount',
  actionLabel: 'Mount here', revertDiskId: null, df1: null, df1Held: false, df1Stale: false, ...o,
});
const inDf0 = board({ state: 'converged', holding: 'SysInfo — disk 1', isThisDisk: true, action: 'eject', actionLabel: 'Eject' });

const data = (o: Partial<StripData> = {}): StripData => ({
  diskId: 'd1', choices: [board()], history: [], historyUnavailable: false, headSeq: 2, color: 'red', copiedFrom: null,
  info: disk, ...o,
});

const noop = () => {};
function render(d: Partial<DiskInfo> = {}, s: Partial<StripData> = {}): string {
  return renderToStaticMarkup(createElement(DiskStrip, { side: 'right', disk: { ...disk, ...d }, data: data(s), onChanged: noop }));
}
const tagOf = (html: string, testid: string) => html.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${testid}"[^>]*>`))?.[0];
const textOf = (html: string, testid: string) =>
  html.match(new RegExp(`data-testid="${testid}"[^>]*>(.*?)</`))?.[1]?.replace(/<[^>]+>/g, '');

describe('driveChip (Files increment 1, Task 9)', () => {
  it('names the drive and the board, or says it is in none', () => {
    expect(driveChip([board()])).toBe('Not in a drive');
    expect(driveChip([])).toBe('Not in a drive');
    expect(driveChip([inDf0])).toBe('In DF0: of A500 bench');
    expect(driveChip([board({ df1: { enabled: true, reason: null, isThisDisk: true }, df1Held: true })])).toBe('In DF1: of A500 bench');
  });
  it('an unconfirmed request is never "In" (holderText wording)', () => {
    expect(driveChip([board({ state: 'pending', isThisDisk: true, action: 'eject', actionLabel: 'Cancel' })])).toBe('Mounting to A500 bench…');
  });
});

describe('usageLine', () => {
  it('used of total, then free', () => {
    expect(usageLine(disk)).toBe('857 of 880 KB · 23 KB free');
    expect(usageLine({ ...disk, usedBytes: null, freeBytes: null, totalBytes: null })).toBe('Free space unknown');
  });
});

describe('DiskStrip', () => {
  it('is the strip for its side, with the title, the volume and the space', () => {
    const html = render();
    expect(tagOf(html, 'disk-strip-right')).toBeTruthy();
    expect(html).toContain('SysInfo');
    expect(textOf(html, 'disk-strip-usage')).toBe('857 of 880 KB · 23 KB free');
    expect(textOf(html, 'disk-strip-volume')).toBe('SysInfo');
  });

  it('a free disk: "Not in a drive", Mount, no Eject to edit', () => {
    const html = render();
    expect(textOf(html, 'disk-strip-drive')).toBe('Not in a drive');
    expect(tagOf(html, 'mount-d1')).toBeTruthy();
    expect(tagOf(html, 'disk-strip-eject')).toBeUndefined();
  });

  it('a held disk: "In DF0: of A500 bench", Eject to edit instead of Mount, and the volume name is locked', () => {
    const html = render({ holder: 'A500 bench' }, { choices: [inDf0] });
    expect(textOf(html, 'disk-strip-drive')).toBe('In DF0: of A500 bench');
    expect(textOf(html, 'disk-strip-eject')).toBe('Eject to edit');
    expect(tagOf(html, 'mount-d1')).toBeUndefined();
    expect(tagOf(html, 'eject-d1')).toBeUndefined();
    expect(tagOf(html, 'disk-strip-volume-edit')).toMatch(/disabled=""/);
  });

  it('⬇ ADF downloads the disk image', () => {
    const a = tagOf(render(), 'disk-strip-adf')!;
    expect(a).toMatch(/^<a\b/);
    expect(a).toContain('href="/api/disks/d1/adf"');
  });

  it('History names the current version, and the panel is closed until asked', () => {
    const html = render();
    expect(textOf(html, 'disk-strip-history-toggle')).toBe('History · v2');
    expect(tagOf(html, 'disk-strip-history')).toBeUndefined();
    // A disk never edited has no version yet: plain "History".
    expect(textOf(render({}, { headSeq: null }), 'disk-strip-history-toggle')).toBe('History');
  });

  it("an own copy of a shared library's disk says whose it was (Task 9b); any other disk says nothing", () => {
    expect(textOf(render({}, { copiedFrom: "Your copy of Bob's library" }), 'disk-copied-from')).toBe('Your copy of Bob&#x27;s library');
    expect(tagOf(render(), 'disk-copied-from')).toBeUndefined();
  });
});
