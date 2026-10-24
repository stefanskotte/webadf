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

import { Link } from '@/components/shell/link';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoreHorizontal, Plus } from 'lucide-react';
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

const ROW = 'flex h-[38px] min-w-0 items-center gap-2.5 rounded-[10px] px-3 text-[14px]';
const CURRENT_STYLE = { background: 'var(--surface)', boxShadow: '0 1px 2px rgb(36 33 27 / .1), 0 0 0 1px var(--line)' };

/** The 8x8 rounded square in front of every rail row (spec 1.2). */
function Dot({ color }: { color: string }) {
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: color }} />;
}

export function CollectionRail({ viewMode = 'grid' }: { viewMode?: 'grid' | 'table' }) {
  const { collections, view, uncategorizedCount } = useCollectionsContext();
  const searchParams = useSearchParams();

  // Preserves every other query param (view, q) while only ever touching
  // `collection` -- so switching slices never drops the grid/table toggle.
  const hrefFor = (v: LibraryView) => viewHref(v, new URLSearchParams(searchParams.toString()));
  const current = (v: LibraryView) => isCurrentView(view, v);
  const inbox = current({ kind: 'uncategorized' });
  const all = current({ kind: 'all' });

  // Below `md` the rail is a full-width band above the grid (page.tsx stacks
  // the two there), so it takes the page's own gutter on both sides. From `md`
  // it is the 240px left column and the right margin goes back to nothing: the
  // parent's `gap-4` is what separates it from the grid. No card box (spec
  // 1.2): the rail sits on the ground, and the current row is the only
  // surface in it.
  return (
    <aside
      className="ml-4 mr-4 flex w-auto shrink-0 flex-col gap-0.5 sm:ml-7 sm:mr-7 md:mr-0 md:w-60"
      data-testid="collection-rail"
    >
      <div className="px-3 py-2 text-[12px] font-medium" style={{ color: 'var(--muted-2)' }}>Collections</div>

      {/* The inbox, and the landing view. It sits with the collections
          rather than apart from them because it behaves like one: it has a
          count, it is a place titles are, and filing one into a collection
          takes it out of here. It is NOT a drop target -- "uncategorize this"
          is a removal, which the collection's own menu already does. */}
      <Link
        href={hrefFor({ kind: 'uncategorized' })}
        data-testid="collection-uncategorized"
        aria-current={inbox ? 'page' : undefined}
        className={`${ROW} justify-between hover:bg-[var(--track)]`}
        style={inbox ? CURRENT_STYLE : undefined}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Dot color="#C4B9A2" />
          <span className="truncate" style={{ color: 'var(--ink)', fontWeight: inbox ? 600 : 500 }}>Uncategorized</span>
        </span>
        <span className="shrink-0 font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>{uncategorizedCount}</span>
      </Link>

      <div className="my-1 h-px" style={{ background: 'var(--line)' }} />

      {collections.length === 0 ? (
        <p className="px-3 py-1 text-[12px]" style={{ color: 'var(--muted-2)' }}>
          No collections yet
        </p>
      ) : (
        <SortableContext items={collections.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-0.5">
            {collections.map((c) => (
              <CollectionRow
                key={c.id}
                collection={c}
                active={current({ kind: 'collection', id: c.id })}
                href={hrefFor({ kind: 'collection', id: c.id })}
              />
            ))}
          </div>
        </SortableContext>
      )}

      <div className="my-1 h-px" style={{ background: 'var(--line)' }} />

      <CreateCollectionForm />

      {/* Last, and below the divider: the whole library in one list is an
          escape hatch, not the place you work. Kept because it is the only
          view that shows a title filed in two collections once, and the only
          one where "where did that disk go" has a single answer. */}
      <div className="my-1 h-px" style={{ background: 'var(--line)' }} />
      <Link
        href={hrefFor({ kind: 'all' })}
        data-testid="collection-all"
        aria-current={all ? 'page' : undefined}
        className={`${ROW} hover:bg-[var(--track)]`}
        style={all ? CURRENT_STYLE : undefined}
      >
        <Dot color="var(--ink)" />
        <span className="truncate" style={{ color: 'var(--ink)', fontWeight: all ? 600 : 500 }}>All titles</span>
      </Link>

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
}: {
  collection: CollectionSummary;
  active: boolean;
  href: string;
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
   * goes. Anything computed independently (pointer position, bounding boxes)
   * could differ from the collision detection and would be worse than no
   * highlight: it would confidently point at the wrong row.
   *
   * `isOver` alone is not the condition, though. It is equally true while
   * REORDERING the rail, where a drop moves the collection rather than filing
   * anything into it, so the active drag has to be a game for the row to arm.
   */
  const draggingGame =
    (dragActive?.data.current as CollectionsDragData | undefined)?.type === 'game';
  const isDropTarget = draggingGame && isOver;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    // Armed rows get a whisper so the rail reads as live; the one under the
    // pointer gets an unmissable ring. Geometry NEVER changes -- no padding
    // or size shift -- because moving a drop target out from under the cursor
    // mid-drag is how you make a drop land somewhere the person did not aim.
    background: isDropTarget
      ? 'var(--surface-2)'
      : active ? CURRENT_STYLE.background : draggingGame ? 'rgb(36 33 27 / 0.05)' : undefined,
    boxShadow: isDropTarget ? '0 0 0 1px var(--ink)' : active ? CURRENT_STYLE.boxShadow : undefined,
  };

  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(collection.name);
  const [busy, setBusy] = useState(false);

  async function submitRename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === collection.name) {
      setRenaming(false);
      return;
    }
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
      setRenaming(false);
      router.refresh();
    }
  }

  async function onDelete() {
    // The reasonable fear here is "did this delete my disks" -- it doesn't,
    // and the confirm copy says so explicitly.
    const confirmed = window.confirm(
      `Delete "${collection.name}"? This deletes only the collection -- the titles in it are not deleted.`,
    );
    if (!confirmed) return;

    setBusy(true);
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
      // If this was the filtered collection, the stale `?collection=` param
      // is left in the URL on purpose: page.tsx resolves it against a fresh
      // listCollections() on refresh and quietly falls back to unfiltered
      // (requirement carried from earlier reviews) -- no redirect needed here.
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="collection-row"
      data-collection-id={collection.id}
      data-drop-target={isDropTarget ? 'true' : undefined}
      className="group flex h-[38px] items-center gap-1 rounded-[10px] pl-1 pr-1.5 hover:bg-[var(--track)]"
    >
      {/*
        `touchAction: 'none'` was already here for the old PointerSensor and is
        MORE load-bearing now that a TouchSensor drives this by press-and-hold.
        dnd-kit only calls preventDefault() on a touchmove that is still
        `cancelable` (handleMove in AbstractPointerSensor); once the browser has
        committed the gesture to a scroll, it is not, and the page would scroll
        away underneath a rail reorder. Opting the handle out of browser
        gestures is what keeps that first post-hold move cancelable.

        Its cost is that a swipe begun exactly on this 20x24px grip scrolls
        nothing -- which is why the drag activators live on the grip alone and
        not on the row, so the rest of the rail scrolls like any other list.
      */}
      <button
        type="button"
        aria-label={`Reorder ${collection.name}`}
        {...attributes}
        {...listeners}
        style={{ touchAction: 'none', color: 'var(--muted-2)' }}
        className="grid h-7 w-5 shrink-0 cursor-grab place-items-center opacity-60 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
      >
        <GripVertical size={13} />
      </button>

      {renaming ? (
        <input
          autoFocus
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
            if (e.key === 'Escape') { setName(collection.name); setRenaming(false); }
          }}
          className="h-8 min-w-0 flex-1 rounded-lg border px-2 text-[14px]"
          style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)', color: 'var(--ink)' }}
        />
      ) : (
        <Link
          href={href}
          aria-current={active ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-1.5"
        >
          <Dot color={collectionDot(collection.id)} />
          <span
            data-testid="collection-name"
            className="min-w-0 flex-1 truncate text-[14px]"
            style={{ color: 'var(--ink)', fontWeight: active ? 600 : 500 }}
          >
            {collection.name}
          </span>
          {/* The count sits in the row's plain surface whether or not the collection is selected, so it stays a
              --muted-2 grey: an earlier draft flipped it to #fff when active and rendered it invisible. */}
          <span data-testid="collection-count" className="shrink-0 font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>
            {collection.gameCount}
          </span>
        </Link>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`collection-menu-${collection.id}`}
          aria-label={`More actions for ${collection.name}`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-[var(--track)]"
          style={{ color: 'var(--muted)' }}
        >
          <MoreHorizontal size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)' }}
        >
          <DropdownMenuItem
            data-testid={`collection-rename-${collection.id}`}
            onClick={() => { setName(collection.name); setRenaming(true); }}
          >
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

function CreateCollectionForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setBusy(true);
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
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-1.5 px-1 py-1">
      <input
        data-testid="collection-create"
        aria-label="New collection name"
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        placeholder="New collection"
        className="h-9 min-w-0 flex-1 rounded-[9px] px-2.5 text-[13px]"
        style={{ background: 'var(--surface)', border: '1px dashed var(--line-strong)', color: 'var(--ink)' }}
      />
      <button
        type="submit"
        aria-label="Add collection"
        disabled={busy}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border disabled:opacity-50"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
      >
        <Plus size={16} aria-hidden />
      </button>
    </form>
  );
}
