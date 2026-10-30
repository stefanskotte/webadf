'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MENU_ITEM } from '@/components/ui/menu-item-look';
import { cn } from '@/lib/utils';
import type { DiskInfo, FsEntry, Listing, RefusalCode, StripData } from '@/lib/files/types';
import { nextSort, type FilesSort, type FilesSortKey } from '@/lib/files/sort';
import { EMPTY_SELECTION, moveCursor, selectAll, selectClick, togglePick, type Selection } from '@/lib/files/selection';
import type { BankCommand } from '@/lib/files/bank';
import { commandFor, type FilesCommand } from '@/lib/files/keys';
import { refusalWords } from '@/lib/files/words';
import { deleteAsks, paneDefaults, paneHelpTopic, paneRows, remapSelection, showsComment, type PaneView } from '@/lib/files/view';
import { formatPath, PANE_DEVICES, parsePath } from '@/lib/files/path';
import type { OpItem, OpRequest } from '@/lib/files/ops';
import type { Added } from '@/lib/files/driver';
import {
  acceptsCopies, addToLibraryReason, copyOutReason, deleteWhere as deleteWhereOf, failedReason, holdsFiles, netBoardOf, netReadOnly, netVolumeReason,
  offersUndo, placeOf,
} from '@/lib/files/pane-rules';
import { askUntilAnswered } from '@/lib/files/ask-listing';
import { boardNameFor, isNetVolume, netBoardRoot, netPollMs, NET_MOVE_IN, NET_OPEN_VOLUME, NET_PICK_BOARD, NET_READ_ONLY } from '@/lib/files/net-rules';
import { errorWords } from '@/lib/remote-browse';
import { COLLECTIONS_STAY, createAdfReason, filingNoun, filingReason, shelfOf, shelfOfRow, shelfReasons } from '@/lib/files/shelf-rules';
import { stashPollMs, trackArriving, withStalls, type ArrivingSeen } from '@/lib/files/arriving';
import { netDropRefusal, sendToBoard } from '@/lib/files/net-send';
import type { UserPrefs } from '@/lib/user-prefs-schema';
import { latestSaver } from '@/lib/user-prefs-client';
import { clashGroups, downloadHref, DOWNLOAD_URL_MAX, type TransferGroup } from '@/lib/files/transfer';
import { diskRelative, identityToConfirm, undoTarget, withAddedIn, type OpVersion } from '@/lib/files/edit-rules';
import { createClosesDialog, dropBlocked, fetchDownload, fetchStatus, navTargets, oneAtATime, opTitle, reloadsBoth, skippedItems, skippedWords, stashTitle, stripDiskOf, tallyItems } from '@/lib/files/manager-rules';
import { addedIn } from '@/lib/disk-history/added-in';
import { readDroppedItems, type DroppedItem } from '@/lib/drop-reader';
import { isFileDrag } from '@/components/disks/native-drop';
import { IdentityConfirmDialog, requestUndo } from '@/components/disks/file-actions';
import { Pane } from './pane';
import { ButtonBank } from './button-bank';
import { DiskStrip } from './disk-strip';
import { DropReview } from './drop-review';
import { CopyToPicker, type ListResult } from './copy-to-picker';
import { StashDropZone } from './stash-drop-zone';
import { SendDropZone } from './send-drop-zone';
import type { SendTarget } from '@/lib/send-ui';
import { useStashUpload, type StashUploadResult } from './use-stash-upload';
import { sameStashName } from '@/lib/files/stash-paths';
import { isSignedOutAnswer, SIGNED_OUT_TEXT } from '@/lib/signed-out';
import { QUEUE_FOLDER } from '@/lib/remote-limits';
import {
  ClashDialog, ConfirmDeleteDialog, InfoDialog, NameDialog, ProtectDialog, placeName, type Clash, type ClashChoice,
} from './dialogs';
import { CreateAdfDialog } from './create-adf-dialog';

/**
 * The Files manager (spec 2026-10-29 §5; Files 2 §2): two panes side by side and, from lg, the button bank under both
 * (button-bank.tsx: the device column and the six-by-three grid). The active pane is the SOURCE (its title bar is
 * dark), the other the destination: every bank command acts on the source, Copy and Move go source → destination. It
 * owns everything the panes only draw -- each side's listing, sort and selection -- and the URL (`?left&right&active`).
 *
 * Navigation fetches /api/files/list and records the new place with the NATIVE history API, which Next.js keeps in
 * step with its router: `pushState` when a pane moves (so Back walks back through folders), `replaceState` when only
 * the active side changes. Back and Forward come in as `popstate` and load whatever the URL now says; a reload lands
 * on the page, which lists both paths on the server. (A router.push would re-render the server page on every folder
 * opened, showing loading.tsx's skeleton in place of both panes each time.)
 *
 * Selections are indexes into the rows a pane DRAWS -- sorted, then filtered by the pane's filter and Show .info
 * (paneRows, as pane.tsx draws them) -- so every index here goes through `rowsOf`, and a row the view hides is never
 * picked: a change of view remaps the picks (remapSelection), letting go of the ones it hides.
 *
 * Each pane shows STASH:, NET: or LIBRARY: (increment 2, R1; increment 3). STASH: keeps no versions, so nothing that
 * changes it offers Undo, and its delete says it cannot be undone (ruling 8). NET: lists the boards and, in each, its
 * queue (increment 3): Copy into a board queues files for its Amiga (no Undo; Move is refused, C16), files from the
 * computer dropped on it are sent the same way (C2), nothing comes out of it (R5), Delete cancels or clears (R4), and
 * a pane showing a queue re-reads it every few seconds while the tab is visible.
 *
 * Below lg (the C7 phone convention) only the ACTIVE pane is drawn, under a Left | Right switch; the button column is
 * a bar at the bottom with Copy to… · Move to… · Delete · More, and Copy to… / Move to… pick the place in a dialog
 * (copy-to-picker.tsx) since the other pane is out of sight. A tap on a folder row opens it and a tap on a file row
 * picks it (an archive too: its Open opens it). Which layout applies is read from the width at the moment of the tap, never at render, so the server's
 * HTML and the first client render are the same at every width.
 */

type Side = 'left' | 'right';
type DeviceKey = keyof UserPrefs['files']['sort'];
/** `filter`: the pane's name filter (R6). It belongs to the place: kept on a fresh listing of the same place and on
 *  Swap (it travels with its pane), cleared when the pane lists another place. */
/** `errorDisk`: the disk a failed listing's refusal named (blob_unavailable), whose strip still shows (stripDiskOf). */
/** `pending`: the label of a NET: listing the Amiga has not answered yet (NET: volumes, spec 2026-10-30 §4.4), else null. */
type PaneState = {
  path: string; listing: Listing | null; loading: boolean; error: string | null; gone: boolean; errorDisk: string | null;
  pending: string | null; selection: Selection; filter: string;
};

export type FilesManagerProps = {
  initial: {
    left: Listing | null; right: Listing | null; leftPath: string; rightPath: string; active: Side;
    /** Words for a pane whose first listing failed for a reason other than "gone" (an unreadable image). */
    leftError?: string; rightError?: string;
    /** The disk an unreadable image's refusal named, for its strip (Files 2 R2: never read from the path). */
    leftErrorDisk?: string; rightErrorDisk?: string;
    /** A pane whose first listing is a NET: listing the Amiga has not answered yet: its label ("Reading … from A500…"). */
    leftPending?: string; rightPending?: string;
    /** The disk strip of each pane that starts inside a disk (disk-strip-data.ts). */
    strips?: StripData[];
  };
  /** The Files settings (sort, panes on opening, comments, delete confirm, clash answer) and Show .info (browse.hideInfo, R1). */
  prefs: { files: UserPrefs['files']; hideInfo: boolean };
  /** The Send files to the Amiga zone: the boards that can receive, the one a link named, and the server's clock. */
  send: { targets: SendTarget[]; initialBoard: string | null; serverNow: number };
};

type Dialog =
  | {
    kind: 'clash'; op: 'copy' | 'move'; sources: string[]; dest: string; where: string; undo: boolean; target: string | null;
    count?: (n: number) => string;
    clashes: Clash[]; at: number;
    choices: Record<string, ClashChoice>;
    /** Requests still to send once these clashes are answered, and the outcomes (and versions) of those already sent. */
    rest: TransferGroup[]; done: OpItem[]; versions: OpVersion[];
  }
  | { kind: 'delete'; side: Side; entries: FsEntry[] }
  /** `refused`: a collection name the server found taken (R3), said under the field while it holds that name. */
  | { kind: 'makedir'; side: Side; refused?: { name: string; words: string } }
  | { kind: 'rename'; side: Side; entry: FsEntry; refused?: { name: string; words: string } }
  | { kind: 'protect'; side: Side; entries: FsEntry[] }
  | { kind: 'info'; side: Side; entry: FsEntry }
  /** Create ADF… (Files 2 §4): a blank disk in the `side` pane's place. */
  | { kind: 'create'; side: Side }
  /** Copy to… / Move to… on a phone: `sources` from the active pane, the picker starting at the other pane's place. */
  | { kind: 'pick'; op: 'copy' | 'move'; sources: string[]; start: string }
  /** The TOSEC-identity confirm before the first write to `disk` this visit; `next` goes on once it is confirmed. */
  | { kind: 'identity'; disk: DiskInfo; next(): void }
  /** Files from the computer, being read, under review for `folder` (from the disk's root) of `disk`. */
  | { kind: 'drop'; disk: DiskInfo; folder: string; where: string; items: Promise<DroppedItem[]> }
  /**
   * Files from the computer for the STASH: folder `dir` whose top names clash with what is there: one answer each (or
   * for all), then they go up in groups by answer; `later` waits behind them, `done` is what already landed.
   */
  | { kind: 'stash-clash'; dir: string; items: DroppedItem[]; clashes: Clash[]; at: number; choices: Record<string, ClashChoice>;
      later: StashGroup[]; done: StashUploadResult; skipped: Set<string> };

/** Dropped items going to STASH: with one clash answer. */
type StashGroup = { onClash: 'ask' | ClashChoice; items: DroppedItem[] };

