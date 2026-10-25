'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Search } from 'lucide-react';
import type { AdfEntry } from '@/lib/adffs';
import type { SendContext } from '@/lib/send-ui';
import { useSendAction } from '@/components/send/send-button';
import { useFileEdit, MAX_NAME_LENGTH, type EditDisabled } from './file-actions';
import { useNativeDrop, isFileDrag } from './native-drop';
import { SelectionBar } from './selection-bar';
import { FilesCard } from './files-card';
import { DiskIcon } from '@/components/ui/disk-icon';
import { countInfo, entryGlyph, infoCompanions, plural, protectionChips } from '@/lib/disk-files-look';
import { ProtectionEditor } from './protection-editor';
import { FileRowMenu } from './file-row-menu';
import { filterTree } from '@/lib/file-filter';
import { underSelected } from '@/lib/disk-entries';

/**
 * The handlers that make an element take an OS file drop for `block`
 * (native-drop.tsx). Only a FILE drag is claimed, so dnd-kit's own moves --
 * pointer events, never a native `drop` -- and dragged text are untouched.
 * stopPropagation keeps the tree's root handler from claiming a drop a
 * folder row already took.
 */
export interface NativeDropProps {
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
}
import { sortEntries } from '@/lib/browse-sort';
import { latestSaver } from '@/lib/user-prefs-client';
import { BROWSE_SORT_OPTIONS, DEFAULT_PREFS, sortOptionId, type BrowseSort } from '@/lib/user-prefs-schema';
import { SortSelect } from '@/components/prefs/sort-select';
import { toast } from 'sonner';

// Each level's order: sortEntries (src/lib/browse-sort.ts), folders first,
// then the person's remembered Browse sort (user prefs browse.sort).

interface VisibleRow {
  entry: AdfEntry;
  depth: number;
  open: boolean;
  /** Root-relative, '/'-separated: the key "new in vN" marks are looked up by. */
  path: string;
}

/**
 * The tree, flattened into exactly the rows on screen, in the order they are
 * painted.
 *
 * This exists for the striping. Zebra rows have to alternate down the VISIBLE
 * list, and a recursive component cannot know its own position in that list --
 * each level would restart its own odd/even count, so expanding a directory
 * puts two same-shaded rows next to each other at every boundary, which reads
 * as a rendering bug rather than a stripe. Flattening first makes the row
 * index the single source of truth for the shade.
 *
 * It also moves `open` out of the row and into the tree: per-row state would
 * be destroyed whenever the flattening changed a row's position.
 *
 * A side effect this drag task relies on: every row -- at any depth -- ends
 * up a DIRECT CHILD of the same container, not nested inside its parent
 * directory's own DOM node. A folder's droppable rect is therefore exactly
 * that one row, never its descendants' rows too, which is what makes "drop
 * onto a folder row" and "drop anywhere else falls through to the root
 * droppable wrapping the whole list" both true at once without either one
 * fighting the other for the pointer.
 */
function flatten(
  entries: AdfEntry[], openBlocks: ReadonlySet<number>, sort: BrowseSort, depth = 0, prefix = '',
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const entry of sortEntries(entries, sort)) {
    const open = entry.kind === 'dir' && openBlocks.has(entry.block);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    rows.push({ entry, depth, open, path });
    if (open && entry.kind === 'dir') {
      rows.push(...flatten(entry.children, openBlocks, sort, depth + 1, path));
    }
  }
  return rows;
}

/** Every block in the tree, so a selection can drop what a refresh took away. */
function allBlocks(entries: AdfEntry[], into = new Set<number>()): Set<number> {
  for (const e of entries) { into.add(e.block); allBlocks(e.children, into); }
  return into;
}

/**
 * What a draggable/droppable row declares about itself -- just the block
 * number, since that is all `PATCH /api/disks/[id]/files/[block]` needs,
 * whether read off `active` (the entry being moved) or `over` (its new
 * parent, `toParent`).
 */
interface FileDragData {
  block: number;
}

/**
 * Resolve a drop from the POINTER, not from the dragged row's rectangle.
 *
 * Copied from src/components/collections/collection-provider.tsx, which paid
 * for this: dnd-kit's default `rectIntersection` picks whichever droppable
 * the DRAGGED element overlaps most, and a card there was big enough to
 * overlap three or four rows at once, so drops routinely landed one row off
 * from where they were aimed. A file row is small and sits inside a deeply
 * nested tree -- the identical bug applies here, if anything more easily.
 *
 * `pointerWithin` requires the pointer to be inside the droppable, which is
 * how a person believes dragging works. The `rectIntersection` fallback
 * covers the one case `pointerWithin` returns nothing for -- no pointer
 * coordinates at all (a keyboard sensor, if one is ever added) -- and
 * silently resolving no collision at all would be worse.
 */
const fileTreeCollisionDetection: CollisionDetection = (args) =>
  (args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args));

/**
 * Depth-first search for the entry at `block` -- the same walk the route's
 * own `findEntry` (route.ts) does server-side, needed here too so a drag can
 * know the dragged entry's KIND and NAME without a round trip.
 */
