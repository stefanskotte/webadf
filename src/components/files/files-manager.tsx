'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_ITEM } from '@/components/ui/menu-item-look';
import { cn } from '@/lib/utils';
import type { DiskInfo, FsEntry, Listing, RefusalCode, StripData } from '@/lib/files/types';
import { nextSort, sortFsEntries, type FilesSort, type FilesSortKey } from '@/lib/files/sort';
import { EMPTY_SELECTION, moveCursor, selectClick, togglePick, type Selection } from '@/lib/files/selection';
import { commandFor, type FilesCommand } from '@/lib/files/keys';
import { refusalWords } from '@/lib/files/words';
import { DEFAULT_LEFT, DEFAULT_RIGHT, formatPath, PANE_DEVICES, parsePath } from '@/lib/files/path';
import type { OpItem, OpRequest } from '@/lib/files/ops';
import type { Added } from '@/lib/files/driver';
import { addToLibraryReason, holdsFiles, offersUndo, placeOf } from '@/lib/files/pane-rules';
import type { UserPrefs } from '@/lib/user-prefs-schema';
import { latestSaver } from '@/lib/user-prefs-client';
import { clashGroups, downloadHref, DOWNLOAD_URL_MAX, type TransferGroup } from '@/lib/files/transfer';
import { identityToConfirm, undoTarget, withAddedIn, type OpVersion } from '@/lib/files/edit-rules';
import { dropBlocked, fetchDownload, reloadsBoth, stripDiskOf } from '@/lib/files/manager-rules';
import { addedIn } from '@/lib/disk-history/added-in';
import { readDroppedItems, type DroppedItem } from '@/lib/drop-reader';
import { isFileDrag } from '@/components/disks/native-drop';
import { IdentityConfirmDialog, requestUndo } from '@/components/disks/file-actions';
import { Pane } from './pane';
import { DiskStrip } from './disk-strip';
import { DropReview } from './drop-review';
import { CopyToPicker } from './copy-to-picker';
import {
  ClashDialog, ConfirmDeleteDialog, InfoDialog, NameDialog, ProtectDialog, placeName, type Clash, type ClashChoice,
} from './dialogs';

/**
 * The Files manager (spec 2026-10-29 §5): two panes with the button column between them. It owns everything the
 * panes only draw -- each side's listing, sort and selection -- and the URL (`?left&right&active`).
 *
 * Navigation fetches /api/files/list and records the new place with the NATIVE history API, which Next.js keeps in
 * step with its router: `pushState` when a pane moves (so Back walks back through folders), `replaceState` when only
 * the active side changes. Back and Forward come in as `popstate` and load whatever the URL now says; a reload lands
 * on the page, which lists both paths on the server. (A router.push would re-render the server page on every folder
 * opened, showing loading.tsx's skeleton in place of both panes each time.)
 *
 * Selections are indexes into the SORTED rows (pane.tsx), so every index here goes through `rowsOf`.
 *
 * Each pane shows STASH: or LIBRARY: (increment 2, R1). STASH: keeps no versions, so nothing that changes it offers
 * Undo, and its delete says it cannot be undone (ruling 8).
 *
 * Below lg (the C7 phone convention) only the ACTIVE pane is drawn, under a Left | Right switch; the button column is
 * a bar at the bottom with Copy to… · Move to… · Delete · More, and Copy to… / Move to… pick the place in a dialog
 * (copy-to-picker.tsx) since the other pane is out of sight. A tap on a folder row opens it and a tap on a file row
 * picks it (an archive too: its Open opens it). Which layout applies is read from the width at the moment of the tap, never at render, so the server's
 * HTML and the first client render are the same at every width.
 */

type Side = 'left' | 'right';
type DeviceKey = keyof UserPrefs['files']['sort'];
type PaneState = { path: string; listing: Listing | null; loading: boolean; error: string | null; gone: boolean; selection: Selection };

export type FilesManagerProps = {
  initial: {
    left: Listing | null; right: Listing | null; leftPath: string; rightPath: string; active: Side;
    /** Words for a pane whose first listing failed for a reason other than "gone" (an unreadable image). */
    leftError?: string; rightError?: string;
    /** The disk strip of each pane that starts inside a disk (disk-strip-data.ts). */
    strips?: StripData[];
  };
  prefs: { sort: UserPrefs['files']['sort'] };
};

type Dialog =
  | {
    kind: 'clash'; op: 'copy' | 'move'; sources: string[]; dest: string; where: string; undo: boolean; clashes: Clash[]; at: number;
    choices: Record<string, ClashChoice>;
    /** Requests still to send once these clashes are answered, and the outcomes (and versions) of those already sent. */
    rest: TransferGroup[]; done: OpItem[]; versions: OpVersion[];
  }
  | { kind: 'delete'; side: Side; entries: FsEntry[] }
  | { kind: 'makedir'; side: Side }
  | { kind: 'rename'; side: Side; entry: FsEntry }
  | { kind: 'protect'; side: Side; entries: FsEntry[] }
  | { kind: 'info'; side: Side; entry: FsEntry }
  /** Copy to… / Move to… on a phone: `sources` from the active pane, the picker starting at the other pane's place. */
  | { kind: 'pick'; op: 'copy' | 'move'; sources: string[]; start: string }
  /** The TOSEC-identity confirm before the first write to `disk` this visit; `next` goes on once it is confirmed. */
  | { kind: 'identity'; disk: DiskInfo; next(): void }
  /** Files from the computer, being read, under review for `folder` (from the disk's root) of `disk`. */
  | { kind: 'drop'; disk: DiskInfo; folder: string; where: string; items: Promise<DroppedItem[]> };

const GONE = 'This place no longer exists.';
const NO_MARKS: ReadonlyMap<string, number> = new Map();
const DRAG_TYPE = 'application/x-webfloppy-files';
const KNOWN_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  'not_found', 'read_only', 'mounted', 'disk_full', 'name_exists', 'bad_name', 'comment_too_long', 'cycle',
  'no_filesystem', 'hfe_read_only', 'conflict', 'unsupported', 'blob_unavailable', 'failed',
  'stash_full', 'too_large', 'archive_unreadable', 'not_a_disk_image',
]);
/** Enter and Space belong to a focused control; the manager must not open or pick a row as well. */
const CONTROL = 'button, a, [role="button"], [role="checkbox"]';

const otherSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');
/** Below lg: the one-pane phone layout (Tailwind's lg is 64rem). */
const isPhone = () => window.matchMedia('(max-width: 63.98rem)').matches;
const deviceOf = (path: string): DeviceKey => (path.startsWith('STASH:') ? 'stash' : path.startsWith('NET:') ? 'net' : 'library');
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const items = (n: number) => (n === 1 ? '1 item' : `${n} items`);
const disks = (n: number) => (n === 1 ? '1 disk' : `${n} disks`);
/** The disk a LIBRARY: path is in (LIBRARY:/<title>/<disk>/...), or null above the disks and anywhere else. */
function diskIdOf(path: string | undefined): string | null {
  const p = path ? parsePath(path) : null;
  return p?.device === 'LIBRARY' ? p.segments[1] ?? null : null;
}
/** The root of the device a path is on ("STASH:"), for a pane whose place is gone. */
const deviceRoot = (path: string) => `${parsePath(path)?.device ?? 'LIBRARY'}:`;
const byDisk = (list: StripData[] | undefined) => Object.fromEntries((list ?? []).map((d) => [d.diskId, d]));

