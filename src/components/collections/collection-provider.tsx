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
  type Active,
  type ClientRect,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DroppableContainer,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { SetDropDialog, type DropTitle } from '@/components/library/set-drop-dialog';
import {
  IDLE_FOLDER, armedId, dropOutcome, folderMove, folderTick, nextDue, previewId, zoneOf,
  type FolderState, type Hit, type Point, type Zone,
} from '@/lib/set-folder';

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
 *
 * The droppable the pointer is in also gets the ZONE of that droppable the
 * pointer is in (src/lib/set-folder.ts), on its collision's `data.zone`, and
 * the pointer itself on `data.pointer`, and the slot's middle on `data.middle`.
 * Computed here and nowhere else because this is the one place where the
 * pointer and the droppable rects are guaranteed to be the same frame, and
 * those rects are dnd-kit's transform-agnostic measurements: a card the
 * reorder preview has nudged aside still answers for its own slot, so the
 * centre cannot slide out from under the pointer. Only a card-on-card drag
 * inside a collection reads it; every other drag ignores it.
 */
export const collectionCollisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return rectIntersection(args);
  const hits = pointerWithin(args);
  const [first, ...rest] = hits;
  const rect = first ? args.droppableRects.get(first.id) : undefined;
  if (!first || !rect) return hits;
  const zone: Zone = zoneOf(args.pointerCoordinates, rect);
  const pointer: Point = { x: args.pointerCoordinates.x, y: args.pointerCoordinates.y };
  const middle: Point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return [{ ...first, data: { ...first.data, zone, pointer, middle } }, ...rest];
};

/**
 * The collision detection inside a collection view: the same as above, and
 * a drop in the GAP between cards counts as a drop on the NEAREST card
 * (operator, 2026-09-29).
 *
 * `pointerWithin` answers nothing in the 16 px gutters of the grid, so a
 * person who let go between two cards got no `over` at all and the drop was
 * silently ignored -- one of the ways "it does not detect the re-ordering".
 * Here the pointer is given to the card whose slot's middle is closest, as
 * that card's EDGE: a drop there reorders to its position, and a rest there
 * shows the same reorder preview as a rest in the card's own edge. A gap is
 * never a centre, so it never arms.
 *
 * "In the grid" is the box around every card's slot. A pointer outside it
 * -- the rail, the header, the empty page below -- keeps the plain answer,
 * so a drop there still does nothing, and a drop on a rail row (which
 * `pointerWithin` finds) is untouched. Only a GAME drag gets the fallback: a
 * collection dragged in the rail has no business landing on a card.
 *
 * One exception to "nearest": the empty cells after the LAST card, in a
 * partial last row. Nearest would give them to the card above (at 1280 with
 * six cards, index 3 rather than the end), and to a different card at phone
 * width than at desktop. A person dropping there means "at the end", so a
 * pointer in the last card's row band, to its right, goes to the last card
 * (operator ruling 2026-09-29: append). With a single row there are no such
 * cells inside the box -- the box ends at the last card -- so a drop to the
 * right of a lone row stays outside the grid and does nothing.
 *
 * Not used in the unfiltered views: there any card-on-card drop offers a
 * disk set, and a near miss must not open that dialog.
 */
export const collectionGridCollisionDetection: CollisionDetection = (args) => {
  const hits = collectionCollisionDetection(args);
  const p = args.pointerCoordinates;
  if (hits.length > 0 || !p) return hits;
  if ((args.active.data.current as CollectionsDragData | undefined)?.type !== 'game') return hits;

  type Card = { container: DroppableContainer; rect: ClientRect; distance: number };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let nearest: Card | null = null;
  let last: Card | null = null;   // in reading order: the lowest row, then the rightmost in it
  for (const container of args.droppableContainers) {
    const rect = args.droppableRects.get(container.id);
    if (!rect || (container.data.current as CollectionsDragData | undefined)?.type !== 'game') continue;
    left = Math.min(left, rect.left); top = Math.min(top, rect.top);
    right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
    const card: Card = { container, rect, distance: Math.hypot(p.x - (rect.left + rect.width / 2), p.y - (rect.top + rect.height / 2)) };
    if (!nearest || card.distance < nearest.distance) nearest = card;
    if (!last || rect.top > last.rect.top + 1 || (Math.abs(rect.top - last.rect.top) <= 1 && rect.left > last.rect.left)) last = card;
  }
  if (!nearest || !last) return hits;
  if (p.x < left || p.x > right || p.y < top || p.y > bottom) return hits;

  const afterLast = p.y >= last.rect.top && p.y <= last.rect.bottom && p.x > last.rect.right;
  const to = afterLast ? last : nearest;
  const zone: Zone = 'edge';
  return [{
    id: to.container.id,
    // `value` is what dnd-kit sorts collisions by (smaller first); there is
    // only ever this one, so it is informational: the pointer's distance
    // from the chosen card's middle.
    data: {
      droppableContainer: to.container, value: to.distance, zone,
      pointer: { x: p.x, y: p.y },
      middle: { x: to.rect.left + to.rect.width / 2, y: to.rect.top + to.rect.height / 2 },
    },
  }];
};

