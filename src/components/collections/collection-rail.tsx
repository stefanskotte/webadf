'use client';

// The left rail on /library: the org's collections, each one both a drop
// target for a dragged game card (case 1 in collection-provider's onDragEnd)
// and a sortable item among its siblings (case 3). A single `useSortable`
// per row supplies both -- dnd-kit's sortable hook already registers a
// draggable AND a droppable at the same id internally, so there is no
// separate useDroppable call here. `attributes`/`listeners` (the actual drag
// activators) go ONLY on the small grip handle, not the whole row: the row
// also hosts a Link, a rename input and a menu, and none of those should
// have to survive an 8px-pointer-move-then-release to register as a click.
//
// Below md (C7 spec §4.2, Ruling 16) the same rows are the board's chip row: one line that scrolls sideways,
// Uncategorized, the collections, All titles, + New. Chips stay drop targets; the grip is not drawn, so a phone does
// not reorder; only the current collection shows its ⋯. One DOM at every width: the classes switch at md.

import { Link } from '@/components/shell/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { collectionDot } from '@/lib/library-look';
import { viewHref, isCurrentView, type LibraryView } from '@/lib/library-view';
import {
  useCollectionsContext,
  type CollectionSummary,
  type CollectionDragData,
  type CollectionsDragData,
} from './collection-provider';

/** A rail row from md; a chip below it (44 px, round, a hairline on the surface). */
const ROW = 'flex min-w-0 shrink-0 items-center gap-2.5 text-[14px] md:h-[38px] md:rounded-[10px] md:px-3 md:hover:bg-(--track) max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:border max-md:border-(--line) max-md:bg-(--surface) max-md:px-3 max-md:text-[13px]';
/** The current row: a raised surface from md, an ink chip below it. In classes, so each width keeps its own look. */
const CURRENT = 'md:bg-(--surface) md:shadow-[0_1px_2px_rgb(36_33_27/.1),0_0_0_1px_var(--line)] max-md:border-(--ink) max-md:bg-(--ink)';
/** A row's words: ink, and the surface on the ink chip. */
const NAME = 'min-w-0 truncate text-(--ink) max-md:group-data-[current=true]:text-(--surface)';
/** The count stays --muted-2 on the rail (an earlier draft flipped it to #fff and lost it); on the ink chip, on-ink. */
const COUNT = 'shrink-0 font-mono text-[12px] text-(--muted-2) max-md:group-data-[current=true]:text-(--on-ink-muted)';
const FIELD = 'h-9 min-w-0 flex-1 rounded-[9px] px-2.5 text-[13px] max-md:h-11 max-md:text-[14px] aria-disabled:opacity-60';

/** The 8x8 rounded square in front of every rail row (spec 1.2). */
function Dot({ color }: { color: string }) {
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: color }} />;
}