/** A strip as JSON brings it: the History's dates are strings until revived. */
function reviveStrip(d: StripData): StripData {
  return { ...d, history: d.history.map((v) => ({ ...v, createdAt: new Date(v.createdAt) })) };
}

async function fetchStrip(diskId: string): Promise<StripData | null> {
  try {
    const res = await fetch(`/api/files/disk-strip?diskId=${encodeURIComponent(diskId)}`, { cache: 'no-store' });
    return res.ok ? reviveStrip((await res.json()) as StripData) : null;
  } catch {
    return null;
  }
}

/** A refreshed server listing changes a pane only when the drive state it shows has changed (a mount, an eject). */
function heldChanged(a: Listing, b: Listing): boolean {
  return a.writable !== b.writable || a.readOnlyReason !== b.readOnlyReason || a.disk?.holder !== b.disk?.holder;
}

/** A query value as a pane path, as the page reads it (page.tsx): canonical on a pane's device, or `fallback`. */
function pathParam(raw: string | null, fallback: string): string {
  const p = raw === null ? null : parsePath(raw);
  return p && PANE_DEVICES.includes(p.device) ? formatPath(p) : fallback;
}

function urlOf(left: string, right: string, active: Side): string {
  return `/files?${new URLSearchParams({ left, right, active })}`;
}

/** The words for an error body; codes this client does not know read as a plain failure. */
function wordsFor(code: unknown, detail: unknown): string {
  const d = typeof detail === 'string' ? detail : undefined;
  return typeof code === 'string' && KNOWN_CODES.has(code) ? refusalWords(code as RefusalCode, d) : refusalWords('failed');
}

