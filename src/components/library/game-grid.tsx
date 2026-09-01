'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useDraggable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import { Cover } from './cover';
import type { GameListItem } from '@/lib/queries';
import { useCollectionsContext, type GameDragData } from '@/components/collections/collection-provider';

export function GameGrid({ games }: { games: GameListItem[] }) {
  const { gameIds, filteredCollectionId } = useCollectionsContext();

  if (games.length === 0) {
    return (
      <div className="glass-card mx-7 flex flex-col items-center gap-3 p-12 text-center" data-testid="game-grid">
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
    <div className="mx-7 grid grid-cols-5 gap-4" data-testid="game-grid">
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

function CardBody({ game: g }: { game: GameListItem }) {
  return (
    <>
      <Cover id={g.id} title={g.title} diskCount={g.diskCount} coverUrl={g.coverUrl} kind={g.kind} />
      <div className="flex flex-col gap-0.5 px-0.5 pb-1 pt-2.5">
        <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
          {g.title}
        </span>
        <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
          {[g.year, g.publisher].filter(Boolean).join(' · ') || 'unidentified'}
        </span>
      </div>
    </>
  );
}

/** Unfiltered recently-added view: draggable onto a rail collection, not sortable against siblings. */
function DraggableCard({ game: g }: { game: GameListItem }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: g.id,
    data: { type: 'game', id: g.id } satisfies GameDragData,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}`}
      data-testid="game-card"
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: g.id,
    data: { type: 'game', id: g.id } satisfies GameDragData,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const [busy, setBusy] = useState(false);

  async function onRemove(e: React.MouseEvent) {
    // Must not reach the card's own Link -- this button sits inside it, and
    // an unstopped click would both remove the game AND navigate to it.
    e.preventDefault();
    e.stopPropagation();

    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collectionId}/games/${g.id}`, { method: 'DELETE' });
      } catch {
        toast.error('Could not reach the server', { description: 'The game was not removed from the collection.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not remove the game from the collection', {
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
