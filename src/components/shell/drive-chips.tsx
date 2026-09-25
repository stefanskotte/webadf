'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDownIcon } from 'lucide-react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/components/shell/link';
import { requestEject, requestWriteProtect } from '@/components/devices/device-actions';
import { chipSlots, diskText, protectTag, splitChips, type DriveChip } from '@/lib/drive-chips';

/**
 * Every paired wifi-floppy as a small chip in the header, each opening a menu
 * with Go to disk / the disk's write protection / Eject (HANDOFF §4 backlog;
 * design approved 2026-09-25). Quick access only -- /devices stays where
 * devices are managed.
 *
 * NO floppy pictogram: the operator turned the floppy drawings down when the
 * Devices cards were redesigned. A chip is words: a status dot, the device's
 * name and what is in the drive. Every state carries BOTH of its values on
 * screen -- online is a filled dot and offline a hollow ring (shape, not only
 * colour), an empty drive says "empty", and a settled disk wears WP or RW --
 * because an icon that is simply absent is not a reading.
 *
 * The props come from the (app) layout, derived from the same rows the live
 * fingerprint hashes, so LiveRefresh's router.refresh() is what keeps a chip
 * current. There is deliberately no optimistic state here: after an eject the
 * chip reads "ejecting…" because the layout says desired != mounted, and it
 * reads "empty" only once the BOARD has reported it.
 *
 * Two presentations, one set of props, switched by CSS at `xl`:
 *   - xl and up: chips beside the wordmark, then a "+k" chip whose menu lists
 *     the boards that did not get a chip of their own.
 *   - below xl: ONE compact "Drives" control listing every board. On a phone
 *     that sits on the header's top line -- NOT in the fixed bottom bar,
 *     which already scrolls with four items at 390px.
 * Menus render their contents only while open, so the two presentations
 * never put a device's actions in the DOM twice.
 *
 * HOW MANY chips is measured, not assumed (see chipSlots in drive-chips.ts):
 * the room is what lies between the wordmark and the viewport-centred pill,
 * about 370px at 1280 -- one full chip, not the three the design first asked
 * for. The count grows with the viewport instead, 1 / 2 / 3 at xl / 2xl /
 * 1920px, and never passes MAX_CHIPS.
 */
export function DriveChips({ chips }: { chips: DriveChip[] }) {
  // Zero paired devices: nothing at all, not an empty "Drives" control.
  if (chips.length === 0) return null;
  const { shown } = splitChips(chips);
  return (
    <>
      <div className="hidden min-w-0 items-center gap-1.5 xl:flex" data-testid="drive-chips">
        {shown.map((c, i) => <Chip key={c.id} chip={c} className={CHIP_VISIBILITY[i]} />)}
        {chips.length > 1 && <MoreChip chips={chips} />}
      </div>
      {/* ml-auto below sm puts it at the right end of the wordmark's line
          (the search box and sign-out wrap to line two there); from sm the
          header no longer wraps and it simply follows the wordmark. */}
      <div className="ml-auto sm:ml-0 xl:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="drives-compact" className={`${CHIP_CLASS} flex`} style={CHIP_STYLE}>
            {/* The dot summarises: filled when every board is online, a ring
                when any is not -- each board's own reading is in the list. */}
            <StatusDot online={chips.every((c) => c.online)} />
            Drives
            <span className="font-mono text-[11px] opacity-80">{chips.length}</span>
            <ChevronDownIcon className="h-3 w-3 opacity-70" aria-hidden />
          </DropdownMenuTrigger>
          {/* align="end": on a phone the trigger is at the right edge, and
              Base UI does NOT clamp an over-wide popup back on screen
              (HANDOFF §3t, proven by mutation) -- anchored at the start it
              would open off the right of the viewport. */}
          <MenuPopup testId="drives-compact-menu" align="end">
            <DriveList chips={chips} />
          </MenuPopup>
        </DropdownMenu>
      </div>
    </>
  );
}

/**
 * Tailwind needs literal class names, so chipSlots' breakpoints
 * (drive-chips.ts) are spelled out here once more: chip i shows from the
 * width at which slot i opens. Change one, change the other -- the e2e
 * layout test measures the result at 1280.
 */
const CHIP_VISIBILITY = ['flex', 'hidden 2xl:flex', 'hidden min-[1920px]:flex'] as const;

/** "+k" is drawn only while some board has no chip of its own at this width. */
function moreVisibility(n: number): string {
  if (n > 3) return 'flex';
  if (n === 3) return 'flex min-[1920px]:hidden';
  return 'flex 2xl:hidden'; // n === 2
}

/**
 * The overflow chip. Its NUMBER is switched by CSS, so it is right on the
 * first paint at every width; its LIST is chosen in JS from the same slots,
 * which is safe because the list only exists once someone has opened it --
 * after hydration, with a real viewport to read.
 */