export function CollectionRail({ viewMode = 'grid' }: { viewMode?: 'grid' | 'table' }) {
  const { collections, view, uncategorizedCount } = useCollectionsContext();
  const searchParams = useSearchParams();
  // Where the rename and create fields go (Plan ruling, C7 Task 5): in the rail from md, under the chip row below it.
  // Both open only on a tap after hydration, so this has its client value by then.
  const isMd = useMediaQuery('(min-width: 768px)', {});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);

  // Preserves every other query param (view, q) while only ever touching
  // `collection` -- so switching slices never drops the grid/table toggle.
  const hrefFor = (v: LibraryView) => viewHref(v, new URLSearchParams(searchParams.toString()));
  const current = (v: LibraryView) => isCurrentView(view, v);
  const inbox = current({ kind: 'uncategorized' });
  const all = current({ kind: 'all' });
  const renaming = collections.find((c) => c.id === renamingId) ?? null;

  // Keyed on the view's kind and id, not the `view` object: that is a new object after every refresh, which would pull
  // the row back while the person is scrolling it.
  const viewKey = `${view.kind}:${view.kind === 'collection' ? view.id : ''}`;
  // Below md the current chip is scrolled into view on load, without moving the page (spec §4.2).
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) return;
    // The row's own scrollLeft, not scrollIntoView: that scrolls every ancestor too, the page among them.
    const row = scroller.current;
    const chip = row?.querySelector<HTMLElement>('[data-current="true"]');
    if (!row || !chip) return;
    const r = row.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    if (c.left < r.left) row.scrollLeft += c.left - r.left;
    else if (c.right > r.right) row.scrollLeft += c.right - r.right;
  }, [viewKey]);

  function endRename(id: string, refocus: boolean) {
    setRenamingId(null);
    // Ended by Enter or Escape: back to the row's ⋯, never to <body>. A blur already put focus somewhere else.
    if (refocus) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="collection-menu-${id}"]`)?.focus());
  }
  function endNew() {
    setNewOpen(false);
    requestAnimationFrame(() => newRef.current?.focus());
  }

  return (
    <aside className="flex shrink-0 flex-col md:ml-7 md:w-60 md:gap-0.5" data-testid="collection-rail">
      <div className="px-3 py-2 text-[12px] font-medium max-md:hidden" style={{ color: 'var(--muted-2)' }}>Collections</div>

      {/* Below md the chip row; from md `contents`, so its children are the rail's own rows, in today's order. */}
      <nav ref={scroller} aria-label="Collections" className="flex gap-2 overflow-x-auto px-4 pb-1 sm:px-7 md:contents">
        {/* The inbox, and the landing view. It sits with the collections
            rather than apart from them because it behaves like one: it has a
            count, it is a place titles are, and filing one into a collection
            takes it out of here. It is NOT a drop target -- "uncategorize this"
            is a removal, which the collection's own menu already does. */}
        <Link
          href={hrefFor({ kind: 'uncategorized' })}
          data-testid="collection-uncategorized"
          data-current={inbox}
          aria-current={inbox ? 'page' : undefined}
          className={`group ${ROW} justify-between ${inbox ? CURRENT : ''}`}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Dot color="#C4B9A2" />
            <span className={NAME} style={{ fontWeight: inbox ? 600 : 500 }}>Uncategorized</span>
          </span>
          <span className={COUNT}>{uncategorizedCount}</span>
        </Link>

        <div className="my-1 h-px max-md:hidden" style={{ background: 'var(--line)' }} />

        {collections.length === 0 ? (
          <p className="px-3 py-1 text-[12px] max-md:hidden" style={{ color: 'var(--muted-2)' }}>
            No collections yet
          </p>
        ) : (
          <SortableContext items={collections.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-0.5 max-md:contents">
              {collections.map((c) => (
                <CollectionRow
                  key={c.id}
                  collection={c}
                  active={current({ kind: 'collection', id: c.id })}
                  href={hrefFor({ kind: 'collection', id: c.id })}
                  renaming={renamingId === c.id && isMd}
                  onRename={() => setRenamingId(c.id)}
                  onRenameEnd={(refocus) => endRename(c.id, refocus)}
                />
              ))}
            </div>
          </SortableContext>
        )}

        <div className="my-1 h-px max-md:hidden" style={{ background: 'var(--line)' }} />

        {/* From md the form lives here; below md it opens under the row from + New. */}
        {!(newOpen && !isMd) && (
          <div className="max-md:hidden"><CreateCollectionForm /></div>
        )}

        {/* Last, and below the divider: the whole library in one list is an
            escape hatch, not the place you work. Kept because it is the only
            view that shows a title filed in two collections once, and the only
            one where "where did that disk go" has a single answer. */}
        <div className="my-1 h-px max-md:hidden" style={{ background: 'var(--line)' }} />
        <Link
          href={hrefFor({ kind: 'all' })}
          data-testid="collection-all"
          data-current={all}
          aria-current={all ? 'page' : undefined}
          className={`group ${ROW} ${all ? CURRENT : ''}`}
        >
          <Dot color="var(--ink)" />
          <span className={NAME} style={{ fontWeight: all ? 600 : 500 }}>All titles</span>
        </Link>

        <button ref={newRef} type="button" data-testid="collections-new" aria-expanded={newOpen}
                aria-controls="collection-create-form" onClick={() => setNewOpen((o) => !o)}
                className={`${ROW} font-medium text-(--ink) md:hidden`}>
          <Plus size={14} aria-hidden /> New
        </button>
      </nav>

      {renaming && !isMd && (
        <div className="px-4 pt-2 sm:px-7 md:hidden">
          <RenameField collection={renaming} onEnd={(refocus) => endRename(renaming.id, refocus)} />
        </div>
      )}
      {newOpen && !isMd && (
        <div className="px-4 pt-2 sm:px-7 md:hidden">
          <CreateCollectionForm phone onDone={endNew} />
        </div>
      )}

      <p className="mx-3 mt-3 hidden text-[12px] leading-[1.5] md:block" style={{ color: 'var(--muted-2)' }}>
        {viewMode === 'table'
          ? 'Drag a row onto a collection to file it.'
          : 'Drag titles onto a collection to file them. Drag collections to reorder.'}
      </p>
    </aside>
  );
}

function CollectionRow({
  collection,
  active,
  href,
  renaming,
  onRename,
  onRenameEnd,
}: {
  collection: CollectionSummary;
  active: boolean;
  href: string;
  /** The inline field (from md only; below md the rail draws it under the chip row). */
  renaming: boolean;
  onRename: () => void;
  onRenameEnd: (refocus: boolean) => void;
}) {
  const router = useRouter();
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
    isOver, active: dragActive,
  } = useSortable({
    id: collection.id,
    data: { type: 'collection', id: collection.id } satisfies CollectionDragData,
  });

  /**
   * Which row a dragged card will actually land in.
   *
   * Driven by dnd-kit's own `isOver` -- the SAME value onDragEnd resolves the
   * drop from -- so the highlight cannot disagree with where the title really
   * goes. `isOver` is equally true while REORDERING the rail, where a drop
   * moves the collection rather than filing anything into it, so the active
   * drag has to be a game for the row to arm.
   */
  const draggingGame =
    (dragActive?.data.current as CollectionsDragData | undefined)?.type === 'game';
  const isDropTarget = draggingGame && isOver;
  // While a card is over the current row it shows as a target, not as current (its words stay ink on surface-2).
  const showCurrent = active && !isDropTarget;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    // Armed rows get a whisper so the rail reads as live; the one under the
    // pointer gets an unmissable ring. Geometry NEVER changes -- no padding
    // or size shift -- because moving a drop target out from under the cursor
    // mid-drag is how you make a drop land somewhere the person did not aim.
    // The current row's own look is a class (CURRENT), so each width keeps its own.
    background: isDropTarget ? 'var(--surface-2)' : draggingGame && !active ? 'rgb(36 33 27 / 0.05)' : undefined,
    boxShadow: isDropTarget ? '0 0 0 1px var(--ink)' : undefined,
  };

  async function onDelete() {
    // The reasonable fear here is "did this delete my disks" -- it doesn't,
    // and the confirm copy says so explicitly. (window.confirm is today's, pinned by collections.spec; C7 Plan ruling.)
    const confirmed = window.confirm(
      `Delete "${collection.name}"? This deletes only the collection -- the titles in it are not deleted.`,
    );
    if (!confirmed) return;
    let deleted = false;
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collection.id}`, { method: 'DELETE' });
      } catch {
        toast.error('Could not reach the server', { description: 'The collection was not deleted.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not delete the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
      deleted = true;
      // If this was the filtered collection, the stale `?collection=` param
      // is left in the URL on purpose: page.tsx resolves it against a fresh
      // listCollections() on refresh and quietly falls back to unfiltered
      // (requirement carried from earlier reviews) -- no redirect needed here.
    } finally {
      router.refresh();
      // The row is about to unmount with the menu's focus on its ⋯: hand focus to the rail's first link once the row
      // is gone (this closure outlives the row), never to <body>. Gives up after ~2 s.
      if (deleted) {
        const id = collection.id;
        let frames = 0;
        const land = () => {
          const gone = !document.querySelector(`[data-testid="collection-row"][data-collection-id="${id}"]`);
          if (gone || ++frames > 120) document.querySelector<HTMLElement>('[data-testid="collection-uncategorized"]')?.focus();
          else requestAnimationFrame(land);
        };
        requestAnimationFrame(land);
      }
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="collection-row"
      data-collection-id={collection.id}
      data-current={showCurrent}
      data-drop-target={isDropTarget ? 'true' : undefined}
      className={`group flex shrink-0 items-center gap-1 md:h-[38px] md:rounded-[10px] md:pl-1 md:pr-1.5 max-md:h-11 max-md:rounded-full max-md:border max-md:border-(--line) max-md:bg-(--surface) ${active ? 'max-md:pr-0' : 'max-md:pr-3'} ${showCurrent ? CURRENT : 'md:hover:bg-(--track)'}`}
    >
      {/*
        `touchAction: 'none'` is load-bearing for the TouchSensor's press-and-hold: dnd-kit only calls preventDefault()
        on a touchmove that is still `cancelable`, and opting the handle out of browser gestures is what keeps that
        first post-hold move cancelable. Not drawn below md: a phone does not reorder (C7 Ruling 16).
      */}
      <button
        type="button"
        aria-label={`Reorder ${collection.name}`}
        {...attributes}
        {...listeners}
        style={{ touchAction: 'none', color: 'var(--muted-2)' }}
        className="grid h-7 w-5 shrink-0 cursor-grab place-items-center opacity-60 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing max-md:hidden"
      >
        <GripVertical size={13} />
      </button>

      {renaming ? (
        <RenameField collection={collection} onEnd={onRenameEnd} inline />
      ) : (
        <Link
          href={href}
          aria-current={active ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-1.5 max-md:flex-none max-md:gap-2 max-md:pl-3"
        >
          <Dot color={collectionDot(collection.id)} />
          <span
            data-testid="collection-name"
            className={`${NAME} flex-1 text-[14px] max-md:flex-none max-md:text-[13px]`}
            style={{ fontWeight: active ? 600 : 500 }}
          >
            {collection.name}
          </span>
          <span data-testid="collection-count" className={COUNT}>
            {collection.gameCount}
          </span>
        </Link>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`collection-menu-${collection.id}`}
          aria-label={`More actions for ${collection.name}`}
          // Below md only the current collection's chip shows its ⋯ (44 x 44); from md every row has it, as before.
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-(--muted) hover:bg-(--track) max-md:size-11 max-md:rounded-full max-md:group-data-[current=true]:text-(--surface) max-md:hover:bg-transparent ${active ? '' : 'max-md:hidden'}`}
        >
          <MoreHorizontal size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)' }}
        >
          <DropdownMenuItem data-testid={`collection-rename-${collection.id}`} onClick={onRename}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`collection-delete-${collection.id}`}
            variant="destructive"
            onClick={onDelete}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Rename a collection: inline in its rail row from md, on a line under the chip row below md (C7 spec §4.2). One field
 * either way. Enter saves and Escape cancels (focus back on the ⋯); a blur saves and leaves focus where it went.
 */
function RenameField({ collection, onEnd, inline = false }: {
  collection: CollectionSummary; onEnd: (refocus: boolean) => void; inline?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(collection.name);
  const [busy, setBusy] = useState(false);
  const ended = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  // Opened from the ⋯ menu, which hands focus back to its trigger as it closes: take it after that (two frames).
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => field.current?.focus()); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, []);

  async function submit(refocus: boolean) {
    if (ended.current) return;   // Enter then the unmount's blur: one request
    ended.current = true;
    const trimmed = name.trim();
    if (!trimmed || trimmed === collection.name) { onEnd(refocus); return; }
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collection.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'The collection was not renamed.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not rename the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
    } finally {
      setBusy(false);
      onEnd(refocus);
      router.refresh();
    }
  }

  return (
    <input
      ref={field}
      autoFocus
      aria-label="Collection name"
      value={name}
      readOnly={busy}
      aria-disabled={busy || undefined}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => void submit(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void submit(true); }
        if (e.key === 'Escape') { e.preventDefault(); ended.current = true; onEnd(true); }
      }}
      className={inline
        ? 'h-8 min-w-0 flex-1 rounded-lg border px-2 text-[14px] aria-disabled:opacity-60'
        : 'h-11 w-full rounded-[10px] border px-3 text-[14px] aria-disabled:opacity-60'}
      style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)', color: 'var(--ink)' }}
    />
  );
}

function CreateCollectionForm({ phone = false, onDone }: { phone?: boolean; onDone?: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    let created = false;
    try {
      let res: Response;
      try {
        res = await fetch('/api/collections', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'The collection was not created.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not create the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
      setName('');
      created = true;
    } finally {
      setBusy(false);
      router.refresh();
      // Below md a create closes the form and focus goes back to + New; a failure keeps it open to try again.
      if (created) onDone?.();
    }
  }

  return (
    <form id={phone ? 'collection-create-form' : undefined} onSubmit={onSubmit}
          onKeyDown={(e) => { if (phone && e.key === 'Escape') { e.preventDefault(); onDone?.(); } }}
          className="flex items-center gap-1.5 px-1 py-1 max-md:px-0">
      <input
        data-testid="collection-create"
        aria-label="New collection name"
        value={name}
        autoFocus={phone}
        readOnly={busy}
        aria-disabled={busy || undefined}
        onChange={(e) => setName(e.target.value)}
        placeholder="New collection"
        className={FIELD}
        style={{ background: 'var(--surface)', border: '1px dashed var(--line-strong)', color: 'var(--ink)' }}
      />
      <button
        type="submit"
        aria-label="Add collection"
        aria-disabled={busy || undefined}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border aria-disabled:opacity-50 max-md:size-11"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
      >
        <Plus size={16} aria-hidden />
      </button>
    </form>
  );
}
