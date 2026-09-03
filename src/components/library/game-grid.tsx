'use client';

import { Link } from '@/components/shell/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useDraggable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { DeleteDiskDialog } from '@/components/library/delete-disk-dialog';
import { Cover } from './cover';
import type { GameListItem } from '@/lib/queries';
import { useCollectionsContext, type GameDragData } from '@/components/collections/collection-provider';

export function GameGrid({ games }: { games: GameListItem[] }) {
  const { gameIds, filteredCollectionId } = useCollectionsContext();

  if (games.length === 0) {
    return (
      <div className="glass-card mx-4 flex flex-col items-center gap-3 p-12 text-center sm:mx-7" data-testid="game-grid">
        <p className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>No disks yet</p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Drop some ADFs on the ingest page, or run <code className="font-mono">webadf push</code>.
        </p>
        <Link href="/ingest" className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ background: 'var(--primary-action)' }}>Add disks</Link>
      </div>
    );
  }

  // Filtered view: the grid is a reorderable list backed by the collection's
  // membership order, which lives as `gameIds` on the shared context
  // (collection-provider.tsx) so a drag reorders it optimistically ahead of
  // the server round-trip. Unfiltered: render `games` exactly as fetched --
  // that ordering (recently-added first) is untouched by this task, and
  // gameIds is not consulted at all, per the "renders exactly as it does
  // today" requirement when no collection is selected.
  let ordered = games;
  if (filteredCollectionId) {
    const byId = new Map(games.map((g) => [g.id, g] as const));
    ordered = gameIds.map((id) => byId.get(id)).filter((g): g is GameListItem => g !== undefined);
  }

  const grid = (
    // Five across is ~60px per card at 390px, which is smaller than the
    // cover art is legible at. Two, then three, then today's five.
    // The gutter shrinks with it: mx-7 spends 56 of 390px on nothing.
    <div className="mx-4 grid grid-cols-2 gap-4 sm:mx-7 sm:grid-cols-3 md:grid-cols-5" data-testid="game-grid">
      {ordered.map((g) =>
        filteredCollectionId
          ? <SortableCard key={g.id} game={g} collectionId={filteredCollectionId} />
          : <DraggableCard key={g.id} game={g} />,
      )}
    </div>
  );

  // Cards are draggable everywhere (dropping one onto a rail collection
  // works from anywhere), but only wrapped in a SortableContext -- and only
  // sortable among themselves -- while filtered: there is no single ordered
  // list a game-on-game drop could mean in the unfiltered recently-added
  // view (collection-provider.tsx's onDragEnd guards this too, but the
  // point here is to not offer the drop target at all).
  if (!filteredCollectionId) return grid;
  return (
    <SortableContext items={gameIds} strategy={rectSortingStrategy}>
      {grid}
    </SortableContext>
  );
}

/**
 * How a card looks while it is the one being dragged.
 *
 * It shrinks and fades, and that is functional rather than decorative: a card
 * is about 178x200 and the collections rail is about 198 wide, so a full-size
 * drag preview covers the exact rows the person is trying to aim at. The
 * highlight underneath is useless if the thing you are dragging is parked on
 * top of it.
 *
 * Scale goes in the SAME transform string as dnd-kit's translate, after it --
 * a separate `scale` property would be composited before the translate and
 * drag the card away from the pointer.
 */
function dragStyle(translate: string | undefined, isDragging: boolean) {
  return {
    transform: isDragging ? `${translate ?? ''} scale(0.55)`.trim() : translate,
    opacity: isDragging ? 0.4 : 1,
  };
}

/**
 * The volume name of a disk made here, editable on the card.
 *
 * INSIDE the card's <a>, like the remove button above it, and safe for the
 * same reason: every pointer event is stopped before it reaches the anchor or
 * dnd-kit's listeners. Without that, typing would navigate to the game and
 * a drag would start from the text cursor.
 *
 * Offered only for an authored title. Renaming rewrites the disk's BYTES --
 * new sha-256, new blob, repointed disks.sha256 -- and "which disk?" has no
 * answer on a multi-disk game, which is why this is gated on `authored`
 * rather than on metadataSource 'human' (true of any hand-edited title).
 */
