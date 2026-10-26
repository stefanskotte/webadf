'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDownIcon } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { DiskIcon } from '@/components/ui/disk-icon';
import { WpSwitch } from '@/components/games/write-protect-toggle';
import { requestEject, requestNextDisk, requestWriteProtect } from '@/components/devices/device-actions';
import { statusPill } from '@/lib/devices-look';
import { driveDiskColor } from '@/lib/library-look';
import {
  chipSlots, diskLine, diskText, nextLabel, preloadText, protectTag, splitChips, type DriveChip,
} from '@/lib/drive-chips';

/**
 * Every paired wifi-floppy as a chip in the header (HANDOFF §4 backlog, 2026-09-25), in the board's look since C8
 * (spec 2026-10-26-phase-c8-drive-menu-design.md): the status dot, the name, the disk, the WP/RW tag. A chip opens a
 * PANEL (a Base UI Popover, role="dialog" -- Ruling 1): a "Controlling" / "Manage devices" head row and that board's
 * card, with Go to disk (the title), Write-protect, Next, Eject and the board-settings gear. No "current drive": each
 * chip's panel is its own board's card; "+k" and the compact control hold one card per board. /devices stays where
 * devices are managed.
 *
 * Every state carries BOTH of its values on screen -- online is a filled dot and offline a hollow ring (shape, not
 * only colour) and a pill in words, an empty drive says so, a settled disk wears WP or RW -- because an icon that is
 * simply absent is not a reading.
 *
 * The props come from the (app) layout, derived from the same rows the live fingerprint hashes, so LiveRefresh's
 * router.refresh() is what keeps a chip and an open panel current. There is deliberately no optimistic state: after
 * an eject the card reads "Ejecting …" because the layout says desired != mounted, and "Drive empty" only once the
 * BOARD has reported it. The panel holds busy flags only. Its open state lives in each Popover.Root, keyed by the
 * board id (or, for the compact control, by nothing that changes), so a refresh re-renders it and never remounts it.
 *
 * Two presentations, one set of props, switched by CSS at `xl` (`2xl` for the super-admin with two or more boards):
 *   - chips beside the wordmark, then a "+k" chip for the boards that did not get one;
 *   - below that, ONE compact control. Below lg it fills the header row's middle -- NOT in the fixed bottom bar.
 * Popups render their contents only while open, so the two never put a board's controls in the DOM twice.
 *
 * HOW MANY chips is measured, not assumed (see chipSlots in drive-chips.ts): one 240 px chip plus "+k" at xl and
 * 2xl, two from 1920 (C8 spec §2.1); the super-admin with two or more boards keeps the compact control until 2xl.
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
        <CompactControl chips={chips} />
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

// The board's drive chip (C8 spec §2, Rulings 2, 25): surface-2 on the line, the board's surface on an ink border
// while its panel is open. Colours are classes, not inline styles, so data-[popup-open] can change them. No `display`
// here: every caller supplies its own (`flex`, or a breakpoint-switched `hidden min-[1920px]:flex`). The 240 px cap
// is the width chipSlots is measured against; below lg the compact control that shares this look fills its row.
const CHIP_BASE =
  'h-10 max-lg:h-11 min-w-0 items-center gap-2 rounded-[10px] border border-(--line) bg-(--surface-2) pl-3 pr-2.5 text-[14px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';
const CHIP_CLASS = `${CHIP_BASE} lg:max-w-[240px]`;
// "+k" keeps its compact padding, px-1.5 (C8 plan ruling; Task 3 narrowed it so a two-digit "+10" still clears the
// member pill by 16 px at 1280).
const MORE_CLASS =
  'h-10 items-center gap-1 rounded-[10px] border border-(--line) bg-(--surface-2) px-1.5 text-[12px] text-(--ink) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] data-[popup-open]:border-(--ink) data-[popup-open]:bg-(--surface)';

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
 *  control's face for one board, under its own ids: the xl chip is mounted at the same time, and duplicate ids
 *  would break strict-mode getByTestId. */
