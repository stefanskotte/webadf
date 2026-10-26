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

const { DriveChips, DriveCard, MoreList, closeOnPlainClick } = await import('./drive-chips');
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
    expect(openTag(html, 'drive-chip-more')).toContain('px-1.5');
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

const card = (c: DriveChip) => renderToStaticMarkup(createElement(DriveCard, { chip: c, close: () => {} }));
const emptyChip: DriveChip = {
  ...base, phase: 'empty', state: 'empty', disk: null, canGoTo: false, canToggleProtect: false, canEject: false, next: null,
};

describe('the chip opens a dialog, not a menu (Ruling 1)', () => {
  it('announces a dialog and renders no panel while closed', () => {
    const html = chips([base]);
    expect(openTag(html, 'drive-chip-dev-a')).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('drive-entry-dev-a');
  });
});

describe('DriveCard (C8 spec §3.3, §4, §5)', () => {
  it('a loaded board: a section named for the board, its name linking to its card, " · DF0", the title link, the count', () => {
    const html = card(base);
    expect(openTag(html, 'drive-entry-dev-a')).toMatch(/^<section\b/);
    expect(openTag(html, 'drive-entry-dev-a')).toContain('aria-label="Bench controls"');
    expect(openTag(html, 'drive-entry-link-dev-a')).toContain('href="/devices#device-dev-a"');
    expect(html).toContain('· DF0');
    expect(openTag(html, 'drive-goto-dev-a')).toContain('href="/games/gam-1"');
    expect(html).toMatch(/data-testid="drive-entry-disk-dev-a"[^>]*><a[^>]*>Turrican<\/a> · disk 1 of 2<\/span>/);
    expect(html).toMatch(/data-testid="drive-entry-status-dev-a"[^>]*><span[^>]*><\/span>Online<\/span>/);
    expect(html).not.toContain('drive-entry-offline-dev-a');
  });
  it('a loaded board: the switch on and live, Next in the card\'s words, Eject live, the gear to its Board settings', () => {
    const html = card(base);
    const sw = openTag(html, 'drive-protect-dev-a');
    expect(sw).toContain('role="switch"');
    expect(sw).toContain('aria-checked="true"');
    expect(sw).toContain('data-protected="true"');
    expect(sw).not.toMatch(/\saria-disabled=/);
    expect(html).toMatch(/data-testid="drive-protect-dev-a"[^>]*>.*Write-protect/);
    const next = openTag(html, 'drive-next-dev-a');
    expect(next).toContain('aria-label="Next: disk 2 of 2"');
    expect(html).toMatch(/data-testid="drive-next-dev-a"[^>]*>Next: disk 2<\/button>/);
    expect(openTag(html, 'drive-eject-dev-a')).not.toMatch(/\saria-disabled=/);
    expect(html).toMatch(/data-testid="drive-eject-dev-a"[^>]*>.*Eject<\/button>/);
    const gear = openTag(html, 'drive-settings-dev-a');
    expect(gear).toContain('href="/devices?settings=dev-a"');
    expect(gear).toContain('aria-label="Bench board settings"');
  });
  it('an empty drive: "Drive empty" in words, the switch neutral and off, no Next, Eject there but off, the gear live', () => {
    const html = card(emptyChip);
    expect(html).toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Drive empty<\/span>/);
    const sw = openTag(html, 'drive-protect-dev-a');
    for (const a of ['aria-checked="false"', 'aria-disabled="true"', 'data-disabled=""']) expect(sw, a).toContain(a);
    expect(html).toContain('(shown once the board holds a disk)');
    expect(html).not.toContain('drive-next-dev-a');
    const ej = openTag(html, 'drive-eject-dev-a');
    expect(ej).toContain('aria-disabled="true"');
    expect(ej).toContain('title="The drive is empty"');
    expect(ej).not.toMatch(/\sdisabled(=|\s|>)/);   // never native disabled
    expect(openTag(html, 'drive-settings-dev-a')).not.toMatch(/\saria-disabled=/);
  });
  it('an offline board: the pill says Offline, the line says when and what happens, every action stays live', () => {
    const html = card({ ...base, online: false, seen: '5m ago' });
    expect(html).toMatch(/data-testid="drive-entry-status-dev-a"[^>]*><span[^>]*><\/span>Offline<\/span>/);
    expect(html).toMatch(/data-testid="drive-entry-offline-dev-a"[^>]*>Offline, last seen 5m ago\. Changes reach it when it reconnects\.</);
    for (const id of ['drive-protect-dev-a', 'drive-next-dev-a', 'drive-eject-dev-a']) {
      expect(openTag(html, id), id).not.toMatch(/\saria-disabled=/);
    }
  });
  it('an HFE: the switch on, off, and why', () => {
    const html = card({ ...base, canToggleProtect: false, disk: { ...base.disk!, readOnly: 'HFE' } });
    const sw = openTag(html, 'drive-protect-dev-a');
    expect(sw).toContain('aria-checked="true"');
    expect(sw).toContain('aria-disabled="true"');
    expect(sw).toContain('title="HFE disks are always read-only"');
    expect(html).toContain('(HFE, always read-only)');
  });
  it('loading and ejecting are words; a title with no game is plain text', () => {
    expect(card({ ...emptyChip, phase: 'loading', state: 'pending', loadingTitle: 'Lotus', canEject: true }))
      .toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Loading Lotus…<\/span>/);
    expect(card({ ...base, phase: 'ejecting', state: 'pending', canToggleProtect: false, next: null }))
      .toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Ejecting Turrican…<\/span>/);
    expect(card({ ...base, canGoTo: false, disk: { ...base.disk!, gameId: null } }))
      .toMatch(/data-testid="drive-goto-dev-a" data-disabled="">Turrican<\/span> · disk 1 of 2/);
  });
  it('the preload and DF1 lines keep their ids', () => {
    const html = card({ ...base, next: { ...base.next!, preload: 'ready' }, df1: 'DF1: next disk of the set — empty' });
    expect(openTag(html, 'drive-preload-dev-a')).toContain('data-preload="ready"');
    expect(html).toContain('Disk 2 ready (instant swap)');
    expect(html).toMatch(/data-testid="drive-entry-df1-dev-a"[^>]*>DF1: next disk of the set — empty</);
  });
});