/**
 * The folder state machine's input: which OTHER card the dragged card is
 * over, in which zone, and where the pointer is. A gap inside the grid
 * arrives as the nearest card's edge (collectionGridCollisionDetection).
 * Null hit for the dragged card's own slot or a rail row; null altogether
 * when there is no collision to read a pointer from (outside the grid).
 */
function folderInput(active: Active, collisions: Collision[] | null): { hit: Hit | null; pointer: Point } | null {
  const first = collisions?.[0];
  const pointer = first?.data?.pointer as Point | undefined;
  if (!first || !pointer) return null;
  const activeData = active.data.current as CollectionsDragData | undefined;
  const overData = first.data?.droppableContainer?.data?.current as CollectionsDragData | undefined;
  const isCard = first.id !== active.id && activeData?.type === 'game' && overData?.type === 'game';
  const hit: Hit | null = isCard
    ? { id: String(first.id), zone: first.data?.zone as Zone, middle: first.data?.middle as Point | undefined }
    : null;
  return { hit, pointer };
}

/** What a draggable card in the library grid declares about itself. */
export interface GameDragData {
  type: 'game';
  id: string;
  /** The card's title and disk count, for the "Add to a disk set" dialog a
   *  card-on-card drop opens (at once in the unfiltered views; from an armed
   *  card's centre inside a collection). */
  title?: string;
  diskCount?: number;
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
  /**
   * Inside a collection view: the card whose EDGE the pointer has rested in,
   * so the grid shows the reorder preview. While it is null no card moves.
   */
  previewGameId: string | null;
  /**
   * The same card once the pointer has rested in its centre for
   * ARM_DELAY_MS: a drop there makes a disk set. The grid draws the "Add to
   * disk set" hint on it. Null otherwise.
   */
  armedGameId: string | null;
  /**
   * The card that was DRAGGED into a drop that is still being resolved, and
   * so is hidden rather than flown back to its slot. Cards in game-grid.tsx
   * hide themselves (opacity/visibility, not display, so the grid does not
   * reflow). Null the rest of the time. Two reasons:
   *
   *  - 'set': a "make a disk set" drop, while its dialog is open or fading
   *    back after a close without success.
   *  - 'collection': a card dropped on a rail collection (operator,
   *    2026-09-29), while the add is saving and until the refresh after it
   *    lands; then it fades back in if the refreshed view still has it
   *    (Uncategorized no longer does), and at once on a failure.
   */
  pendingHide: PendingHide | null;
}

/** See `pendingHide` above. */
export interface PendingHide {
  /** The id of the card that was dragged. */
  sourceId: string;
  reason: 'set' | 'collection';
  /** 'collection' only: the add succeeded and router.refresh() is on its way. */
  saved?: boolean;
  /** True while this card is fading back into view; false while it is simply
   *  hidden (dialog open, add saving, or a success awaiting router.refresh()). */
  returning: boolean;
}

/**
 * How long the fade-back takes once a close-without-success starts it (ms).
 * The one place this number lives -- game-grid.tsx imports it rather than
 * keeping its own copy, so the timer here and the CSS transition it starts
 * cannot drift apart.
 */
export const SET_DROP_RETURN_MS = 200;

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
  /** In a collection: every title of it, in its order -- `gameIds` is one PAGE of it (library paging). A drag inside
   *  the page is applied to this whole list, which is what the order route takes; absent, `gameIds` is the whole list. */
  collectionOrder?: string[];
  view: LibraryView;
  uncategorizedCount: number;
  children: ReactNode;
}

