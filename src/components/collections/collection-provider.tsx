'use client';

// The shared drag context for collections: one DndContext wrapping both the
// rail (Task 7) and the library grid, because a card is dragged FROM the
// grid TO the rail and a single context is what makes cross-tree drops work
// at all -- two separate DndContexts cannot see each other's draggables.
//
// This file owns onDragEnd and nothing about rendering: the rail and the
// grid (Task 7) supply their own draggable/droppable elements via dnd-kit's
// useDraggable/useDroppable, tagged with the drag-data shapes exported below.
// onDragEnd tells its three cases apart from that data alone -- never by
// guessing from ids, which would break the moment a game id and a collection
// id happened to collide (both are randomUUID()s from unrelated tables, so
// nothing rules that out).

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

/** What a draggable card in the library grid declares about itself. */
export interface GameDragData {
  type: 'game';
  id: string;
}

/**
 * What a rail entry declares about itself. A collection is BOTH draggable
 * (rail reordering) and droppable (a game can be dropped on it), so the same
 * shape tags both roles -- there is no separate "droppable" variant.
 */
export interface CollectionDragData {
  type: 'collection';
  id: string;
}

/**
 * The complete vocabulary onDragEnd understands. Both draggables and
 * droppables in the rail/grid tree set their dnd-kit `data` to one of these,
 * and Task 7's components import this type so the shapes can never drift
 * apart from what onDragEnd actually switches on.
 */
export type CollectionsDragData = GameDragData | CollectionDragData;

/** The subset of CollectionListItem (src/lib/collections.ts) the rail needs to render itself, kept local so this client file has no import into server/db code. */
export interface CollectionSummary {
  id: string;
  name: string;
  sortKey: number;
  gameCount: number;
}

interface CollectionsContextValue {
  /** This org's collections, in display order. Optimistically reordered by drag, reconciled by router.refresh(). */
  collections: CollectionSummary[];
  /**
   * Ids of the games currently shown in the grid, in display order.
   * Reordering only ever targets ONE collection's membership order, so this
   * list is only meaningful -- and only rendered as reorderable by Task 7 --
   * while `filteredCollectionId` is set to the collection it came from.
   */
  gameIds: string[];
  /** The collection the grid is currently filtered to, or null when showing the whole library (unfiltered games cannot be reordered: there is no single membership list to write). */
  filteredCollectionId: string | null;
}

const CollectionsContext = createContext<CollectionsContextValue | null>(null);

/** Read the live (optimistically-updated) collections/grid state. Must be called under CollectionsProvider. */
export function useCollectionsContext(): CollectionsContextValue {
  const ctx = useContext(CollectionsContext);
  if (!ctx) throw new Error('useCollectionsContext must be used within CollectionsProvider');
  return ctx;
}

export interface CollectionsProviderProps {
  collections: CollectionSummary[];
  gameIds: string[];
  filteredCollectionId: string | null;
  children: ReactNode;
}

export function CollectionsProvider({
  collections: initialCollections,
  gameIds: initialGameIds,
  filteredCollectionId,
  children,
}: CollectionsProviderProps) {
  const router = useRouter();
  const [collections, setCollections] = useState(initialCollections);
  const [gameIds, setGameIds] = useState(initialGameIds);

  // router.refresh() re-runs the server component tree and hands this
  // provider fresh `initial*` props, but useState's initial value is only
  // consulted on mount -- without reconciling here, a refresh after a
  // successful (or failed, and therefore unchanged) drag would leave the
  // optimistic snapshot in place instead of picking up what the server
  // actually has. This is React's documented "adjusting state during
  // rendering" pattern rather than a useEffect, deliberately: setState from
  // inside an effect here would itself cause the extra render-then-refetch
  // cycle the lint rule react-hooks/set-state-in-effect exists to flag.
  const [prevInitialCollections, setPrevInitialCollections] = useState(initialCollections);
  if (initialCollections !== prevInitialCollections) {
    setPrevInitialCollections(initialCollections);
    setCollections(initialCollections);
  }
  const [prevInitialGameIds, setPrevInitialGameIds] = useState(initialGameIds);
  if (initialGameIds !== prevInitialGameIds) {
    setPrevInitialGameIds(initialGameIds);
    setGameIds(initialGameIds);
  }

  // ~8px of movement before a drag starts. Without this, PointerSensor
  // starts a drag on the mousedown of a plain click -- and every card in the
  // grid is wrapped in a Link (src/components/library/game-grid.tsx), so an
  // unconstrained sensor would swallow every click that should navigate to
  // a game and make the library unclickable.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  async function addGameToCollection(collectionId: string, gameId: string) {
    setCollections((prev) => prev.map((c) =>
      c.id === collectionId ? { ...c, gameCount: c.gameCount + 1 } : c));
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collectionId}/games`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gameId }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'The game was not added to the collection.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not add the game to the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
    } finally {
      router.refresh();
    }
  }

  async function reorderGamesInCollection(collectionId: string, ids: string[]) {
    setGameIds(ids);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/collections/${collectionId}/order`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'The new order was not saved.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not save the new order', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
    } finally {
      router.refresh();
    }
  }

  async function reorderCollectionsList(next: CollectionSummary[]) {
    setCollections(next);
    try {
      let res: Response;
      try {
        res = await fetch('/api/collections/order', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: next.map((c) => c.id) }),
        });
      } catch {
        toast.error('Could not reach the server', { description: 'The new order was not saved.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not save the new order', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        return;
      }
    } finally {
      router.refresh();
    }
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return; // dropped outside any droppable -- nothing to do

    const activeData = active.data.current as CollectionsDragData | undefined;
    const overData = over.data.current as CollectionsDragData | undefined;
    if (!activeData || !overData) return;
    if (active.id === over.id) return;

    // Case 1: a game dropped on a collection -- file it there. Works from
    // anywhere a game card is draggable, filtered or not.
    if (activeData.type === 'game' && overData.type === 'collection') {
      void addGameToCollection(overData.id, activeData.id);
      return;
    }

    // Case 2: a game dropped on another game. Only meaningful while the grid
    // is filtered to one collection -- that collection's membership order is
    // the only ordered list a game-on-game drop could mean. Task 7 is
    // expected to not make grid cards droppable at all when unfiltered, but
    // this guard is the actual safety net if it ever does.
    if (activeData.type === 'game' && overData.type === 'game') {
      if (!filteredCollectionId) return;
      const oldIndex = gameIds.indexOf(activeData.id);
      const newIndex = gameIds.indexOf(overData.id);
      if (oldIndex === -1 || newIndex === -1) return;
      void reorderGamesInCollection(filteredCollectionId, arrayMove(gameIds, oldIndex, newIndex));
      return;
    }

    // Case 3: a collection dropped on another collection -- reorder the rail.
    if (activeData.type === 'collection' && overData.type === 'collection') {
      const oldIndex = collections.findIndex((c) => c.id === activeData.id);
      const newIndex = collections.findIndex((c) => c.id === overData.id);
      if (oldIndex === -1 || newIndex === -1) return;
      void reorderCollectionsList(arrayMove(collections, oldIndex, newIndex));
    }
  }

  return (
    <CollectionsContext.Provider value={{ collections, gameIds, filteredCollectionId }}>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {children}
      </DndContext>
    </CollectionsContext.Provider>
  );
}