function ChipFace({ chip, ids }: { chip: DriveChip; ids: 'chip' | 'compact' }) {
  const tag = protectTag(chip);
  const tid = (part: 'name' | 'disk' | 'wp') => (ids === 'chip' ? `drive-chip-${part}-${chip.id}` : `drives-compact-${part}`);
  // The compact control only (the xl chip is untouched): from lg to xl it is 120 px wide and the face is the dot, a name
  // that shrinks to fit, and the chevron; the disk and the tag are in the title and the panel. The phone row keeps all.
  const c = ids === 'compact';
  return (
    <>
      <StatusDot online={chip.online} />
      <span className={`max-w-[6rem] shrink-0 truncate font-semibold${c ? ' lg:min-w-0 lg:shrink xl:min-w-[auto] xl:shrink-0' : ''}`}
            data-testid={tid('name')}>{chip.shortName}</span>
      <span className={`min-w-0 flex-1 truncate text-left font-mono text-[13px] text-(--muted)${c ? ' lg:hidden xl:block' : ''}`}
            data-testid={tid('disk')}>
        {diskText(chip)}
      </span>
      {tag && (
        <>
          <span aria-hidden="true" className={`shrink-0 rounded-[5px] bg-(--track) px-1.5 font-mono text-[11px] font-semibold leading-4 text-(--muted)${c ? ' lg:hidden xl:block' : ''}`}
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

// ---- One panel's open state and focus rules (spec §6) ---------------------------------------------------------

/** Why the panel last closed: Base UI's reason, 'navigate' for a link inside it, null while it is open. */
type CloseWhy = string | null;

type Panel = {
  open: boolean;
  onOpenChange: (open: boolean, details: Popover.Root.ChangeEventDetails) => void;
  /** Close for a link press: the destination's own focus rule applies, so focus is not sent back to the trigger. */
  close: () => void;
  finalFocus: () => boolean;
};

/**
 * Ruling 20 (Base UI's finalFocus function gets the interaction type, not the reason -- C8 plan ruling): after an
 * outside press the pressed element keeps the focus if it took it (the search field), otherwise the trigger gets it;
 * after Tab out ('focus-out') or a link, focus is already where it should be; otherwise the trigger.
 */
function finalFocusFor(why: RefObject<CloseWhy>, trigger: RefObject<HTMLButtonElement | null>): boolean {
  const reason = why.current;
  if (reason === 'navigate' || reason === 'focus-out') return false;
  if (reason !== 'outside-press') return true;
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (!a || a === document.body) trigger.current?.focus();
  });
  return false;
}

/** Ruling 21: the trigger unmounted while its panel was open (the board was deleted elsewhere). */
function rescueIfOpen(why: RefObject<CloseWhy>) {
  if (why.current !== null) return;
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (!a || a === document.body) document.querySelector<HTMLElement>('[data-testid="wordmark-home"]')?.focus();
  });
}

function usePanel(): [Panel, RefObject<HTMLButtonElement | null>] {
  const [open, setOpen] = useState(false);
  // 'never' until first opened, so an unmount of a never-opened chip rescues nothing.
  const why = useRef<CloseWhy>('never');
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => rescueIfOpen(why), []);
  const panel: Panel = {
    open,
    onOpenChange: (next, details) => {
      why.current = next ? null : details.reason;
      setOpen(next);
    },
    close: () => {
      why.current = 'navigate';
      setOpen(false);
    },
    finalFocus: () => finalFocusFor(why, triggerRef),
  };
  return [panel, triggerRef];
}