/** `code`: the refusal's own code, for a caller that answers one differently (an archive that does not open). */
async function fetchListing(path: string): Promise<{ listing: Listing } | { gone: true } | { error: string; code?: unknown }> {
  try {
    const res = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (res.ok) return { listing: (await res.json()) as Listing };
    if (res.status === 404 || res.status === 400) return { gone: true };
    const body = (await res.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null;
    return { error: wordsFor(body?.error, body?.detail), code: body?.error };
  } catch {
    return { error: refusalWords('failed') };
  }
}

function firstState(path: string, listing: Listing | null, error: string | undefined): PaneState {
  return { path, listing, loading: false, error: listing ? null : error ?? GONE, gone: !listing && !error, selection: EMPTY_SELECTION };
}

/** The picked entries, in the order the rows are drawn. */
function pickedOf(rows: FsEntry[], sel: Selection): FsEntry[] {
  return [...sel.picked].filter((i) => i < rows.length).sort((a, b) => a - b).map((i) => rows[i]);
}

/** The same rows under another sort: the picked ones and the cursor follow their entries. */
function remapSelection(before: FsEntry[], after: FsEntry[], sel: Selection): Selection {
  const at = new Map(after.map((e, i) => [e.path, i]));
  const map = (i: number | null) => (i === null || !before[i] ? null : at.get(before[i].path) ?? null);
  const picked = new Set<number>();
  for (const i of sel.picked) { const j = map(i); if (j !== null) picked.add(j); }
  return { anchor: map(sel.anchor), cursor: map(sel.cursor) ?? 0, picked };
}

/** The "new in vN" marks of the disk a listing is inside, from its strip's History; none above the disks. */
function useMarks(l: Listing | null, strips: Record<string, StripData>): ReadonlyMap<string, number> {
  const history = l?.disk ? strips[l.disk.diskId]?.history : undefined;
  return useMemo(() => (history ? addedIn(history) : NO_MARKS), [history]);
}

function shown(l: Listing | null, marks: ReadonlyMap<string, number>): Listing | null {
  return l && marks.size ? { ...l, entries: withAddedIn(l.entries, marks) } : l;
}

/** One button of the column. The reason sits on a wrapper too: a disabled button takes no pointer events, so its
 *  own title never shows. */
function ActionButton({ id, label, reason, busy, onClick, primary = false }: {
  id: string; label: string; reason: string | null; busy: boolean; onClick(): void; primary?: boolean;
}) {
  return (
    <span title={reason ?? undefined} className="flex max-lg:hidden">
      <Button variant={primary ? 'default' : 'outline'} size="sm" className="w-full" onClick={onClick}
              disabled={reason !== null || busy} title={reason ?? undefined} data-testid={`files-${id}`}>
        {label}
      </Button>
    </span>
  );
}

/**
 * One button of the phone bar. A finger gets no tooltip, so a button that cannot act now is not `disabled`: it looks
 * dimmed (aria-disabled) and a tap says why (act() toasts the reason).
 */
function PhoneButton({ id, label, reason, busy, onClick, primary = false }: {
  id: string; label: string; reason: string | null; busy: boolean; onClick(): void; primary?: boolean;
}) {
  return (
    <Button variant={primary ? 'default' : 'outline'} onClick={onClick} data-testid={`files-phone-${id}`}
            aria-disabled={reason !== null || busy || undefined}
            className="min-h-11 min-w-0 flex-1 px-1.5 aria-disabled:opacity-50 lg:hidden">
      {label}
    </Button>
  );
}

export function FilesManager({ initial, prefs }: FilesManagerProps) {
  const router = useRouter();
  const [panes, setPanes] = useState<Record<Side, PaneState>>(() => ({
    left: firstState(initial.leftPath, initial.left, initial.leftError),
    right: firstState(initial.rightPath, initial.right, initial.rightError),
  }));
  const [active, setActive] = useState<Side>(initial.active);
  const [sorts, setSorts] = useState(prefs.sort);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saver] = useState(latestSaver);
  const [strips, setStrips] = useState<Record<string, StripData>>(() => byDisk(initial.strips));
  // A router refresh (the live device poll, a Mount) renders the page again with fresh strips and listings. The strips
  // replace ours; a listing is taken only where the pane is still at that place and its drive state changed, so a
  // pane the person is working in is never reset by a refresh that changed nothing it shows.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setStrips((cur) => ({ ...cur, ...byDisk(initial.strips) }));
    setPanes((ps) => {
      let out = ps;
      for (const s of ['left', 'right'] as const) {
        const fresh = initial[s];
        const cur = ps[s].listing;
        if (fresh && cur && !ps[s].loading && fresh.path === cur.path && heldChanged(cur, fresh)) {
          const same = fresh.entries.length === cur.entries.length && fresh.entries.every((e, i) => e.path === cur.entries[i].path);
          out = { ...out, [s]: { ...ps[s], listing: fresh, selection: same ? ps[s].selection : EMPTY_SELECTION } };
        }
      }
      return out;
    });
  }
  const rootRef = useRef<HTMLDivElement>(null);
  // A pane's newest request wins: a slow listing that lands after a newer one is dropped.
  const seq = useRef<Record<Side, number>>({ left: 0, right: 0 });
  // For the popstate listener, which outlives a render.
  const latest = useRef({ panes, active });
  useEffect(() => { latest.current = { panes, active }; });

  const sortOf = (l: Listing | null, path: string) => sorts[deviceOf(l?.path ?? path)];
  // What each pane draws: its listing with the "new in vN" marks from its disk's History (the strip carries it).
  const marksLeft = useMarks(panes.left.listing, strips);
  const marksRight = useMarks(panes.right.listing, strips);
  const shownLeft = useMemo(() => shown(panes.left.listing, marksLeft), [panes.left.listing, marksLeft]);
  const shownRight = useMemo(() => shown(panes.right.listing, marksRight), [panes.right.listing, marksRight]);
  const rowsLeft = useMemo(() => (shownLeft ? sortFsEntries(shownLeft.entries, sorts[deviceOf(shownLeft.path)]) : []), [shownLeft, sorts]);
  const rowsRight = useMemo(() => (shownRight ? sortFsEntries(shownRight.entries, sorts[deviceOf(shownRight.path)]) : []), [shownRight, sorts]);
  const rowsOf = (s: Side) => (s === 'left' ? rowsLeft : rowsRight);

  // ---- loading and the URL ------------------------------------------------------------------------------------

  /**
   * List `path` into a side. A new place keeps the old rows on screen (busy) until it lands; then nothing is picked.
   * A refusal with the code `stayOn` leaves the pane where it was and says so in a toast (an archive that does not
   * open: the person is still in its folder, and can download it). Resolves true when the place was listed.
   */
  async function load(side: Side, path: string, stayOn?: RefusalCode): Promise<boolean> {
    const n = ++seq.current[side];
    setPanes((ps) => ({ ...ps, [side]: { ...ps[side], path: stayOn ? ps[side].path : path, loading: true } }));
    const r = await fetchListing(path);
    if (n !== seq.current[side]) return false;
    if (stayOn && 'code' in r && r.code === stayOn) {
      toast.error(r.error);
      setPanes((ps) => ({ ...ps, [side]: { ...ps[side], loading: false } }));
      return false;
    }
    setPanes((ps) => ({
      ...ps,
      [side]: 'listing' in r
        ? { path, listing: r.listing, loading: false, error: null, gone: false, selection: EMPTY_SELECTION }
        : { path, listing: null, loading: false, error: 'gone' in r ? GONE : r.error, gone: 'gone' in r, selection: EMPTY_SELECTION },
    }));
    return 'listing' in r;
  }

  /**
   * Fresh listings where the panes are NOW. Called after an operation's await, so it reads the latest state, not
   * this render's: a pane the person moved while the operation ran stays where they took it.
   */
  function reloadBoth() {
    const { panes: cur } = latest.current;
    void load('left', cur.left.path);
    void load('right', cur.right.path);
  }

  function navigate(side: Side, path: string) {
    void load(side, path);
    const left = side === 'left' ? path : panes.left.path;
    const right = side === 'right' ? path : panes.right.path;
    if (active !== side) setActive(side);
    window.history.pushState(null, '', urlOf(left, right, side));
  }

  /**
   * An archive opens as a read-only folder (ruling 7). One that does not open (422 archive_unreadable) is a toast and
   * the pane stays; the URL moves only once it has opened.
   */
  function openArchive(side: Side, path: string) {
    if (active !== side) setActive(side);
    void load(side, path, 'archive_unreadable').then((ok) => {
      if (!ok) return;
      const { panes: cur } = latest.current;
      window.history.pushState(null, '', urlOf(side === 'left' ? path : cur.left.path, side === 'right' ? path : cur.right.path, side));
    });
  }

  /** Idempotent: the panes call this on every mousedown and focus inside them. */
  function activate(side: Side) {
    if (active === side) return;
    setActive(side);
    window.history.replaceState(null, '', urlOf(panes.left.path, panes.right.path, side));
  }

  useEffect(() => {
    function onPop() {
      const q = new URLSearchParams(window.location.search);
      const want = { left: pathParam(q.get('left'), DEFAULT_LEFT), right: pathParam(q.get('right'), DEFAULT_RIGHT) };
      const { panes: cur } = latest.current;
      for (const s of ['left', 'right'] as const) if (cur[s].path !== want[s]) void load(s, want[s]);
      setActive(q.get('active') === 'right' ? 'right' : 'left');
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // `load` only touches refs and state setters, so the listener never goes stale.
  }, []);

  // ---- the disk strips ---------------------------------------------------------------------------------------

  /** Fresh strip data for a disk; resolves to its current version (null when unknown or never changed). */
  async function refreshStrip(diskId: string): Promise<number | null> {
    const d = await fetchStrip(diskId);
    if (d) setStrips((cur) => ({ ...cur, [diskId]: d }));
    return d?.headSeq ?? null;
  }

  // A pane that moved into a disk on the client has no strip yet: ask for it once.
  const asked = useRef(new Set<string>(Object.keys(byDisk(initial.strips))));
  const shownDisks = [stripDiskOf(panes.left), stripDiskOf(panes.right)].filter((x): x is string => !!x);
  const shownKey = shownDisks.join(',');
  useEffect(() => {
    for (const id of shownKey.split(',')) {
      if (!id || asked.current.has(id)) continue;
      asked.current.add(id);
      void refreshStrip(id);
    }
  }, [shownKey]);

  /** After the strip changed a disk or its drive (an eject, a rename, a restore): the panes showing it and the strip. */
  function stripChanged(diskId: string) {
    const { panes: cur } = latest.current;
    for (const s of ['left', 'right'] as const) if (cur[s].listing?.disk?.diskId === diskId) void load(s, cur[s].path);
    void refreshStrip(diskId);
  }

  // A dialog unmounts when it closes, and Base UI's own return of focus then lands on a stale element (the opener of
  // an EARLIER dialog) or on <body>. So the manager puts it back itself: on the control that opened the dialog when it
  // was dismissed, or on the manager after the dialog's operation ran -- the buttons go disabled while it runs and the
  // selection they acted on is gone after, and a disabled button drops focus to <body>. Only the manager's own DOM is
  // remembered: React bubbles a portalled dialog's focus events through this tree too.
  const lastFocus = useRef<HTMLElement | null>(null);
  const hadDialog = useRef(false);
  const ranOp = useRef(false);
  useEffect(() => {
    if (dialog) { hadDialog.current = true; return; }
    if (!hadDialog.current) return;
    hadDialog.current = false;
    const afterOp = ranOp.current;
    ranOp.current = false;
    const id = requestAnimationFrame(() => {
      const now = document.activeElement;
      // Focus somewhere else on purpose (a toast's Undo, another portal) is left alone.
      if (now && now !== document.body && now.isConnected && !rootRef.current?.contains(now)) return;
      const back = lastFocus.current;
      const usable = !afterOp && back?.isConnected && !(back as HTMLButtonElement).disabled && rootRef.current?.contains(back);
      (usable ? back : rootRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [dialog]);

  // Keep the cursor row on screen as the arrow keys move it.
  const cursorKey = `${active}:${panes[active].selection.cursor}`;
  useEffect(() => {
    rootRef.current?.querySelector(`[data-testid="pane-${active}"] tr[data-cursor="true"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursorKey, active]);

  // ---- selection and sort -------------------------------------------------------------------------------------

  function setSelection(side: Side, f: (s: Selection) => Selection) {
    setPanes((ps) => ({ ...ps, [side]: { ...ps[side], selection: f(ps[side].selection) } }));
  }

  function changeSort(side: Side, key: FilesSortKey) {
    applySort(side, nextSort(sorts[deviceOf(panes[side].listing?.path ?? panes[side].path)], key));
  }

  /** `next` for the device `side` shows (a header click, or the phone's sort button), remembered for next time. */
  function applySort(side: Side, next: FilesSort) {
    const dev = deviceOf(panes[side].listing?.path ?? panes[side].path);
    // Both panes on this device re-sort; their picks follow their entries.
    setPanes((ps) => {
      const out = { ...ps };
      for (const s of ['left', 'right'] as const) {
        const l = ps[s].listing;
        if (!l || deviceOf(l.path) !== dev) continue;
        out[s] = { ...ps[s], selection: remapSelection(sortFsEntries(l.entries, sorts[dev]), sortFsEntries(l.entries, next), ps[s].selection) };
      }
      return out;
    });
    setSorts((cur) => ({ ...cur, [dev]: next }));
    const sort: { library?: FilesSort; stash?: FilesSort; net?: FilesSort } = {};
    sort[dev] = next;
    saver.save({ files: { sort } }).catch(() => toast.error("Couldn't remember this sort order for next time."));
  }

  /**
   * A row tapped on a phone: a folder (title, disk) opens, a file or an archive is picked or let go (an archive opens
   * by its Open, or a double-tap). Desktop clicks select.
   */
  function rowClick(side: Side, index: number, mods: { shift: boolean; toggle: boolean }) {
    activate(side);
    const e = rowsOf(side)[index];
    if (e && !mods.shift && !mods.toggle && isPhone()) {
      if (e.kind === 'file' || e.kind === 'archive') setSelection(side, (s) => togglePick({ ...s, cursor: index }, index));
      else navigate(side, e.path);
      return;
    }
    setSelection(side, (s) => selectClick(s, index, mods));
  }

  function openRow(side: Side, index: number) {
    const e = rowsOf(side)[index];
    if (!e) return;
    if (e.kind === 'file') setDialog({ kind: 'info', side, entry: e });
    else if (e.kind === 'archive') openArchive(side, e.path);
    else navigate(side, e.path);
  }

  // ---- what the buttons can do --------------------------------------------------------------------------------

  const src = panes[active].listing;
  const dst = panes[otherSide(active)].listing;
  const picked = pickedOf(rowsOf(active), panes[active].selection);
  const folderName = src?.crumbs[src.crumbs.length - 1]?.label ?? 'Files';
  const readOnly = (l: Listing) => refusalWords('read_only', l.readOnlyReason ?? undefined);

  // Only a place that holds files (inside a disk, or STASH:) has rows to act on and room to take them (ruling 8).
  function sourceReason(writable: boolean): string | null {
    if (picked.length === 0) return 'Select something first';
    if (!holdsFiles(src)) return 'Only files and folders on a disk or in STASH: can be changed here — open one first';
    if (writable && !src!.writable) return readOnly(src!);
    return null;
  }
  function transferReason(op: 'copy' | 'move'): string | null {
    const r = sourceReason(op === 'move');
    if (r) return r;
    if (!holdsFiles(dst)) return 'Open a disk or STASH: on the other side';
    if (!dst!.writable) return readOnly(dst!);
    return null;
  }
  const one = (r: string | null, what: string) => r ?? (picked.length !== 1 ? `Select one item to ${what}` : null);
  const reasons = {
    copy: transferReason('copy'),
    move: transferReason('move'),
    delete: sourceReason(true),
    rename: one(sourceReason(true), 'rename it'),
    makedir: !holdsFiles(src) ? 'Open a disk or STASH: to make a folder in it' : !src!.writable ? readOnly(src!) : null,
    protect: sourceReason(true),
    info: one(sourceReason(false), 'see its details'),
    // One file by path; several, or a folder, as a .zip (spec §3.3).
    download: sourceReason(false)
      ?? (downloadHref(picked, folderName).length > DOWNLOAD_URL_MAX ? 'Too many items to download at once — download their folder instead' : null),
    // The phone's Copy to… / Move to…: the place is picked afterwards, so only the source is checked here.
    copyTo: sourceReason(false),
    moveTo: sourceReason(true),
    // Disk images in STASH: into the library (R8).
    addlib: addToLibraryReason(src, picked),
  };
  /** Add to library is offered only while the active pane is in STASH: (R8). */
  const inStash = !!src && deviceOf(src.path) === 'stash';

  // ---- running an operation -----------------------------------------------------------------------------------

  type Outcome = { kind: 'done'; items: OpItem[]; versions: OpVersion[]; added: Added[] } | { kind: 'clashes'; clashes: Clash[] } | { kind: 'refused' };

  async function post(req: OpRequest, label: string): Promise<Outcome> {
    setBusy(label);
    try {
      const res = await fetch('/api/files/ops', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
      });
      const body = (await res.json().catch(() => null)) as {
        items?: OpItem[]; versions?: OpVersion[]; added?: Added[]; error?: unknown; detail?: unknown; clashes?: Clash[];
      } | null;
      if (res.status === 409 && body?.error === 'clashes' && body.clashes) return { kind: 'clashes', clashes: body.clashes };
      if (!res.ok || !body?.items) {
        toast.error(wordsFor(body?.error, body?.detail));
        if (reloadsBoth(body?.error)) reloadBoth();
        return { kind: 'refused' };
      }
      return { kind: 'done', items: body.items, versions: body.versions ?? [], added: body.added ?? [] };
    } catch {
      toast.error(refusalWords('failed'));
      return { kind: 'refused' };
    } finally {
      setBusy(null);
    }
  }

  /** Undo from a toast: the disk back to the version before the op's own, then fresh panes and strip. */
  async function undo(v: OpVersion) {
    if (await requestUndo(v.diskId, v.seq)) {
      reloadBoth();
      void refreshStrip(v.diskId);
    }
  }

  /** A toast's Undo, when the op saved exactly one version of one disk (edit-rules.ts undoTarget). */
  function undoAction(versions: OpVersion[]) {
    const v = undoTarget(versions);
    return v ? { action: { label: 'Undo', onClick: () => void undo(v) } } : {};
  }

  type ToastAction = { label: string; onClick(): void };

  /**
   * The toast for a finished operation, and fresh listings on both sides (which also clears both selections). With a
   * `target` disk the toast says which version the change was saved as (the op's own, else the disk's fresh head), and
   * an op that saved one version of one disk offers Undo -- unless `undo` is false (it changed STASH: too, which keeps
   * no versions) or the toast carries its own `action` instead.
   */
  async function report(done: OpItem[], success: (n: number) => string, target: string | null, versions: OpVersion[],
    opts: { undo?: boolean; action?: ToastAction } = {}) {
    const offer = (): { action?: ToastAction } => (opts.action ? { action: opts.action } : opts.undo === false ? {} : undoAction(versions));
    const failed = done.filter((i): i is Extract<OpItem, { ok: false }> => !i.ok);
    const ok = done.length - failed.length;
    reloadBoth();
    // Every disk on screen may have a new version (a move changes its source too); the target's is the one named.
    const { panes: cur } = latest.current;
    const others = [cur.left.listing?.disk?.diskId, cur.right.listing?.disk?.diskId].filter((x): x is string => !!x && x !== target);
    for (const id of new Set(others)) void refreshStrip(id);
    const head = target && ok > 0 ? await refreshStrip(target) : null;
    const seq = versions.filter((v) => v.diskId === target).at(-1)?.seq ?? head;
    const said = (n: number) => (seq === null ? success(n) : `${success(n).replace(/\.$/, '')} — saved as version ${seq}.`);
    if (failed.length === 0) toast.success(said(done.length), offer());
    else {
      toast.error(ok > 0 ? `${said(ok)} ${items(failed.length)} could not be done.` : `Nothing was done.`, {
        ...(ok > 0 ? offer() : {}),
        description: (
          <ul data-testid="files-failures">
            {failed.map((f) => <li key={f.source}>{baseName(f.source)}: {refusalWords(f.refusal.code, f.refusal.detail)}</li>)}
          </ul>
        ),
      });
    }
  }

  const verbs = { copy: ['Copying', 'Copied'], move: ['Moving', 'Moved'] } as const;

  type ClashDialogState = Extract<Dialog, { kind: 'clash' }>;
  /** `undo`: whether the run may offer Undo (offersUndo: not when it changes STASH:). */
  type Run = { op: 'copy' | 'move'; dest: string; where: string; undo: boolean };

  function transfer(op: 'copy' | 'move', sources: string[], dest: string, where: string) {
    if (busy) return;
    void runGroups({ op, dest, where, undo: offersUndo(op, sources, dest) }, [{ onClash: 'ask', sources }], [], []);
  }

  /**
   * Send the groups in turn. A 409 clashes answer (always on the first 'ask'; on a resend only if the folder changed
   * in between) opens the Clash dialog; the groups not yet sent wait in it with what is already done, and go on once
   * every clash has an answer. A refusal stops the run (its toast is already up); what was done is still reported.
   */
  async function runGroups(run: Run, groups: TransferGroup[], done: OpItem[], versions: OpVersion[]) {
    for (const [k, g] of groups.entries()) {
      const r = await post({ op: run.op, sources: g.sources, dest: run.dest, onClash: g.onClash },
        `${verbs[run.op][0]} ${items(g.sources.length)}…`);
      if (r.kind === 'done') { done.push(...r.items); versions.push(...r.versions); continue; }
      if (r.kind === 'clashes') {
        setDialog({ kind: 'clash', ...run, sources: g.sources, clashes: r.clashes, at: 0, choices: {}, rest: groups.slice(k + 1), done, versions });
        return;
      }
      break;
    }
    finishRun(run, done, versions);
  }

  /** Several requests saved several versions: Undo of the last alone would undo only part of the run, so none. */
  function finishRun(run: Run, done: OpItem[], versions: OpVersion[]) {
    if (done.length) void report(done, (n) => `${verbs[run.op][1]} ${items(n)} to ${run.where}.`, diskIdOf(run.dest), versions, { undo: run.undo });
    else reloadBoth();
  }

  function chooseClash(choice: ClashChoice, forAll: boolean) {
    if (dialog?.kind !== 'clash') return;
    const d: ClashDialogState = dialog;
    const choices = { ...d.choices };
    const upto = forAll ? d.clashes.length : d.at + 1;
    for (let i = d.at; i < upto; i++) choices[d.clashes[i].source] = choice;
    if (upto < d.clashes.length) { setDialog({ ...d, at: upto, choices }); return; }
    ranOp.current = true;
    setDialog(null);
    void runGroups(d, [...clashGroups(d.sources, d.clashes.map((c) => c.source), choices), ...d.rest], [...d.done], [...d.versions]);
  }

  /** Cancel stops the run here; anything an earlier request already did is still reported. */
  function cancelClash() {
    if (dialog?.kind !== 'clash') return;
    const d: ClashDialogState = dialog;
    setDialog(null);
    if (d.done.length) finishRun(d, d.done, d.versions);
  }

  const where = placeOf;

  /**
   * Run `go` once every disk it will change has had its TOSEC-identity confirm (the Browse page's D-W-3): asked before
   * the first write to such a disk this visit, one disk at a time; Cancel writes nothing.
   */
  const confirmedIdentity = useRef(new Set<string>());
  function guarded(changes: (DiskInfo | null | undefined)[], go: () => void) {
    const disk = identityToConfirm(changes, confirmedIdentity.current);
    if (!disk) { go(); return; }
    setDialog({ kind: 'identity', disk, next: () => guarded(changes, go) });
  }

  function confirmIdentity() {
    if (dialog?.kind !== 'identity') return;
    const { disk, next } = dialog;
    confirmedIdentity.current.add(disk.diskId);
    ranOp.current = true;
    setDialog(null);
    next();
  }

  function act(cmd: 'copy' | 'move' | 'delete' | 'rename' | 'makedir' | 'protect' | 'info' | 'download' | 'copyTo' | 'moveTo' | 'addlib') {
    if (busy) return;
    const reason = reasons[cmd];
    if (reason) { toast.error(reason); return; }
    const side = active;
    const sources = picked.map((e) => e.path);
    switch (cmd) {
      case 'copy': guarded([dst?.disk], () => transfer('copy', sources, dst!.path, where(dst))); return;
      case 'move': guarded([dst?.disk, src?.disk], () => transfer('move', sources, dst!.path, where(dst))); return;
      case 'delete': guarded([src?.disk], () => setDialog({ kind: 'delete', side, entries: picked })); return;
      case 'rename': guarded([src?.disk], () => setDialog({ kind: 'rename', side, entry: picked[0] })); return;
      case 'makedir': guarded([src?.disk], () => setDialog({ kind: 'makedir', side })); return;
      case 'protect': guarded([src?.disk], () => setDialog({ kind: 'protect', side, entries: picked })); return;
      case 'info': setDialog({ kind: 'info', side, entry: picked[0] }); return;
      case 'copyTo': setDialog({ kind: 'pick', op: 'copy', sources, start: panes[otherSide(side)].path }); return;
      case 'moveTo': setDialog({ kind: 'pick', op: 'move', sources, start: panes[otherSide(side)].path }); return;
      case 'download': void download(downloadHref(picked, folderName)); return;
      case 'addlib': void addToLibrary(picked); return;
    }
  }

  /**
   * Disk images in STASH: into the library (R8): one op, then the toast with Open title (the first disk added); both
   * panes reload, so the rows gain "in the library". Failures are listed as for any op.
   */
  async function addToLibrary(entries: FsEntry[]) {
    const r = await post({ op: 'add-to-library', sources: entries.map((e) => e.path) }, `Adding ${disks(entries.length)} to the library…`);
    if (r.kind !== 'done') return;
    const first = r.added[0];
    void report(r.items, (n) => `Added ${disks(n)} to the library.`, null, [],
      first ? { action: { label: 'Open title', onClick: () => router.push(`/games/${first.gameId}`) } } : { undo: false });
  }

  /** A disk image row's own Add to library (pane.tsx): that row alone, whatever else is picked. */
  function addRowToLibrary(side: Side, index: number) {
    activate(side);
    const e = rowsOf(side)[index];
    if (!e || busy) return;
    const reason = addToLibraryReason(panes[side].listing, [e]);
    if (reason) { toast.error(reason); return; }
    void addToLibrary([e]);
  }

  /**
   * Fetched, then saved from memory: a refusal (too large, gone, unreadable) is a toast in words rather than an error
   * page saved as the file. One file is at most an HD disk's 1.76 MB and a zip at most the 4 MB cap, so memory is fine.
   */
  async function download(href: string) {
    setBusy('Preparing the download…');
    try {
      const r = await fetchDownload(href);
      if (!r.ok) { toast.error('words' in r ? r.words : wordsFor(r.code, r.detail)); return; }
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.name;
      document.body.appendChild(a); a.click(); a.remove();
      // The click has handed the bytes to the browser's download; the URL is not needed after this task.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
      setBusy(null);
    }
  }

  /**
   * The picker chose `l`: the other pane goes there (so switching to it shows the result) and the copy or move runs as
   * the desktop's does -- the TOSEC confirm, the clash dialog, the versioned toast with Undo.
   */
  function placePicked(d: Extract<Dialog, { kind: 'pick' }>, l: Listing) {
    ranOp.current = true;
    setDialog(null);
    const side = otherSide(active);
    if (panes[side].path !== l.path) {
      void load(side, l.path);
      window.history.pushState(null, '', urlOf(side === 'left' ? l.path : panes.left.path, side === 'right' ? l.path : panes.right.path, active));
    }
    guarded([l.disk, d.op === 'move' ? src?.disk : null], () => transfer(d.op, d.sources, l.path, where(l)));
  }

  /** A dialog's operation: the dialog stays open (busy) while it runs and closes once it is done. */
  async function runFromDialog(req: OpRequest, label: string, success: (n: number) => string) {
    const r = await post(req, label);
    // The disk the operation changed: where it made the folder, else where its first source is.
    const target = diskIdOf('dest' in req ? req.dest : 'source' in req ? req.source : req.sources[0]);
    if (r.kind === 'done') { ranOp.current = true; setDialog(null); void report(r.items, success, target, r.versions); }
  }

  function swap() {
    if (busy) return;
    const next = { left: panes.right, right: panes.left };
    // A listing still on its way belongs to the other side now: drop it and ask again for the side it moved to.
    seq.current = { left: seq.current.left + 1, right: seq.current.right + 1 };
    setPanes({ left: { ...next.left, loading: false }, right: { ...next.right, loading: false } });
    for (const s of ['left', 'right'] as const) if (next[s].loading) void load(s, next[s].path);
    window.history.pushState(null, '', urlOf(next.left.path, next.right.path, active));
  }

  // ---- keys and drag ------------------------------------------------------------------------------------------

  function command(cmd: FilesCommand, shift: boolean) {
    const sel = panes[active].selection;
    const count = rowsOf(active).length;
    switch (cmd) {
      case 'up': setSelection(active, (s) => moveCursor(s, -1, count, shift)); return;
      case 'down': setSelection(active, (s) => moveCursor(s, 1, count, shift)); return;
      case 'pick': if (count) setSelection(active, (s) => togglePick(s, s.cursor)); return;
      case 'open': if (count) openRow(active, sel.cursor); return;
      case 'parent': {
        const crumbs = src?.crumbs ?? [];
        if (crumbs.length > 1) navigate(active, crumbs[crumbs.length - 2].path);
        return;
      }
      case 'switch': activate(otherSide(active)); return;
      default: act(cmd);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    // React bubbles a portal's events through the component tree, so keys pressed in the More menu, a dialog or a
    // toast reach this handler although their DOM is elsewhere. Only keys from the manager's own DOM are its keys.
    if (!rootRef.current?.contains(target)) return;
    const cmd = commandFor({ key: e.key, target, dialogOpen: dialog !== null, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
    if (!cmd) return;
    if ((cmd === 'open' || cmd === 'pick') && target.matches(CONTROL)) return;
    // Tab switches panes only from the manager itself; on a control it moves focus as usual, and Shift+Tab always
    // leaves, so the keyboard is never trapped here.
    if (cmd === 'switch' && (target !== rootRef.current || e.shiftKey)) return;
    e.preventDefault();
    command(cmd, e.shiftKey);
  }

  function dragStart(side: Side, indexes: number[], e: React.DragEvent) {
    const l = panes[side].listing;
    const rows = rowsOf(side);
    const paths = indexes.map((i) => rows[i]?.path).filter((p): p is string => !!p);
    if (!holdsFiles(l) || paths.length === 0) { e.preventDefault(); return; }   // titles and disks do not move
    activate(side);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ from: side, paths }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  /** The folder row a drop landed on, else the folder the pane shows. */
  function dropFolder(l: Listing, e: React.DragEvent): string {
    const row = (e.target as HTMLElement).closest?.('tr[data-testid="pane-row"]') as HTMLElement | null;
    return row?.dataset.kind === 'dir' ? l.entries.find((x) => x.name === row.dataset.name)?.path ?? l.path : l.path;
  }

  /**
   * Files from the computer dropped on a pane (R5): the Browse page's review (drop-review.tsx) for the folder they
   * landed in, then the disk's batch route. Only a writable folder inside a disk takes them.
   */
  function dropFromComputer(side: Side, e: React.DragEvent) {
    const l = panes[side].listing;
    if (!l?.disk) { toast.error('Open a disk to drop files into it'); return; }
    if (!l.writable) { toast.error(readOnly(l)); return; }
    // Busy, or a dialog open (the review would replace it, and whatever it was in the middle of): not taken, said.
    const blocked = dropBlocked({ busy: busy !== null, dialogOpen: dialog !== null });
    if (blocked) { toast.error(blocked); return; }
    activate(side);
    const disk = l.disk;
    const dest = dropFolder(l, e);
    const folder = (parsePath(dest)?.segments ?? []).slice(2).join('/');
    const where = dest === l.path ? l.crumbs[l.crumbs.length - 1]?.label ?? disk.label : baseName(dest);
    // Read synchronously, before any await or confirm: the browser empties the DataTransfer once this handler returns.
    const reading = readDroppedItems(e.dataTransfer.items);
    guarded([disk], () => setDialog({ kind: 'drop', disk, folder, where, items: reading }));
  }

  /** The review wrote its batch: fresh panes and strip, and the versioned toast with Undo. */
  function dropWritten(d: Extract<Dialog, { kind: 'drop' }>, written: { seq: number | null; message: string }) {
    // The review may have been closed while it wrote, and another dialog opened since: only the review itself closes.
    ranOp.current = true;
    setDialog((cur) => (cur === d ? null : cur));
    reloadBoth();
    void refreshStrip(d.disk.diskId);
    const saved = written.seq === null ? '' : ` — saved as version ${written.seq}`;
    toast.success(`${written.message} to ${d.where}${saved}.`,
      undoAction(written.seq === null ? [] : [{ diskId: d.disk.diskId, seq: written.seq }]));
  }

  /** Rows dropped on a pane: Copy, or Move with Shift; onto a folder row, into that folder. */
  function drop(side: Side, e: React.DragEvent) {
    // Files from the computer first: an OS drag never carries the panes' own type.
    if (isFileDrag(e)) { dropFromComputer(side, e); return; }
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    let data: { from: Side; paths: string[] };
    try { data = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(data.paths) || data.paths.length === 0) return;
    const blocked = dropBlocked({ busy: busy !== null, dialogOpen: dialog !== null });
    if (blocked) { toast.error(blocked); return; }
    const l = panes[side].listing;
    if (!l || !holdsFiles(l)) { toast.error('Open a disk or STASH: to drop files into it'); return; }
    if (!l.writable) { toast.error(readOnly(l)); return; }
    const dest = dropFolder(l, e);
    if (data.paths.includes(dest)) return;                       // a folder dropped on itself
    if (data.from === side && dest === l.path) return;           // put back where it was picked up
    const op = e.shiftKey ? 'move' : 'copy';
    const from = panes[data.from]?.listing;
    if (op === 'move' && from && !from.writable) { toast.error(readOnly(from)); return; }
    activate(side);
    const label = where(l);
    guarded([l.disk, op === 'move' ? from?.disk : null], () => transfer(op, data.paths, dest, label));
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  const arrow = active === 'left';
  const dialogBusy = busy !== null;
  const dialogListing = dialog && 'side' in dialog ? panes[dialog.side].listing : null;
  // What a delete names: the disk, or STASH: (whose delete cannot be undone: ruling 8).
  const deleteWhere = dialogListing && deviceOf(dialogListing.path) === 'stash' ? 'STASH:' as const : dialogListing?.disk ?? null;

  function pane(side: Side) {
    const p = panes[side];
    // A disk whose image cannot be read has no listing, but still has its strip (History, Restore) from the database.
    const stripId = stripDiskOf(p);
    const strip = stripId ? strips[stripId] : undefined;
    const disk = p.listing?.disk ?? strip?.info ?? null;
    return (
      // Below lg only the active side is drawn, as tall as its rows: the page scrolls, not a box inside it.
      <div className={`grid min-h-0 min-w-0 lg:grid-rows-[minmax(0,1fr)] ${active === side ? '' : 'max-lg:hidden'}`}>
        <Pane side={side} active={active === side} listing={side === 'left' ? shownLeft : shownRight} loading={p.loading} error={p.error}
              // STASH: files carry comments more often than not (ruling 9): its panes show the column.
              sort={sortOf(p.listing, p.path)} selection={p.selection} showComment={deviceOf(p.listing?.path ?? p.path) === 'stash'}
              onActivate={() => activate(side)} onNavigate={(path) => navigate(side, path)}
              onSort={(key) => changeSort(side, key)} onSetSort={(next) => applySort(side, next)}
              onRowClick={(i, mods) => rowClick(side, i, mods)}
              onRowOpen={(i) => openRow(side, i)}
              onDragStartRows={(ix, e) => dragStart(side, ix, e)} onDropRows={(e) => drop(side, e)}
              onAddToLibrary={(i) => addRowToLibrary(side, i)}
              strip={disk && strip ? (
                <DiskStrip key={`${disk.diskId}:${disk.volumeName}`} side={side} disk={disk} data={strip}
                           onChanged={() => stripChanged(disk.diskId)} />
              ) : undefined}
              errorAction={p.gone ? (
                <Button variant="outline" size="sm" onClick={() => navigate(side, deviceRoot(p.path))} data-testid={`pane-${side}-home`}>
                  Go to {deviceRoot(p.path)}
                </Button>
              ) : undefined} />
      </div>
    );
  }

  const sep = <div aria-hidden className="my-1 h-px max-lg:hidden" style={{ background: 'var(--line)' }} />;

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} data-testid="files-manager" aria-label="File manager"
         onFocusCapture={(e) => { if (rootRef.current?.contains(e.target)) lastFocus.current = e.target; }}
         // Files from the computer never open in the tab: a drop the panes did not take is answered here.
         onDragOver={(e) => { if (isFileDrag(e)) e.preventDefault(); }}
         onDrop={(e) => {
           if (!isFileDrag(e) || e.defaultPrevented) return;
           e.preventDefault();
           toast.error('Open a disk to drop files into it');
         }}
         className="rounded-[20px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
      {/* Below lg: which pane is on screen. The same choice as the active side, so Tab, a tap and the URL agree. */}
      <div data-testid="files-side-switch" role="group" aria-label="Pane shown" className="seg mb-3 lg:hidden">
        {(['left', 'right'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={active === s} data-testid={`files-side-${s}`} onClick={() => activate(s)}
                  className="seg-item min-h-11 flex-1 justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
            {s === 'left' ? 'Left' : 'Right'}
          </button>
        ))}
      </div>
      {/* Below lg nothing clips: a clip would cut off the strip's History over a short pane, and `hidden` would make
          this a scroll box the phone bar could not stick out of. The pane's top and the bar round their own corners. */}
      <div className="grid rounded-[20px] lg:overflow-hidden max-lg:grid-cols-[minmax(0,1fr)] lg:h-[clamp(480px,calc(100dvh-260px),900px)] lg:grid-cols-[minmax(0,1fr)_92px_minmax(0,1fr)]"
           style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
        {pane('left')}
        <div data-testid="files-actions" role="group" aria-label="File actions"
             className="files-bar flex flex-wrap gap-1.5 border-t p-2 max-lg:order-last max-lg:rounded-b-[20px] lg:flex-col lg:gap-[7px] lg:border-x lg:border-t-0 lg:px-2 lg:py-4"
             style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
          <ActionButton busy={busy !== null} id="copy" label={arrow ? 'Copy →' : '← Copy'} reason={reasons.copy} onClick={() => act('copy')}
                        primary={picked.length > 0} />
          <ActionButton busy={busy !== null} id="move" label={arrow ? 'Move →' : '← Move'} reason={reasons.move} onClick={() => act('move')} />
          {sep}
          <ActionButton busy={busy !== null} id="delete" label="Delete" reason={reasons.delete} onClick={() => act('delete')} />
          <ActionButton busy={busy !== null} id="rename" label="Rename" reason={reasons.rename} onClick={() => act('rename')} />
          <ActionButton busy={busy !== null} id="makedir" label="Makedir" reason={reasons.makedir} onClick={() => act('makedir')} />
          <ActionButton busy={busy !== null} id="protect" label="Protect" reason={reasons.protect} onClick={() => act('protect')} />
          <ActionButton busy={busy !== null} id="info" label="Info" reason={reasons.info} onClick={() => act('info')} />
          {inStash && (
            <ActionButton busy={busy !== null} id="addlib" label="Add to library" reason={reasons.addlib} onClick={() => act('addlib')} />
          )}
          {sep}
          <ActionButton busy={busy !== null} id="download" label="Download" reason={reasons.download} onClick={() => act('download')} />
          <ActionButton busy={busy !== null} id="swap" label="Swap ⇄" reason={null} onClick={swap} />
          {/* The phone bar: one row of four, the rest under More. */}
          <PhoneButton busy={busy !== null} id="copy" label="Copy to…" reason={reasons.copyTo} onClick={() => act('copyTo')}
                       primary={picked.length > 0} />
          <PhoneButton busy={busy !== null} id="move" label="Move to…" reason={reasons.moveTo} onClick={() => act('moveTo')} />
          <PhoneButton busy={busy !== null} id="delete" label="Delete" reason={reasons.delete} onClick={() => act('delete')} />
          <DropdownMenu>
            <DropdownMenuTrigger data-testid="files-more" aria-haspopup="menu"
                                 className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center rounded-[10px] border px-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-(--ring) lg:hidden"
                                 style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--ink)' }}>
              More ▾
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" data-testid="files-more-menu"
                                 className="w-[min(240px,calc(100vw-32px))] rounded-2xl"
                                 style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-card)' }}>
              {([['rename', 'Rename…'], ['makedir', 'Makedir…'], ['protect', 'Protect…'], ['info', 'Info'],
                ...(inStash ? [['addlib', 'Add to library']] as const : []), ['download', 'Download']] as const).map(([id, label]) => (
                // Not disabled: a tap on one that cannot act now says why.
                <DropdownMenuItem key={id} data-testid={`files-more-${id}`} aria-disabled={reasons[id] !== null || undefined}
                                  onClick={() => act(id)} className={cn(MENU_ITEM, 'h-11 sm:h-11 font-medium aria-disabled:opacity-50')}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <p role="status" data-testid="files-busy" className="text-center text-[12px] max-lg:basis-full max-lg:empty:hidden lg:mt-auto" style={{ color: 'var(--muted)' }}>
            {busy ?? ''}
          </p>
        </div>
        {pane('right')}
      </div>

      {dialog?.kind === 'clash' && (
        <ClashDialog key={dialog.at} clash={dialog.clashes[dialog.at]} remaining={dialog.clashes.length - dialog.at}
                     busy={dialogBusy} onChoose={chooseClash} onCancel={cancelClash} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDeleteDialog entries={dialog.entries} where={deleteWhere} busy={dialogBusy}
                             onCancel={() => setDialog(null)}
                             onConfirm={() => void runFromDialog({ op: 'delete', sources: dialog.entries.map((e) => e.path) },
                               `Deleting ${items(dialog.entries.length)}…`,
                               (n) => `Deleted ${items(n)} from ${deleteWhere === 'STASH:' ? deleteWhere : placeName(deleteWhere)}.`)} />
      )}
      {(dialog?.kind === 'makedir' || dialog?.kind === 'rename') && (
        <NameDialog mode={dialog.kind} initial={dialog.kind === 'rename' ? dialog.entry.name : ''}
                    taken={dialogListing?.entries.map((e) => e.name) ?? []} busy={dialogBusy}
                    onCancel={() => setDialog(null)}
                    onSave={(name) => void (dialog.kind === 'rename'
                      ? runFromDialog({ op: 'rename', source: dialog.entry.path, name }, 'Renaming…', () => `Renamed ${dialog.entry.name} to ${name}.`)
                      : runFromDialog({ op: 'makedir', dest: dialogListing!.path, name }, 'Making the folder…', () => `Made the folder ${name}.`))} />
      )}
      {dialog?.kind === 'protect' && (
        <ProtectDialog entries={dialog.entries} busy={dialogBusy} onCancel={() => setDialog(null)}
                       onSave={(protection) => void runFromDialog({ op: 'protect', sources: dialog.entries.map((e) => e.path), protection },
                         'Setting protection…', (n) => `Protection set on ${items(n)}.`)} />
      )}
      {dialog?.kind === 'info' && (
        <InfoDialog entry={dialog.entry} writable={!!dialogListing?.writable} busy={dialogBusy} onClose={() => setDialog(null)}
                    onSaveComment={(comment) => {
                      const entry = dialog.entry;
                      guarded([dialogListing?.disk], () => void runFromDialog({ op: 'comment', source: entry.path, comment },
                        'Saving the comment…', () => `Comment saved on ${entry.name}.`));
                    }} />
      )}
      {dialog?.kind === 'pick' && (
        <CopyToPicker op={dialog.op} count={dialog.sources.length} start={dialog.start} busy={dialogBusy} list={fetchListing}
                      onCancel={() => setDialog(null)} onPick={(l) => placePicked(dialog, l)} />
      )}
      {dialog?.kind === 'identity' && dialog.disk.tosecName && (
        <IdentityConfirmDialog tosecName={dialog.disk.tosecName} onCancel={() => setDialog(null)} onConfirm={confirmIdentity} />
      )}
      {dialog?.kind === 'drop' && (
        <DropReview disk={dialog.disk} folder={dialog.folder} items={dialog.items} onClose={() => setDialog(null)}
                    onWritten={(w) => dropWritten(dialog, w)} />
      )}
    </div>
  );
}