function VolumeNameField({ game: g }: { game: GameListItem }) {
  const router = useRouter();
  const [name, setName] = useState(g.title);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === g.title) { setName(g.title); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${g.diskId}/volume-name`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ volumeName: trimmed }),
      });
      if (!res.ok) {
        toast.error('Could not rename the disk');
        setName(g.title);
        return;
      }
      // Said plainly, because it is not what a rename usually costs: the disk
      // is content-addressed, so this really did make a new one.
      toast.success('Disk renamed', { description: 'The disk was rewritten under a new digest.' });
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
      setName(g.title);
    } finally {
      setBusy(false);
    }
  }

  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };

  return (
    <input
      data-testid={`volume-name-${g.id}`}
      aria-label={`Volume name for ${g.title}`}
      value={name}
      disabled={busy}
      onChange={(e) => setName(e.target.value)}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setName(g.title); e.currentTarget.blur(); }
      }}
      onBlur={commit}
      className="w-full truncate rounded border bg-transparent px-1 py-0.5 text-[13px] font-semibold"
      style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}
    />
  );
}

function CardBody({ game: g }: { game: GameListItem }) {
  return (
    <>
      <Cover id={g.id} title={g.title} diskCount={g.diskCount} coverUrl={g.coverUrl} kind={g.kind} />
      <div className="flex flex-col gap-0.5 px-0.5 pb-1 pt-2.5">
        {g.authored && g.diskId ? (
          <VolumeNameField game={g} />
        ) : (
          <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            {g.title}
          </span>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
            {[g.year, g.publisher].filter(Boolean).join(' · ') || (g.authored ? 'made here' : 'unidentified')}
          </span>
          {/* Inside the card's <a href>, like the rename field and the
              collection remove button, and safe the same way: the dialog
              stops every pointer event before it reaches the anchor or
              dnd-kit's drag listeners. */}
          <DeleteDiskDialog kind="game" id={g.id} title={g.title} diskCount={g.diskCount} />
        </div>
      </div>
    </>
  );
}

/** Unfiltered recently-added view: draggable onto a rail collection, not sortable against siblings. */
function DraggableCard({ game: g }: { game: GameListItem }) {
  // `role` is pulled OUT of dnd-kit's attributes and thrown away: it is
  // "button", and this card is an <a href> that really does navigate. Spread
  // whole, it would have a screen reader announce every game in the library
  // as a button, and the 8px activation constraint exists precisely so the
  // link half keeps working. The rest of the attributes (tabIndex,
  // aria-roledescription, aria-describedby) are kept.
  const { attributes: dragAttributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: g.id,
    data: { type: 'game', id: g.id } satisfies GameDragData,
  });
  const attributes = { ...dragAttributes, role: undefined };
  const style = dragStyle(CSS.Translate.toString(transform), isDragging);

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}`}
      data-testid="game-card"
      // An <a href> is natively draggable, so pressing one and moving started
      // the BROWSER's own link drag alongside dnd-kit's -- and dropping a
      // link onto the page makes Chrome navigate to it, which took a person
      // filing a game straight out of the library. The other half of that
      // failure (the click the browser fires at the end of a drag) is fixed
      // in collection-provider.tsx, which is the only place it CAN be fixed.
      draggable={false}
      className="glass-card flex flex-col p-2.5"
      style={style}
      {...attributes}
      {...listeners}
    >
      <CardBody game={g} />
    </Link>
  );
}

/** Filtered-to-a-collection view: sortable against siblings (reorders the collection), plus a remove control. */
function SortableCard({ game: g, collectionId }: { game: GameListItem; collectionId: string }) {
  const router = useRouter();
  // See DraggableCard on why `role` is discarded rather than spread.
  const { attributes: dragAttributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: g.id,
    data: { type: 'game', id: g.id } satisfies GameDragData,
  });
  const attributes = { ...dragAttributes, role: undefined };
  const style = { ...dragStyle(CSS.Translate.toString(transform), isDragging), transition };

  const [busy, setBusy] = useState(false);

  async function onRemove(e: React.MouseEvent) {
    // Must not reach the card's own Link -- this button sits inside it, and
    // an unstopped click would both remove the title AND navigate to it.
    e.preventDefault();
    e.stopPropagation();

    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collectionId}/games/${g.id}`, { method: 'DELETE' });
      } catch {
        toast.error('Could not reach the server', { description: 'The title was not removed from the collection.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not remove the title from the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}`}
      data-testid="game-card"
      // See DraggableCard on why an anchor must opt out of native dragging.
      draggable={false}
      className="glass-card relative flex flex-col p-2.5"
      style={style}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        data-testid={`remove-from-collection-${g.id}`}
        aria-label={`Remove ${g.title} from collection`}
        title="Remove from collection"
        disabled={busy}
        onClick={onRemove}
        className="absolute right-1.5 top-1.5 z-10 grid h-5 w-5 place-items-center rounded-full text-[12px] font-bold leading-none"
        style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
      >
        <X size={11} />
      </button>
      <CardBody game={g} />
    </Link>
  );
}