/** The popup every panel uses (spec §3.1): 440 px, clamped on screen, focus on the popup itself on open (Ruling 19). */
function PanelPopup({ panel, testId, label, align, children }: {
  panel: Panel; testId: string; label: string; align: 'start' | 'end'; children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Popover.Portal>
      <Popover.Positioner side="bottom" sideOffset={6} align={align} collisionPadding={16} className="z-50">
        <Popover.Popup
          ref={popupRef}
          tabIndex={-1}
          aria-label={label}
          data-testid={testId}
          data-drive-panel=""
          initialFocus={popupRef}
          finalFocus={panel.finalFocus}
          className="drive-panel flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-2xl border border-(--line) bg-(--surface) p-2 text-(--ink) outline-none"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}

/** One head row, then one card per board (Ruling 7). */
function PanelCards({ chips, panel }: { chips: DriveChip[]; panel: Panel }) {
  const ids = chips.map((c) => c.id).join(' ');
  // Ruling 21, second half: a card that vanished with the focus in it leaves this panel open with focus on <body>.
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body) document.querySelector<HTMLElement>('[data-drive-panel]')?.focus();
  }, [ids]);
  return (
    <>
      <PanelHead close={panel.close} />
      {chips.map((c) => <DriveCard key={c.id} chip={c} close={panel.close} />)}
    </>
  );
}

/** A link press closes the panel only when it navigates in this tab: a modified or middle click opens elsewhere and
 *  leaves the panel (and its focus) alone. */
export function closeOnPlainClick(close: () => void) {
  return (e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    close();
  };
}

function PanelHead({ close }: { close: () => void }) {
  return (
    <div className="flex items-center justify-between px-2.5 pb-0.5 pt-2">
      {/* Plain text, not a heading: one per panel, no section structure (spec §3.2). */}
      <span className="text-[12px] font-medium text-(--muted-2)">Controlling</span>
      <Link href="/devices" data-testid="drive-panel-manage" onClick={closeOnPlainClick(close)}
            className="flex items-center text-[13px] font-semibold text-(--accent-amber) underline-offset-2 hover:underline max-lg:min-h-11">
        Manage devices
      </Link>
    </div>
  );
}

// ---- The triggers ---------------------------------------------------------------------------------------------

function Chip({ chip, className }: { chip: DriveChip; className: string }) {
  const [p, triggerRef] = usePanel();
  return (
    <Popover.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Popover.Trigger
        ref={triggerRef}
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
      </Popover.Trigger>
      <PanelPopup panel={p} testId={`drive-chip-menu-${chip.id}`} label={`${chip.name} drive`} align="start">
        <PanelCards chips={[chip]} panel={p} />
      </PanelPopup>
    </Popover.Root>
  );
}

/**
 * The overflow chip. Its NUMBER is switched by CSS, so it is right on the first paint at every width; its LIST is
 * chosen in JS from the same slots, which is safe because the list only exists once someone has opened it -- after
 * hydration, with a real viewport to read.
 */
function MoreChip({ chips, showAdmin }: { chips: DriveChip[]; showAdmin: boolean }) {
  const [p, triggerRef] = usePanel();
  const n = chips.length;
  const label = (slots: number) => `+${Math.max(0, n - slots)}`;
  return (
    <Popover.Root open={p.open} onOpenChange={p.onOpenChange}>
      {/* No aria-label: the other display:none number is out of the
          accessibility tree, so the name is exactly the "+k" on screen. */}
      <Popover.Trigger ref={triggerRef} data-testid="drive-chip-more" title="More drives"
                       className={`${MORE_CLASS} ${moreVisibility(n)}`}>
        {/* One number per band, each bounded by its own variant: one chip below 1920, two from it. */}
        <span className="min-[1920px]:hidden">{label(1)}</span>
        <span className="hidden min-[1920px]:inline">{label(2)}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      </Popover.Trigger>
      <PanelPopup panel={p} testId="drive-chip-more-menu" label="Drives" align="start">
        <MoreCards chips={chips} showAdmin={showAdmin} panel={p} />
      </PanelPopup>
    </Popover.Root>
  );
}

/** The boards the "+k" chip holds: those with no chip of their own at this viewport. Read only once the popup is open. */
function restFor(chips: DriveChip[], showAdmin: boolean): DriveChip[] {
  return splitChips(chips, chipSlots(window.innerWidth, showAdmin, chips.length)).rest;
}