function findEntryByBlock(entries: AdfEntry[], block: number): AdfEntry | null {
  for (const entry of entries) {
    if (entry.block === block) return entry;
    if (entry.kind === 'dir') {
      const found = findEntryByBlock(entry.children, block);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Every entry's block, mapped to the block it currently lives directly
 * under (the disk's root block for anything at the top level) -- `AdfEntry` itself
 * carries no parent pointer (it is a tree of children, not a flat list with
 * back-references), so this is the one walk that knows it.
 *
 * Fix round 1: `moveEntry` now treats a move to the entry's OWN current
 * parent as a no-op success rather than the misleading `name-exists` it
 * used to report, but offering that destination in the menu is still
 * noise -- it does nothing, so a person choosing it would reasonably
 * expect something to have happened. This map is what lets `moveOptions`
 * (below, on FileRow) drop it from the list rather than merely tolerate it.
 */
function buildParentMap(entries: AdfEntry[], parent: number, map: Map<number, number>): void {
  for (const entry of entries) {
    map.set(entry.block, parent);
    if (entry.kind === 'dir') buildParentMap(entry.children, entry.block, map);
  }
}

/**
 * Every block number in `entry`'s own subtree, itself included -- what a
 * dragged directory must forbid as a drop target. The server already refuses
 * this cycle correctly (`'a folder cannot be moved inside itself'`), but a
 * drop the interface visibly accepts and then rejects is worse than one it
 * never offered, so this is computed from the same tree already rendered and
 * fed to every folder's `useDroppable({ disabled })` below.
 */
function subtreeBlocks(entry: AdfEntry): Set<number> {
  const blocks = new Set<number>([entry.block]);
  if (entry.kind === 'dir') {
    for (const child of entry.children) {
      for (const block of subtreeBlocks(child)) blocks.add(block);
    }
  }
  return blocks;
}

/** One directory a "Move to…" control can offer, labelled by its full path so two directories that share a name at different depths are never offered as indistinguishable options. */
export interface DirectoryOption {
  block: number;
  label: string;
}

/**
 * Every directory in the tree, depth-first, labelled with its full path from
 * the root -- the keyboard equivalent of the drag targets a directory row
 * already accepts. The root itself is not an `AdfEntry` (it has no block of
 * its own to walk into here), so callers prepend it -- see `directoryOptions`
 * below.
 *
 * EXPORTED so `DropStaging`'s destination selector (drop-staging.tsx) can
 * reuse the identical list rather than a second directory-collecting walk
 * that could quietly disagree with this one about what counts as a
 * directory or how it's labelled.
 */
export function collectDirectories(entries: AdfEntry[], parentPath = ''): DirectoryOption[] {
  const dirs: DirectoryOption[] = [];
  for (const entry of sortEntries(entries)) {
    if (entry.kind !== 'dir') continue;
    const path = `${parentPath}/${entry.name}`;
    dirs.push({ block: entry.block, label: path });
    dirs.push(...collectDirectories(entry.children, path));
  }
  return dirs;
}

/** Reserved on the left of every row for the drag handle, so the handle can be absolutely positioned in that gutter without disturbing any of the existing `pl-[22px]` alignment the metadata/action lines below the name already depend on. */

/** Room for the selection checkbox (A5), left of the grip, when rows are selectable. */


export function FileTree({
  entries, diskId, toolbar, send = null, sort: initialSort = DEFAULT_PREFS.browse.sort,
  hideInfo: initialHideInfo = DEFAULT_PREFS.browse.hideInfo, addedIn = {},
}: {
  entries: AdfEntry[]; diskId: string; send?: SendContext | null;
  /** The Add file / New folder controls, drawn in the Files card header. */
  toolbar: ReactNode;
  /** The person's remembered Browse sort (user prefs browse.sort), read by the page. */
  sort?: BrowseSort;
  /** The person's remembered "Hide .info files" (user prefs browse.hideInfo). */
  hideInfo?: boolean;
  /** Path -> the version that added it (disk-history/added-in.ts): the "new in vN" marks. */
  addedIn?: Record<string, number>;
}) {
  const [openBlocks, setOpenBlocks] = useState<ReadonlySet<number>>(() => new Set());
  // Sorted here in the browser (the whole tree is already on the page), so a
  // change shows at once; the save behind it only has to succeed for the NEXT
  // visit, and says so if it does not. Only the latest choice is saved
  // (latestSaver: arrow keys on the select fire a change per press), and a
  // refresh that brings a different server value is followed.
  const [saver] = useState(latestSaver);
  const [sort, setSort] = useState<BrowseSort>(initialSort);
  const [serverSort, setServerSort] = useState<BrowseSort>(initialSort);
  if (sortOptionId(initialSort) !== sortOptionId(serverSort)) {
    setServerSort(initialSort);
    setSort(initialSort);
  }
  function changeSort(next: BrowseSort) {
    setSort(next);
    saver.save({ browse: { sort: next } }).catch(() => {
      toast.error("Couldn't remember this sort order for next time.");
    });
  }
  const { disabled, busy, runEdit, rootBlock } = useFileEdit();
  const sender = useSendAction(send);

  // Name filter and "Hide .info files" (A5). The filter is for this visit
  // only; hiding .info is remembered like the sort.
  const [query, setQuery] = useState('');
  const [hideInfo, setHideInfo] = useState(initialHideInfo);
  // Its own saver: latestSaver keeps only the newest pending patch, so sharing
  // the sort's would let this cancel a sort save still waiting to go.
  const [infoSaver] = useState(latestSaver);
  function changeHideInfo(next: boolean) {
    setHideInfo(next);
    infoSaver.save({ browse: { hideInfo: next } }).catch(() => {
      toast.error("Couldn't remember that for next time.");
    });
  }
  const filtered = useMemo(() => filterTree(entries, { query, hideInfo }), [entries, query, hideInfo]);
  const companions = useMemo(() => infoCompanions(entries), [entries]);
  const shownBlocks = useMemo(() => allBlocks(filtered.entries), [filtered]);

  // Multi-select (A5). A refresh after an edit renumbers nothing it did not
  // touch, but drops what it removed -- and a later add may reuse a freed
  // block -- so the selection is pruned to the blocks still on the disk each
  // time the tree changes. Anything inside a selected folder goes with it.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [selectedFor, setSelectedFor] = useState(entries);
  if (selectedFor !== entries) {
    setSelectedFor(entries);
    const present = allBlocks(entries);
    setSelected((prev) => new Set([...prev].filter((b) => present.has(b))));
  }
  const live = selected;
  const selectionTops = useMemo(
    () => [...live].filter((b) => !underSelected(entries, b, live))
      .map((b) => findEntryByBlock(entries, b)).filter((e): e is AdfEntry => e !== null),
    [entries, live],
  );
  function toggleSelected(block: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(block)) next.add(block);
      return next;
    });
  }
  const selectable = disabled?.reason !== 'historical';

  // OS file drops onto a folder row (or the tree itself, meaning the root)
  // go to the staging area with that folder as the destination. Even when
  // editing is disabled the drop is CLAIMED -- an unclaimed file drop makes
  // the browser open the file -- and the staging receiver says why nothing
  // was staged.
  const nativeDrop = useNativeDrop();
  const [nativeOver, setNativeOver] = useState<number | null>(null);
  function nativeDropProps(block: number): NativeDropProps | undefined {
    if (!nativeDrop) return undefined;
    return {
      onDragOver: (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        try { e.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; } catch { /* read-only in some engines */ }
        if (nativeOver !== block) setNativeOver(block);
      },
      onDragLeave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setNativeOver((prev) => (prev === block ? null : prev));
      },
      onDrop: (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setNativeOver(null);
        nativeDrop.receive(e.dataTransfer.items, block);
      },
    };
  }

  // Which single row, if any, has its rename or delete form expanded. Kept
  // here rather than per-row, and mutually exclusive with each other: at
  // most one row is ever mid-edit, which keeps the inline layout simple
  // without losing anything a person would actually want to do at once.
  const [renameBlock, setRenameBlock] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteBlock, setDeleteBlock] = useState<number | null>(null);
  // Third member of the same mutually-exclusive trio: opening "Move to…" on
  // one row closes any rename/delete form open on another (or the same)
  // row, and starting a rename or delete closes this one right back --
  // see startRename/startDelete below.
  const [moveBlock, setMoveBlock] = useState<number | null>(null);
  const [moveTarget, setMoveTarget] = useState<number | ''>('');
  // Fourth of the same set: the row whose protection editor is open.
  const [protectBlock, setProtectBlock] = useState<number | null>(null);

  // The block of whichever row is currently being dragged, or null. Tracked
  // here (not per-row) because deciding whether a GIVEN folder may accept
  // THIS drop needs to know what is being dragged in the first place.
  const [activeBlock, setActiveBlock] = useState<number | null>(null);

  function toggle(block: number) {
    setOpenBlocks((prev) => {
      const next = new Set(prev);
      if (!next.delete(block)) next.add(block);
      return next;
    });
  }

  function startRename(entry: AdfEntry) {
    setDeleteBlock(null);
    setMoveBlock(null);
    setProtectBlock(null);
    setRenameBlock(entry.block);
    setRenameValue(entry.name.slice(0, MAX_NAME_LENGTH));
  }

  // Every Cancel, Escape and submit hands focus back to the row's ⋯ (never to <body>).
  function focusMore(block: number | null) {
    if (block === null) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="fs-more-${block}"]`)?.focus());
  }

  function cancelRename() {
    focusMore(renameBlock);
    setRenameBlock(null);
    setRenameValue('');
  }

  function submitRename(block: number) {
    const name = renameValue.trim();
    if (!name) return;
    runEdit(() => fetch(`/api/disks/${diskId}/files/${block}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }), `Renamed to "${name}"`);
    cancelRename();
  }

  function startDelete(entry: AdfEntry) {
    setRenameBlock(null);
    setMoveBlock(null);
    setProtectBlock(null);
    setDeleteBlock(entry.block);
  }

  function cancelDelete() {
    focusMore(deleteBlock);
    setDeleteBlock(null);
  }

  function closeProtect() {
    focusMore(protectBlock);
    setProtectBlock(null);
  }

  // The confirm is unmounted at once, so focus moves to the ⋯ first; once the row is gone it lands on the heading.
  function submitDelete(block: number) {
    document.querySelector<HTMLElement>(`[data-testid="fs-more-${block}"]`)?.focus();
    runEdit(
      () => fetch(`/api/disks/${diskId}/files/${block}`, { method: 'DELETE' }),
      'Deleted',
      () => document.getElementById('files-heading')?.focus(),
    );
    setDeleteBlock(null);
  }

  function startProtect(entry: AdfEntry) {
    setRenameBlock(null);
    setDeleteBlock(null);
    setMoveBlock(null);
    setProtectBlock(entry.block);
  }

  function startMove(entry: AdfEntry) {
    setRenameBlock(null);
    setDeleteBlock(null);
    setProtectBlock(null);
    setMoveBlock(entry.block);
    setMoveTarget('');
  }

  function cancelMove() {
    focusMore(moveBlock);
    setMoveBlock(null);
    setMoveTarget('');
  }

  /**
   * The keyboard equivalent of `onDragEnd` below -- same route, same body
   * shape, same success toast wording, so the cycle refusal and the 409
   * naming a mounted device read identically whichever way the move was
   * started. `moveTarget` is only ever a block a directory row actually
   * offered (`directoryOptions` below already excludes the entry's own
   * subtree), so there is nothing left to validate here beyond "something
   * was chosen".
   */
  function submitMove(block: number) {
    if (moveTarget === '') return;
    const toParent = moveTarget;
    const movedEntry = findEntryByBlock(entries, block);
    const name = movedEntry?.name ?? 'item';
    runEdit(() => fetch(`/api/disks/${diskId}/files/${block}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toParent }),
    }), `Moved "${name}"`, () => document.getElementById('files-heading')?.focus());
    cancelMove();
  }

  /**
   * A folder can never accept a drop of itself or of anything already inside
   * it -- see `subtreeBlocks` above. Empty whenever nothing is being
   * dragged, or the thing being dragged is a file (a file has no subtree to
   * forbid anything else from entering).
   */
  const forbiddenBlocks = useMemo(() => {
    if (activeBlock === null) return new Set<number>();
    const active = findEntryByBlock(entries, activeBlock);
    if (!active || active.kind !== 'dir') return new Set<number>();
    return subtreeBlocks(active);
  }, [entries, activeBlock]);

  /**
   * Every "Move to…" destination this disk has, root included -- computed
   * once from the tree (not from drag state, unlike `forbiddenBlocks` above:
   * this list backs a menu that can be open independently of any drag).
   * Each row filters its OWN forbidden subtree out of this shared list
   * rather than this being recomputed per row, since the list itself never
   * differs between rows -- only what a given row must exclude from it does.
   */
  const directoryOptions = useMemo<DirectoryOption[]>(
    () => [{ block: rootBlock, label: '/' }, ...collectDirectories(entries)],
    [entries, rootBlock],
  );

  // Each row's own current parent block, so it can drop that one entry back
  // out of the shared `directoryOptions` list -- see `buildParentMap`.
  // `moveEntry` no longer ERRORS on this destination (fix round 1), but
  // offering a choice that changes nothing is still misleading noise.
  const parentBlocks = useMemo(() => {
    const map = new Map<number, number>();
    buildParentMap(entries, rootBlock, map);
    return map;
  }, [entries, rootBlock]);

  /**
   * Mouse and touch are two sensors, not one PointerSensor -- copied
   * verbatim from collection-provider.tsx, whose comment explains why in
   * full: PointerSensor cannot be kept alongside TouchSensor (one finger
   * would activate both), the 8px mouse threshold is what keeps ordinary
   * clicks on the toggle/Download/Rename/Delete controls from being eaten,
   * and the touch delay is what stops a drag eating page scrolling on a
   * phone -- `tolerance` is the movement budget during that hold, and
   * exceeding it lets the gesture stay a scroll instead.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  function onDragStart(event: DragStartEvent) {
    const data = event.active.data.current as FileDragData | undefined;
    setActiveBlock(data?.block ?? null);
  }

  function onDragCancel() {
    setActiveBlock(null);
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveBlock(null);

    const { active, over } = event;
    if (!over) return; // dropped outside any droppable -- nothing to do

    const activeData = active.data.current as FileDragData | undefined;
    const overData = over.data.current as FileDragData | undefined;
    if (!activeData || !overData) return;
    if (activeData.block === overData.block) return; // dropped on itself

    const movedEntry = findEntryByBlock(entries, activeData.block);
    const name = movedEntry?.name ?? 'item';
    runEdit(() => fetch(`/api/disks/${diskId}/files/${activeData.block}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toParent: overData.block }),
    }), `Moved "${name}"`);
  }

  // The disk's root directory -- the one drop target that isn't any single
  // row, so it is registered on the container that wraps every row instead.
  // Reuses the container's existing `file-tree` testid rather than inventing
  // a new one: there is exactly one of these per page, so it was already a
  // stable, unique locator.
  const { setNodeRef: setRootDropRef, isOver: rootIsOver } = useDroppable({
    id: rootBlock,
    data: { block: rootBlock } satisfies FileDragData,
    disabled: !!disabled,
  });

  // While a filter is typed, the folders leading to a match are open as well
  // as whatever the person opened themselves.
  const shownOpen = query.trim() ? new Set([...openBlocks, ...filtered.open]) : openBlocks;
  const rows = flatten(filtered.entries, shownOpen, sort);
  const shownDirs = rows.filter((r) => r.entry.kind === 'dir').length;
  const hiddenInfo = hideInfo ? countInfo(entries) : 0;   // every *.info in the whole tree

  const controls = (
    <>
      <label className="flex h-9 flex-1 items-center gap-2 rounded-[9px] px-2.5 focus-within:outline-2 focus-within:outline-(--ring) sm:w-[220px] sm:flex-none"
             style={{ background: 'var(--surface-2)', boxShadow: 'inset 0 0 0 1px var(--line)' }}>
        <Search size={14} aria-hidden style={{ color: 'var(--muted-2)' }} className="shrink-0" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          placeholder="Filter by name"
          aria-label="Filter files by name"
          data-testid="fs-filter"
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-[var(--muted-2)]"
          style={{ color: 'var(--ink)' }}
        />
      </label>
      <button type="button" role="switch" aria-checked={hideInfo} onClick={() => changeHideInfo(!hideInfo)}
              data-testid="fs-hide-info"
              className="flex h-9 items-center gap-2 rounded-[9px] px-2.5 text-[13px] font-medium hover:bg-[var(--track)] focus-visible:outline-2 focus-visible:outline-(--ring)"
              style={{ color: 'var(--muted)' }}>
        <span aria-hidden className={`flex h-4 w-7 shrink-0 rounded-full p-0.5 ${hideInfo ? 'justify-end' : 'justify-start'}`}
              style={hideInfo ? { background: 'var(--ink)' } : { background: 'var(--line-strong)', boxShadow: 'inset 0 0 0 1px var(--muted-2)' }}>
          <span className="h-3 w-3 rounded-full" style={{ background: 'var(--surface)', boxShadow: '0 1px 2px rgb(0 0 0 / 0.25)' }} />
        </span>
        Hide .info files
      </button>
      <SortSelect options={BROWSE_SORT_OPTIONS} value={sort} onChange={changeSort} testId="browse-sort" toolbar />
    </>
  );

  return (
    // `id` is not decoration. dnd-kit derives the hidden drag description's
    // element id from a MODULE-LEVEL counter when none is given, and that
    // counter is shared with collection-provider.tsx's own DndContext on
    // other pages -- a server render and a fresh client load would not
    // agree on where that counter starts, so React would report a hydration
    // mismatch on every /disks/[id]/files load. A fixed id is the same on
    // both sides. (Same reasoning as collection-provider.tsx; a different
    // literal so the two contexts' descriptions never collide either.)
    <DndContext
      id="disk-files-dnd"
      sensors={sensors}
      collisionDetection={fileTreeCollisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <FilesCard controls={controls} toolbar={toolbar}>
        {selectionTops.length > 0 && (
          <SelectionBar diskId={diskId} tops={selectionTops} directoryOptions={directoryOptions}
                        hidden={selectionTops.filter((e) => !shownBlocks.has(e.block)).length}
                        onClear={() => setSelected(new Set())} />
        )}
        {entries.length > 0 && (
          <div aria-hidden data-testid="fs-columns"
               className="hidden h-9 items-center gap-3 border-b px-4 text-[12px] font-medium md:grid md:grid-cols-[28px_28px_minmax(0,1fr)_96px_132px_104px_36px]"
               style={{ borderColor: 'var(--line)', background: 'var(--modal-foot)', color: 'var(--muted-2)' }}>
            <span /><span /><span>Name</span><span className="text-right">Size</span><span>Protection</span><span>Modified</span><span />
          </div>
        )}
      <div
        role={rows.length > 0 ? 'list' : undefined}
        ref={setRootDropRef}
        className="md:max-h-[700px] md:overflow-y-auto"
        style={{ boxShadow: nativeOver === rootBlock ? 'inset 0 0 0 2px var(--accent-amber)' : undefined }}
        data-testid="file-tree"
        data-drop-target={rootIsOver || nativeOver === rootBlock ? 'true' : undefined}
        {...nativeDropProps(rootBlock)}
      >
        {entries.length === 0 && (
          <div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
            <DiskIcon color="cream" size={48} />
            <span className="text-[14px]" style={{ color: 'var(--muted)' }}>This disk&apos;s root directory is empty.</span>
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
              {disabled ? `Editing is off: ${disabled.message}` : 'Drop files on the bar below, or press Add file.'}
            </span>
          </div>
        )}
        {entries.length > 0 && rows.length === 0 && (
          <p className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }} data-testid="fs-filter-empty">
            {query.trim() ? `No files match "${query.trim()}".` : 'Every file here is a .info icon file.'}
          </p>
        )}
        {rows.map(({ entry, depth, open, path }) => (
          <FileRow
            key={entry.block}
            entry={entry}
            depth={depth}
            open={open}
            hasInfo={hideInfo && companions.has(entry.block)}
            editDisabled={disabled}
            busy={busy}
            renameBlock={renameBlock}
            renameValue={renameValue}
            deleteBlock={deleteBlock}
            moveBlock={moveBlock}
            moveTarget={moveTarget}
            directoryOptions={directoryOptions}
            currentParent={parentBlocks.get(entry.block) ?? rootBlock}
            forbiddenBlocks={forbiddenBlocks}
            diskId={diskId}
            canSend={sender !== null}
            sendBusy={sender?.busy ?? false}
            onSend={(e) => void sender?.send({ diskId, blocks: [e.block] }, e.kind === 'dir' ? `${e.name}/` : e.name)}
            toggle={toggle}
            startRename={startRename}
            cancelRename={cancelRename}
            submitRename={submitRename}
            setRenameValue={setRenameValue}
            startDelete={startDelete}
            cancelDelete={cancelDelete}
            submitDelete={submitDelete}
            startMove={startMove}
            cancelMove={cancelMove}
            submitMove={submitMove}
            setMoveTarget={setMoveTarget}
            // A folder takes a drop into itself; a file row means "next to
            // this file", i.e. into the folder it is in.
            nativeDrop={nativeDropProps(entry.kind === 'dir' ? entry.block : (parentBlocks.get(entry.block) ?? rootBlock))}
            nativeOver={nativeOver === entry.block}
            selectable={selectable}
            selected={live.has(entry.block)}
            onSelect={toggleSelected}
            addedInSeq={addedIn[path] ?? null}
            protectOpen={protectBlock === entry.block}
            startProtect={startProtect}
            closeProtect={closeProtect}
          />
        ))}
      </div>
      {entries.length > 0 && (
        <div className="border-t px-4 py-3 text-[12px]" data-testid="fs-footer"
             style={{ borderColor: 'var(--line)', background: 'var(--modal-foot)', color: 'var(--muted-2)' }}>
          {plural(shownDirs, 'folder')} · {plural(rows.length - shownDirs, 'file')} shown{hiddenInfo > 0 ? ` · ${plural(hiddenInfo, '.info file')} hidden` : ''}
        </div>
      )}
      </FilesCard>
    </DndContext>
  );
}

