'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { FsEntry, Listing, RefusalCode, StripData } from '@/lib/files/types';
import { nextSort, sortFsEntries, type FilesSort, type FilesSortKey } from '@/lib/files/sort';
import { EMPTY_SELECTION, moveCursor, selectClick, togglePick, type Selection } from '@/lib/files/selection';
import { commandFor, type FilesCommand } from '@/lib/files/keys';
import { refusalWords } from '@/lib/files/words';
import { formatPath, parsePath } from '@/lib/files/path';
import type { OpItem, OpRequest } from '@/lib/files/ops';
import type { UserPrefs } from '@/lib/user-prefs-schema';
import { latestSaver } from '@/lib/user-prefs-client';
import { clashGroups, downloadHref, DOWNLOAD_URL_MAX, type TransferGroup } from '@/lib/files/transfer';
import { planComputerDrop } from '@/lib/files/computer-drop';
import { readDroppedItems } from '@/lib/drop-reader';
import { isFileDrag } from '@/components/disks/native-drop';
import { describeEditError } from '@/components/disks/file-actions';
import { Pane } from './pane';
import { DiskStrip } from './disk-strip';
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
    kind: 'clash'; op: 'copy' | 'move'; sources: string[]; dest: string; where: string; clashes: Clash[]; at: number;
    choices: Record<string, ClashChoice>;
    /** Requests still to send once these clashes are answered, and the outcomes of those already sent. */
    rest: TransferGroup[]; done: OpItem[];
  }
  | { kind: 'delete'; side: Side; entries: FsEntry[] }
  | { kind: 'makedir'; side: Side }
  | { kind: 'rename'; side: Side; entry: FsEntry }
  | { kind: 'protect'; side: Side; entries: FsEntry[] }
  | { kind: 'info'; side: Side; entry: FsEntry };

const GONE = 'This place no longer exists.';
const DRAG_TYPE = 'application/x-webfloppy-files';
const DEFAULT_PATH = 'LIBRARY:';
const KNOWN_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  'not_found', 'read_only', 'mounted', 'disk_full', 'name_exists', 'bad_name', 'comment_too_long', 'cycle',
  'no_filesystem', 'hfe_read_only', 'conflict', 'unsupported', 'blob_unavailable', 'failed',
]);
/** Enter and Space belong to a focused control; the manager must not open or pick a row as well. */
const CONTROL = 'button, a, [role="button"], [role="checkbox"]';

const otherSide = (s: Side): Side => (s === 'left' ? 'right' : 'left');
const deviceOf = (path: string): DeviceKey => (path.startsWith('STASH:') ? 'stash' : path.startsWith('NET:') ? 'net' : 'library');
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const items = (n: number) => (n === 1 ? '1 item' : `${n} items`);
/** The disk a LIBRARY: path is in (LIBRARY:/<title>/<disk>/...), or null above the disks. */
const diskIdOf = (path: string | undefined): string | null => (path ? parsePath(path)?.segments[1] ?? null : null);
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

/** A query value as a pane path, as the page reads it (page.tsx): canonical, or the default. */
function pathParam(raw: string | null): string {
  const p = raw === null ? null : parsePath(raw);
  return p && p.device === 'LIBRARY' ? formatPath(p) : DEFAULT_PATH;
}

function urlOf(left: string, right: string, active: Side): string {
  return `/files?${new URLSearchParams({ left, right, active })}`;
}

/** The words for an error body; codes this client does not know read as a plain failure. */
function wordsFor(code: unknown, detail: unknown): string {
  const d = typeof detail === 'string' ? detail : undefined;
  return typeof code === 'string' && KNOWN_CODES.has(code) ? refusalWords(code as RefusalCode, d) : refusalWords('failed');
}

