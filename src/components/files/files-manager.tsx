'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { FsEntry, Listing, RefusalCode } from '@/lib/files/types';
import { nextSort, sortFsEntries, type FilesSort, type FilesSortKey } from '@/lib/files/sort';
import { EMPTY_SELECTION, moveCursor, selectClick, togglePick, type Selection } from '@/lib/files/selection';
import { commandFor, type FilesCommand } from '@/lib/files/keys';
import { refusalWords } from '@/lib/files/words';
import { formatPath, parsePath } from '@/lib/files/path';
import type { OpItem, OpRequest } from '@/lib/files/ops';
import type { UserPrefs } from '@/lib/user-prefs-schema';
import { latestSaver } from '@/lib/user-prefs-client';
import { Pane } from './pane';
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
  };
  prefs: { sort: UserPrefs['files']['sort'] };
};

type Dialog =
  | { kind: 'clash'; op: 'copy' | 'move'; sources: string[]; dest: string; where: string; clashes: Clash[]; at: number; choices: Record<string, ClashChoice> }
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

  function reloadBoth() {
    void load('left', panes.left.path);
    void load('right', panes.right.path);
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
    // R4: one file downloads by path. Several files on one disk would need the zip route's block numbers, which a
    // Listing does not carry (yet), so a multiple selection is refused for now.
    download: sourceReason(false) ?? (picked.length !== 1 ? 'Select one file to download it'
      : picked[0].kind !== 'file' ? 'Select a file to download it' : null),
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

  /** The toast for a finished operation, and fresh listings on both sides (which also clears both selections). */
  function report(done: OpItem[], success: (n: number) => string) {
    const failed = done.filter((i): i is Extract<OpItem, { ok: false }> => !i.ok);
    if (failed.length === 0) toast.success(success(done.length));
    else {
      const ok = done.length - failed.length;
      toast.error(ok > 0 ? `${success(ok)} ${items(failed.length)} could not be done.` : `Nothing was done.`, {
        description: (
          <ul data-testid="files-failures">
            {failed.map((f) => <li key={f.source}>{baseName(f.source)}: {refusalWords(f.refusal.code, f.refusal.detail)}</li>)}
          </ul>
        ),
      });
    }
    reloadBoth();
  }

  const verbs = { copy: ['Copying', 'Copied'], move: ['Moving', 'Moved'] } as const;

  async function transfer(op: 'copy' | 'move', sources: string[], dest: string, where: string) {
    if (busy) return;
    const r = await post({ op, sources, dest, onClash: 'ask' }, `${verbs[op][0]} ${items(sources.length)}…`);
    if (r.kind === 'clashes') setDialog({ kind: 'clash', op, sources, dest, where, clashes: r.clashes, at: 0, choices: {} });
    else if (r.kind === 'done') report(r.items, (n) => `${verbs[op][1]} ${items(n)} to ${where}.`);
  }

  /**
   * Every clash has an answer. One answer for all is one request (one new version per disk). Mixed answers cannot
   * be one request -- `onClash` is per operation -- so the sources go in one request per answer (skipped ones not at
   * all), the clash-free ones with the first.
   */
  async function finishClashes(d: Extract<Dialog, { kind: 'clash' }>, choices: Record<string, ClashChoice>) {
    setDialog(null);
    const answers = [...new Set(d.clashes.map((c) => choices[c.source]))];
    const groups: { onClash: ClashChoice; sources: string[] }[] = answers.length === 1
      ? [{ onClash: answers[0], sources: d.sources }]
      : answers.filter((a) => a !== 'skip').map((a, i) => ({
        onClash: a, sources: d.sources.filter((s) => (choices[s] ?? (i === 0 ? a : null)) === a),
      }));
    const all: OpItem[] = [];
    for (const g of groups) {
      if (g.sources.length === 0) continue;
      const r = await post({ op: d.op, sources: g.sources, dest: d.dest, onClash: g.onClash }, `${verbs[d.op][0]} ${items(g.sources.length)}…`);
      if (r.kind === 'done') all.push(...r.items);
      else if (r.kind === 'clashes') { toast.error(refusalWords('name_exists')); break; }
      else break;
    }
    if (all.length) report(all, (n) => `${verbs[d.op][1]} ${items(n)} to ${d.where}.`);
    else reloadBoth();
  }

  function chooseClash(choice: ClashChoice, forAll: boolean) {
    if (dialog?.kind !== 'clash') return;
    const choices = { ...dialog.choices };
    const upto = forAll ? dialog.clashes.length : dialog.at + 1;
    for (let i = dialog.at; i < upto; i++) choices[dialog.clashes[i].source] = choice;
    if (upto < dialog.clashes.length) setDialog({ ...dialog, at: upto, choices });
    else void finishClashes(dialog, choices);
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
        a.href = `/api/files/download?path=${encodeURIComponent(picked[0].path)}`;
        a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
        return;
      }
    }
  }

  /** A dialog's operation: the dialog stays open (busy) while it runs and closes once it is done. */
  async function runFromDialog(req: OpRequest, label: string, success: (n: number) => string) {
    const r = await post(req, label);
    if (r.kind === 'done') { setDialog(null); report(r.items, success); }
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

  /** Rows dropped on a pane: Copy, or Move with Shift; onto a folder row, into that folder. */
  function drop(side: Side, e: React.DragEvent) {
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;   // files from the computer: R5, the disk drop pipeline (Task 9)
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
    return (
      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] max-lg:h-[460px]">
        <Pane side={side} active={active === side} listing={p.listing} loading={p.loading} error={p.error}
              sort={sortOf(p.listing, p.path)} selection={p.selection} showComment={false}
              onActivate={() => activate(side)} onNavigate={(path) => navigate(side, path)}
              onSort={(key) => changeSort(side, key)}
              onRowClick={(i, mods) => { activate(side); setSelection(side, (s) => selectClick(s, i, mods)); }}
              onRowOpen={(i) => openRow(side, i)}
              onDragStartRows={(ix, e) => dragStart(side, ix, e)} onDropRows={(e) => drop(side, e)}
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
                     busy={dialogBusy} onChoose={chooseClash} onCancel={() => setDialog(null)} />
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
