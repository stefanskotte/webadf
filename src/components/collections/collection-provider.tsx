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

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { LibraryView } from '@/lib/library-view';
import {
  DndContext,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

/**
 * Resolve the drop from the POINTER, not from the dragged card's rectangle.
 *
 * dnd-kit's default is `rectIntersection`, which picks whichever droppable the
 * DRAGGED ELEMENT overlaps most. A library card is about 178x200; a rail row
 * is about 198x31 with a couple of pixels between rows. So one card covers
 * three or four rows at once, and the one with the greatest overlap is
 * routinely NOT the one under the cursor -- a title would land in the
 * collection above or below the one being aimed at, with nothing on screen
 * explaining why. Reported as "it's hard to spot which collection you are
 * actually hitting"; the aiming was the bug, the missing highlight only hid it.
 *
 * `pointerWithin` requires the pointer to be inside the droppable, which is
 * how a person believes dragging works, and it is what lets the rail's
 * highlight be honest: the row lighting up is the row `over` resolves to,
 * because both read the same value.
 *
 * The `rectIntersection` fallback is not decoration -- `pointerWithin` needs
 * pointer coordinates and returns nothing without them (a keyboard sensor, if
 * one is ever added), and silently dropping nothing would be worse.
 */
export const collectionCollisionDetection: CollisionDetection = (args) =>
  (args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args));

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
  /** The collection the grid is currently filtered to, or null when showing the whole library or the uncategorized inbox (neither can be reordered: there is no single membership list to write). */
  filteredCollectionId: string | null;
  /** Which slice the page is showing. Separate from filteredCollectionId
   *  because "Uncategorized" and "All titles" are both null there and the
   *  rail has to tell them apart to mark the right row as current. */
  view: LibraryView;
  /** Titles in no collection at all, counted the same way and at the same
   *  moment as every collection's own count. */
  uncategorizedCount: number;
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
  view: LibraryView;
  uncategorizedCount: number;
  children: ReactNode;
}

export function CollectionsProvider({
  collections: initialCollections,
  gameIds: initialGameIds,
  filteredCollectionId,
  view,
  uncategorizedCount,
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

  /**
   * Swallow the click the browser fires at the END of a drag.
   *
   * Every game card is an <a href>, so without this, dropping one onto a
   * collection filed the game AND navigated to it -- the person lands on a
   * game page instead of seeing their library. That is not fixable on the
   * card: dnd-kit's pointer sensors already install their OWN document-level
   * capture listener that calls stopPropagation() on that click (see
   * handleStart in AbstractPointerSensor, which both MouseSensor and
   * TouchSensor extend), so React's delegated onClick -- and
   * therefore next/link's own handler -- never runs at all. What it does NOT
   * do is preventDefault(), and the browser's default action on an anchor is
   * to follow the href.
   *
   * So the fix has to be a listener on the same node. stopPropagation does
   * not stop other listeners already registered on document, only the
   * remaining path, so this one still runs and can prevent the default.
   *
   * Found by e2e/collections.spec.ts's drag test, which ended up on
   * /games/<id> instead of on the library it started from.
   */
  const suppressNextClick = useRef(false);
  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      if (!suppressNextClick.current) return;
      suppressNextClick.current = false;
      e.preventDefault();
    }
    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, []);

  /**
   * Mouse and touch are two sensors, not one PointerSensor, because the two
   * inputs need different answers to "was that a drag or a tap?".
   *
   * Mouse keeps the ~8px threshold it has always had: without it a drag starts
   * on the mousedown of a plain click -- and every card in the grid is wrapped
   * in a Link (src/components/library/game-grid.tsx), so an unconstrained
   * sensor would swallow every click that should navigate to a game and make
   * the library unclickable.
   *
   * Touch cannot use distance for that, because on a phone a finger moving 8px
   * across a card is how you SCROLL the library -- a distance constraint would
   * pick a card up every time someone tried to look further down the page.
   * Press-and-hold is the gesture that means "pick this up" instead, so touch
   * gets a delay. `tolerance` is not optional on dnd-kit's delay form: it is
   * the movement budget during the hold, and exceeding it aborts the drag,
   * which is precisely what lets a swipe scroll rather than drag.
   *
   * PointerSensor could not have been kept alongside TouchSensor: it keys on
   * onPointerDown with no pointerType check, so one finger would have
   * activated both. And the delay had to go on the TOUCH path only --
   * e2e/collections.spec.ts drives page.mouse, which presses and moves
   * immediately without ever holding, so a delay on the mouse path would fail
   * every drag test at 1280.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
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
        toast.error('Could not reach the server', { description: 'The title was not added to the collection.' });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not add the title to the collection', {
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

  function onDragStart() {
    suppressNextClick.current = true;
  }

  /**
   * A cancelled drag (Escape, or a lost pointer) never reaches onDragEnd, so
   * it needs its own disarm -- otherwise the flag stays set and eats the next
   * real click anywhere on the page.
   */
  function onDragCancel() {
    setTimeout(() => { suppressNextClick.current = false; }, 0);
  }

  function onDragEnd(event: DragEndEvent) {
    // Armed on drag start, disarmed here on the next task -- by then the
    // click belonging to this drag has been dispatched (the browser fires it
    // in the same input-processing sequence as the mouseup that ended the
    // drag). Without this, a drag that produced no click at all would leave
    // the flag set and eat the NEXT real click on the page.
    setTimeout(() => { suppressNextClick.current = false; }, 0);

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
    <CollectionsContext.Provider value={{ collections, gameIds, filteredCollectionId, view, uncategorizedCount }}>
      {/*
        `id` is not decoration. dnd-kit derives the hidden drag description's
        element id from a MODULE-LEVEL counter (useUniqueId in
        @dnd-kit/utilities) when none is given -- and that module lives for
        the whole life of the server process, so the server rendered
        aria-describedby="DndDescribedBy-10" while a freshly loaded client
        started again at 0. React reported a hydration mismatch on every
        /library load. A fixed id is the same on both sides.
      */}
      <DndContext id="collections-dnd" sensors={sensors} collisionDetection={collectionCollisionDetection} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        {children}
      </DndContext>
    </CollectionsContext.Provider>
  );
}
