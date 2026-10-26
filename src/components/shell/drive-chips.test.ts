import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Menu } from '@base-ui/react/menu';
import type { DriveChip } from '@/lib/drive-chips';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => '/library',
}));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {}, message: () => {} } }));

const { DriveChips, MoreList } = await import('./drive-chips');
const { chipSlots } = await import('@/lib/drive-chips');

/** A converged, online board holding disk 1 of a two-disk title, protected. */
const base: DriveChip = {
  id: 'dev-a', name: 'Bench', shortName: 'Bench', online: true, state: 'converged', phase: 'loaded',
  disk: { id: 'disk-1', gameId: 'gam-1', title: 'Turrican', diskNo: 1, diskCount: 2, writeProtected: true, readOnly: null },
  loadingTitle: null, canGoTo: true, canToggleProtect: true, canEject: true,
  next: { diskNo: 2, diskCount: 2, wraps: false, preload: null }, df1: null, seen: null,
};
const two = [base, { ...base, id: 'dev-b', name: 'Shelf', shortName: 'Shelf' }];
const chips = (list: DriveChip[], showAdmin = false) =>
  renderToStaticMarkup(createElement(DriveChips, { chips: list, showAdmin }));
/** The opening tag of the element carrying `testId`. */
const openTag = (html: string, testId: string) =>
  html.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

describe('the chip (C8 spec §2, Rulings 2, 3)', () => {
  it('is 40 px (44 below lg), capped at 240 px from lg, surface-2 on the line, ink-bordered surface when open', () => {
    const t = openTag(chips([base]), 'drive-chip-dev-a');
    for (const c of ['h-10', 'max-lg:h-11', 'lg:max-w-[240px]', 'bg-(--surface-2)', 'border-(--line)',
      'data-[popup-open]:bg-(--surface)', 'data-[popup-open]:border-(--ink)']) expect(t, c).toContain(c);
  });
  it('shows the name, the disk in mono, the WP tag with its word beside it, and no "n/N"', () => {
    const html = chips([base]);
    expect(openTag(html, 'drive-chip-name-dev-a')).toContain('max-w-[6rem]');
    expect(html).toMatch(/data-testid="drive-chip-name-dev-a"[^>]*>Bench</);
    expect(openTag(html, 'drive-chip-disk-dev-a')).toContain('font-mono');
    expect(html).toMatch(/data-testid="drive-chip-disk-dev-a"[^>]*>Turrican</);
    expect(html).toMatch(/data-testid="drive-chip-wp-dev-a"[^>]*>WP<\/span><span class="sr-only">write-protected<\/span>/);
    // Visible text only: the style attributes carry "85 / 0.18" (rgb alpha).
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\d+\s*\/\s*\d+/);
  });
  it('an offline board wears the hollow ring and the word', () => {
    const html = chips([{ ...base, online: false, seen: '5m ago' }]);
    expect(html).toContain('border:1.5px solid var(--muted)');
    expect(html).toContain('<span class="sr-only">Offline</span>');
  });
});

describe('slots (C8 spec §2.1)', () => {
  it('a member: chips from xl, the compact control below it; the second chip from 1920; "+k" until 1920 with two', () => {
    const html = chips(two);
    expect(openTag(html, 'drive-chips')).toContain('xl:flex');
    expect(openTag(html, 'drive-chips')).not.toContain('2xl:flex');
    expect(openTag(html, 'drive-chip-dev-b')).toContain('hidden min-[1920px]:flex');
    expect(openTag(html, 'drive-chip-more')).toContain('flex min-[1920px]:hidden');
    expect(html).toContain('xl:hidden');
  });
  it('the super-admin with two or more boards: no chip below 2xl, the compact control until then', () => {
    const html = chips(two, true);
    expect(openTag(html, 'drive-chips')).toContain('2xl:flex');
    expect(html).toContain('2xl:hidden');
  });
  it('the super-admin with one board keeps the chip from xl', () => {
    expect(openTag(chips([base], true), 'drive-chips')).not.toContain('2xl:flex');
  });
  it('"+k" shows one number per band: n-1 below 1920, n-2 from it', () => {
    const html = chips([...two, { ...base, id: 'dev-c', name: 'Zed', shortName: 'Zed' }]);
    expect(html).toMatch(/<span class="min-\[1920px\]:hidden">\+2<\/span><span class="hidden min-\[1920px\]:inline">\+1<\/span>/);
    expect(openTag(html, 'drive-chip-more')).toContain('px-2');
  });
  it('renders no third chip: MAX_CHIPS is 2', () => {
    expect(chips([...two, { ...base, id: 'dev-c', name: 'Zed', shortName: 'Zed' }])).not.toContain('data-testid="drive-chip-dev-c"');
  });
});

const three = [...two, { ...base, id: 'dev-c', name: 'Zed', shortName: 'Zed' }];
const ids = (html: string) => [...html.matchAll(/data-testid="drive-entry-(dev-[a-z])"/g)].map((m) => m[1]);

describe('"+k" and its list agree with the chips on screen (Task 1 review, item A)', () => {
  it('a member with three boards sees "+1" at 1920 (two chips) and "+2" below it', () => {
    const html = chips(three);
    expect(html).toMatch(/<span class="min-\[1920px\]:hidden">\+2<\/span><span class="hidden min-\[1920px\]:inline">\+1<\/span>/);
    expect(openTag(html, 'drive-chip-more')).not.toContain('min-[1920px]:hidden');
  });
  it('with exactly two boards "+k" goes away at 1920; with one board there is no "+k" at all', () => {
    expect(openTag(chips(two), 'drive-chip-more')).toContain('min-[1920px]:hidden');
    expect(chips([base])).not.toContain('drive-chip-more"');
  });
  it('the chips shown at each width are chipSlots(w) of them, and the rest list is the others, never a visible one', () => {
    const g = globalThis as { window?: unknown };
    for (const showAdmin of [false, true]) {
      for (const w of [1280, 1536, 1920]) {
        g.window = { innerWidth: w };
        try {
          const slots = chipSlots(w, showAdmin, three.length);
          const rest = ids(renderToStaticMarkup(createElement(Menu.Root, { open: true }, createElement(MoreList, { chips: three, showAdmin }))));
          expect(rest, `rest at ${w} admin=${showAdmin}`).toEqual(three.slice(slots).map((c) => c.id));
          const shown = three.slice(0, slots).map((c) => c.id);
          for (const id of shown) expect(rest).not.toContain(id);
        } finally { delete g.window; }
      }
    }
  });
  it('the CSS shows as many chips at each band as chipSlots says (member: 1 / 1 / 2)', () => {
    const t0 = openTag(chips(three), 'drive-chip-dev-a');
    const t1 = openTag(chips(three), 'drive-chip-dev-b');
    expect(t0).not.toMatch(/\bhidden\b/);
    expect(t1).toContain('hidden min-[1920px]:flex');
    expect([chipSlots(1280, false, 3), chipSlots(1536, false, 3), chipSlots(1920, false, 3)]).toEqual([1, 1, 2]);
    expect([chipSlots(1280, true, 3), chipSlots(1536, true, 3), chipSlots(1920, true, 3)]).toEqual([0, 1, 2]);
  });
});