function MoreCards({ chips, showAdmin, panel }: { chips: DriveChip[]; showAdmin: boolean; panel: Panel }) {
  return <PanelCards chips={restFor(chips, showAdmin)} panel={panel} />;
}

/** Exported for the unit test: the cards chosen from the viewport must never repeat a chip drawn beside them. */
export function MoreList({ chips, showAdmin }: { chips: DriveChip[]; showAdmin: boolean }) {
  return <>{restFor(chips, showAdmin).map((c) => <DriveCard key={c.id} chip={c} close={() => {}} />)}</>;
}

/** The one-board control's title: between lg and xl its face drops the disk and the tag, so the title keeps them. */
function compactTitle(c: DriveChip): string {
  return [`${c.name} — ${c.online ? 'online' : 'offline'}`, diskText(c), protectTag(c)].filter(Boolean).join(' — ');
}

/** Below xl: one control (spec §8). One board: that board's chip (Ruling 6). Two or more: "Drives n" (Ruling 5). */
function CompactControl({ chips }: { chips: DriveChip[] }) {
  const [p, triggerRef] = usePanel();
  const one = chips.length === 1 ? chips[0] : null;
  return (
    <Popover.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Popover.Trigger
        ref={triggerRef}
        data-testid="drives-compact"
        title={one ? compactTitle(one) : undefined}
        className={`${CHIP_BASE} flex max-lg:w-full lg:max-w-[120px] xl:max-w-[240px]`}
        style={one && !one.online ? { opacity: 0.8 } : undefined}
      >
        {one ? (
          <ChipFace chip={one} ids="compact" />
        ) : (
          <>
            {/* The dot summarises: filled when every board is online, a ring when any is not -- each board's own
                reading is in its card. The number is how many boards, not the removed "n of N" position (Ruling 5). */}
            <StatusDot online={chips.every((c) => c.online)} />
            <span className="font-semibold">Drives</span>
            <span className="font-mono text-[13px] text-(--muted)">{chips.length}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
          </>
        )}
      </Popover.Trigger>
      {/* align="end": on a phone the trigger reaches the right edge; collisionPadding keeps the popup 16 px in. */}
      <PanelPopup panel={p} testId="drives-compact-menu" label="Drives" align="end">
        <PanelCards chips={chips} panel={p} />
      </PanelPopup>
    </Popover.Root>
  );
}

// ---- The card and its actions (spec §3.3, §4) -----------------------------------------------------------------

/**
 * Ruling 16: every action is busy from the press until its refresh lands -- aria-disabled (focus stays on it) plus a
 * guard (aria-disabled does not stop a click) plus aria-busy; try/catch/finally so a dropped connection never leaves
 * it busy; the request*() helpers already toast their own failures.
 */
