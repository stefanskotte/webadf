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
import {
  useCollectionsContext,
  type CollectionSummary,
  type CollectionDragData,
  type CollectionsDragData,
} from './collection-provider';

export function CollectionRail() {
  const { collections, filteredCollectionId } = useCollectionsContext();
  const searchParams = useSearchParams();

  // Preserves every other query param (just `view` today) while only ever
  // touching `collection` -- so switching collections never drops the
  // grid/table toggle, and clearing the filter doesn't either.
  function hrefFor(id: string | null): string {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set('collection', id);
    else params.delete('collection');
    const qs = params.toString();
    return qs ? `/library?${qs}` : '/library';
  }

  // Below `md` the rail is a full-width band above the grid (page.tsx stacks
  // the two there), so it drops its fixed 224px and takes the page's own
  // gutter on both sides. From `md` it is the left column again and the right
  // margin goes back to nothing: the parent's `gap-4` is what separates it
  // from the grid, and a second margin would widen that split beyond what it
  // has always been.
  return (
    <aside
      className="glass-card ml-4 mr-4 flex w-auto shrink-0 flex-col gap-1 p-3 sm:ml-7 sm:mr-7 md:mr-0 md:w-56"
      data-testid="collection-rail"
    >
      <Link
        href={hrefFor(null)}
        data-testid="collection-all"
        className="rounded-md px-2.5 py-1.5 text-[13px] font-semibold"
        style={
          filteredCollectionId === null
            ? { background: 'var(--primary-action)', color: '#fff' }
            : { color: 'var(--ink)' }
        }
      >
        All titles
      </Link>

      <div className="my-1 h-px" style={{ background: 'var(--hairline)' }} />

      {collections.length === 0 ? (
        <p className="px-2.5 py-1 text-[11.5px]" style={{ color: 'var(--faint)' }}>
          No collections yet
        </p>
      ) : (
        <SortableContext items={collections.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-0.5">
            {collections.map((c) => (
              <CollectionRow
                key={c.id}
                collection={c}
                active={c.id === filteredCollectionId}
                href={hrefFor(c.id)}
              />
            ))}
          </div>
        </SortableContext>
      )}

      <div className="my-1 h-px" style={{ background: 'var(--hairline)' }} />

      <CreateCollectionForm />
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
      ? 'rgb(245 130 46 / 0.20)'
      : draggingGame ? 'rgb(30 45 60 / 0.05)' : undefined,
    boxShadow: isDropTarget ? 'inset 0 0 0 2px var(--accent-amber)' : undefined,
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
      className="flex items-center gap-1 rounded-md px-1 py-0.5"
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
        className="grid h-6 w-5 shrink-0 cursor-grab place-items-center active:cursor-grabbing"
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
          className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[13px]"
          style={{ borderColor: 'var(--hairline-strong)', background: 'var(--input-bg)', color: 'var(--ink)' }}
        />
      ) : (
        <Link
          href={href}
          data-testid="collection-name"
          className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[13px] font-semibold"
          style={active ? { background: 'var(--primary-action)', color: '#fff' } : { color: 'var(--ink)' }}
        >
          {collection.name}
        </Link>
      )}

      {/* The active highlight lives on the Link alone, not on this row, so
          this count sits on the rail's plain glass whether or not the
          collection is selected -- it must stay a --muted-2 grey. An earlier
          draft flipped it to #fff when active and rendered it invisible. */}
      <span
        data-testid="collection-count"
        className="shrink-0 font-mono text-[10.5px]"
        style={{ color: 'var(--muted-2)' }}
      >
        {collection.gameCount}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`collection-menu-${collection.id}`}
          aria-label={`More actions for ${collection.name}`}
          className="grid h-6 w-5 shrink-0 place-items-center rounded"
          style={{ color: 'var(--muted-2)' }}
        >
          <MoreHorizontal size={13} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          style={{ background: 'var(--glass-strong)', color: 'var(--ink)', border: '1px solid var(--hairline-strong)' }}
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
    <form onSubmit={onSubmit} className="flex items-center gap-1.5 px-0.5">
      <Plus size={13} style={{ color: 'var(--muted-2)' }} className="shrink-0" />
      <input
        data-testid="collection-create"
        aria-label="New collection name"
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        placeholder="New collection"
        className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12.5px]"
        style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}
      />
    </form>
  );
}