function MoreChip({ chips }: { chips: DriveChip[] }) {
  const n = chips.length;
  const label = (slots: number) => `+${Math.max(0, n - slots)}`;
  return (
    <DropdownMenu>
      {/* No aria-label: the two display:none numbers are out of the
          accessibility tree, so the name is exactly the "+k" on screen. */}
      <DropdownMenuTrigger data-testid="drive-chip-more" title="More drives"
                           className={`${CHIP_CLASS} ${moreVisibility(n)}`} style={CHIP_STYLE}>
        <span className="2xl:hidden">{label(1)}</span>
        <span className="hidden 2xl:inline min-[1920px]:hidden">{label(2)}</span>
        <span className="hidden min-[1920px]:inline">{label(3)}</span>
        <ChevronDownIcon className="h-3 w-3 opacity-70" aria-hidden />
      </DropdownMenuTrigger>
      <MenuPopup testId="drive-chip-more-menu" align="start">
        <MoreList chips={chips} />
      </MenuPopup>
    </DropdownMenu>
  );
}

function MoreList({ chips }: { chips: DriveChip[] }) {
  return <DriveList chips={splitChips(chips, chipSlots(window.innerWidth)).rest} />;
}

// No `display` here: every caller supplies its own (`flex`, or a
// breakpoint-switched `hidden 2xl:flex`), so a hidden chip never depends on
// which of two conflicting display utilities the stylesheet happens to emit
// last. gap-1/px-2 rather than roomier values: each 4px here is 4px per chip
// of a width budget chipSlots is measured against.
const CHIP_CLASS =
  'h-[30px] max-w-full items-center gap-1 rounded-full border px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-white/60';
// The TopNav pill's own translucent-white treatment, so the chips read as
// part of the same header rather than as cards dropped onto it.
const CHIP_STYLE = {
  background: 'rgb(255 255 255 / 0.12)',
  borderColor: 'rgb(255 255 255 / 0.16)',
  color: 'var(--on-dark)',
} as const;

function StatusDot({ online }: { online: boolean }) {
  // Filled vs hollow -- tellable apart without colour -- and the word itself
  // for a screen reader, which cannot see either.
  return (
    <>
      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={online
              ? { background: 'var(--online-dot)' }
              : { border: '1.5px solid rgb(233 240 244 / 0.7)' }} />
      <span className="sr-only">{online ? 'Online' : 'Offline'}</span>
    </>
  );
}

function Chip({ chip, className }: { chip: DriveChip; className: string }) {
  const tag = protectTag(chip);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`drive-chip-${chip.id}`}
        data-phase={chip.phase}
        data-online={chip.online ? 'true' : 'false'}
        // The alias, in full, where a truncated chip cannot fit it --
        // several identical floppies say nothing on their own.
        title={`${chip.name} — ${chip.online ? 'online' : 'offline'}`}
        className={`${CHIP_CLASS} ${className}`}
        style={{ ...CHIP_STYLE, ...(chip.online ? {} : { opacity: 0.8 }) }}
      >
        <StatusDot online={chip.online} />
        {/* Both texts capped at 3.5rem: a chip at most ~187px wide is what
            lets three, plus "+k", sit beside the wordmark at 1920 without
            reaching the pill even when it carries Admin -- measured at 4rem,
            the "+k" ran 24px into it (the budget chipSlots is built on). The
            full name is in `title` and the menu; the disk's number is only in
            the menu, for the same room. */}
        <span className="max-w-[3.5rem] truncate font-semibold" data-testid={`drive-chip-name-${chip.id}`}>
          {chip.shortName}
        </span>
        <span className="max-w-[3.5rem] truncate" style={{ color: 'var(--on-dark-muted)' }}
              data-testid={`drive-chip-disk-${chip.id}`}>
          {diskText(chip)}
        </span>
        {tag && (
          <span className="shrink-0 rounded border px-1 font-mono text-[9.5px] font-semibold leading-[14px]"
                style={{ borderColor: 'rgb(255 255 255 / 0.3)' }}
                data-testid={`drive-chip-wp-${chip.id}`}>
            {tag}
          </span>
        )}
        <ChevronDownIcon className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
      </DropdownMenuTrigger>
      <MenuPopup testId={`drive-chip-menu-${chip.id}`} align="start">
        <DriveEntry chip={chip} />
      </MenuPopup>
    </DropdownMenu>
  );
}

function MenuPopup({ testId, align, children }: { testId: string; align: 'start' | 'end'; children: React.ReactNode }) {
  return (
    <DropdownMenuContent
      align={align}
      data-testid={testId}
      // The primitive sizes the popup to its trigger (--anchor-width), which
      // for a chip is narrower than a disk title. A fixed width that never
      // exceeds the viewport less its gutters instead: Base UI will not pull
      // an over-wide popup back on screen by itself.
      // backdrop-blur: --glass-strong is 80% white, and over the library's
      // cards a multi-board list (the phone's) let the text behind show
      // through its own -- seen in the first screenshot, not predicted.
      className="w-64 max-w-[calc(100vw-2rem)] backdrop-blur-xl"
      style={{ background: 'var(--glass-strong)', color: 'var(--ink)', border: '1px solid var(--hairline-strong)' }}
    >
      {children}
    </DropdownMenuContent>
  );
}