const GONE = 'This place no longer exists.';
const NO_MARKS: ReadonlyMap<string, number> = new Map();
const DRAG_TYPE = 'application/x-webfloppy-files';
const KNOWN_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  'not_found', 'read_only', 'mounted', 'disk_full', 'name_exists', 'bad_name', 'comment_too_long', 'cycle',
  'no_filesystem', 'hfe_read_only', 'conflict', 'unsupported', 'blob_unavailable', 'failed',
  'stash_full', 'too_large', 'archive_unreadable', 'not_a_disk_image', 'queue_full',
]);
/** What Rename, Makedir and Protect say in NET:, where the rows are queue rows. */
const NOT_IN_NET = 'Not in NET:';
/** Enter and Space belong to a focused control; the manager must not open or pick a row as well. */
const CONTROL = 'button, a, [role="button"], [role="checkbox"]';

const otherSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');
/** Below lg: the one-pane phone layout (Tailwind's lg is 64rem). */
const isPhone = () => window.matchMedia('(max-width: 63.98rem)').matches;
const deviceOf = (path: string): DeviceKey => (path.startsWith('STASH:') ? 'stash' : path.startsWith('NET:') ? 'net' : 'library');
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const topOf = (path: string) => path.split('/').filter(Boolean)[0] ?? path;
const noneDone = (): StashUploadResult => ({ items: [], renamed: [], refused: [], stopped: null });
const items = (n: number) => (n === 1 ? '1 item' : `${n} items`);
const disks = (n: number) => (n === 1 ? '1 disk' : `${n} disks`);
const files = (n: number) => (n === 1 ? '1 file' : `${n} files`);
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

/** When each listing was read in this tab: an arriving STASH: row's stall clock runs on it. The server's first has none. */
const readAt = new WeakMap<Listing, number>();

type Fetched = { listing: Listing } | { gone: true } | { pending: string } | { error: string; code?: unknown; detail?: unknown };

/**
 * `code`: the refusal's own code, for a caller that answers one differently (an archive that does not open); `detail`:
 * its detail (blob_unavailable names the disk). `pending`: the Amiga has been asked for this NET: listing and has not
 * answered yet (202, NET: volumes spec 2026-10-30 §4.4) -- the label to show while asking again; never a listing.
 * `fresh`: Refresh, which asks the Amiga again rather than take the 2-minute memory.
 */