interface FileRowProps {
  entry: AdfEntry;
  depth: number;
  open: boolean;
  /** Hide .info is on and `<name>.info` sits beside this entry: the `.info` badge. */
  hasInfo: boolean;
  editDisabled: EditDisabled | null;
  busy: boolean;
  renameBlock: number | null;
  renameValue: string;
  deleteBlock: number | null;
  /** The block whose "Move to…" form is expanded, or null. Mutually exclusive with `renameBlock`/`deleteBlock` -- see FileTree's startMove/startRename/startDelete. */
  moveBlock: number | null;
  /** The directory chosen so far in the open "Move to…" form -- `''` until something is picked, mirroring the `<select>`'s own empty-option value. */
  moveTarget: number | '';
  /** Every destination a "Move to…" menu can offer, root included -- see FileTree's `directoryOptions`. Each row filters its own forbidden subtree out of this shared list rather than this being recomputed per row. */
  directoryOptions: DirectoryOption[];
  /** The block this entry currently lives directly under -- see FileTree's `parentBlocks`. Dropped from this row's own `moveOptions`: `moveEntry` treats it as a no-op success (fix round 1), not an error, but offering a destination that changes nothing is still noise. */
  currentParent: number;
  /** Blocks this row must refuse as a drop target for the CURRENT drag -- see `subtreeBlocks` on FileTree. Only ever non-empty while a directory is being dragged. */
  forbiddenBlocks: ReadonlySet<number>;
  diskId: string;
  /** A board can take files (useSendAction): draw Send on this row (spec §4; R3). */
  canSend: boolean;
  sendBusy: boolean;
  onSend: (entry: AdfEntry) => void;
  toggle: (block: number) => void;
  startRename: (entry: AdfEntry) => void;
  cancelRename: () => void;
  submitRename: (block: number) => void;
  setRenameValue: (value: string) => void;
  startDelete: (entry: AdfEntry) => void;
  cancelDelete: () => void;
  submitDelete: (block: number) => void;
  startMove: (entry: AdfEntry) => void;
  cancelMove: () => void;
  submitMove: (block: number) => void;
  setMoveTarget: (value: number | '') => void;
  /** OS file-drop handlers for this row (see FileTree's nativeDropProps). */
  nativeDrop?: NativeDropProps;
  /** An OS file drag is over this folder right now. */
  nativeOver: boolean;
  /** Multi-select (A5): off while browsing an older version. */
  selectable: boolean;
  selected: boolean;
  onSelect: (block: number) => void;
  /** The version that added this entry, for its "new in vN" mark; null for none. */
  addedInSeq: number | null;
  protectOpen: boolean;
  startProtect: (entry: AdfEntry) => void;
  closeProtect: () => void;
}

