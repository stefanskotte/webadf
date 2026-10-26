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
 * HOW MANY chips is measured, not assumed (see chipSlots in drive-chips.ts): one 240 px chip plus "+k" at xl and 2xl,
 * two from 1920 (C8 spec §2.1); the super-admin with two or more boards keeps the compact control until 2xl.
 */
export function DriveChips({ chips, showAdmin = false }: { chips: DriveChip[]; showAdmin?: boolean }) {
  // Zero paired devices: nothing at all, not an empty "Drives" control.
  if (chips.length === 0) return null;
  const { shown } = splitChips(chips);
  // The super-admin with two or more boards: one chip plus "+k" does not fit beside the Admin pill at 1280-1535
  // (chipSlots), so the compact control stays until 2xl. Literal classes, chosen on the server: the first paint is right.
  const late = chipSlots(1280, showAdmin, chips.length) === 0;
  return (
    <>
      <div className={late ? 'hidden min-w-0 items-center gap-1.5 2xl:flex' : 'hidden min-w-0 items-center gap-1.5 xl:flex'}
           data-testid="drive-chips">
        {shown.map((c, i) => <Chip key={c.id} chip={c} className={CHIP_VISIBILITY[i]} />)}
        {chips.length > 1 && <MoreChip chips={chips} showAdmin={showAdmin} />}
      </div>
      {/* Below lg the chip slot of the header's single row (C7 spec §2.2): full width, 44 px. From lg to xl (2xl in
          the late case) it follows the wordmark. */}
      <div className={late ? 'min-w-0 flex-1 lg:flex-none 2xl:hidden' : 'min-w-0 flex-1 lg:flex-none xl:hidden'}>
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="drives-compact" className={`${CHIP_CLASS} flex max-lg:w-full`}>
            {/* The dot summarises: filled when every board is online, a ring
                when any is not -- each board's own reading is in the list. */}
            <StatusDot online={chips.every((c) => c.online)} />
            <span className="font-semibold">Drives</span>
            <span className="font-mono text-[13px] text-(--muted)">{chips.length}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
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
 * Tailwind needs literal class names, so chipSlots' breakpoints (drive-chips.ts) are spelled out here once more:
 * chip i shows from the width at which slot i opens -- 1 / 1 / 2 at xl / 2xl / 1920 for a member and (once the late
 * rule above has moved the whole group to 2xl) for the super-admin. Change one, change the other.
 */
const CHIP_VISIBILITY = ['flex', 'hidden min-[1920px]:flex'] as const;

/** "+k" is drawn only while some board has no chip of its own at this width: with two boards, until 1920. */
function moreVisibility(n: number): string {
  return n > 2 ? 'flex' : 'flex min-[1920px]:hidden';
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
                           className={`${MORE_CLASS} ${moreVisibility(n)}`}>
        {/* One number per band, each bounded by its own variant: one chip below 1920, two from it. */}
        <span className="min-[1920px]:hidden">{label(1)}</span>
        <span className="hidden min-[1920px]:inline">{label(2)}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </DropdownMenuTrigger>
      <MenuPopup testId="drive-chip-more-menu" align="start">
        <MoreList chips={chips} showAdmin={showAdmin} />
      </MenuPopup>
    </DropdownMenu>
  );
}

/** Exported for the unit test: the list is chosen from the viewport, and must never repeat a chip drawn beside it. */
export function MoreList({ chips, showAdmin }: { chips: DriveChip[]; showAdmin: boolean }) {
  return <DriveList chips={splitChips(chips, chipSlots(window.innerWidth, showAdmin, chips.length)).rest} />;
}

// The board's drive chip (C8 spec §2, Rulings 2, 25): surface-2 on the line, the board's surface on an ink border
// while its panel is open. Colours are classes, not inline styles, so data-[popup-open] can change them. No `display`
// here: every caller supplies its own (`flex`, or a breakpoint-switched `hidden min-[1920px]:flex`). The 240 px cap
// is the width chipSlots is measured against; below lg the compact control that shares this look fills its row.
const CHIP_CLASS =
  'h-10 max-lg:h-11 lg:max-w-[240px] min-w-0 items-center gap-2 rounded-[10px] border border-(--line) bg-(--surface-2) pl-3 pr-2.5 text-[14px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';
// "+k" keeps its compact padding (Plan ruling): measured 50.1 px (Task 2), which is what lets one 240 px chip plus "+k" clear the
// member pill by 16 px at 1280.
const MORE_CLASS =
  'h-10 items-center gap-1 rounded-[10px] border border-(--line) bg-(--surface-2) px-2 text-[12px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';

function StatusDot({ online }: { online: boolean }) {
  // Filled vs hollow -- tellable apart without colour -- and the word itself
  // for a screen reader, which cannot see either.
  return (
    <>
      <span aria-hidden className="size-2 shrink-0 rounded-full"
            style={online
              ? { background: 'var(--online-dot)', boxShadow: '0 0 0 3px rgb(63 191 85 / 0.18)' }
              : { border: '1.5px solid var(--muted)' }} />
      <span className="sr-only">{online ? 'Online' : 'Offline'}</span>
    </>
  );
}

/** What a chip says (C8 spec §2): the dot, the name, the disk, the WP/RW tag and the chevron. Also the compact
 *  control's face for one board (Task 5), under its own ids: the xl chip is mounted at the same time, and duplicate
 *  ids would break strict-mode getByTestId. */
function ChipFace({ chip, ids }: { chip: DriveChip; ids: 'chip' | 'compact' }) {
  const tag = protectTag(chip);
  const tid = (part: 'name' | 'disk' | 'wp') => (ids === 'chip' ? `drive-chip-${part}-${chip.id}` : `drives-compact-${part}`);
  return (
    <>
      <StatusDot online={chip.online} />
      <span className="max-w-[6rem] shrink-0 truncate font-semibold" data-testid={tid('name')}>{chip.shortName}</span>
      <span className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-(--muted)" data-testid={tid('disk')}>
        {diskText(chip)}
      </span>
      {tag && (
        <>
          <span className="shrink-0 rounded-[5px] bg-(--track) px-1.5 font-mono text-[11px] font-semibold leading-4 text-(--muted)"
                data-testid={tid('wp')}>
            {tag}
          </span>
          <span className="sr-only">{tag === 'WP' ? 'write-protected' : 'writable'}</span>
        </>
      )}
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
    </>
  );
}

function Chip({ chip, className }: { chip: DriveChip; className: string }) {
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
        style={chip.online ? undefined : { opacity: 0.8 }}
      >
        <ChipFace chip={chip} ids="chip" />
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