async function fetchListing(path: string, fresh = false): Promise<Fetched> {
  try {
    const res = await fetch(`/api/files/list?path=${encodeURIComponent(path)}${fresh ? '&fresh=1' : ''}`, { cache: 'no-store' });
    if (res.status === 202) {
      const body = (await res.json().catch(() => null)) as { label?: unknown } | null;
      return { pending: typeof body?.label === 'string' ? body.label : 'Reading from the Amiga…' };
    }
    if (res.ok) {
      const listing = (await res.json()) as Listing;
      readAt.set(listing, Date.now());
      return { listing };
    }
    if (res.status === 404 || res.status === 400) return { gone: true };
    const body = (await res.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null;
    // A NET: refusal's detail is the pane's whole sentence ("Object not found", "Switch on browsing in Transfer on
    // A500"), as the page's first listing says it (first-listing.ts): never read through a disk's words.
    const netWords = parsePath(path)?.device === 'NET' && typeof body?.detail === 'string' ? body.detail : null;
    return { error: netWords ?? wordsFor(body?.error, body?.detail), code: body?.error, detail: body?.detail };
  } catch {
    return { error: refusalWords('failed') };
  }
}

/** "A500 didn't answer — Refresh to try again": a pending listing asked for PANE_GIVE_UP_MS without an answer. */
const noAnswer = (path: string, l: Listing | null) => errorWords('timeout', '', boardNameFor(path, l));

/** A listing for the Copy to… picker, which walks places rather than show a wait. Module-level: its identity never changes. */
async function settledListing(path: string): Promise<ListResult> {
  return (await askUntilAnswered<ListResult>(path, { ask: fetchListing, wanted: () => true, onPending: () => {}, giveUp: () => ({ error: noAnswer(path, null) }) }))!;
}

function firstState(path: string, listing: Listing | null, error: string | undefined, errorDisk?: string, pending?: string): PaneState {
  // A pending place is neither gone nor failed: the pane says the label until it is answered (Task 7 asks again).
  const waits = !listing && !error && pending !== undefined;
  return {
    path, listing, loading: false, error: listing || waits ? null : error ?? GONE, gone: !listing && !error && !waits,
    errorDisk: listing ? null : errorDisk ?? null, pending: waits ? pending : null, selection: EMPTY_SELECTION, filter: '',
  };
}

/** The disk a failed listing names: an unreadable image's refusal carries its disk id (Files 2 R2). */
const errorDiskOf = (r: { code?: unknown; detail?: unknown }) =>
  (r.code === 'blob_unavailable' && typeof r.detail === 'string' ? r.detail : null);

/** The picked entries, in the order the rows are drawn. */
function pickedOf(rows: FsEntry[], sel: Selection): FsEntry[] {
  return [...sel.picked].filter((i) => i < rows.length).sort((a, b) => a - b).map((i) => rows[i]);
}

/** The "new in vN" marks of the disk a listing is inside, from its strip's History; none above the disks. */
function useMarks(l: Listing | null, strips: Record<string, StripData>): ReadonlyMap<string, number> {
  const history = l?.disk ? strips[l.disk.diskId]?.history : undefined;
  return useMemo(() => (history ? addedIn(history) : NO_MARKS), [history]);
}

/**
 * The arriving STASH: rows a pane's listings have shown, and when the newest was read (trackArriving): taken afresh
 * each time the pane's listing changes. A listing this tab did not read (the server's first) starts no clock.
 */
function useArriving(l: Listing | null): { seen: ArrivingSeen; at: number } {
  const [t, setT] = useState<{ l: Listing | null; seen: ArrivingSeen; at: number }>({ l, seen: {}, at: 0 });
  if (t.l !== l) {
    const at = l ? readAt.get(l) : undefined;
    setT(l && at !== undefined ? { l, seen: trackArriving(t.seen, l.entries, at), at } : { l, seen: t.seen, at: t.at });
  }
  return t;
}

/** What a pane draws: the "new in vN" marks, and a stopped arriving row's words in place of its percentage. */
function shown(l: Listing | null, marks: ReadonlyMap<string, number>, arr: { seen: ArrivingSeen; at: number }): Listing | null {
  if (!l) return l;
  const entries = withStalls(marks.size ? withAddedIn(l.entries, marks, l.diskBase) : l.entries, arr.seen, arr.at);
  return entries === l.entries ? l : { ...l, entries };
}

/**
 * One button of the phone bar. A finger gets no tooltip, so a button that cannot act now is not `disabled`: it looks
 * dimmed (aria-disabled) and a tap says why (act() toasts the reason). While an operation runs it is described by the
 * status row, and a tap toasts what runs.
 */
function PhoneButton({ id, label, reason, busy, onClick, primary = false }: {
  id: string; label: string; reason: string | null; busy: boolean; onClick(): void; primary?: boolean;
}) {
  return (
    <Button variant={primary ? 'default' : 'outline'} onClick={onClick} data-testid={`files-phone-${id}`}
            aria-disabled={reason !== null || busy || undefined} aria-describedby={busy ? 'files-busy' : undefined}
            className="min-h-11 min-w-0 flex-1 px-1.5 aria-disabled:opacity-50 lg:hidden">
      {label}
    </Button>
  );
}

export function FilesManager({ initial, prefs, send }: FilesManagerProps) {
  const router = useRouter();
  const [panes, setPanes] = useState<Record<Side, PaneState>>(() => ({
    left: firstState(initial.leftPath, initial.left, initial.leftError, initial.leftErrorDisk, initial.leftPending),
    right: firstState(initial.rightPath, initial.right, initial.rightError, initial.rightErrorDisk, initial.rightPending),
  }));
  const [active, setActive] = useState<Side>(initial.active);
  const [sorts, setSorts] = useState(prefs.files.sort);
  // Show .info (R7): one setting for both panes, saved by its own saver -- a sort save must not replace a pending one.
  const [hideInfo, setHideInfo] = useState(prefs.hideInfo);
  const [infoSaver] = useState(latestSaver);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [opBusy, setBusy] = useState<string | null>(null);
  // Copies out of NET: volumes, as the board fetches them (spec 2026-10-30 §4.5): one status line each, after the busy
  // line. Several may run at once (they queue on the board); a finished one's summary stays until the next one starts.
  const [fetchLines, setFetchLines] = useState<{ id: string; line: string; finished: boolean }[]>([]);
  // Files from the computer into STASH: (the top drop zone, or a pane in STASH:) keep the manager busy as an op does.
  const stash = useStashUpload();
  const busy = opBusy ?? stash.busy;
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
  /** Create ADF…'s submit, one at a time: Enter and a click in the same moment make one disk (Task 7 review). */
  const createOnce = useRef(oneAtATime());
  const filterRefs = { left: useRef<HTMLInputElement>(null), right: useRef<HTMLInputElement>(null) };
  // A pane's newest request wins: a slow listing that lands after a newer one is dropped.
  const seq = useRef<Record<Side, number>>({ left: 0, right: 0 });
  // False once the manager unmounts: a NET: listing still being asked for stops re-asking (askUntilAnswered's `wanted`).
  const alive = useRef(true);
  // The progress polls' timers (watchFetch), cleared on unmount.
  const fetchTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // For the popstate listener and the NET: poll, which outlive a render.
  // R5: where a pane the address does not name opens (Back to a bare /files too).
  const defaults = paneDefaults(prefs.files.panes);
  const latest = useRef({ panes, active, sorts, hideInfo, defaults });
  useEffect(() => { latest.current = { panes, active, sorts, hideInfo, defaults }; });

  const viewOf = (p: PaneState, hide = hideInfo): PaneView => ({ filter: p.filter, hideInfo: hide });
  const sortOf = (l: Listing | null, path: string) => sorts[deviceOf(l?.path ?? path)];
  // What each pane draws: its listing with the "new in vN" marks from its disk's History (the strip carries it).
  const marksLeft = useMarks(panes.left.listing, strips);
  const marksRight = useMarks(panes.right.listing, strips);
  const arrLeft = useArriving(panes.left.listing);
  const arrRight = useArriving(panes.right.listing);
  const shownLeft = useMemo(() => shown(panes.left.listing, marksLeft, arrLeft), [panes.left.listing, marksLeft, arrLeft]);
  const shownRight = useMemo(() => shown(panes.right.listing, marksRight, arrRight), [panes.right.listing, marksRight, arrRight]);
  // The rows each pane draws, in its order (paneRows: sorted, then the filter and Show .info): the only row order here.
  const filterLeft = panes.left.filter;
  const filterRight = panes.right.filter;
  const rowsLeft = useMemo(() => (shownLeft ? paneRows(shownLeft.entries, sorts[deviceOf(shownLeft.path)], { filter: filterLeft, hideInfo }) : []),
    [shownLeft, sorts, filterLeft, hideInfo]);
  const rowsRight = useMemo(() => (shownRight ? paneRows(shownRight.entries, sorts[deviceOf(shownRight.path)], { filter: filterRight, hideInfo }) : []),
    [shownRight, sorts, filterRight, hideInfo]);
  const rowsOf = (s: Side) => (s === 'left' ? rowsLeft : rowsRight);

  // ---- loading and the URL ------------------------------------------------------------------------------------

  /**
   * List `path` into a side. A new place keeps the old rows on screen (busy) until it lands; then nothing is picked.
   * The filter stays when the listing that lands is of the place the pane showed (a reload after an operation), else it
   * clears (R6) -- only once it lands, so the old rows keep the view their picks were made in while they wait.
   * A refusal with the code `stayOn` leaves the pane where it was and says so in a toast (an archive that does not
   * open: the person is still in its folder, and can download it). `select`: the path of a row to pick once the
   * listing lands (a disk just made, §4); the filter then clears so the row is drawn. Resolves true when the place was listed.
   *
   * A NET: listing the Amiga has not answered yet (NET: volumes, spec 2026-10-30 §4.4, §5) keeps the old rows (dimmed)
   * under its label and is asked again every PANE_ASK_MS (without `fresh`: the request is already on its way) until it
   * lands, is refused, or PANE_GIVE_UP_MS pass ("A500 didn't answer — Refresh to try again"). A newer load of the side
   * (a navigation, a Swap) bumps `seq`, and this loop then stops without a word. `fresh`: Refresh.
   */
  async function load(side: Side, path: string, opts: { stayOn?: RefusalCode; select?: string; fresh?: boolean } = {}): Promise<boolean> {
    const { stayOn } = opts;
    const n = ++seq.current[side];
    // Asking the same place again (Refresh, the page's pending first state) keeps its label up rather than flash "Loading…".
    setPanes((ps) => ({ ...ps, [side]: { ...ps[side], path: stayOn ? ps[side].path : path, loading: true,
      pending: ps[side].path === path ? ps[side].pending : null } }));
    const r = await askUntilAnswered<Exclude<Fetched, { pending: string }>>(path, {
      ask: fetchListing, fresh: opts.fresh, wanted: () => alive.current && n === seq.current[side],
      giveUp: () => ({ error: noAnswer(path, latest.current.panes[side].listing) }),
      onPending: (label) => setPanes((ps) => ({ ...ps, [side]: { ...ps[side], pending: label } })),
    });
    if (r === null || n !== seq.current[side]) return false;
    if (stayOn && 'code' in r && r.code === stayOn) {
      toast.error(r.error);
      setPanes((ps) => ({ ...ps, [side]: { ...ps[side], loading: false, pending: null } }));
      return false;
    }
    let selection: Selection = EMPTY_SELECTION;
    if ('listing' in r && opts.select) {
      const drawn = paneRows(r.listing.entries, latest.current.sorts[deviceOf(r.listing.path)], { filter: '', hideInfo: latest.current.hideInfo });
      const i = drawn.findIndex((x) => x.path === opts.select);
      if (i >= 0) selection = { anchor: i, cursor: i, picked: new Set([i]) };
    }
    setPanes((ps) => ({
      ...ps,
      [side]: 'listing' in r
        ? { path, listing: r.listing, loading: false, error: null, gone: false, errorDisk: null, pending: null, selection,
            filter: !opts.select && ps[side].listing?.path === r.listing.path ? ps[side].filter : '' }
        : { path, listing: null, loading: false, error: 'gone' in r ? GONE : r.error, gone: 'gone' in r,
            errorDisk: 'gone' in r ? null : errorDiskOf(r), pending: null, selection: EMPTY_SELECTION, filter: '' },
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

  /** Files were queued for a board from the Send zone: a pane showing its queue reads it again. */
  function sentTo(deviceId: string) {
    const { panes: cur } = latest.current;
    for (const side of ['left', 'right'] as const) if (cur[side].path === `NET:/${deviceId}/${QUEUE_FOLDER}`) void load(side, cur[side].path);
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
    void load(side, path, { stayOn: 'archive_unreadable' }).then((ok) => {
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
      const { panes: cur, defaults: d } = latest.current;
      const want = { left: pathParam(q.get('left'), d.left), right: pathParam(q.get('right'), d.right) };
      for (const s of ['left', 'right'] as const) if (cur[s].path !== want[s]) void load(s, want[s]);
      setActive(q.get('active') === 'right' ? 'right' : 'left');
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // `load` only touches refs and state setters, so the listener never goes stale.
  }, []);

  // A pane the page opened pending (a NET: listing the Amiga had not answered, first-listing.ts) asks again from here,
  // as a navigation does. On unmount every listing still asked for is let go: a pending one stops re-asking.
  useEffect(() => {
    alive.current = true;
    for (const s of ['left', 'right'] as const) {
      const p = latest.current.panes[s];
      if (p.pending !== null && !p.listing) void load(s, p.path);
    }
    const timers = fetchTimers.current;
    return () => { alive.current = false; timers.forEach(clearTimeout); timers.clear(); };
    // Once, on mount: `load` reads refs and state setters only.
  }, []);

  /**
   * The NET: and arriving-STASH: poll (increment 3): a fresh listing of the place a pane already shows, in place --
   * no busy line, and the picked rows follow their entries. An answer is dropped when a navigation (or a reload) began since it was asked
   * (the `seq` guard) or the pane is loading; a failed read changes nothing, and the next one tries again.
   */
  async function refresh(side: Side) {
    const at = latest.current.panes[side];
    if (at.loading || !at.listing) return;
    const n = seq.current[side];
    const r = await fetchListing(at.path);
    if (n !== seq.current[side] || !('listing' in r)) return;
    const fresh = r.listing;
    setPanes((ps) => {
      const p = ps[side];
      if (p.path !== at.path || p.loading || !p.listing) return ps;
      const sort = latest.current.sorts[deviceOf(fresh.path)];
      const view: PaneView = { filter: p.filter, hideInfo: latest.current.hideInfo };
      return { ...ps, [side]: { ...p, listing: fresh, selection: remapSelection(paneRows(p.listing.entries, sort, view), paneRows(fresh.entries, sort, view), p.selection) } };
    });
  }

  // A pane showing a board's queue re-reads it: every 3 s while anything waits or sends, else every 10 s (netPollMs);
  // a STASH: pane showing a file arriving from the Amiga, every 3 s while it moves, every 10 s once it has stopped,
  // not at all once none is arriving (stashPollMs). Only while the tab is visible.
  const pollLeft = netPollMs(panes.left.listing) ?? stashPollMs(panes.left.listing, arrLeft.seen, arrLeft.at);
  const pollRight = netPollMs(panes.right.listing) ?? stashPollMs(panes.right.listing, arrRight.seen, arrRight.at);
  useEffect(() => {
    const timers = (['left', 'right'] as const).flatMap((s) => {
      const ms = s === 'left' ? pollLeft : pollRight;
      return ms ? [setInterval(() => { if (document.visibilityState === 'visible') void refresh(s); }, ms)] : [];
    });
    return () => timers.forEach(clearInterval);
    // `refresh` reads refs and state setters only.
  }, [pollLeft, pollRight]);

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
        const view = viewOf(ps[s]);
        out[s] = { ...ps[s], selection: remapSelection(paneRows(l.entries, sorts[dev], view), paneRows(l.entries, next, view), ps[s].selection) };
      }
      return out;
    });
    setSorts((cur) => ({ ...cur, [dev]: next }));
    const sort: { library?: FilesSort; stash?: FilesSort; net?: FilesSort } = {};
    sort[dev] = next;
    saver.save({ files: { sort } }).catch(() => toast.error("Couldn't remember this sort order for next time."));
  }

  /** The pane's filter (R6): its picks follow their entries, and a row the filter hides is let go. */
  function setFilter(side: Side, text: string) {
    setPanes((ps) => {
      const p = ps[side];
      const l = p.listing;
      if (!l) return { ...ps, [side]: { ...p, filter: text } };
      const sort = sorts[deviceOf(l.path)];
      const selection = remapSelection(paneRows(l.entries, sort, viewOf(p)), paneRows(l.entries, sort, { filter: text, hideInfo }), p.selection);
      return { ...ps, [side]: { ...p, filter: text, selection } };
    });
  }

  /** Show .info (R7), from either pane's switch: both panes follow, hidden picks are let go, and it is remembered. */
  function showInfo(show: boolean) {
    const hide = !show;
    if (hide === hideInfo) return;
    setPanes((ps) => {
      const out = { ...ps };
      for (const s of ['left', 'right'] as const) {
        const l = ps[s].listing;
        if (!l) continue;
        const sort = sorts[deviceOf(l.path)];
        out[s] = { ...ps[s], selection: remapSelection(paneRows(l.entries, sort, viewOf(ps[s])), paneRows(l.entries, sort, viewOf(ps[s], hide)), ps[s].selection) };
      }
      return out;
    });
    setHideInfo(hide);
    infoSaver.save({ browse: { hideInfo: hide } }).catch(() => toast.error("Couldn't remember Show .info for next time."));
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

  /** Enter, a desktop double-click, a row's Open. A phone double tap on a file only picks it (Info is under More). */
  function openRow(side: Side, index: number, how: 'dblclick' | 'key' = 'key') {
    const e = rowsOf(side)[index];
    if (!e) return;
    if (how === 'dblclick' && isPhone() && e.kind === 'file') return;
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

  // Only a place that holds files (inside a disk, or STASH:) has rows to act on and room to take them (ruling 8). A
  // board's queue under NET: has rows too: Delete cancels or clears them and Info shows them; nothing else acts there.
  const inNet = netReadOnly(src);
  const board = netBoardOf(src);
  // A volume of a board's Amiga (NET: volumes, spec 2026-10-30 §5) is read, never written, in phase 1: every command
  // that writes says "Read-only for now", whatever is picked; Copy, Download and Info act on its rows.
  const volumeRO = netVolumeReason(src);
  const volume = isNetVolume(src);
  // NET:/<board> lists its volumes and Queue: places to open, as LIBRARY: lists titles.
  const boardRoot = !!src && netBoardRoot(src.path) !== null;
  function sourceReason(writable: boolean): string | null {
    if (writable && volumeRO) return volumeRO;
    if (picked.length === 0) return 'Select something first';
    if (volume) return null;
    if (inNet) return board ? null : boardRoot ? NET_OPEN_VOLUME : 'Open a board to see what waits for it';
    if (!holdsFiles(src)) return 'Only files and folders on a disk or in STASH: can be changed here — open one first';
    if (writable && !src!.writable) return readOnly(src!);
    return null;
  }
  // R5: nothing leaves NET:, said before anything else.
  const outOfNet = copyOutReason(src);
  function transferReason(op: 'copy' | 'move'): string | null {
    if (outOfNet) return outOfNet;
    // Titles, or disk images from STASH:, onto LIBRARY: or a collection (Files 2 §3.2): the filing rules decide.
    const filing = filingReason(op, src, picked, shelfOf(dst));
    if (filing !== undefined) return filing;
    // A STASH: file that failed to arrive holds no bytes: a copy would skip it and still say done.
    const r = sourceReason(op === 'move') ?? failedReason(picked);
    if (r) return r;
    if (!acceptsCopies(dst)) return isNetVolume(dst) ? NET_READ_ONLY : dst && netReadOnly(dst) ? readOnly(dst) : 'Open a disk or STASH: on the other side';
    if (!dst!.writable) return readOnly(dst!);
    if (op === 'move' && netBoardOf(dst)) return NET_MOVE_IN;   // C16: a send never takes the original away
    return null;
  }
  const one = (r: string | null, what: string) => r ?? (picked.length !== 1 ? `Select one item to ${what}` : null);
  // Above the disks (Files 2 §3.2): Makedir makes a collection on LIBRARY:, Rename and Delete act on collections only.
  const shelf = shelfReasons(src, picked);
  // Titles picked on LIBRARY: or in a collection: the phone's Copy to… / Move to… file them (the picker checks where).
  const filingFrom = shelfOf(src) !== null && picked.length > 0 && picked.every((e) => e.kind === 'title');
  // A collection never leaves LIBRARY: (fix round 1): said before the picker opens.
  const collectionPicked = shelfOf(src) !== null && picked.some((e) => e.kind === 'collection');
  const reasons = {
    copy: transferReason('copy'),
    move: transferReason('move'),
    delete: shelf ? shelf.delete : sourceReason(true),
    rename: shelf ? shelf.rename : volumeRO ?? (inNet ? NOT_IN_NET : one(sourceReason(true), 'rename it')),
    makedir: shelf ? shelf.makedir : volumeRO ?? (inNet ? NOT_IN_NET : !holdsFiles(src) ? 'Open a disk or STASH: to make a folder in it' : !src!.writable ? readOnly(src!) : null),
    protect: volumeRO ?? (inNet ? NOT_IN_NET : sourceReason(true)),
    info: inNet && !board && !volume ? NOT_IN_NET : one(sourceReason(false), 'see its details'),
    // One file by path; several, or a folder, as a .zip (spec §3.3).
    // Out of a volume, one file at a time: it is copied into the STASH: root first (plan P8).
    download: outOfNet ?? sourceReason(false) ?? failedReason(picked)
      ?? (volume && (picked.length !== 1 || picked[0].kind !== 'file') ? 'Select one file to download' : null)
      ?? (downloadHref(picked, folderName).length > DOWNLOAD_URL_MAX ? 'Too many items to download at once — download their folder instead' : null),
    // The phone's Copy to… / Move to…: the place is picked afterwards, so only the source is checked here.
    copyTo: collectionPicked ? COLLECTIONS_STAY : filingFrom ? null : outOfNet ?? sourceReason(false) ?? failedReason(picked),
    moveTo: collectionPicked ? COLLECTIONS_STAY : filingFrom ? null : outOfNet ?? sourceReason(true) ?? failedReason(picked),
    // Disk images in STASH: into the library (R8).
    addlib: volumeRO ?? addToLibraryReason(src, picked),
    // A blank disk in STASH:, or a new title on LIBRARY: or in a collection (§4).
    createadf: createAdfReason(src),
  };
  /** Add to library is offered only while the active pane is in STASH: (R8). */
  const inStash = !!src && deviceOf(src.path) === 'stash';

  // The bank's grid (Files 2 §2.3): the commands above, plus the ones that pick, move about and show.
  // A pane showing an error has no listing: Parent and Root then go up from its path (Task 8 review).
  const nav = navTargets(src, panes[active].path);
  const bankReasons: Record<BankCommand, string | null> = {
    copy: reasons.copy, move: reasons.move, delete: reasons.delete, rename: reasons.rename, makedir: reasons.makedir,
    protect: reasons.protect, info: reasons.info, download: reasons.download, addlib: reasons.addlib, createadf: reasons.createadf,
    all: rowsOf(active).length === 0 ? 'Nothing here to select' : null,
    none: picked.length === 0 ? 'Nothing is selected' : null,
    parent: nav.parent ? null : 'Already at the top',
    root: nav.root ? null : 'Already at the top',
    swap: null,
    filter: src ? null : 'Nothing is listed here',
    showinfo: holdsFiles(src) || volume ? null : 'Open a disk or STASH: to show or hide .info files',
    // Reads the source pane again; in NET: it asks the Amiga afresh (spec 2026-10-30 §5). Every pane has a place.
    refresh: null,
  };

  // ---- running an operation -----------------------------------------------------------------------------------

  /**
   * `queued`: how many files a copy into a board's queue queued (C3), a folder being several. `fetching`: a copy out of
   * a NET: volume, whose files the board fetches from now on (spec 2026-10-30 §4.5): GET /api/files/net/fetch/<id>.
   */
  type Fetching = { id: string; files: number };
  type Outcome = { kind: 'done'; items: OpItem[]; versions: OpVersion[]; added: Added[]; queued?: number; fetching?: Fetching } | { kind: 'clashes'; clashes: Clash[] }
    | { kind: 'refused'; words?: string };

  /** `inline`: a refusal code the caller says itself (a collection name clash, under the field): no toast for it. */
  async function post(req: OpRequest, label: string, inline?: RefusalCode): Promise<Outcome> {
    setBusy(label);
    try {
      const res = await fetch('/api/files/ops', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
      });
      // Signed out, the fetch lands on the sign-in page (a 200 that is not JSON): said so, and nothing changes.
      if (isSignedOutAnswer(res)) { toast.error(SIGNED_OUT_TEXT); return { kind: 'refused' }; }
      const body = (await res.json().catch(() => null)) as {
        items?: OpItem[]; versions?: OpVersion[]; added?: Added[]; queued?: number; fetching?: Fetching; error?: unknown; detail?: unknown; clashes?: Clash[];
      } | null;
      if (res.status === 409 && body?.error === 'clashes' && body.clashes) return { kind: 'clashes', clashes: body.clashes };
      if (!res.ok || !body?.items) {
        if (inline && body?.error === inline) return { kind: 'refused', words: wordsFor(body.error, body.detail) };
        toast.error(wordsFor(body?.error, body?.detail));
        if (reloadsBoth(body?.error)) reloadBoth();
        return { kind: 'refused' };
      }
      return { kind: 'done', items: body.items, versions: body.versions ?? [], added: body.added ?? [], ...(body.queued !== undefined ? { queued: body.queued } : {}),
        ...(body.fetching ? { fetching: body.fetching } : {}) };
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
    opts: { undo?: boolean; action?: ToastAction; count?: (n: number) => string } = {}) {
    const count = opts.count ?? items;
    const offer = (): { action?: ToastAction } => (opts.action ? { action: opts.action } : opts.undo === false ? {} : undoAction(versions));
    const failed = done.filter((i): i is Extract<OpItem, { ok: false }> => !i.ok);
    // A clash answered Skip is neither done nor failed: said apart, never counted as moved or copied.
    const tally = tallyItems(done);
    const ok = tally.done;
    reloadBoth();
    // Every disk on screen may have a new version (a move changes its source too); the target's is the one named.
    const { panes: cur } = latest.current;
    const others = [cur.left.listing?.disk?.diskId, cur.right.listing?.disk?.diskId].filter((x): x is string => !!x && x !== target);
    for (const id of new Set(others)) void refreshStrip(id);
    const head = target && ok > 0 ? await refreshStrip(target) : null;
    const seq = versions.filter((v) => v.diskId === target).at(-1)?.seq ?? head;
    const said = (n: number) => (seq === null ? success(n) : `${success(n).replace(/\.$/, '')} — saved as version ${seq}.`);
    if (failed.length === 0) toast.success(opTitle(tally, said, count), ok > 0 ? offer() : {});
    else {
      toast.error(opTitle(tally, said, count), {
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
  /**
   * `undo`: whether the run may offer Undo (offersUndo: not when it changes STASH: or sends). `queued`: the files a
   * copy into a board's queue has queued so far (NET: never clashes, so a send is one request). `target`: the disk
   * whose version the toast names (the destination pane's disk; Files 2 R2: from the listing, not the path).
   */
  type Run = { op: 'copy' | 'move'; dest: string; where: string; undo: boolean; target: string | null; queued?: number;
    /** What the toast counts: items, or for a filing titles or disks (filingNoun). */
    count?: (n: number) => string;
    /** Copies out of a NET: volume this run started (§4.5): their progress is the status row's, not a toast's. */
    fetches?: number };

  function transfer(op: 'copy' | 'move', sources: string[], dest: string, where: string, target: string | null, count?: (n: number) => string) {
    if (busy) return;
    const run: Run = { op, dest, where, undo: offersUndo(op, sources, dest), target, ...(count ? { count } : {}) };
    // R4: the Files setting's answer goes with the first request; only 'ask' (the default) can come back as clashes.
    const groups: TransferGroup[] = [{ onClash: prefs.files.onClash, sources }];
    // Out of a NET: volume, the picked drawers are listed afresh first: the server expands a drawer only from a listing
    // the Amiga gave in the last 2 minutes (plan P3).
    const { panes: cur } = latest.current;
    const from = [cur.left.listing, cur.right.listing].find((l) => isNetVolume(l) && sources.every((x) => l!.entries.some((e) => e.path === x)));
    const drawers = from ? from.entries.filter((e) => e.kind === 'dir' && sources.includes(e.path)).map((e) => e.path) : [];
    if (!drawers.length) { void runGroups(run, groups, [], []); return; }
    void (async () => {
      setBusy(`Reading ${baseName(drawers[0])}…`);
      const failed = await walkDrawers(drawers, from!);
      setBusy(null);
      if (failed === null) void runGroups(run, groups, [], []);
      else if (failed) showFetchLine(`walk-${Date.now()}`, failed, true);
    })();
  }

  /**
   * Every drawer under `drawers`, listed with `fresh` on each one's first ask (the pending loop, its label in the status
   * row), so the server remembers them all (P3); nothing is collected here. Null when all were read; else the words of
   * the first that was not ('' when the manager went away).
   */
  async function walkDrawers(drawers: string[], from: Listing): Promise<string | null> {
    const todo = [...drawers];
    for (let path = todo.shift(); path !== undefined; path = todo.shift()) {
      const at = path;
      const r = await askUntilAnswered<Exclude<Fetched, { pending: string }>>(at, {
        ask: fetchListing, fresh: true, wanted: () => alive.current, onPending: (label) => setBusy(label),
        giveUp: () => ({ error: noAnswer(at, from) }),
      });
      if (r === null) return '';
      if (!('listing' in r)) return 'gone' in r ? GONE : r.error;
      todo.push(...r.listing.entries.filter((e) => e.kind === 'dir').map((e) => e.path));
    }
    return null;
  }

  /** One copy's line in the status row; a new copy's first line lets go of the summaries of those already finished. */
  function showFetchLine(id: string, line: string, finished: boolean) {
    setFetchLines((cur) => {
      const i = cur.findIndex((x) => x.id === id);
      if (i >= 0) return cur.map((x, k) => (k === i ? { id, line, finished } : x));
      return [...cur.filter((x) => !x.finished), { id, line, finished }];
    });
  }

  /**
   * A copy out of a volume as the board fetches it (§4.5): GET /api/files/net/fetch/<id> every second, its fetchStatus
   * in the status row, until it is finished or the manager unmounts. Then the summary stays, a pane showing `dest` reads
   * it again, and `then` hears the last progress (Download, P8). The busy lock is not held: the person may go on.
   */
  function watchFetch(f: Fetching, dest: string, then?: (p: { done: number; arrived: string[] }) => void) {
    const again = () => {
      if (!alive.current) return;
      const t = setTimeout(() => { fetchTimers.current.delete(t); void tick(); }, 1000);
      fetchTimers.current.add(t);
    };
    const tick = async () => {
      let res: Response;
      try { res = await fetch(`/api/files/net/fetch/${encodeURIComponent(f.id)}`, { cache: 'no-store' }); } catch { again(); return; }
      if (!alive.current) return;
      if (isSignedOutAnswer(res)) { showFetchLine(f.id, SIGNED_OUT_TEXT, true); return; }
      const p = (await res.json().catch(() => null)) as
        { total: number; done: number; failed: { name: string; reason: string }[]; waiting: number; board: string; arrived: string[] } | null;
      if (!res.ok || !p) { if (res.status >= 500) { again(); return; } showFetchLine(f.id, refusalWords('failed'), true); return; }
      const s = fetchStatus(p, p.board);
      showFetchLine(f.id, s.line, s.finished);
      if (!s.finished) { again(); return; }
      const { panes: cur } = latest.current;
      for (const side of ['left', 'right'] as const) if (cur[side].path === dest) void refresh(side);
      then?.(p);
    };
    void tick();
  }

  /**
   * Send the groups in turn. A 409 clashes answer (on a first 'ask'; on a resend only if the folder changed
   * in between) opens the Clash dialog; the groups not yet sent wait in it with what is already done, and go on once
   * every clash has an answer. A refusal stops the run (its toast is already up); what was done is still reported.
   */
  async function runGroups(run: Run, groups: TransferGroup[], done: OpItem[], versions: OpVersion[]) {
    for (const [k, g] of groups.entries()) {
      const r = await post({ op: run.op, sources: g.sources, dest: run.dest, onClash: g.onClash },
        `${verbs[run.op][0]} ${items(g.sources.length)}…`);
      if (r.kind === 'done') {
        done.push(...r.items); versions.push(...r.versions);
        if (r.queued !== undefined) run.queued = (run.queued ?? 0) + r.queued;
        if (r.fetching) { run.fetches = (run.fetches ?? 0) + 1; watchFetch(r.fetching, run.dest); }
        continue;
      }
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
    // Out of a volume the files have not arrived yet: the status row says how it goes. Only what was skipped or refused
    // at once (a clash answered Skip, a non-disk onto LIBRARY:) is a toast now.
    if (run.fetches) {
      const failed = done.filter((i): i is Extract<OpItem, { ok: false }> => !i.ok);
      const skipped = done.filter((i) => i.ok && i.skipped).length;
      if (skipped) toast(skippedWords(skipped));
      if (failed.length) {
        toast.error(`${items(failed.length)} could not be copied.`, {
          description: <ul data-testid="files-failures">{failed.map((f) => <li key={f.source}>{baseName(f.source)}: {refusalWords(f.refusal.code, f.refusal.detail)}</li>)}</ul>,
        });
      }
      return;
    }
    // A copy into a board's queue says how many FILES it queued (a folder is several): "Queued 3 files to A500 bench."
    const said = (n: number) => (run.queued !== undefined ? `Queued ${files(run.queued)} to ${run.where}.` : `${verbs[run.op][1]} ${(run.count ?? items)(n)} to ${run.where}.`);
    if (done.length) void report(done, said, run.target, versions, { undo: run.undo, ...(run.count ? { count: run.count } : {}) });
    else reloadBoth();
  }

  function chooseClash(choice: ClashChoice, forAll: boolean) {
    if (dialog?.kind === 'stash-clash') { chooseStashClash(choice, forAll); return; }
    if (dialog?.kind !== 'clash') return;
    const d: ClashDialogState = dialog;
    const choices = { ...d.choices };
    const upto = forAll ? d.clashes.length : d.at + 1;
    for (let i = d.at; i < upto; i++) choices[d.clashes[i].source] = choice;
    if (upto < d.clashes.length) { setDialog({ ...d, at: upto, choices }); return; }
    ranOp.current = true;
    setDialog(null);
    // Mixed answers send no request for the skipped sources; they are reported as skipped all the same.
    void runGroups(d, [...clashGroups(d.sources, d.clashes.map((c) => c.source), choices), ...d.rest],
      [...d.done, ...skippedItems(d.sources, choices)], [...d.versions]);
  }

  /** Cancel stops the run here; anything an earlier request already did is still reported. */
  function cancelClash() {
    if (dialog?.kind === 'stash-clash') {
      const d = dialog;
      setDialog(null);
      if (d.done.items.length || d.done.refused.length || d.done.stopped) reportStash(d.dir, d.done, d.skipped);
      return;
    }
    if (dialog?.kind !== 'clash') return;
    const d: ClashDialogState = dialog;
    setDialog(null);
    if (d.done.length) finishRun(d, d.done, d.versions);
  }

  const where = placeOf;
  /** A copy or move onto LIBRARY: or a collection counts titles or disks (filingNoun); anywhere else, items. */
  const filedCount = (to: Listing | null) => (shelfOf(to) ? filingNoun(src) : undefined);

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

  function act(cmd: Exclude<BankCommand, 'all' | 'none' | 'parent' | 'root' | 'swap' | 'filter' | 'showinfo' | 'refresh'> | 'copyTo' | 'moveTo') {
    // While an operation runs a press says what runs (the status row's words), never silently nothing (Task 8 review).
    if (busy) { toast(busy, { id: 'files-busy' }); return; }
    const reason = reasons[cmd];
    if (reason) { toast.error(reason); return; }
    const side = active;
    const sources = picked.map((e) => e.path);
    switch (cmd) {
      case 'copy': guarded([dst?.disk], () => transfer('copy', sources, dst!.path, where(dst), dst?.disk?.diskId ?? null, filedCount(dst))); return;
      case 'move': guarded([dst?.disk, src?.disk], () => transfer('move', sources, dst!.path, where(dst), dst?.disk?.diskId ?? null, filedCount(dst))); return;
      // R2: with Ask before deleting off, a delete inside a disk runs at once (it saves a version; the toast offers
      // Undo). STASH: and NET: keep no versions, so they always ask.
      case 'delete':
        if (!deleteAsks(prefs.files.confirmDelete, src)) { const l = src!; guarded([l.disk], () => void deleteNow(l, picked)); return; }
        guarded([src?.disk], () => setDialog({ kind: 'delete', side, entries: picked }));
        return;
      case 'rename': guarded([src?.disk], () => setDialog({ kind: 'rename', side, entry: picked[0] })); return;
      case 'makedir': guarded([src?.disk], () => setDialog({ kind: 'makedir', side })); return;
      case 'protect': guarded([src?.disk], () => setDialog({ kind: 'protect', side, entries: picked })); return;
      case 'info': setDialog({ kind: 'info', side, entry: picked[0] }); return;
      case 'copyTo': setDialog({ kind: 'pick', op: 'copy', sources, start: panes[otherSide(side)].path }); return;
      case 'moveTo': setDialog({ kind: 'pick', op: 'move', sources, start: panes[otherSide(side)].path }); return;
      case 'download': if (volume) void downloadFromVolume(picked[0]); else void download(downloadHref(picked, folderName)); return;
      case 'addlib': void addToLibrary(picked); return;
      case 'createadf': setDialog({ kind: 'create', side }); return;
    }
  }

  /**
   * Create ADF… (§4): one op into the `side` pane's place; the toast names what was made (a title on LIBRARY: offers
   * Open title), and the pane reloads with the new disk picked. The other pane reloads too when it shows the same place.
   */
  async function createDisk(side: Side, v: { name: string; filesystem: 'FFS' | 'OFS'; density: 'dd' | 'hd' }) {
    const l = panes[side].listing;
    if (!l) return;
    const r = await post({ op: 'create-adf', dest: l.path, ...v, onClash: prefs.files.onClash }, 'Creating the disk…');
    if (r.kind === 'clashes') { toast.error(refusalWords('name_exists')); return; }   // a race with the dialog's own check
    if (r.kind !== 'done') return;
    const made = r.items[0];
    // A refused disk keeps the dialog open with the typed name, to be changed and tried again (Task 7 review).
    if (!createClosesDialog(r)) {
      if (made && !made.ok) toast.error(refusalWords(made.refusal.code, made.refusal.detail));
      return;
    }
    ranOp.current = true;
    setDialog(null);
    const first = r.added[0];
    if (!made?.ok) return;
    if (made.skipped) toast.success(skippedWords(1));
    else toast.success(`Made ${first ? v.name : `${v.name}.adf`} in ${placeOf(l)}.`,
      first ? { action: { label: 'Open title', onClick: () => router.push(`/games/${first.gameId}`) } } : {});
    void load(side, l.path, { select: made.skipped ? undefined : made.source });
    const other = otherSide(side);
    if (latest.current.panes[other].path === l.path) void load(other, l.path);
  }

  /**
   * A delete without the confirm (R2), as the confirm's Delete runs it: the versioned toast with Undo. The Delete button
   * goes disabled while it runs, which drops its focus to <body>: the manager takes it back, as after a dialog's op.
   */
  async function deleteNow(l: Listing, entries: FsEntry[]) {
    const r = await post({ op: 'delete', sources: entries.map((e) => e.path) }, `Deleting ${items(entries.length)}…`);
    if (r.kind === 'done') void report(r.items, (n) => `Deleted ${items(n)} from ${placeName(l.disk)}.`, l.disk?.diskId ?? null, r.versions);
    const now = document.activeElement;
    if (!now || now === document.body) rootRef.current?.focus({ preventScroll: true });
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
   * Download of a volume's file (plan P8): a one-file copy into the STASH: root (keep both on a clash), and once the
   * board has fetched it, the STASH: download of where it arrived. The copy stays in STASH:, like any other (§4.5). A
   * failure is the status row's summary, which names the reason.
   */
  async function downloadFromVolume(e: FsEntry) {
    const r = await post({ op: 'copy', sources: [e.path], dest: 'STASH:', onClash: 'keep-both' }, `Copying ${e.name} to STASH:…`);
    if (r.kind !== 'done') return;
    const f = r.items[0];
    if (f && !f.ok) { toast.error(`${e.name}: ${refusalWords(f.refusal.code, f.refusal.detail)}`); return; }
    if (!r.fetching) return;
    watchFetch(r.fetching, 'STASH:', (p) => {
      const at = p.arrived[0];
      if (p.done > 0 && at) void download(`/api/files/download?path=${encodeURIComponent(at)}`);
    });
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
    guarded([l.disk, d.op === 'move' ? src?.disk : null], () => transfer(d.op, d.sources, l.path, where(l), l.disk?.diskId ?? null, filedCount(l)));
  }

  /**
   * A dialog's operation: the dialog stays open (busy) while it runs and closes once it is done. `target`: the disk it
   * changes -- the dialog's pane's disk, where it makes the folder or its sources are (Files 2 R2: from the listing).
   */
  async function runFromDialog(req: OpRequest, label: string, success: (n: number) => string, target: string | null,
    inline?: { code: RefusalCode; refused(words: string): void }) {
    const r = await post(req, label, inline?.code);
    if (r.kind === 'done') { ranOp.current = true; setDialog(null); void report(r.items, success, target, r.versions); }
    else if (r.kind === 'refused' && r.words !== undefined) inline?.refused(r.words);
  }

  /** A bank command, on the source (active) pane. One that cannot apply says why (its button is aria-disabled, §2.3). */
  function bank(cmd: BankCommand) {
    if (busy) { toast(busy, { id: 'files-busy' }); return; }
    const reason = bankReasons[cmd];
    if (reason) { toast.error(reason); return; }
    switch (cmd) {
      case 'all': setSelection(active, () => selectAll(rowsOf(active).length)); return;
      case 'none': setSelection(active, () => EMPTY_SELECTION); return;
      case 'parent': command('parent', false); return;
      case 'root': if (nav.root) navigate(active, nav.root); return;
      case 'swap': swap(); return;
      case 'filter': filterRefs[active].current?.focus(); return;
      case 'showinfo': showInfo(hideInfo); return;   // hidden now → show
      case 'refresh': void load(active, panes[active].path, { fresh: true }); return;
      default: act(cmd);
    }
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
      case 'parent': if (nav.parent) navigate(active, nav.parent); return;
      case 'switch': activate(otherSide(active)); return;
      case 'find': filterRefs[active].current?.focus(); return;
      case 'refresh': bank('refresh'); return;
      default: act(cmd);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    // React bubbles a portal's events through the component tree, so keys pressed in the More menu, a dialog or a
    // toast reach this handler although their DOM is elsewhere. Only keys from the manager's own DOM are its keys.
    if (!rootRef.current?.contains(target)) return;
    // Escape in an empty filter box gives the keys back to the manager (R6); the Escape that cleared it was the box's
    // own (pane.tsx prevents its default), so it never gets here.
    if (e.key === 'Escape' && (target === filterRefs.left.current || target === filterRefs.right.current)) {
      e.preventDefault();
      rootRef.current.focus({ preventScroll: true });
      return;
    }
    const cmd = commandFor({ key: e.key, target, dialogOpen: dialog !== null, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
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
    // Titles on LIBRARY: or in a collection drag, to be filed (Files 2 §3.2). A selection that holds a collection too
    // drags as well, and its drop says why it is refused (fix round 1): never a drag that silently does not start.
    const shelf = shelfOf(l) !== null && indexes.every((i) => rows[i]?.kind === 'title' || rows[i]?.kind === 'collection');
    // A volume's rows drag too, as copies (NET: volumes, spec 2026-10-30 §5).
    const volumeRows = isNetVolume(l);
    if ((!holdsFiles(l) && !shelf && !volumeRows) || paths.length === 0) { e.preventDefault(); return; }
    activate(side);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ from: side, paths }));
    e.dataTransfer.effectAllowed = volumeRows ? 'copy' : 'copyMove';
  }

  /** The folder (or collection) row a drop landed on, else the folder the pane shows. */
  function dropFolder(l: Listing, e: React.DragEvent): string {
    const row = (e.target as HTMLElement).closest?.('tr[data-testid="pane-row"]') as HTMLElement | null;
    const kind = row?.dataset.kind;
    return kind === 'dir' || kind === 'collection'
      ? l.entries.find((x) => x.name === row!.dataset.name && x.kind === kind)?.path ?? l.path : l.path;
  }

  /**
   * Files from the computer dropped on a pane (R5): the Browse page's review (drop-review.tsx) for the folder they
   * landed in, then the disk's batch route. Only a writable folder inside a disk takes them.
   */
  function dropFromComputer(side: Side, e: React.DragEvent) {
    const l = panes[side].listing;
    if (l && !l.disk && holdsFiles(l)) { dropIntoStash(side, l, e); return; }
    if (isNetVolume(l)) { toast.error(NET_READ_ONLY); return; }
    if (l && netReadOnly(l)) { dropOnBoard(side, l, e); return; }
    if (!l?.disk) { toast.error('Open a disk to drop files into it'); return; }
    if (!l.writable) { toast.error(readOnly(l)); return; }
    // Busy, or a dialog open (the review would replace it, and whatever it was in the middle of): not taken, said.
    const blocked = dropBlocked({ busy: busy !== null, dialogOpen: dialog !== null });
    if (blocked) { toast.error(blocked); return; }
    activate(side);
    const disk = l.disk;
    const dest = dropFolder(l, e);
    // The folder's place on the disk, under the listing's diskBase (Files 2 R2: a collection adds a segment).
    const folder = diskRelative(dest, l.diskBase) ?? '';
    const where = dest === l.path ? l.crumbs[l.crumbs.length - 1]?.label ?? disk.label : baseName(dest);
    // Read synchronously, before any await or confirm: the browser empties the DataTransfer once this handler returns.
    const reading = readDroppedItems(e.dataTransfer.items);
    guarded([disk], () => setDialog({ kind: 'drop', disk, folder, where, items: reading }));
  }

  /**
   * Files from the computer dropped on a pane in STASH: (any folder, or the folder row they landed on): stored there.
   * Inside an archive, which is read-only, it is said instead.
   */
  function dropIntoStash(side: Side, l: Listing, e: React.DragEvent) {
    if (!l.writable) { toast.error(readOnly(l)); return; }
    const blocked = dropBlocked({ busy: busy !== null, dialogOpen: dialog !== null });
    if (blocked) { toast.error(blocked); return; }
    activate(side);
    const dest = dropFolder(l, e);
    // Read synchronously, before any await: the browser empties the DataTransfer once this handler returns.
    void storeDrop(dest, readDroppedItems(e.dataTransfer.items));
  }

  /**
   * Files from the computer dropped on a board's queue (C2): sent to that board, as Send to the Amiga sends them --
   * checked whole against the queue and the 4 MB cap first, then one upload a file. On NET: itself, a board is asked for.
   */
  function dropOnBoard(side: Side, l: Listing, e: React.DragEvent) {
    const id = netBoardOf(l);
    if (!id || !l.queue) { toast.error(refusalWords('read_only', NET_PICK_BOARD)); return; }
    const blocked = dropBlocked({ busy: busy !== null, dialogOpen: dialog !== null });
    if (blocked) { toast.error(blocked); return; }
    activate(side);
    // Read synchronously, before any await: the browser empties the DataTransfer once this handler returns.
    void sendDrop(id, placeOf(l), l.queue, readDroppedItems(e.dataTransfer.items));
  }

  async function sendDrop(id: string, boardName: string, queue: { files: number; bytes: number }, reading: Promise<DroppedItem[]>) {
    setBusy('Reading the drop…');
    try {
      let dropped: DroppedItem[];
      try { dropped = await reading; } catch { toast.error('The dropped files could not be read.'); return; }
      // NET: has no folders: a folder's files go by their path inside the drop (R1).
      const sending = dropped.filter((i) => i.kind === 'file' && i.file).map((i) => ({ path: i.path, file: i.file!, size: i.sizeBytes }));
      const refusal = netDropRefusal(sending, queue);
      if (refusal) { toast.error(refusal); return; }
      setBusy(`Sending ${files(sending.length)}…`);
      const r = await sendToBoard(id, sending);
      reloadBoth();
      const lines = [...r.failed.map((f) => `${f.path}: ${f.why}`), ...(r.stopped ? [r.stopped] : [])];
      const title = r.queued > 0 ? `Queued ${files(r.queued)} to ${boardName}.` : 'Nothing was queued.';
      if (lines.length) toast.error(title, { description: <ul data-testid="files-send-report">{lines.map((x, i) => <li key={i}>{x}</li>)}</ul> });
      else toast.success(title);
    } finally {
      setBusy(null);
    }
  }

  /** The top drop zone's files (or Browse files): into the STASH: root (R1). */
  function dropOnZone(reading: Promise<DroppedItem[]>) {
    const blocked = dropBlocked({ busy: busy !== null, dialogOpen: dialog !== null });
    if (blocked) { reading.catch(() => {}); toast.error(blocked); return; }
    void storeDrop('STASH:', reading);
  }

  /** The names in the STASH: folder `dir`: from a pane that shows it, else a fresh listing; null when it cannot be listed. */
  async function namesIn(dir: string): Promise<string[] | null> {
    const { panes: cur } = latest.current;
    const there = [cur.left.listing, cur.right.listing].find((l) => l?.path === dir);
    if (there) return there.entries.map((x) => x.name);
    const r = await fetchListing(dir);
    return 'listing' in r ? r.listing.entries.map((x) => x.name) : null;
  }

  /**
   * Dropped items into the STASH: folder `dir`. Their top names are compared with what the folder holds (case does not
   * matter): any clash opens the Clash dialog first (or takes the Files setting's answer); none, and they go up with
   * that answer, so a clash the server finds (a race) follows the setting too.
   */
  async function storeDrop(dir: string, reading: Promise<DroppedItem[]>) {
    stash.setBusy('Reading the drop…');
    let dropped: DroppedItem[];
    let names: string[] | null;
    try {
      [dropped, names] = await Promise.all([reading, namesIn(dir)]);
    } catch {
      toast.error('The dropped files could not be read.');
      return;
    } finally {
      stash.setBusy(null);
    }
    if (!dropped.length) return;
    const tops = [...new Set(dropped.map((i) => topOf(i.path)))];
    const clashes = tops.filter((t) => names?.some((n) => sameStashName(n, t))).map((t) => ({ source: t, name: t, dest: dir }));
    // R4: an answer set in the Files settings is given without asking; the server says which tops Skip left out.
    const answer = prefs.files.onClash;
    if (clashes.length && answer !== 'ask') {
      void runStash(dir, [{ onClash: answer, items: dropped }], noneDone(), new Set());
      return;
    }
    if (clashes.length) {
      setDialog({ kind: 'stash-clash', dir, items: dropped, clashes, at: 0, choices: {}, later: [], done: noneDone(), skipped: new Set() });
      return;
    }
    // No clash seen up front: the answer still goes with the drop, so a clash the server finds (a race) follows it.
    void runStash(dir, [{ onClash: answer, items: dropped }], noneDone(), new Set());
  }

  /** Each group up in turn; a clash the server found (a race) asks again, with the groups not yet sent waiting. */
  async function runStash(dir: string, groups: StashGroup[], done: StashUploadResult, skipped: Set<string>) {
    for (const [k, g] of groups.entries()) {
      const r = await stash.upload(dir, g.items, g.onClash);
      done.items.push(...r.items);
      done.renamed.push(...r.renamed);
      done.refused.push(...r.refused);
      if (r.clashes && r.rest) {
        setDialog({ kind: 'stash-clash', dir, items: r.rest, clashes: r.clashes, at: 0, choices: {}, later: groups.slice(k + 1), done, skipped });
        return;
      }
      if (r.stopped) { done.stopped = r.stopped; break; }
    }
    reportStash(dir, done, skipped);
  }

  function chooseStashClash(choice: ClashChoice, forAll: boolean) {
    if (dialog?.kind !== 'stash-clash') return;
    const d = dialog;
    const choices = { ...d.choices };
    const upto = forAll ? d.clashes.length : d.at + 1;
    for (let i = d.at; i < upto; i++) choices[d.clashes[i].source] = choice;
    if (upto < d.clashes.length) { setDialog({ ...d, at: upto, choices }); return; }
    ranOp.current = true;
    setDialog(null);
    const skipped = new Set(d.skipped);
    for (const [top, c] of Object.entries(choices)) if (c === 'skip') skipped.add(top.toLowerCase());
    const tops = [...new Set(d.items.map((i) => topOf(i.path)))];
    const groups = clashGroups(tops, d.clashes.map((c) => c.source), choices).map((g): StashGroup => {
      const take = new Set(g.sources.map((t) => t.toLowerCase()));
      return { onClash: g.onClash, items: d.items.filter((i) => take.has(topOf(i.path).toLowerCase())) };
    });
    void runStash(d.dir, [...groups, ...d.later], d.done, skipped);
  }

  /**
   * What a drop into STASH: did: "Added 3 items to STASH:/Mods", every name the server stored differently ("ReadMe
   * stored as ReadMe_1") and every refusal listed under it; both panes reload. Tops answered Skip are said apart
   * ("Skipped 1 (already there).") and never counted as added.
   */
  function reportStash(dir: string, r: StashUploadResult, skipped: Set<string>) {
    reloadBoth();
    const failed = r.items.filter((i): i is Extract<OpItem, { ok: false }> => !i.ok);
    // Skipped: the tops a mixed answer never sent, and every top the server says it skipped (a Skip setting, a race).
    const answered = new Set(r.items.map((i) => i.source.toLowerCase()));
    const skips = new Set([...skipped].filter((t) => !answered.has(t)));
    for (const i of r.items) if (i.ok && i.skipped) skips.add(i.source.toLowerCase());
    const added = r.items.filter((i) => i.ok && !i.skipped).length;
    const lines = [
      ...r.renamed.map((x) => `${x.from} stored as ${x.to}`),
      ...failed.map((f) => `${baseName(f.source)}: ${refusalWords(f.refusal.code, f.refusal.detail)}`),
      ...r.refused.map((x) => `${x.path}: ${x.why}`),
      ...(r.stopped ? [r.stopped] : []),
    ];
    const title = stashTitle(added, skips.size, dir, items);
    const description = lines.length
      ? <ul data-testid="files-stash-report">{lines.map((x, i) => <li key={i}>{x}</li>)}</ul>
      : undefined;
    if (failed.length || r.refused.length || r.stopped) toast.error(title, { description });
    else toast.success(title, { description });
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
    const from = panes[data.from]?.listing ?? null;
    const dest = l ? dropFolder(l, e) : '';
    // Out of a volume a drag always copies (spec 2026-10-30 §5): Shift asks for nothing a volume can give.
    const op = e.shiftKey && !isNetVolume(from) ? 'move' : 'copy';
    const pickedHere = from?.entries.filter((x) => data.paths.includes(x.path)) ?? [];
    // Onto LIBRARY:, a collection, or a collection row (Files 2 §3.2): titles, or disk images from STASH:, are filed.
    const row = l?.entries.find((x) => x.path === dest) ?? null;
    const to = row ? shelfOfRow(row) : shelfOf(l);
    const filing = filingReason(op, from, pickedHere, to);
    if (filing !== undefined) {
      if (data.from === side && dest === l?.path) return;        // put back where it was picked up
      if (filing) { toast.error(filing); return; }
      activate(side);
      transfer(op, data.paths, dest, row ? row.name : where(l), null, filingNoun(from));
      return;
    }
    if (!l || !acceptsCopies(l)) {
      toast.error(isNetVolume(l) ? NET_READ_ONLY : l && netReadOnly(l) ? readOnly(l) : 'Open a disk or STASH: to drop files into it');
      return;
    }
    if (!l.writable) { toast.error(readOnly(l)); return; }
    if (data.paths.includes(dest)) return;                       // a folder dropped on itself
    if (data.from === side && dest === l.path) return;           // put back where it was picked up
    // A STASH: file that failed to arrive holds no bytes: said as Copy → says it, not as the op's "not found".
    const failed = failedReason(pickedHere);
    if (failed) { toast.error(failed); return; }
    if (op === 'move' && netBoardOf(l)) { toast.error(`${NET_MOVE_IN}.`); return; }   // C16
    if (op === 'move' && from && !from.writable) { toast.error(readOnly(from)); return; }
    activate(side);
    const label = where(l);
    guarded([l.disk, op === 'move' ? from?.disk : null], () => transfer(op, data.paths, dest, label, l.disk?.diskId ?? null));
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  const dialogBusy = busy !== null;
  const dialogListing = dialog && 'side' in dialog ? panes[dialog.side].listing : null;
  // The disk a dialog's operation changes, whose version its toast names.
  const dialogTarget = dialogListing?.disk?.diskId ?? null;
  // What a delete names: the disk, STASH: (whose delete cannot be undone: ruling 8), or NET: (it cancels or clears, R4).
  const deleteWhere = deleteWhereOf(dialogListing);
  const deletedFrom = (n: number) => (deleteWhere === 'LIBRARY:' ? `Deleted ${n === 1 ? '1 collection' : `${n} collections`}.`
    : deleteWhere === 'NET:' ? `Cancelled or cleared ${items(n)} on ${placeOf(dialogListing)}.`
    : `Deleted ${items(n)} from ${deleteWhere === 'STASH:' ? deleteWhere : placeName(deleteWhere)}.`);
  // Makedir and Rename on LIBRARY: name collections (Files 2 §3.2, R3): the Library's rules, clashes among collections.
  const naming = shelfOf(dialogListing) !== null;
  const nameTaken = naming ? dialogListing!.entries.filter((e) => e.kind === 'collection').map((e) => e.name)
    : dialogListing?.entries.map((e) => e.name) ?? [];

  /** The Queue of the board whose root a pane waits on or could not read, while it has no rows to open Queue from. */
  const queueOf = (p: PaneState) => {
    const b = netBoardRoot(p.path);
    return b !== null && (p.error !== null || p.pending !== null) && p.listing?.path !== p.path ? `NET:/${b}/${QUEUE_FOLDER}` : null;
  };

  function pane(side: Side) {
    const p = panes[side];
    // A disk whose image cannot be read has no listing, but still has its strip (History, Restore) from the database.
    const stripId = stripDiskOf(p);
    const strip = stripId ? strips[stripId] : undefined;
    const disk = p.listing?.disk ?? strip?.info ?? null;
    return (
      // Below lg only the active side is drawn, as tall as its rows: the page scrolls, not a box inside it.
      <div className={`grid min-h-0 min-w-0 lg:grid-rows-[minmax(0,1fr)] ${active === side ? '' : 'max-lg:hidden'}`}>
        <Pane side={side} active={active === side} listing={side === 'left' ? shownLeft : shownRight} loading={p.loading} error={p.error} pending={p.pending}
              // The Comment column: STASH: only by default (ruling 9), or always, or never (R3).
              sort={sortOf(p.listing, p.path)} selection={p.selection} showComment={showsComment(prefs.files.comments, p.listing?.path ?? p.path)}
              view={viewOf(p)} onFilter={(text) => setFilter(side, text)} onShowInfo={showInfo} filterRef={filterRefs[side]}
              help={paneHelpTopic(p.listing?.path ?? p.path)}
              onActivate={() => activate(side)} onNavigate={(path) => navigate(side, path)}
              onSort={(key) => changeSort(side, key)} onSetSort={(next) => applySort(side, next)}
              onRowClick={(i, mods) => rowClick(side, i, mods)}
              onRowOpen={(i, how) => openRow(side, i, how)}
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
              ) : queueOf(p) ? (
                // A board's root waits on its Amiga for the volumes; its send queue never does (spec 2026-10-30 §4.4).
                <Button variant="outline" size="sm" onClick={() => navigate(side, queueOf(p)!)} data-testid={`pane-${side}-queue`}>
                  Open Queue
                </Button>
              ) : undefined} />
      </div>
    );
  }

  return (
    <>
    {/* The top drop zones (R1): Drop files into STASH:, and Send files to the Amiga (R7). */}
    <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-stretch">
      {/* Below lg the zones stack (spec §5.4); below sm each is its own two-column tile grid, its tile full width. */}
      <div className="grid min-w-0 max-sm:grid-cols-2 max-sm:gap-x-2.5 max-sm:gap-y-2 sm:contents">
        <StashDropZone busy={stash.busy} onItems={dropOnZone} onFetched={() => reloadBoth()} />
      </div>
      <div className="grid min-w-0 max-sm:grid-cols-2 max-sm:gap-x-2.5 max-sm:gap-y-2 sm:contents">
        <SendDropZone targets={send.targets} initialBoard={send.initialBoard} serverNow={send.serverNow} onSent={sentTo}
                      paneQueues={[panes.left.listing?.queue, panes.right.listing?.queue]}
                      onShowQueue={(id) => navigate('right', `NET:/${id}/${QUEUE_FOLDER}`)} />
      </div>
    </div>
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
          this a scroll box the phone bar could not stick out of. The pane's top and the bar round their own corners.
          From lg (Files 2 §2): the two panes, a 1 px line between them and nothing else, then the bank under both and
          one status row. The manager fills the window under the header and the compact drop zones (about 260-300 px
          of them): at 1280 x 800 the whole manager -- the bank's last row and the status row too -- is on screen as the
          page opens, each pane about 385 px tall; from 1366 x 768 up likewise. 500 px is the floor: a pane inside a
          disk (title bar, filter row, strip, foot: about 280 px) keeps room for a few rows, so on a shorter window the
          page scrolls rather than squeezing them out. */}
      <div className="grid rounded-[20px] lg:overflow-hidden max-lg:grid-cols-[minmax(0,1fr)] lg:h-[clamp(500px,calc(100dvh-300px),1000px)] lg:grid-rows-[minmax(0,1fr)_auto_auto]"
           style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
        <div className="grid min-h-0 max-lg:contents lg:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)]">
          {pane('left')}
          <div aria-hidden data-testid="files-divider" className="max-lg:hidden" style={{ background: 'var(--line)' }} />
          {pane('right')}
        </div>
        <ButtonBank device={parsePath(src?.path ?? panes[active].path)?.device ?? null}
                    reasons={bankReasons} busy={busy !== null} showInfo={!hideInfo} primaryCopy={picked.length > 0}
                    onDevice={(d) => navigate(active, `${d}:`)} onCommand={bank} />
        {/* Below lg the phone bar and the status row stick to the bottom together; from lg the wrapper is not a box
            (contents), the bar is gone and the status row is the manager's last row, under the bank. */}
        <div className="files-bar max-lg:rounded-b-[20px] lg:contents" style={{ background: 'var(--surface-2)' }}>
          <div data-testid="files-actions" role="group" aria-label="File actions"
               className="flex flex-wrap gap-1.5 border-t p-2 lg:hidden" style={{ borderColor: 'var(--line)' }}>
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
                {/* NET: volumes (spec 2026-10-30 §5): Refresh on the phone sheet, where no Ctrl-R reaches. Not a fifth
                    button in the bar: at 375 px five do not fit their labels. */}
                <DropdownMenuItem data-testid="files-more-refresh" aria-disabled={bankReasons.refresh !== null || busy !== null || undefined}
                                  aria-describedby={busy !== null ? 'files-busy' : undefined}
                                  onClick={() => bank('refresh')} className={cn(MENU_ITEM, 'h-11 sm:h-11 font-medium aria-disabled:opacity-50')}>
                  Refresh
                </DropdownMenuItem>
                {([['rename', 'Rename…'], ['makedir', 'Makedir…'], ['createadf', 'Create ADF…'], ['protect', 'Protect…'], ['info', 'Info'],
                  ...(inStash ? [['addlib', 'Add to library']] as const : []), ['download', 'Download']] as const).map(([id, label]) => (
                  // Not disabled: a tap on one that cannot act now says why.
                  <DropdownMenuItem key={id} data-testid={`files-more-${id}`} aria-disabled={reasons[id] !== null || busy !== null || undefined}
                                    aria-describedby={busy !== null ? 'files-busy' : undefined}
                                    onClick={() => act(id)} className={cn(MENU_ITEM, 'h-11 sm:h-11 font-medium aria-disabled:opacity-50')}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* The one status row (§2.3): progress such as "Copying 3 of 12…". */}
          <p role="status" id="files-busy" data-testid="files-busy"
             className="px-3 py-0.5 text-[12px] max-lg:pb-2 max-lg:text-center max-lg:empty:hidden lg:min-h-[22px] lg:border-t"
             style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>{busy ?? fetchLines.map((x) => x.line).join(' · ')}</p>
        </div>
      </div>

      {(dialog?.kind === 'clash' || dialog?.kind === 'stash-clash') && (
        <ClashDialog key={`${dialog.kind}:${dialog.at}`} clash={dialog.clashes[dialog.at]} remaining={dialog.clashes.length - dialog.at}
                     busy={dialogBusy} onChoose={chooseClash} onCancel={cancelClash} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDeleteDialog entries={dialog.entries} where={deleteWhere} busy={dialogBusy}
                             onCancel={() => setDialog(null)}
                             onConfirm={() => void runFromDialog({ op: 'delete', sources: dialog.entries.map((e) => e.path) },
                               deleteWhere === 'NET:' ? `Cancelling or clearing ${items(dialog.entries.length)}…` : `Deleting ${items(dialog.entries.length)}…`,
                               deletedFrom, dialogTarget)} />
      )}
      {(dialog?.kind === 'makedir' || dialog?.kind === 'rename') && (
        <NameDialog mode={dialog.kind} initial={dialog.kind === 'rename' ? dialog.entry.name : ''}
                    rules={naming ? 'collection' : 'amiga'} taken={nameTaken} refused={dialog.refused ?? null} busy={dialogBusy}
                    onCancel={() => setDialog(null)}
                    onSave={(name) => {
                      // A collection name the server finds taken (R3) is said under the field, which keeps the name.
                      const inline = naming ? {
                        code: 'name_exists' as const,
                        refused: (words: string) => setDialog((cur) => (cur === dialog ? { ...dialog, refused: { name, words } } : cur)),
                      } : undefined;
                      void (dialog.kind === 'rename'
                        ? runFromDialog({ op: 'rename', source: dialog.entry.path, name }, 'Renaming…', () => `Renamed ${dialog.entry.name} to ${name}.`, dialogTarget, inline)
                        : runFromDialog({ op: 'makedir', dest: dialogListing!.path, name }, naming ? 'Making the collection…' : 'Making the folder…',
                          () => (naming ? `Made the collection ${name}.` : `Made the folder ${name}.`), dialogTarget, inline));
                    }} />
      )}
      {dialog?.kind === 'create' && (
        // The subtitle names a STASH: folder by its path ("In STASH:/Disks"); elsewhere the place's own name ("In Demos").
        <CreateAdfDialog where={panes[dialog.side].listing?.path.startsWith('STASH:') ? panes[dialog.side].listing!.path : placeOf(panes[dialog.side].listing)}
                         busy={dialogBusy}
                         taken={prefs.files.onClash === 'ask' && panes[dialog.side].listing?.path.startsWith('STASH:')
                           ? panes[dialog.side].listing!.entries.map((e) => e.name) : null}
                         onCancel={() => setDialog(null)} onCreate={(v) => { createOnce.current(() => createDisk(dialog.side, v)); }} />
      )}
      {dialog?.kind === 'protect' && (
        <ProtectDialog entries={dialog.entries} busy={dialogBusy} onCancel={() => setDialog(null)}
                       onSave={(protection) => void runFromDialog({ op: 'protect', sources: dialog.entries.map((e) => e.path), protection },
                         'Setting protection…', (n) => `Protection set on ${items(n)}.`, dialogTarget)} />
      )}
      {dialog?.kind === 'info' && (
        // A queue row's Info only reads: its comment travels with the send and is not edited in NET:.
        <InfoDialog entry={dialog.entry} writable={!!dialogListing?.writable && !netReadOnly(dialogListing)} busy={dialogBusy} onClose={() => setDialog(null)}
                    onSaveComment={(comment) => {
                      const entry = dialog.entry;
                      guarded([dialogListing?.disk], () => void runFromDialog({ op: 'comment', source: entry.path, comment },
                        'Saving the comment…', () => `Comment saved on ${entry.name}.`, dialogTarget));
                    }} />
      )}
      {dialog?.kind === 'pick' && (
        <CopyToPicker op={dialog.op} count={dialog.sources.length} start={dialog.start} busy={dialogBusy} list={settledListing}
                      filing={(l) => filingReason(dialog.op, src, picked, shelfOf(l))}
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
    </>
  );
}