export function CollectionsProvider({
  collections: initialCollections,
  gameIds: initialGameIds,
  filteredCollectionId,
  collectionOrder,
  view,
  uncategorizedCount,
  children,
}: CollectionsProviderProps) {
  const router = useRouter();
  const [collections, setCollections] = useState(initialCollections);
  const [gameIds, setGameIds] = useState(initialGameIds);
  /** A card dropped on a card in an unfiltered view, awaiting confirmation. */
  const [setDrop, setSetDrop] = useState<{ target: DropTitle; source: DropTitle } | null>(null);

  /**
   * Folder-style card-on-card inside a collection view. The state drives the
   * hint and the still preview; the ref is what the timer and onDragEnd read,
   * so neither can see a value from a render that has already been superseded.
   */
  const [folder, setFolder] = useState<FolderState>(IDLE_FOLDER);
  const folderRef = useRef<FolderState>(IDLE_FOLDER);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function updateFolder(next: FolderState) {
    folderRef.current = next;
    setFolder(next);
  }
  function scheduleArm() {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    const due = nextDue(folderRef.current);
    if (due === null) return;
    // Re-checked on the tick rather than assumed: a timer can fire a hair
    // early against performance.now(), and then it simply waits the rest.
    const wait = Math.max(1, due - performance.now());
    armTimer.current = setTimeout(() => {
      armTimer.current = null;
      updateFolder(folderTick(folderRef.current, performance.now()));
      scheduleArm();
    }, wait);
  }
  function resetFolder() {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    updateFolder(IDLE_FOLDER);
  }

  /** See PendingHide above. */
  const [pendingHide, setPendingHide] = useState<PendingHide | null>(null);
  // A card fading back stops being pending once its fade has run. Keyed on
  // the pending object itself, so a newer drop (or a reset) cancels the
  // timer of the one it replaced.
  useEffect(() => {
    if (!pendingHide?.returning) return;
    const t = setTimeout(() => setPendingHide((p) => (p === pendingHide ? null : p)), SET_DROP_RETURN_MS);
    return () => clearTimeout(t);
  }, [pendingHide]);

  useEffect(() => () => {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
  }, []);

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
    // A refresh means the server has re-rendered: on a successful add the
    // source game is gone from the grid for real (merged into the target),
    // and on a plain reorder/collection edit it was never the hidden card to
    // begin with. Either way any hide/return bookkeeping left over from a
    // PREVIOUS, already-closed drop is stale once new data has landed, so it
    // is cleared here rather than left to the return timer -- which never
    // runs at all on the success path.
    //
    // Gated on the dialog being closed (`setDrop === null`): an Add that
    // FAILS still calls router.refresh() (confirm(), set-drop-dialog.tsx) to
    // show a title that may have gone, but leaves the dialog OPEN. `games`
    // (library/page.tsx) is rebuilt into a new array on every server render
    // regardless of whether anything in it changed, so this branch runs on
    // that refresh too -- and clearing pendingHide then would pop the
    // hidden card back to full visibility right underneath the still-open
    // dialog. `closeSetDrop` (Cancel, Escape, the backdrop, or the dialog's
    // own success close) is what resolves a pending hide while the dialog is
    // up; this is only the cleanup for after it has closed.
    //
    // A 'collection' hide is resolved by the refresh after its add SUCCEEDED
    // (saved): it fades back in -- a card the refreshed view no longer has
    // (Uncategorized, once filed) is simply not drawn. Before that, a refresh
    // leaves it hidden; a failure has already started its fade.
    if (setDrop === null && pendingHide) {
      if (pendingHide.reason === 'set') setPendingHide(null);
      else if (pendingHide.saved && !pendingHide.returning) setPendingHide({ ...pendingHide, returning: true });
    }
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
    // Hidden the instant it is dropped, not flown back to its slot (see
    // PendingHide). Only THIS drop's hide is ever advanced below: a newer
    // drop or drag has replaced it otherwise.
    const mine: PendingHide = { sourceId: gameId, reason: 'collection', returning: false };
    setPendingHide(mine);
    const fadeBack = () => setPendingHide((p) => (p === mine ? { ...mine, returning: true } : p));
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
        fadeBack();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error('Could not add the title to the collection', {
          description: typeof body.error === 'string' ? body.error : undefined,
        });
        fadeBack();
        return;
      }
      setPendingHide((p) => (p === mine ? { ...mine, saved: true } : p));
    } finally {
      router.refresh();
    }
  }

  // `ids` is the collection's whole new order (what the route takes); `shown`, when given, is the page of it on screen.
  async function reorderGamesInCollection(collectionId: string, ids: string[], shown?: string[]) {
    setGameIds(shown ?? ids);
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
    resetFolder();
    // A fresh drag makes any hide/return left over from a previous drop
    // stale (the dialog it belonged to is already closed -- nothing else can
    // start a drag while it is open, but a Cancel's fade-back is still
    // running its timer when this fires, and that timer must not go on to
    // hide the card the person just picked back up again).
    setPendingHide(null);
  }

  /**
   * Fires on every pointer move of a drag (not while it rests -- the timer
   * covers that). Entering a card's centre starts its arm clock, leaving it
   * disarms at once; in an edge, a pointer that stops drifting starts the
   * reorder preview. A move that changes neither re-renders nothing. Only
   * inside a collection view -- the unfiltered views make a set on any drop
   * and have no reorder preview to hold still.
   */
  function onDragMove({ active, collisions }: DragMoveEvent) {
    if (!filteredCollectionId) return;
    const input = folderInput(active, collisions);
    const next = input
      ? folderMove(folderRef.current, input.hit, input.pointer, performance.now())
      : folderMove(folderRef.current, null, { x: 0, y: 0 }, performance.now());
    if (next === folderRef.current) return;
    updateFolder(next);
    scheduleArm();
  }

  /**
   * A cancelled drag (Escape, or a lost pointer) never reaches onDragEnd, so
   * it needs its own disarm -- otherwise the flag stays set and eats the next
   * real click anywhere on the page.
   */
  function onDragCancel() {
    setTimeout(() => { suppressNextClick.current = false; }, 0);
    resetFolder();
  }

  function onDragEnd(event: DragEndEvent) {
    // Armed on drag start, disarmed here on the next task -- by then the
    // click belonging to this drag has been dispatched (the browser fires it
    // in the same input-processing sequence as the mouseup that ended the
    // drag). Without this, a drag that produced no click at all would leave
    // the flag set and eat the NEXT real click on the page.
    setTimeout(() => { suppressNextClick.current = false; }, 0);

    const { active, over } = event;
    // Read before the reset: the arm state at the moment of release.
    const folderAtDrop = folderRef.current;
    resetFolder();
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

    // Case 2: a game dropped on another game. Unfiltered ("All titles",
    // "Uncategorized"), where there is no ordered list, any drop means "make
    // these two one disk set". Filtered to one collection
    // (src/lib/set-folder.ts): a drop on a card whose centre the pointer has
    // held still in until it armed makes a set; any other drop on a card --
    // its edge, or its centre before it arms -- reorders. A set deletes a
    // title, so it only ever opens the confirm dialog and never acts on the
    // drop itself.
    if (activeData.type === 'game' && overData.type === 'game') {
      const outcome = filteredCollectionId ? dropOutcome(folderAtDrop, String(over.id)) : 'set';
      if (outcome === 'set') {
        // Hidden the instant the dialog opens, not animated back to its slot
        // by dnd-kit's own drop animation underneath it. `returning: false`:
        // this is the drop, not a close, so it is not fading back yet.
        setPendingHide({ sourceId: activeData.id, reason: 'set', returning: false });
        setSetDrop({
          target: { id: overData.id, title: overData.title ?? '', diskCount: overData.diskCount ?? 0 },
          source: { id: activeData.id, title: activeData.title ?? '', diskCount: activeData.diskCount ?? 0 },
        });
        return;
      }
      // Moved within the WHOLE collection, not the page: both titles are on this page, so the move is the same, and
      // the titles on other pages keep their places (library paging, 2026-10-22).
      const full = collectionOrder ?? gameIds;
      const oldIndex = full.indexOf(activeData.id);
      const newIndex = full.indexOf(overData.id);
      if (!filteredCollectionId || oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(full, oldIndex, newIndex);
      const onPage = new Set(gameIds);
      void reorderGamesInCollection(filteredCollectionId, next, collectionOrder ? next.filter((id) => onPage.has(id)) : undefined);
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

  /**
   * The dialog's onClose: called for Cancel, Escape, the backdrop, AND a
   * successful add (set-drop-dialog.tsx). Only the last one passes `true`.
   * A success leaves the source card hidden -- router.refresh() is about to
   * remove it from the grid for real, and unhiding it first would flash it
   * back for a frame first. Everything else fades it back into view.
   */
  function closeSetDrop(success?: boolean) {
    setSetDrop(null);
    if (success) return;
    setPendingHide((p) => (p ? { ...p, returning: true } : p));
  }

  return (
    <CollectionsContext.Provider value={{ collections, gameIds, filteredCollectionId, view, uncategorizedCount, previewGameId: previewId(folder), armedGameId: armedId(folder), pendingHide }}>
      {/*
        `id` is not decoration. dnd-kit derives the hidden drag description's
        element id from a MODULE-LEVEL counter (useUniqueId in
        @dnd-kit/utilities) when none is given -- and that module lives for
        the whole life of the server process, so the server rendered
        aria-describedby="DndDescribedBy-10" while a freshly loaded client
        started again at 0. React reported a hydration mismatch on every
        /library load. A fixed id is the same on both sides.
      */}
      <DndContext id="collections-dnd" sensors={sensors} collisionDetection={filteredCollectionId ? collectionGridCollisionDetection : collectionCollisionDetection} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        {children}
      </DndContext>
      {setDrop && <SetDropDialog target={setDrop.target} source={setDrop.source} onClose={closeSetDrop} />}
    </CollectionsContext.Provider>
  );
}