function FileRow({
  entry, depth, open, hasInfo, editDisabled, busy,
  renameBlock, renameValue, deleteBlock, moveBlock, moveTarget, directoryOptions, currentParent,
  forbiddenBlocks, diskId, canSend, sendBusy, onSend,
  toggle, startRename, cancelRename, submitRename, setRenameValue,
  startDelete, cancelDelete, submitDelete,
  startMove, cancelMove, submitMove, setMoveTarget, nativeDrop, nativeOver,
  selectable, selected, onSelect, addedInSeq, protectOpen, startProtect, closeProtect,
}: FileRowProps) {
  const isDir = entry.kind === 'dir';

  // The "Move to…" menu's own options -- this row's exclusion of
  // `directoryOptions`, computed the same way `forbiddenBlocks` is computed
  // for the drag (same `subtreeBlocks` helper, same rule): a directory can
  // never be offered as a destination for itself or anything already inside
  // it. A file has no subtree to forbid anything from, so it gets the full
  // list untouched. This is the one rule Task 9's drag and this task's
  // keyboard control share on purpose -- see the module comment on
  // `subtreeBlocks`.
  //
  // `currentParent` is filtered out on top of that: `moveEntry` now treats
  // moving into the entry's own current location as a no-op SUCCESS (fix
  // round 1) rather than the `name-exists` it used to misreport, but a
  // destination that changes nothing is still not worth offering -- the
  // person would reasonably expect choosing something to do something.
  const moveOptions = useMemo(() => {
    const forbidden = isDir ? subtreeBlocks(entry) : new Set<number>();
    return directoryOptions.filter(
      (option) => !forbidden.has(option.block) && option.block !== currentParent,
    );
  }, [directoryOptions, entry, isDir, currentParent]);

  // Every row is draggable, but the grip handle below is the ONLY
  // activator -- `attributes`/`listeners` are never spread on the row
  // itself. Copied from collection-rail.tsx's own CollectionRow, whose
  // comment states why: this row also hosts the directory toggle, Download,
  // Rename and Delete, and none of those should have to survive an
  // 8px-pointer-move-then-release to still register as a click.
  const {
    attributes, listeners, setNodeRef: setDragRef, transform, isDragging,
  } = useDraggable({
    id: entry.block,
    data: { block: entry.block } satisfies FileDragData,
    disabled: !!editDisabled || busy,
  });

  // Only a directory can receive a drop -- `disabled` is unconditionally
  // true for a file -- and never one that is itself or already inside the
  // thing being dragged (`forbiddenBlocks`, computed once on FileTree from
  // the same tree this row is part of).
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: entry.block,
    data: { block: entry.block } satisfies FileDragData,
    disabled: !isDir || !!editDisabled || forbiddenBlocks.has(entry.block),
  });

  // "New in vN" (A5): this entry was not on the disk as uploaded.
  const newMark = addedInSeq !== null && (
    <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold"
          style={{ background: 'var(--success-bg)', color: 'var(--success-fg)' }}
          title={`Added in version ${addedInSeq} — see History`}
          data-testid={`fs-new-${entry.block}`}>
      new in v{addedInSeq}
    </span>
  );

  const glyph = entryGlyph(entry);
  const chips = protectionChips(entry.protection).map((c) => (
    <span key={c.letter} title={c.label} className="grid h-[18px] w-[14px] place-items-center rounded-[4px]"
          style={c.on ? { background: 'var(--track)', color: 'var(--ink)' } : { color: 'var(--muted-2)' }}>
      {c.on ? c.letter : '-'}
    </span>
  ));
  const glyphChip = (
    <span aria-hidden data-testid={`fs-glyph-${entry.block}`}
          className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px] font-mono text-[9px] font-bold"
          style={{ background: glyph.bg, color: glyph.fg }}>{glyph.label}</span>
  );
  const nameBits = (
    <>
      {glyphChip}
      <span className={`text-[14px] [overflow-wrap:anywhere] ${isDir ? 'font-semibold' : ''}`} style={{ color: 'var(--ink)' }}>{entry.name}</span>
      {hasInfo && (
        <span className="shrink-0 rounded-[5px] px-1.5 font-mono text-[10px] font-semibold"
              style={{ background: 'var(--track)', color: 'var(--muted-2)' }}
              data-testid={`fs-info-${entry.block}`}>.info</span>
      )}
      {newMark}
    </>
  );

  // The inline forms (A5's, opened from the ⋯ menu): one at a time, a full-width line under the row.
  const field = 'h-[30px] rounded-[8px] border px-2.5 text-[13px]';
  const fieldStyle = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;
  const btn = 'h-[30px] rounded-[8px] px-3 text-[13px] font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--ring)';
  const primary = { background: 'var(--ink)', color: 'var(--surface)' } as const;
  const outline = { border: '1px solid var(--line)', color: 'var(--ink)' } as const;
  const formOpen = protectOpen || renameBlock === entry.block || deleteBlock === entry.block || moveBlock === entry.block;
  function cancelForm() {
    if (protectOpen) closeProtect();
    else if (renameBlock === entry.block) cancelRename();
    else if (deleteBlock === entry.block) cancelDelete();
    else if (moveBlock === entry.block) cancelMove();
  }

  const row = (
    <div
      ref={setDragRef}
      role={isDir ? undefined : 'listitem'}
      data-testid="fs-entry"
      data-name={entry.name}
      data-selected={selected || undefined}
      // From md one line on the board's grid; below it a two-line card (select, grip and ⋯ span both lines).
      className="grid grid-cols-[28px_32px_minmax(0,1fr)_44px] items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-[13px] hover:bg-[var(--surface-2)] data-[selected=true]:bg-[var(--surface-2)] md:min-h-[40px] md:grid-cols-[28px_28px_minmax(0,1fr)_96px_132px_104px_36px] md:gap-x-3 md:py-1"
      style={{ borderColor: 'var(--hairline)', transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.5 : 1 }}
      {...(isDir ? {} : nativeDrop)}
    >
      <span className="row-span-2 grid place-items-center md:row-span-1">
        {selectable && (
          <input type="checkbox" checked={selected} onChange={() => onSelect(entry.block)}
                 aria-label={`Select ${entry.name}`} data-testid={`fs-select-${entry.block}`}
                 className="h-4 w-4" style={{ accentColor: 'var(--ink)' }} />
        )}
      </span>
      {/* The grip is the ONLY drag activator (`attributes`/`listeners` are never spread on the row): the row hosts
          the folder toggle and the ⋯ menu, and none of those should have to survive an 8px move to register as a
          click. `touchAction: none` keeps the first post-hold touchmove cancelable (collection-rail.tsx's grip). */}
      <button type="button" aria-label={`Move ${entry.name}`} disabled={!!editDisabled || busy} title={editDisabled?.message}
              data-testid={`fs-drag-${entry.block}`} {...attributes} {...listeners}
              style={{ touchAction: 'none', color: 'var(--muted-2)' }}
              className="row-span-2 grid h-11 w-8 cursor-grab place-items-center rounded-[6px] active:cursor-grabbing disabled:cursor-default disabled:opacity-40 md:row-span-1 md:h-8 md:w-7">
        <GripVertical size={14} aria-hidden />
      </button>
      {isDir ? (
        // A stable testid of its own: a row holds more than one <button>, so a test choosing "the button" by role
        // alone would be ambiguous (e2e moved onto fs-toggle-* for exactly that reason).
        <button type="button" onClick={() => toggle(entry.block)} data-testid={`fs-toggle-${entry.block}`}
                aria-expanded={open}
                className="col-start-3 flex min-w-0 items-center gap-2 rounded-[6px] text-left focus-visible:outline-2 focus-visible:outline-(--ring)"
                style={{ paddingLeft: `${depth * 18}px` }}>
          <span aria-hidden className="inline-block w-3 shrink-0 transition-transform duration-150"
                style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none' }}>▸</span>
          {nameBits}
        </button>
      ) : (
        <span className="col-start-3 flex min-w-0 items-center gap-2" style={{ paddingLeft: `${depth * 18}px` }}>
          <span aria-hidden className="inline-block w-3 shrink-0" />
          {nameBits}
        </span>
      )}
      <div className="col-start-3 row-start-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] md:contents">
        <span className="md:text-right" style={{ color: isDir ? 'var(--muted-2)' : 'var(--muted)' }}>
          {isDir ? '—' : `${entry.sizeBytes.toLocaleString()} B`}
        </span>
        {editDisabled ? (
          <span className="flex gap-0.5 text-[11px] font-semibold" data-testid={`fs-protect-${entry.block}`}>{chips}</span>
        ) : (
          <button type="button" onClick={() => startProtect(entry)} title="Change protection bits"
                  aria-label={`Protection of ${entry.name}: ${entry.protection}. Change`} data-testid={`fs-protect-${entry.block}`}
                  className="flex w-fit gap-0.5 rounded-[4px] text-[11px] font-semibold hover:outline hover:outline-1 hover:outline-(--line-strong) focus-visible:outline-2 focus-visible:outline-(--ring)">
            {chips}
          </button>
        )}
        <span style={{ color: 'var(--muted)' }}>{entry.modifiedAt ? entry.modifiedAt.toISOString().slice(0, 10) : '—'}</span>
      </div>
      <span className="col-start-4 row-span-2 row-start-1 grid place-items-center md:col-start-auto md:row-span-1 md:row-start-auto">
        <FileRowMenu entry={entry} diskId={diskId} editDisabled={editDisabled} canSend={canSend} sendBusy={sendBusy}
                     onSend={() => onSend(entry)} onRename={() => startRename(entry)} onMove={() => startMove(entry)}
                     onProtect={() => startProtect(entry)} onDelete={() => startDelete(entry)} />
      </span>

      {formOpen && (
        // INLINE expansion, not an overlay: opening one grows this row in normal flow, so nothing can cover a sibling
        // row's controls. Escape on any field or button cancels and hands focus back to the row's ⋯.
        <div className="col-span-full flex flex-wrap items-center gap-2 py-2" style={{ paddingLeft: `${depth * 18 + 68}px` }}
             onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelForm(); } }}>
          {protectOpen ? (
            <ProtectionEditor diskId={diskId} entry={entry} onClose={closeProtect} autoFocusFirst />
          ) : renameBlock === entry.block ? (
            <>
              <input value={renameValue} onChange={(e) => setRenameValue(e.target.value.slice(0, MAX_NAME_LENGTH))}
                     maxLength={MAX_NAME_LENGTH} aria-label={`New name for ${entry.name}`}
                     data-testid={`fs-rename-name-${entry.block}`} autoFocus
                     onKeyDown={(e) => { if (e.key === 'Enter') submitRename(entry.block); }}
                     className={`${field} min-w-0 w-[220px] max-w-full`} style={fieldStyle} />
              <button type="button" onClick={() => submitRename(entry.block)} disabled={busy || !renameValue.trim()}
                      data-testid={`fs-rename-submit-${entry.block}`} className={btn} style={primary}>Save</button>
              <button type="button" onClick={cancelRename} disabled={busy}
                      data-testid={`fs-rename-cancel-${entry.block}`} className={btn} style={outline}>Cancel</button>
            </>
          ) : deleteBlock === entry.block ? (
            <>
              <span className="text-[13px]" style={{ color: 'var(--muted)' }}>
                Delete &quot;{entry.name}&quot;{isDir ? ' and everything inside it' : ''}? This cannot be undone.
              </span>
              <button type="button" onClick={() => submitDelete(entry.block)} disabled={busy}
                      data-testid={`fs-delete-confirm-${entry.block}`} className={btn}
                      style={{ background: 'var(--danger-fg)', color: 'white' }}>Delete</button>
              <button type="button" onClick={cancelDelete} disabled={busy} autoFocus
                      data-testid={`fs-delete-cancel-${entry.block}`} className={btn} style={outline}>Cancel</button>
            </>
          ) : (
            // The keyboard path onto the exact PATCH a drop issues (D-DD-7): `moveOptions` has already dropped the
            // entry's own subtree and current parent, so a refusal is surfaced by omission rather than as a 409.
            <>
              <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value === '' ? '' : Number(e.target.value))}
                      aria-label={`Move ${entry.name} to`} data-testid={`fs-move-target-${entry.block}`} autoFocus
                      className={`${field} min-w-0 max-w-full`} style={fieldStyle}>
                <option value="">Choose a location…</option>
                {moveOptions.map((option) => (
                  <option key={option.block} value={option.block}>{option.label}</option>
                ))}
              </select>
              <button type="button" onClick={() => submitMove(entry.block)} disabled={busy || moveTarget === ''}
                      data-testid={`fs-move-submit-${entry.block}`} className={btn} style={primary}>Move</button>
              <button type="button" onClick={cancelMove} disabled={busy}
                      data-testid={`fs-move-cancel-${entry.block}`} className={btn} style={outline}>Cancel</button>
            </>
          )}
        </div>
      )}
    </div>
  );

  if (!isDir) return row;

  // The droppable wrapper is a separate node from the row it wraps (rather
  // than merging both refs onto one element) purely so this drop target
  // gets its own stable testid without disturbing `fs-entry`, which
  // e2e/adf-browser.spec.ts and e2e/mobile.spec.ts already select generically
  // across every row. No layout rules of its own -- it is exactly the size
  // of the row it wraps -- so it changes nothing about how the row looks.
  return (
    <div
      ref={setDropRef}
      data-testid={`fs-drop-${entry.block}`}
      data-drop-target={isOver || nativeOver ? 'true' : undefined}
      {...nativeDrop}
      style={{
        borderRadius: '6px',
        // Geometry never changes -- no padding or size shift -- because
        // moving a drop target out from under the cursor mid-drag is how you
        // make a drop land somewhere the person did not aim (same rule
        // collection-rail.tsx's own drop highlight follows).
        boxShadow: isOver || nativeOver ? 'inset 0 0 0 2px var(--accent-amber)' : undefined,
      }}
    >
      {row}
    </div>
  );
}