describe('fix round 1', () => {
  it('a board never seen says so, not "last seen never"', () => {
    const html = card({ ...base, online: false, seen: 'never' });
    expect(html).toMatch(/data-testid="drive-entry-offline-dev-a"[^>]*>Offline, never seen\. Changes reach it when it reconnects\.</);
    expect(html).not.toContain('last seen never');
  });
  it('a modified or non-primary click on a panel link does not close the panel', () => {
    let closed = 0;
    const h = closeOnPlainClick(() => { closed++; });
    const ev = (o: object) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o }) as never;
    h(ev({ metaKey: true })); h(ev({ ctrlKey: true })); h(ev({ shiftKey: true })); h(ev({ altKey: true })); h(ev({ button: 1 }));
    expect(closed).toBe(0);
    h(ev({}));
    expect(closed).toBe(1);
  });
});

describe('the compact control below xl (C8 spec §8, Rulings 5, 6)', () => {
  it('one board: that board\'s chip -- name, disk, tag -- under the compact ids, never the xl chip\'s', () => {
    const html = chips([base]);
    expect(html).toMatch(/data-testid="drives-compact-name"[^>]*>Bench</);
    expect(html).toMatch(/data-testid="drives-compact-disk"[^>]*>Turrican</);
    expect(html).toMatch(/data-testid="drives-compact-wp"[^>]*>WP</);
    expect(html.match(/data-testid="drive-chip-name-dev-a"/g)?.length).toBe(1);   // the xl chip's only
    // The face is narrower between lg and xl, so the title carries what it drops: name, state, disk and tag.
    expect(openTag(html, 'drives-compact')).toContain('title="Bench — online — Turrican — WP"');
  });
  it('the face between lg and xl: the name shrinks (min-w-0), the disk and tag are hidden; the xl chip is untouched', () => {
    const html = chips([base]);
    expect(openTag(html, 'drives-compact-name')).toContain('lg:min-w-0');
    expect(openTag(html, 'drives-compact-name')).toContain('lg:shrink');
    expect(openTag(html, 'drives-compact-disk')).toContain('lg:hidden');
    expect(openTag(html, 'drives-compact-wp')).toContain('lg:hidden');
    expect(openTag(html, 'drives-compact')).toContain('lg:max-w-[120px]');
    for (const id of ['name', 'disk', 'wp']) expect(openTag(html, `drive-chip-${id}-dev-a`), id).not.toContain('lg:hidden');
    expect(openTag(html, 'drive-chip-name-dev-a')).not.toContain('lg:min-w-0');
  });
  it('two or more boards: "Drives n", a count of boards', () => {
    const html = chips(two);
    expect(html).not.toContain('drives-compact-name');
    expect(html).toMatch(/data-testid="drives-compact"[^>]*>.*Drives<\/span><span[^>]*>2<\/span>/);
  });
});
