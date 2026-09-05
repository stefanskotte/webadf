'use client';

import { useMemo, useState } from 'react';
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
import { GripVertical } from 'lucide-react';
import type { AdfEntry } from '@/lib/adffs';
import { ROOT_BLOCK } from '@/lib/adffs/constants';
import { useFileEdit, MAX_NAME_LENGTH, type EditDisabled } from './file-actions';

/**
 * Directories first, then case-insensitive name order.
 *
 * AmigaDOS stores entries by hash chain, not alphabetically -- a raw listing
 * looks shuffled -- so every level of the tree is re-sorted before it is
 * rendered, not just the root.
 */
function sortEntries(entries: AdfEntry[]): AdfEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

interface VisibleRow {
  entry: AdfEntry;
  depth: number;
  open: boolean;
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
function flatten(entries: AdfEntry[], openBlocks: Set<number>, depth = 0): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const entry of sortEntries(entries)) {
    const open = entry.kind === 'dir' && openBlocks.has(entry.block);
    rows.push({ entry, depth, open });
    if (open && entry.kind === 'dir') {
      rows.push(...flatten(entry.children, openBlocks, depth + 1));
    }
  }
  return rows;
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

/** Reserved on the left of every row for the drag handle, so the handle can be absolutely positioned in that gutter without disturbing any of the existing `pl-[22px]` alignment the metadata/action lines below the name already depend on. */
const GRIP_GUTTER = 22;

export function FileTree({ entries, diskId }: { entries: AdfEntry[]; diskId: string }) {
  const [openBlocks, setOpenBlocks] = useState<ReadonlySet<number>>(() => new Set());
  const { disabled, busy, runEdit } = useFileEdit();

  // Which single row, if any, has its rename or delete form expanded. Kept
  // here rather than per-row, and mutually exclusive with each other: at
  // most one row is ever mid-edit, which keeps the inline layout simple
  // without losing anything a person would actually want to do at once.
  const [renameBlock, setRenameBlock] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteBlock, setDeleteBlock] = useState<number | null>(null);

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
    setRenameBlock(entry.block);
    setRenameValue(entry.name.slice(0, MAX_NAME_LENGTH));
  }

  function cancelRename() {
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
    setDeleteBlock(entry.block);
  }

  function cancelDelete() {
    setDeleteBlock(null);
  }

  function submitDelete(block: number) {
    runEdit(
      () => fetch(`/api/disks/${diskId}/files/${block}`, { method: 'DELETE' }),
      'Deleted',
    );
    cancelDelete();
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
    id: ROOT_BLOCK,
    data: { block: ROOT_BLOCK } satisfies FileDragData,
    disabled: !!disabled,
  });

  if (entries.length === 0) {
    return (
      <DndContext
        id="disk-files-dnd"
        sensors={sensors}
        collisionDetection={fileTreeCollisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div
          ref={setRootDropRef}
          className="glass-card p-5 text-[13px]"
          style={{ color: 'var(--muted)' }}
          data-testid="file-tree"
          data-drop-target={rootIsOver ? 'true' : undefined}
        >
          This disk&apos;s root directory is empty.
        </div>
      </DndContext>
    );
  }

  const rows = flatten(entries, openBlocks as Set<number>);

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
      <div
        ref={setRootDropRef}
        className="glass-card overflow-hidden p-3"
        data-testid="file-tree"
        data-drop-target={rootIsOver ? 'true' : undefined}
      >
        {rows.map(({ entry, depth, open }, i) => (
          <FileRow
            key={entry.block}
            entry={entry}
            depth={depth}
            open={open}
            striped={i % 2 === 1}
            editDisabled={disabled}
            busy={busy}
            renameBlock={renameBlock}
            renameValue={renameValue}
            deleteBlock={deleteBlock}
            forbiddenBlocks={forbiddenBlocks}
            diskId={diskId}
            toggle={toggle}
            startRename={startRename}
            cancelRename={cancelRename}
            submitRename={submitRename}
            setRenameValue={setRenameValue}
            startDelete={startDelete}
            cancelDelete={cancelDelete}
            submitDelete={submitDelete}
          />
        ))}
      </div>
    </DndContext>
  );
}

interface FileRowProps {
  entry: AdfEntry;
  depth: number;
  open: boolean;
  striped: boolean;
  editDisabled: EditDisabled | null;
  busy: boolean;
  renameBlock: number | null;
  renameValue: string;
  deleteBlock: number | null;
  /** Blocks this row must refuse as a drop target for the CURRENT drag -- see `subtreeBlocks` on FileTree. Only ever non-empty while a directory is being dragged. */
  forbiddenBlocks: ReadonlySet<number>;
  diskId: string;
  toggle: (block: number) => void;
  startRename: (entry: AdfEntry) => void;
  cancelRename: () => void;
  submitRename: (block: number) => void;
  setRenameValue: (value: string) => void;
  startDelete: (entry: AdfEntry) => void;
  cancelDelete: () => void;
  submitDelete: (block: number) => void;
}