function usePanelAction(allowed: boolean, request: () => Promise<boolean>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const inFlight = useRef(false);
  const off = !allowed || busy || pending;
  async function run() {
    if (off || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (await request()) start(() => router.refresh());
    } catch {
      toast.error('Something went wrong', { description: 'Try again.' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { run, off, busy: busy || pending };
}

/** Ruling 17: data-disabled mirrors aria-disabled, so the existing assertions keep their meaning. Never `disabled`. */
function offAttrs(off: boolean, busy: boolean) {
  return { 'aria-disabled': off || undefined, 'data-disabled': off ? '' : undefined, 'aria-busy': busy || undefined };
}

const ACTION =
  'flex h-9 items-center justify-center gap-2 rounded-[9px] border border-(--line) bg-(--surface) px-3 text-[13px] font-medium text-(--ink) outline-none hover:bg-(--track) focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-(--surface) max-lg:h-11';
const EJECT =
  'flex h-9 items-center justify-center gap-1.5 rounded-[9px] bg-(--ink) px-3.5 text-[13px] font-semibold text-(--surface) outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] focus-visible:ring-offset-2 aria-disabled:cursor-default aria-disabled:opacity-50 max-lg:h-11';
const GEAR =
  'flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-(--line) bg-(--surface) text-(--ink) outline-none hover:bg-(--track) focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] max-lg:size-11';

/** DriveBox's "no reading yet" switch, at the panel's 28 x 16: knob left on the track. */
function NeutralSwitch() {
  return (
    <span aria-hidden="true" className="box-border flex h-4 w-7 shrink-0 items-center justify-start rounded-full p-0.5"
          style={{ background: 'var(--track)' }}>
      <span className="size-3 rounded-full" style={{ background: '#FFFDF8', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
    </span>
  );
}

/** One board's card (spec §3.3). Exported for the render tests. */
export function DriveCard({ chip, close }: { chip: DriveChip; close: () => void }) {
  const disk = chip.disk;
  const line = diskLine(chip);
  const pill = statusPill(chip.online);
  const hfe = chip.phase === 'loaded' && disk?.readOnly === 'HFE';
  // The switch's reading: on/off once a settled disk has a known flag (an HFE is always on); null draws the neutral one.
  const wpOn = chip.phase === 'loaded' && disk && (disk.readOnly !== null || disk.writeProtected !== null)
    ? disk.readOnly !== null || disk.writeProtected === true
    : null;

  const protect = usePanelAction(chip.canToggleProtect,
    () => (disk ? requestWriteProtect(disk.id, !disk.writeProtected) : Promise.resolve(false)));
  const next = usePanelAction(chip.next !== null, () => requestNextDisk(chip.id));
  const eject = usePanelAction(chip.canEject, () => requestEject(chip.id));

  // Ruling 18: Next unmounts on the loading refresh; if it held the focus, the same card's Eject takes it.
  const ejectRef = useRef<HTMLButtonElement>(null);
  const hadNext = useRef(chip.next !== null);
  // Only a user who was ON Next is rescued; a live update never moves focus (spec 6/7).
  const nextHadFocus = useRef(false);
  useEffect(() => {
    const had = hadNext.current;
    hadNext.current = chip.next !== null;
    if (!had || chip.next !== null) return;
    const was = nextHadFocus.current;
    nextHadFocus.current = false;
    if (!was) return;
    // Base UI may already have pulled the lost focus onto the popup itself; either way nothing useful holds it.
    const a = document.activeElement;
    if (!a || a === document.body || a.hasAttribute('data-drive-panel')) ejectRef.current?.focus();
  }, [chip.next]);

  const nextWords = chip.next ? nextLabel(chip.next) : null;

  return (
    <section data-testid={`drive-entry-${chip.id}`} aria-label={`${chip.name} controls`}
             className="flex flex-col gap-3 rounded-xl bg-(--surface-2) p-3.5">
      <div className="flex items-center gap-3">
        {disk ? (
          <DiskIcon size={44} color={driveDiskColor(disk.gameId)} wp={disk.readOnly !== null || disk.writeProtected === true} />
        ) : (
          <span aria-hidden="true" className="box-border h-[45px] w-11 shrink-0 rounded-[5px]"
                style={{ border: '1.5px dashed #C4B9A2' }} />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline">
            {/* The board's name goes to its card on /devices (operator, 2026-10-01); Ruling 13: no ↗. */}
            <Link href={`/devices#device-${chip.id}`} data-testid={`drive-entry-link-${chip.id}`} onClick={closeOnPlainClick(close)}
                  className="min-w-0 truncate text-[15px] font-semibold text-(--ink) underline-offset-2 hover:underline">
              {chip.name}
            </Link>
            <span aria-hidden="true" className="shrink-0 whitespace-pre font-mono text-[12px] font-medium text-(--muted-2)">
              {' · DF0'}
            </span>
          </span>
          {/* Flex, so a long title truncates and "disk n of N" always survives (by-hand finding, 390 px). */}
          <span data-testid={`drive-entry-disk-${chip.id}`} className="flex min-w-0 font-mono text-[12px] text-(--muted)">
            <span className="min-w-0 truncate">
              {line.kind === 'title' && chip.canGoTo && disk?.gameId ? (
                <Link href={`/games/${disk.gameId}`} data-testid={`drive-goto-${chip.id}`} onClick={closeOnPlainClick(close)}
                      className="underline-offset-2 hover:underline">{line.title}</Link>
              ) : (
                // No link (Plan ruling): the words carry Go to disk's id, marked off, so it still reads as unavailable.
                <span data-testid={`drive-goto-${chip.id}`} data-disabled="">{line.kind === 'title' ? line.title : line.text}</span>
              )}
            </span>
            {line.kind === 'title' && line.count && <span className="shrink-0 whitespace-pre">{` · ${line.count}`}</span>}
          </span>
          {chip.next?.preload && (
            <span className="text-[12px] text-(--muted)" data-testid={`drive-preload-${chip.id}`} data-preload={chip.next.preload}>
              {preloadText(chip.next.diskNo, chip.next.preload)}
            </span>
          )}
          {chip.df1 && (
            <span className="truncate text-[12px] text-(--muted)" data-testid={`drive-entry-df1-${chip.id}`}>{chip.df1}</span>
          )}
        </div>
        {/* Both values, in words -- the Devices card's pill (statusPill). */}
        <span data-testid={`drive-entry-status-${chip.id}`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold"
              style={{ background: pill.bg, color: pill.fg }}>
          <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: pill.dot }} />
          {pill.label}
        </span>
      </div>

      {!chip.online && (
        // Ruling 10: every control stays live; this says why that is safe.
        <p data-testid={`drive-entry-offline-${chip.id}`} className="text-[12px] text-(--amber-text)">
          {chip.seen === 'never' ? 'Offline, never seen.' : `Offline, last seen ${chip.seen}.`} Changes reach it when it reconnects.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={wpOn === true}
          data-testid={`drive-protect-${chip.id}`}
          data-protected={disk && chip.phase === 'loaded' && disk.writeProtected !== null
            ? String(disk.readOnly !== null || disk.writeProtected) : undefined}
          title={hfe ? 'HFE disks are always read-only' : undefined}
          {...offAttrs(protect.off, protect.busy)}
          onClick={() => void protect.run()}
          className={`${ACTION} min-w-[9rem] flex-1 justify-start`}
        >
          {wpOn === null ? <NeutralSwitch /> : <WpSwitch on={wpOn} small />}
          Write-protect
          {hfe && <span className="sr-only"> (HFE, always read-only)</span>}
          {wpOn === null && <span className="sr-only"> (shown once the board holds a disk)</span>}
        </button>
        {nextWords && (
          <button type="button" data-testid={`drive-next-${chip.id}`} {...offAttrs(next.off, next.busy)}
                  aria-label={next.busy ? undefined : nextWords.name} title={nextWords.name}
                  onFocus={() => { nextHadFocus.current = true; }}
                  onBlur={(e) => { if (e.relatedTarget) nextHadFocus.current = false; }}
                  onClick={() => { nextHadFocus.current = true; void next.run(); }} className={ACTION}>
            {next.busy ? 'Switching…' : nextWords.text}
          </button>
        )}
        {/* Always rendered (Ruling 9): an empty drive shows it off, not a "Mount a disk" and not nothing. */}
        <button ref={ejectRef} type="button" data-testid={`drive-eject-${chip.id}`} {...offAttrs(eject.off, eject.busy)}
                title={chip.canEject ? undefined : 'The drive is empty'}
                onClick={() => void eject.run()} className={EJECT}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 5l7 9H5z" /><rect x="5" y="16.5" width="14" height="2.5" rx="1" />
          </svg>
          {eject.busy ? 'Ejecting…' : 'Eject'}
        </button>
        {/* Ruling 12: the board's existing Board settings modal, opened on /devices (Task 4 of the C8 plan). */}
        <Link href={`/devices?settings=${chip.id}`} data-testid={`drive-settings-${chip.id}`} onClick={closeOnPlainClick(close)}
              aria-label={`${chip.name} board settings`} className={GEAR}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