async function fetchListing(path: string): Promise<{ listing: Listing } | { gone: true } | { error: string }> {
  try {
    const res = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (res.ok) return { listing: (await res.json()) as Listing };
    if (res.status === 404 || res.status === 400) return { gone: true };
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return { error: wordsFor(body?.error, undefined) };
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

/** One button of the column. The reason sits on a wrapper too: a disabled button takes no pointer events, so its
 *  own title never shows. */
function ActionButton({ id, label, reason, busy, onClick, primary = false }: {
  id: string; label: string; reason: string | null; busy: boolean; onClick(): void; primary?: boolean;
}) {
  return (
    <span title={reason ?? undefined} className="flex">
      <Button variant={primary ? 'default' : 'outline'} size="sm" className="w-full" onClick={onClick}
              disabled={reason !== null || busy} title={reason ?? undefined} data-testid={`files-${id}`}>
        {label}
      </Button>
    </span>
  );
}

export function FilesManager({ initial, prefs }: FilesManagerProps) {
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
  const rowsLeft = useMemo(() => (panes.left.listing ? sortFsEntries(panes.left.listing.entries, sorts[deviceOf(panes.left.listing.path)]) : []), [panes.left.listing, sorts]);
  const rowsRight = useMemo(() => (panes.right.listing ? sortFsEntries(panes.right.listing.entries, sorts[deviceOf(panes.right.listing.path)]) : []), [panes.right.listing, sorts]);
  const rowsOf = (s: Side) => (s === 'left' ? rowsLeft : rowsRight);

  // ---- loading and the URL ------------------------------------------------------------------------------------

  /** List `path` into a side. A new place keeps the old rows on screen (busy) until it lands; then nothing is picked. */
  async function load(side: Side, path: string) {
    const n = ++seq.current[side];
    setPanes((ps) => ({ ...ps, [side]: { ...ps[side], path, loading: true } }));
    const r = await fetchListing(path);
    if (n !== seq.current[side]) return;
    setPanes((ps) => ({
      ...ps,
      [side]: 'listing' in r
        ? { path, listing: r.listing, loading: false, error: null, gone: false, selection: EMPTY_SELECTION }
        : { path, listing: null, loading: false, error: 'gone' in r ? GONE : r.error, gone: 'gone' in r, selection: EMPTY_SELECTION },
    }));
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

  /** Idempotent: the panes call this on every mousedown and focus inside them. */
  function activate(side: Side) {
    if (active === side) return;
    setActive(side);
    window.history.replaceState(null, '', urlOf(panes.left.path, panes.right.path, side));
  }

  useEffect(() => {
    function onPop() {
      const q = new URLSearchParams(window.location.search);
      const want = { left: pathParam(q.get('left')), right: pathParam(q.get('right')) };
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
  const shownDisks = [panes.left.listing?.disk?.diskId, panes.right.listing?.disk?.diskId].filter((x): x is string => !!x);
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
    const dev = deviceOf(panes[side].listing?.path ?? panes[side].path);
    const next = nextSort(sorts[dev], key);
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

  function openRow(side: Side, index: number) {
    const e = rowsOf(side)[index];
    if (!e) return;
    if (e.kind === 'file') setDialog({ kind: 'info', side, entry: e });
    else navigate(side, e.path);
  }

  // ---- what the buttons can do --------------------------------------------------------------------------------

  const src = panes[active].listing;
  const dst = panes[otherSide(active)].listing;
  const picked = pickedOf(rowsOf(active), panes[active].selection);
  const folderName = src?.crumbs[src.crumbs.length - 1]?.label ?? 'Files';
  const readOnly = (l: Listing) => refusalWords('read_only', l.readOnlyReason ?? undefined);

  function sourceReason(writable: boolean): string | null {
    if (picked.length === 0) return 'Select something first';
    if (!src?.disk) return 'Only files and folders on a disk can be changed here — open a disk first';
    if (writable && !src.writable) return readOnly(src);
    return null;
  }
  function transferReason(op: 'copy' | 'move'): string | null {
    const r = sourceReason(op === 'move');
    if (r) return r;
    if (!dst?.disk) return 'Open a disk on the other side';
    if (!dst.writable) return readOnly(dst);
    return null;
  }
  const one = (r: string | null, what: string) => r ?? (picked.length !== 1 ? `Select one item to ${what}` : null);
  const reasons = {
    copy: transferReason('copy'),
    move: transferReason('move'),
    delete: sourceReason(true),
    rename: one(sourceReason(true), 'rename it'),
    makedir: !src?.disk ? 'Open a disk to make a folder in it' : !src.writable ? readOnly(src) : null,
    protect: sourceReason(true),
    info: one(sourceReason(false), 'see its details'),
    // One file by path; several, or a folder, as a .zip (spec §3.3).
    download: sourceReason(false)
      ?? (downloadHref(picked, folderName).length > DOWNLOAD_URL_MAX ? 'Too many items to download at once — download their folder instead' : null),
  };

  // ---- running an operation -----------------------------------------------------------------------------------

  type Outcome = { kind: 'done'; items: OpItem[] } | { kind: 'clashes'; clashes: Clash[] } | { kind: 'refused' };

  async function post(req: OpRequest, label: string): Promise<Outcome> {
    setBusy(label);
    try {
      const res = await fetch('/api/files/ops', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
      });
      const body = (await res.json().catch(() => null)) as { items?: OpItem[]; error?: unknown; detail?: unknown; clashes?: Clash[] } | null;
      if (res.status === 409 && body?.error === 'clashes' && body.clashes) return { kind: 'clashes', clashes: body.clashes };
      if (!res.ok || !body?.items) {
        toast.error(wordsFor(body?.error, body?.detail));
        if (body?.error === 'conflict') reloadBoth();
        return { kind: 'refused' };
      }
      return { kind: 'done', items: body.items };
    } catch {
      toast.error(refusalWords('failed'));
      return { kind: 'refused' };
    } finally {
      setBusy(null);
    }
  }

  /**
   * The toast for a finished operation, and fresh listings on both sides (which also clears both selections). With a
   * `target` disk the toast waits for that disk's fresh strip and says which version the change was saved as.
   */
  async function report(done: OpItem[], success: (n: number) => string, target: string | null = null) {
    const failed = done.filter((i): i is Extract<OpItem, { ok: false }> => !i.ok);
    const ok = done.length - failed.length;
    reloadBoth();
    // Every disk on screen may have a new version (a move changes its source too); the target's is the one named.
    const { panes: cur } = latest.current;
    const others = [cur.left.listing?.disk?.diskId, cur.right.listing?.disk?.diskId].filter((x): x is string => !!x && x !== target);
    for (const id of new Set(others)) void refreshStrip(id);
    const seq = target && ok > 0 ? await refreshStrip(target) : null;
    const said = (n: number) => (seq === null ? success(n) : `${success(n).replace(/\.$/, '')} — saved as version ${seq}.`);
    if (failed.length === 0) toast.success(said(done.length));
    else {
      toast.error(ok > 0 ? `${said(ok)} ${items(failed.length)} could not be done.` : `Nothing was done.`, {
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
  type Run = { op: 'copy' | 'move'; dest: string; where: string };

  function transfer(op: 'copy' | 'move', sources: string[], dest: string, where: string) {
    if (busy) return;
    void runGroups({ op, dest, where }, [{ onClash: 'ask', sources }], []);
  }

  /**
   * Send the groups in turn. A 409 clashes answer (always on the first 'ask'; on a resend only if the folder changed
   * in between) opens the Clash dialog; the groups not yet sent wait in it with what is already done, and go on once
   * every clash has an answer. A refusal stops the run (its toast is already up); what was done is still reported.
   */
  async function runGroups(run: Run, groups: TransferGroup[], done: OpItem[]) {
    for (const [k, g] of groups.entries()) {
      const r = await post({ op: run.op, sources: g.sources, dest: run.dest, onClash: g.onClash },
        `${verbs[run.op][0]} ${items(g.sources.length)}…`);
      if (r.kind === 'done') { done.push(...r.items); continue; }
      if (r.kind === 'clashes') {
        setDialog({ kind: 'clash', ...run, sources: g.sources, clashes: r.clashes, at: 0, choices: {}, rest: groups.slice(k + 1), done });
        return;
      }
      break;
    }
    finishRun(run, done);
  }

  function finishRun(run: Run, done: OpItem[]) {
    if (done.length) void report(done, (n) => `${verbs[run.op][1]} ${items(n)} to ${run.where}.`, diskIdOf(run.dest));
    else reloadBoth();
  }

  function chooseClash(choice: ClashChoice, forAll: boolean) {
    if (dialog?.kind !== 'clash') return;
    const d: ClashDialogState = dialog;
    const choices = { ...d.choices };
    const upto = forAll ? d.clashes.length : d.at + 1;
    for (let i = d.at; i < upto; i++) choices[d.clashes[i].source] = choice;
    if (upto < d.clashes.length) { setDialog({ ...d, at: upto, choices }); return; }
    setDialog(null);
    void runGroups(d, [...clashGroups(d.sources, d.clashes.map((c) => c.source), choices), ...d.rest], [...d.done]);
  }

  /** Cancel stops the run here; anything an earlier request already did is still reported. */
  function cancelClash() {
    if (dialog?.kind !== 'clash') return;
    const d: ClashDialogState = dialog;
    setDialog(null);
    if (d.done.length) finishRun(d, d.done);
  }

  const where = (l: Listing | null) => (l?.disk ? l.disk.label : 'the other side');

  function act(cmd: 'copy' | 'move' | 'delete' | 'rename' | 'makedir' | 'protect' | 'info' | 'download') {
    if (busy) return;
    const reason = reasons[cmd];
    if (reason) { toast.error(reason); return; }
    const side = active;
    switch (cmd) {
      case 'copy': case 'move': void transfer(cmd, picked.map((e) => e.path), dst!.path, where(dst)); return;
      case 'delete': setDialog({ kind: 'delete', side, entries: picked }); return;
      case 'rename': setDialog({ kind: 'rename', side, entry: picked[0] }); return;
      case 'makedir': setDialog({ kind: 'makedir', side }); return;
      case 'protect': setDialog({ kind: 'protect', side, entries: picked }); return;
      case 'info': setDialog({ kind: 'info', side, entry: picked[0] }); return;
      case 'download': {
        const a = document.createElement('a');
        a.href = downloadHref(picked, folderName);
        a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
        return;
      }
    }
  }

  /** A dialog's operation: the dialog stays open (busy) while it runs and closes once it is done. */
  async function runFromDialog(req: OpRequest, label: string, success: (n: number) => string) {
    const r = await post(req, label);
    // The disk the operation changed: where it made the folder, else where its first source is.
    const target = diskIdOf('dest' in req ? req.dest : 'source' in req ? req.source : req.sources[0]);
    if (r.kind === 'done') { setDialog(null); void report(r.items, success, target); }
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
    if (!l?.disk || paths.length === 0) { e.preventDefault(); return; }   // titles and disks do not move
    activate(side);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ from: side, paths }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  /**
   * Files from the computer dropped on a pane (R5): into the folder the pane shows, through the Browse page's drop
   * pipeline (computer-drop.ts, then the disk's batch route). Only a writable folder inside a disk takes them.
   */
  function dropFromComputer(side: Side, e: React.DragEvent) {
    const l = panes[side].listing;
    if (!l?.disk) { toast.error('Open a disk to drop files into it'); return; }
    if (!l.writable) { toast.error(readOnly(l)); return; }
    if (busy) return;
    activate(side);
    const disk = l.disk;
    const parentPath = (parsePath(l.path)?.segments ?? []).slice(2).join('/');
    const folder = l.entries.map((x) => ({ name: x.name, kind: x.kind === 'dir' ? 'dir' as const : 'file' as const }));
    const where = l.crumbs[l.crumbs.length - 1]?.label ?? disk.label;
    // Read synchronously, before any await: the browser empties the DataTransfer once this handler returns.
    const reading = readDroppedItems(e.dataTransfer.items);
    void (async () => {
      const plan = planComputerDrop(await reading, folder, { filesystem: disk.filesystem ?? 'OFS', intl: disk.intl, freeBytes: disk.freeBytes, parentPath });
      if (!plan.ok) { if (plan.message) toast.error(plan.message); return; }
      const form = new FormData();
      for (const [path, file] of plan.parts) form.set(path, file);
      form.set('manifest', JSON.stringify(plan.manifest));
      setBusy(`Adding ${items(plan.manifest.length)}…`);
      try {
        const res = await fetch(`/api/disks/${disk.diskId}/files/batch`, { method: 'POST', body: form });
        const body = (await res.json().catch(() => null)) as { seq?: unknown; reason?: unknown; error?: unknown } | null;
        if (!res.ok) {
          const reason = typeof body?.reason === 'string' ? body.reason : typeof body?.error === 'string' ? body.error : `the server answered ${res.status}`;
          toast.error('Could not add the files', { description: describeEditError(reason) });
          return;
        }
        const seq = typeof body?.seq === 'number' ? body.seq : null;
        toast.success(`Added ${items(plan.manifest.length)} to ${where}${seq === null ? '' : ` — saved as version ${seq}`}.`, {
          description: plan.renamed.length ? `Renamed for AmigaDOS: ${plan.renamed.map(([a, b]) => `${a} → ${b}`).join(', ')}` : undefined,
        });
      } catch {
        toast.error(refusalWords('failed'));
      } finally {
        setBusy(null);
        stripChanged(disk.diskId);
      }
    })();
  }

  /** Rows dropped on a pane: Copy, or Move with Shift; onto a folder row, into that folder. */
  function drop(side: Side, e: React.DragEvent) {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) { if (isFileDrag(e)) dropFromComputer(side, e); return; }
    let data: { from: Side; paths: string[] };
    try { data = JSON.parse(raw); } catch { return; }
    if (busy || !Array.isArray(data.paths) || data.paths.length === 0) return;
    const l = panes[side].listing;
    if (!l?.disk) { toast.error('Open a disk to drop files into it'); return; }
    if (!l.writable) { toast.error(readOnly(l)); return; }
    let dest = l.path;
    const row = (e.target as HTMLElement).closest?.('tr[data-testid="pane-row"]') as HTMLElement | null;
    if (row?.dataset.kind === 'dir') dest = l.entries.find((x) => x.name === row.dataset.name)?.path ?? dest;
    if (data.paths.includes(dest)) return;                       // a folder dropped on itself
    if (data.from === side && dest === l.path) return;           // put back where it was picked up
    const op = e.shiftKey ? 'move' : 'copy';
    const from = panes[data.from]?.listing;
    if (op === 'move' && from && !from.writable) { toast.error(readOnly(from)); return; }
    activate(side);
    void transfer(op, data.paths, dest, l.disk.label);
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  const arrow = active === 'left';
  const dialogBusy = busy !== null;
  const dialogListing = dialog && 'side' in dialog ? panes[dialog.side].listing : null;

  function pane(side: Side) {
    const p = panes[side];
    const disk = p.listing?.disk ?? null;
    const strip = disk ? strips[disk.diskId] : undefined;
    return (
      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] max-lg:h-[460px]">
        <Pane side={side} active={active === side} listing={p.listing} loading={p.loading} error={p.error}
              sort={sortOf(p.listing, p.path)} selection={p.selection} showComment={false}
              onActivate={() => activate(side)} onNavigate={(path) => navigate(side, path)}
              onSort={(key) => changeSort(side, key)}
              onRowClick={(i, mods) => { activate(side); setSelection(side, (s) => selectClick(s, i, mods)); }}
              onRowOpen={(i) => openRow(side, i)}
              onDragStartRows={(ix, e) => dragStart(side, ix, e)} onDropRows={(e) => drop(side, e)}
              strip={disk && strip ? (
                <DiskStrip key={`${disk.diskId}:${disk.volumeName}`} side={side} disk={disk} data={strip}
                           onChanged={() => stripChanged(disk.diskId)} />
              ) : undefined}
              errorAction={p.gone ? (
                <Button variant="outline" size="sm" onClick={() => navigate(side, DEFAULT_PATH)} data-testid={`pane-${side}-home`}>
                  Go to LIBRARY:
                </Button>
              ) : undefined} />
      </div>
    );
  }

  const sep = <div aria-hidden className="my-1 h-px max-lg:hidden" style={{ background: 'var(--line)' }} />;

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} data-testid="files-manager" aria-label="File manager"
         // Files from the computer never open in the tab: a drop the panes did not take is answered here.
         onDragOver={(e) => { if (isFileDrag(e)) e.preventDefault(); }}
         onDrop={(e) => {
           if (!isFileDrag(e) || e.defaultPrevented) return;
           e.preventDefault();
           toast.error('Open a disk to drop files into it');
         }}
         className="rounded-[20px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
      <div className="grid overflow-hidden rounded-[20px] lg:h-[clamp(480px,calc(100dvh-260px),900px)] lg:grid-cols-[minmax(0,1fr)_92px_minmax(0,1fr)]"
           style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
        {pane('left')}
        <div data-testid="files-actions" role="group" aria-label="File actions"
             className="flex flex-wrap gap-[7px] border-y px-2 py-4 lg:flex-col lg:border-x lg:border-y-0"
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
          {sep}
          <ActionButton busy={busy !== null} id="download" label="Download" reason={reasons.download} onClick={() => act('download')} />
          <ActionButton busy={busy !== null} id="swap" label="Swap ⇄" reason={null} onClick={swap} />
          <p role="status" data-testid="files-busy" className="text-center text-[12px] lg:mt-auto" style={{ color: 'var(--muted)' }}>
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
        <ConfirmDeleteDialog entries={dialog.entries} where={dialogListing?.disk ?? null} busy={dialogBusy}
                             onCancel={() => setDialog(null)}
                             onConfirm={() => void runFromDialog({ op: 'delete', sources: dialog.entries.map((e) => e.path) },
                               `Deleting ${items(dialog.entries.length)}…`,
                               (n) => `Deleted ${items(n)} from ${placeName(dialogListing?.disk ?? null)}.`)} />
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
                    onSaveComment={(comment) => void runFromDialog({ op: 'comment', source: dialog.entry.path, comment },
                      'Saving the comment…', () => `Comment saved on ${dialog.entry.name}.`)} />
      )}
    </div>
  );
}
