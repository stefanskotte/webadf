'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRightIcon, ChevronDownIcon } from 'lucide-react';
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
import { requestEject, requestNextDisk, requestWriteProtect } from '@/components/devices/device-actions';
import { chipSlots, diskText, preloadText, protectTag, splitChips, type DriveChip } from '@/lib/drive-chips';

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
 *   - below xl: ONE compact "Drives" control listing every board. Below lg it fills the header row's middle -- NOT in the
 *     fixed bottom bar.
 * Menus render their contents only while open, so the two presentations
 * never put a device's actions in the DOM twice.
 *
 * HOW MANY chips is measured, not assumed (see chipSlots in drive-chips.ts):
 * the room is what lies between the wordmark and the viewport-centred pill,
 * about 370px at 1280 -- one full chip, not the three the design first asked
 * for. The count grows with the viewport instead, 1 / 2 / 3 at xl / 2xl /
 * 1920px (1 / 1 / 2 when the pill carries the Admin item), and never passes
 * MAX_CHIPS.
 */
export function DriveChips({ chips, showAdmin = false }: { chips: DriveChip[]; showAdmin?: boolean }) {
  // Zero paired devices: nothing at all, not an empty "Drives" control.
  if (chips.length === 0) return null;
  const { shown } = splitChips(chips);
  const visibility = showAdmin ? CHIP_VISIBILITY_ADMIN : CHIP_VISIBILITY;
  return (
    <>
      <div className="hidden min-w-0 items-center gap-1.5 xl:flex" data-testid="drive-chips">
        {shown.map((c, i) => <Chip key={c.id} chip={c} className={visibility[i]} />)}
        {chips.length > 1 && <MoreChip chips={chips} showAdmin={showAdmin} />}
      </div>
      {/* Below lg the chip slot of the header's single row (C7 spec §2.2, §5, Ruling 3): full width, 44 px, the same
          content until C8. From lg to xl it follows the wordmark as before. */}
      <div className="min-w-0 flex-1 lg:flex-none xl:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="drives-compact" className={`${CHIP_CLASS} flex max-lg:h-11 max-lg:w-full`} style={CHIP_STYLE}>
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
/** With the Admin item: 1 / 1 / 2 (chipSlots(w, true)); a third chip never fits. */
const CHIP_VISIBILITY_ADMIN = ['flex', 'hidden min-[1920px]:flex', 'hidden'] as const;

/** "+k" is drawn only while some board has no chip of its own at this width. */
function moreVisibility(n: number, showAdmin: boolean): string {
  if (showAdmin) return n > 2 ? 'flex' : 'flex min-[1920px]:hidden'; // n === 2
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
function MoreChip({ chips, showAdmin }: { chips: DriveChip[]; showAdmin: boolean }) {
  const n = chips.length;
  const label = (slots: number) => `+${Math.max(0, n - slots)}`;
  return (
    <DropdownMenu>
      {/* No aria-label: the other display:none numbers are out of the
          accessibility tree, so the name is exactly the "+k" on screen. */}
      <DropdownMenuTrigger data-testid="drive-chip-more" title="More drives"
                           className={`${CHIP_CLASS} ${moreVisibility(n, showAdmin)}`} style={CHIP_STYLE}>
        {showAdmin ? (
          <>
            {/* With the Admin item: one chip below 1920, two from it. */}
            <span className="min-[1920px]:hidden">{label(1)}</span>
            <span className="hidden min-[1920px]:inline">{label(2)}</span>
          </>
        ) : (
          <>
            <span className="2xl:hidden">{label(1)}</span>
            {/* Bounded on BOTH sides by its own variant, not "2xl:inline
                min-[1920px]:hidden": that pair relies on the stylesheet emitting
                min-[1920px] after 2xl, and it does not -- at 1920 the chip read
                "+2 +1". max-[1920px] is width < 1920px, the exact complement of
                min-[1920px], so exactly one number shows in every band. */}
            <span className="hidden 2xl:max-[1920px]:inline">{label(2)}</span>
            <span className="hidden min-[1920px]:inline">{label(3)}</span>
          </>
        )}
        <ChevronDownIcon className="h-3 w-3 opacity-70" aria-hidden />
      </DropdownMenuTrigger>
      <MenuPopup testId="drive-chip-more-menu" align="start">
        <MoreList chips={chips} showAdmin={showAdmin} />
      </MenuPopup>
    </DropdownMenu>
  );
}

function MoreList({ chips, showAdmin }: { chips: DriveChip[]; showAdmin: boolean }) {
  return <DriveList chips={splitChips(chips, chipSlots(window.innerWidth, showAdmin)).rest} />;
}

// No `display` here: every caller supplies its own (`flex`, or a
// breakpoint-switched `hidden 2xl:flex`), so a hidden chip never depends on
// which of two conflicting display utilities the stylesheet happens to emit
// last. gap-1/px-2 rather than roomier values: each 4px here is 4px per chip
// of a width budget chipSlots is measured against.
const CHIP_CLASS =
  'h-9 max-w-full items-center gap-1 rounded-[10px] border px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]';
// The board's drive chip: surface-2 on the header's surface, with a hairline,
// so it reads as a control sitting in the bar rather than a card on it.
const CHIP_STYLE = {
  background: 'var(--surface-2)',
  borderColor: 'var(--line)',
  color: 'var(--ink)',
} as const;

function StatusDot({ online }: { online: boolean }) {
  // Filled vs hollow -- tellable apart without colour -- and the word itself
  // for a screen reader, which cannot see either.
  return (
    <>
      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={online
              ? { background: 'var(--online-dot)', boxShadow: '0 0 0 3px rgb(63 191 85 / 0.18)' }
              : { border: '1.5px solid var(--muted)' }} />
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
        {/* The name capped at 3.5rem and the disk at 3.25rem: a chip at most
            ~180px wide is what lets two, plus "+k", sit 16px clear of the
            pill at 2xl, and three at 1920 -- the budget chipSlots is built
            on. At 3.5rem for both (184px) a member's widest pair came to
            11.8px of the pill at 1536 (2026-10-24); at 4rem the "+k" ran into
            it. The full name and title are in `title` and the menu; the
            disk's number is only in the menu, for the same room. */}
        <span className="max-w-[3.5rem] truncate font-semibold" data-testid={`drive-chip-name-${chip.id}`}>
          {chip.shortName}
        </span>
        <span className="max-w-[3.25rem] truncate font-mono" style={{ color: 'var(--muted)' }}
              data-testid={`drive-chip-disk-${chip.id}`}>
          {diskText(chip)}
        </span>
        {tag && (
          <span className="shrink-0 rounded-[5px] px-1 font-mono text-[9.5px] font-semibold leading-[14px]"
                style={{ background: 'var(--track)', color: 'var(--muted)' }}
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
      // Opaque --surface, so nothing on the page behind shows through.
      className="w-64 max-w-[calc(100vw-2rem)] rounded-2xl"
      style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-card)' }}
    >
      {children}
    </DropdownMenuContent>
  );
}

/** The whole list, for the "+k" chip and the phone's Drives control: every board, each with its actions. */
function DriveList({ chips }: { chips: DriveChip[] }) {
  return chips.map((c, i) => (
    <div key={c.id}>
      {i > 0 && <DropdownMenuSeparator className="my-1.5" style={{ background: 'var(--line)' }} />}
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
    : disk.readOnly ? `Disk is read-only (${disk.readOnly})`
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
      {/* The board's name goes to its card on /devices (operator, 2026-10-01).
          A menu LinkItem rather than a bare <a> in the label, so it is reachable
          by keyboard and closes the menu like every other entry. */}
      <MenuPrimitive.LinkItem
        data-testid={`drive-entry-link-${chip.id}`}
        closeOnClick
        render={<Link href={`/devices#device-${chip.id}`} />}
        className={`${ITEM_CLASS} justify-between gap-2 pt-1.5`}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            {chip.name}
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0" style={{ color: 'var(--muted)' }} />
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
      </MenuPrimitive.LinkItem>
      <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 pt-0 pb-1">
        <span className="truncate text-[12px]" style={{ color: 'var(--muted)' }}
              data-testid={`drive-entry-disk-${chip.id}`}>
          {heading}
        </span>
        {chip.df1 && (
          <span className="truncate text-[11px]" style={{ color: 'var(--muted)' }}
                data-testid={`drive-entry-df1-${chip.id}`}>
            {chip.df1}
          </span>
        )}
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
          ? String(disk.readOnly !== null || disk.writeProtected) : undefined}
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

      {chip.next && (
        <>
          <DropdownMenuItem
            data-testid={`drive-next-${chip.id}`}
            className={ITEM_CLASS}
            onClick={async () => { if (await requestNextDisk(chip.id)) start(() => router.refresh()); }}
          >
            <span className="flex-1">
              Next disk: Disk {chip.next.diskNo} of {chip.next.diskCount}{chip.next.wraps ? ' (wraps)' : ''}
            </span>
          </DropdownMenuItem>
          {/* A plain div, not a DropdownMenuLabel: a second group label
              would rename the drive's menu group for screen readers. */}
          {chip.next.preload && (
            <div className="px-2 pb-1 text-[11px]" style={{ color: 'var(--muted)' }}
                 data-testid={`drive-preload-${chip.id}`} data-preload={chip.next.preload}>
              {preloadText(chip.next.diskNo, chip.next.preload)}
            </div>
          )}
        </>
      )}

      {/* The divider keeps Eject -- the one action that reaches out and pulls
          a disk from under a running Amiga -- from sitting flush against the
          other two. No confirmation, matching the Eject button on /devices. */}
      <DropdownMenuSeparator style={{ background: 'var(--line)' }} />
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