/** The whole list, for the "+k" chip and the phone's Drives control: every board, each with its actions. */
function DriveList({ chips }: { chips: DriveChip[] }) {
  return chips.map((c, i) => (
    <div key={c.id}>
      {i > 0 && <DropdownMenuSeparator className="my-1.5" style={{ background: 'var(--hairline-strong)' }} />}
      <DriveEntry chip={c} />
    </div>
  ));
}

/** One board's heading and its three actions. */
function DriveEntry({ chip }: { chip: DriveChip }) {
  const router = useRouter();
  const [, start] = useTransition();
  const disk = chip.disk;

  // Worded as the DISK's state, not the device's: the flag lives on the disk
  // row and flips on its own page, and on every other board holding it, too.
  const protectLabel =
    !disk || chip.phase !== 'loaded' ? 'Write protection'
    : disk.readOnly ? 'Disk is read-only (HFE)'
    : disk.writeProtected ? 'Disk is Protected'
    : 'Disk is Writable';
  const protectHint =
    chip.canToggleProtect ? (disk?.writeProtected ? 'make writable' : 'protect') : null;

  const heading =
    chip.phase === 'empty' ? 'Empty'
    : chip.phase === 'loading' ? `Loading ${chip.loadingTitle ?? 'a disk'}…`
    : chip.phase === 'ejecting' ? `Ejecting ${disk?.title ?? 'a disk'}…`
    : disk ? `${disk.title}${disk.diskNo != null ? ` · disk ${disk.diskNo}` : ''}` : 'A disk';

  return (
    <DropdownMenuGroup data-testid={`drive-entry-${chip.id}`}>
      <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 pt-1.5 pb-1">
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            {chip.name}
          </span>
          {/* Both values, in words -- same badge colours as the Devices card. */}
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  background: chip.online ? 'var(--success-bg)' : 'var(--danger-bg)',
                  color: chip.online ? 'var(--success-fg)' : 'var(--danger-fg)',
                }}
                data-testid={`drive-entry-status-${chip.id}`}>
            {chip.online ? 'Online' : 'Offline'}
          </span>
        </span>
        <span className="truncate text-[12px]" style={{ color: 'var(--muted)' }}
              data-testid={`drive-entry-disk-${chip.id}`}>
          {heading}
        </span>
        {!chip.online && chip.canEject && (
          <span className="text-[11px]" style={{ color: 'var(--amber-text)' }}>
            The board is offline — it will act when it is back.
          </span>
        )}
      </DropdownMenuLabel>

      {chip.canGoTo && disk?.gameId ? (
        <MenuPrimitive.LinkItem
          data-testid={`drive-goto-${chip.id}`}
          closeOnClick
          render={<Link href={`/games/${disk.gameId}`} />}
          className={ITEM_CLASS}
        >
          Go to disk
        </MenuPrimitive.LinkItem>
      ) : (
        <DropdownMenuItem data-testid={`drive-goto-${chip.id}`} disabled className={ITEM_CLASS}>
          Go to disk
        </DropdownMenuItem>
      )}

      <DropdownMenuItem
        data-testid={`drive-protect-${chip.id}`}
        data-protected={disk && chip.phase === 'loaded' && disk.writeProtected !== null
          ? String(disk.readOnly || disk.writeProtected) : undefined}
        disabled={!chip.canToggleProtect}
        className={ITEM_CLASS}
        onClick={async () => {
          if (!disk || !chip.canToggleProtect) return;
          if (await requestWriteProtect(disk.id, !disk.writeProtected)) start(() => router.refresh());
        }}
      >
        <span className="flex-1">{protectLabel}</span>
        {protectHint && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{protectHint}</span>}
      </DropdownMenuItem>

      {/* The divider keeps Eject -- the one action that reaches out and pulls
          a disk from under a running Amiga -- from sitting flush against the
          other two. No confirmation, matching the Eject button on /devices. */}
      <DropdownMenuSeparator style={{ background: 'var(--hairline-strong)' }} />
      <DropdownMenuItem
        data-testid={`drive-eject-${chip.id}`}
        disabled={!chip.canEject}
        className={ITEM_CLASS}
        onClick={async () => {
          if (await requestEject(chip.id)) start(() => router.refresh());
        }}
      >
        Eject
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

// The primitive's own item classes, plus a finger-sized row: the phone list
// is tapped, and HANDOFF §3t holds a menu item to at least 32px there.
const ITEM_CLASS =
  'group/dropdown-menu-item relative flex min-h-8 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[13px] outline-hidden select-none focus:bg-black/5 data-highlighted:bg-black/5 data-disabled:pointer-events-none data-disabled:opacity-50';