function FileRow({
  entry, depth, open, striped, editDisabled, busy,
  renameBlock, renameValue, deleteBlock, forbiddenBlocks, diskId,
  toggle, startRename, cancelRename, submitRename, setRenameValue,
  startDelete, cancelDelete, submitDelete,
}: FileRowProps) {
  const isDir = entry.kind === 'dir';

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

  const row = (
    <div
      ref={setDragRef}
      // Two lines on a phone, one line from `sm` up. The metadata
      // columns total ~312px of fixed width inside a card that is only
      // ~310px wide at 390px, so the name column computes NEGATIVE at
      // depth 0 and worse at every level of nesting, and the card's
      // own overflow-hidden clips whatever is left. Scrolling the row
      // sideways is not the alternative: Download is the row's only
      // action, so it would be the first thing pushed out of reach.
      className="relative flex flex-col gap-1 py-1.5 text-[12.5px] sm:flex-row sm:items-center sm:gap-3"
      style={{
        paddingLeft: `${depth * 18 + 8 + GRIP_GUTTER}px`,
        paddingRight: '8px',
        background: striped ? 'rgb(255 255 255 / 0.5)' : 'transparent',
        // Rounded so the wash reads as a band rather than a full-bleed
        // block butting against the card's own rounded corners.
        borderRadius: '6px',
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
      }}
      data-testid="fs-entry"
      data-name={entry.name}
    >
      {/*
        Absolutely positioned in the gutter `GRIP_GUTTER` reserves on the
        row's own left edge, at the SAME horizontal offset the row's
        paddingLeft used to start at before this task -- so it lands in the
        depth-appropriate spot without shifting anything else in the row
        (the chevron, the name, the metadata columns, the rename/delete
        lines) out of the alignment they already had.

        `touchAction: 'none'` matches collection-rail.tsx's own grip handle
        and for the same reason: dnd-kit only calls preventDefault() on a
        touchmove that is still cancelable, and once the browser has
        committed a gesture to a scroll it no longer is -- opting the handle
        out of browser gestures is what keeps the first post-hold move
        cancelable, so a press-and-hold here picks the row up instead of the
        page scrolling under it.
      */}
      <button
        type="button"
        aria-label={`Move ${entry.name}`}
        disabled={!!editDisabled || busy}
        title={editDisabled?.message}
        data-testid={`fs-drag-${entry.block}`}
        {...attributes}
        {...listeners}
        style={{
          position: 'absolute',
          left: `${depth * 18 + 8}px`,
          top: '50%',
          transform: 'translateY(-50%)',
          touchAction: 'none',
          color: 'var(--muted-2)',
        }}
        className="grid h-5 w-5 shrink-0 cursor-grab place-items-center active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVertical size={12} aria-hidden />
      </button>

      {isDir ? (
        // A stable testid of its own -- not just the accessible name
        // (which happens to equal entry.name today) -- because a row
        // now legitimately holds more than one <button> (Rename,
        // Delete, and this toggle), so any test still choosing "the
        // button" by role alone would be ambiguous or, worse, silently
        // pick the wrong one if the row's button order ever changes.
        // Fix round 1 moved e2e/adf-browser.spec.ts and
        // e2e/mobile.spec.ts onto this testid for exactly that reason
        // -- do not "simplify" them back to a bare getByRole('button').
        <button
          type="button"
          onClick={() => toggle(entry.block)}
          data-testid={`fs-toggle-${entry.block}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left font-semibold"
          style={{ color: 'var(--ink)' }}
          aria-expanded={open}
        >
          <span
            aria-hidden
            className="inline-block transition-transform duration-150"
            style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none' }}
          >
            ▸
          </span>
          <span className="truncate">{entry.name}</span>
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate pl-[22px]" style={{ color: 'var(--ink)' }}>
          {entry.name}
        </span>
      )}

      {/*
        `sm:contents` rather than a second set of column rules: from
        `sm` up this wrapper generates no box at all, so the row's own
        flex lays these four out exactly as it did before the wrapper
        existed -- the desktop row is unchanged, not re-derived. Below
        `sm` it is line two, indented by the chevron's width so it
        starts under the name rather than under the arrow.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] sm:contents">
        {!isDir && (
          <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
            {entry.sizeBytes.toLocaleString()} B
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
          {entry.protection}
        </span>
        <span className="w-[80px] shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
          {entry.modifiedAt ? entry.modifiedAt.toISOString().slice(0, 10) : '—'}
        </span>

        {/*
          An <a> with a real href, not a <button>: the browser streams
          the response straight to disk and shows its own progress, the
          same reasoning as the Download control on the game detail
          page (disk-row.tsx). A plain fetch-then-save would buffer the
          whole file in memory to achieve the same result.
        */}
        {!isDir ? (
          <a
            href={`/api/disks/${diskId}/files/${entry.block}`}
            data-testid={`fs-download-${entry.block}`}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
          >
            Download
          </a>
        ) : (
          // Keeps the file column above aligned when a directory row has
          // no download link of its own. Only from `sm` up: on the
          // two-line layout there is no column to align to, and 68px of
          // nothing would just widen line two.
          <span className="hidden w-[68px] shrink-0 sm:block" />
        )}
      </div>

      {/*
        Rename and delete, on their own line so they never have to
        fight the responsive column rules above. INLINE expansion, not
        an overlay: opening one grows this row in normal document
        flow and pushes every row below it down, so nothing can ever
        cover a sibling row's controls the way an anchored popup did
        on the game detail page (see e2e/game-detail.spec.ts).

        Real <button>s, not <a> -- these are destructive/mutating
        actions with no href of their own, and a native anchor only
        activates on Enter, not Space, so a keyboard user tabbing here
        and pressing Space would scroll the page instead of opening the
        form. An earlier version of this file used <a href="#"> plus
        preventDefault to keep the row's `<button>` count at one for a
        test locator's sake; collection-provider.tsx already documents,
        at length, what a bare href under dnd-kit cost this repo once
        (a default action that kept firing despite stopPropagation,
        needing a document-level capture-phase preventDefault, found
        only by an e2e failure). This tree IS in a drag context now
        (this very task), which is exactly why every control added here
        -- the grip handle included -- is a real <button>, never an <a
        href="#">. The directory toggle carries its own
        `fs-toggle-${block}` testid instead, so the row can hold more
        than one button without any test locator caring.
      */}
      {renameBlock === entry.block ? (
        <div className="flex flex-wrap items-center gap-2 pl-[22px]">
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value.slice(0, MAX_NAME_LENGTH))}
            maxLength={MAX_NAME_LENGTH}
            aria-label={`New name for ${entry.name}`}
            data-testid={`fs-rename-name-${entry.block}`}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename(entry.block);
              if (e.key === 'Escape') cancelRename();
            }}
            className="rounded border bg-transparent px-2 py-1 text-[11px]"
            style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}
          />
          <button
            type="button"
            onClick={() => submitRename(entry.block)}
            disabled={busy || !renameValue.trim()}
            data-testid={`fs-rename-submit-${entry.block}`}
            className="rounded px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--primary-action)' }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={cancelRename}
            disabled={busy}
            data-testid={`fs-rename-cancel-${entry.block}`}
            className="rounded px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
            style={{ color: 'var(--muted)' }}
          >
            Cancel
          </button>
        </div>
      ) : deleteBlock === entry.block ? (
        <div className="flex flex-wrap items-center gap-2 pl-[22px]">
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
            Delete &quot;{entry.name}&quot;{isDir ? ' and everything inside it' : ''}? This cannot be undone.
          </span>
          <button
            type="button"
            onClick={() => submitDelete(entry.block)}
            disabled={busy}
            data-testid={`fs-delete-confirm-${entry.block}`}
            className="rounded px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--danger-fg)' }}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={cancelDelete}
            disabled={busy}
            data-testid={`fs-delete-cancel-${entry.block}`}
            className="rounded px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
            style={{ color: 'var(--muted)' }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 pl-[22px]">
          <button
            type="button"
            onClick={() => startRename(entry)}
            disabled={!!editDisabled}
            title={editDisabled?.message}
            data-testid={`fs-rename-${entry.block}`}
            className="text-[11px] font-semibold underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
            style={{ color: 'var(--muted)' }}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => startDelete(entry)}
            disabled={!!editDisabled}
            title={editDisabled?.message}
            data-testid={`fs-delete-${entry.block}`}
            className="text-[11px] font-semibold underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
            style={{ color: 'var(--muted)' }}
          >
            Delete
          </button>
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
      data-drop-target={isOver ? 'true' : undefined}
      style={{
        borderRadius: '6px',
        // Geometry never changes -- no padding or size shift -- because
        // moving a drop target out from under the cursor mid-drag is how you
        // make a drop land somewhere the person did not aim (same rule
        // collection-rail.tsx's own drop highlight follows).
        boxShadow: isOver ? 'inset 0 0 0 2px var(--accent-amber)' : undefined,
      }}
    >
      {row}
    </div>
  );
}
