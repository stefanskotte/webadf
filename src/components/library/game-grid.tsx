'use client';

import { Link } from '@/components/shell/link';
import { useCallback } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable, type SortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { FobContext } from '@/components/nfc/fob-button';
import { DriveRing, type DriveContext } from './card-mount-button';
import { fromQuery } from '@/lib/trail';
import { useTrailView } from './use-trail-view';
import { Cover } from './cover';
import {
  EmptyLibrary, HoldsLabel, TitleControls, TitleName, dragStyle, driveState, pendingHideStyle, titleLabel,
} from './title-controls';
import type { GameListItem } from '@/lib/queries';
import { useCollectionsContext, type GameDragData, type PendingHide } from '@/components/collections/collection-provider';

export function GameGrid({ games, fob = null, drives = null }: {
  games: GameListItem[];
  /** The fob button's boards and multi-disk lists; null (no reader in the org) draws no button. */
  fob?: FobContext;
  /** Boards, what each holds, and sets' disks; null (no board in the org) draws no mount control or ring. */
  drives?: DriveContext;
}) {
  const { gameIds, filteredCollectionId, previewGameId, armedGameId, pendingHide: hidden } = useCollectionsContext();

  if (games.length === 0) return <EmptyLibrary testId="game-grid" />;

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
      {ordered.map((g) => {
        // Only the card actually named by pendingHide hides -- every
        // other card, including the drop's TARGET, renders exactly as today.
        const pendingHide = hidden?.sourceId === g.id ? hidden : null;
        return filteredCollectionId
          ? <SortableCard key={g.id} game={g} collectionId={filteredCollectionId} fob={fob} drives={drives} armed={armedGameId === g.id} pendingHide={pendingHide} />
          : <DraggableCard key={g.id} game={g} fob={fob} drives={drives} pendingHide={pendingHide} />;
      })}
    </div>
  );

  // Cards are draggable everywhere (dropping one onto a rail collection
  // works from anywhere), but only wrapped in a SortableContext -- and only
  // sortable among themselves -- while filtered: there is no single ordered
  // list to reorder in the unfiltered views. There each card is a plain drop
  // target instead (DraggableCard), and a card dropped on it asks to make
  // the two one disk set (collection-provider.tsx's onDragEnd, Case 2).
  //
  // The reorder preview shows only once the pointer has RESTED in a card's
  // EDGE (src/lib/set-folder.ts); otherwise every card stands in its own
  // slot. So the card whose centre the pointer is in stays under it while it
  // arms, and the "Add to disk set" hint is drawn where the pointer is -- and
  // a pointer merely passing through an edge on its way to the centre does
  // not send the card sliding off. dnd-kit measures drop targets without
  // transforms, so the zones never move with the preview either way.
  if (!filteredCollectionId) return grid;
  return (
    <SortableContext items={gameIds} strategy={previewGameId ? rectSortingStrategy : stillStrategy}>
      {grid}
    </SortableContext>
  );
}

/** No sibling moves: the sortable preview unless the pointer rests in a card's edge. */
const stillStrategy: SortingStrategy = () => null;

function CardBody({ game: g, collectionId, fob, drives }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext;
}) {
  const trailView = useTrailView();
  return (
    <>
      <Cover id={g.id} title={g.title} diskCount={g.diskCount} coverUrl={g.coverUrl} kind={g.kind} />
      {/* The ring says it visually; this says it to a screen reader. */}
      <HoldsLabel game={g} drives={drives} />
      <div className="flex flex-col gap-0.5 px-0.5 pb-1 pt-2.5">
        <TitleName game={g} className="truncate text-[13px] font-semibold" />
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
            {/* What is known, and nothing when nothing is (operator 2026-10-22: no "unidentified"). */}
            {[g.year, g.publisher].filter(Boolean).join(' · ') || (g.authored ? 'made here' : '')}
          </span>
          {/* Inside the card's <a href>, like the rename field, and safe the
              same way: each control stops every pointer event before it
              reaches the anchor or dnd-kit's drag listeners. */}
          <TitleControls game={g} collectionId={collectionId} fob={fob} drives={drives} view={trailView} />
        </div>
      </div>
    </>
  );
}

/**
 * What a card shows while another card is held over it in the unfiltered
 * views, or while the pointer has rested in its centre long enough to arm it
 * inside a collection: an
 * outline and the words for what a drop will offer. Nothing at rest -- the
 * state only exists mid-drag.
 */
function SetDropHint() {
  return (
    <div
      data-testid="set-drop-target"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border-2"
      style={{ borderColor: 'var(--primary-action)', background: 'rgb(11 18 28 / 0.35)' }}
    >
      <span className="rounded-full px-3 py-1 text-[12px] font-semibold text-white"
            style={{ background: 'var(--primary-action)' }}>
        Add to disk set
      </span>
    </div>
  );
}

/**
 * Unfiltered views ("All titles", "Uncategorized"): draggable onto a rail
 * collection, and a drop target for another card (make a disk set) -- not
 * sortable against siblings.
 */
function DraggableCard({ game: g, fob, drives, pendingHide }: {
  game: GameListItem; fob: FobContext; drives: DriveContext; pendingHide: PendingHide | null;
}) {
  const trailView = useTrailView();
  // `role` is pulled OUT of dnd-kit's attributes and thrown away: it is
  // "button", and this card is an <a href> that really does navigate. Spread
  // whole, it would have a screen reader announce every game in the library
  // as a button, and the 8px activation constraint exists precisely so the
  // link half keeps working. The rest of the attributes (tabIndex,
  // aria-roledescription, aria-describedby) are kept.
  const data = { type: 'game', id: g.id, title: g.title, diskCount: g.diskCount } satisfies GameDragData;
  const { attributes: dragAttributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({ id: g.id, data });
  // The same id as the draggable, as useSortable does: dnd-kit keeps the two
  // registries apart. Droppable rects are measured without transforms, so
  // the dragged card's own drop area stays where the card started, and
  // onDragEnd ignores a card dropped back on itself.
  const { setNodeRef: setDropRef, isOver, active } = useDroppable({ id: g.id, data });
  // Stable, so React does not detach and re-attach the node on every render
  // of a drag (an inline ref callback is a new function each time).
  const setNodeRef = useCallback((el: HTMLElement | null) => { setDragRef(el); setDropRef(el); }, [setDragRef, setDropRef]);
  const attributes = { ...dragAttributes, role: undefined };
  const style = { ...dragStyle(CSS.Translate.toString(transform), isDragging), ...pendingHideStyle(pendingHide) };
  const hinting = isOver && active !== null && active.id !== g.id
    && (active.data.current as { type?: string } | undefined)?.type === 'game';

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}${fromQuery(null, trailView)}`}
      aria-label={titleLabel(g)}   // the title, not the card's every line and button (final review M5)
      data-testid="game-card"
      data-drive={driveState(drives, g.id)}
      aria-hidden={pendingHide ? true : undefined}
      // An <a href> is natively draggable, so pressing one and moving started
      // the BROWSER's own link drag alongside dnd-kit's -- and dropping a
      // link onto the page makes Chrome navigate to it, which took a person
      // filing a game straight out of the library. The other half of that
      // failure (the click the browser fires at the end of a drag) is fixed
      // in collection-provider.tsx, which is the only place it CAN be fixed.
      draggable={false}
      className="glass-card relative flex flex-col p-2.5"
      style={style}
      {...attributes}
      {...listeners}
    >
      <CardBody game={g} fob={fob} drives={drives} />
      <DriveRing holds={drives?.holds[g.id]} />
      {hinting && <SetDropHint />}
    </Link>
  );
}

/**
 * Filtered-to-a-collection view: sortable against siblings (reorders the
 * collection), plus a remove control. `armed`: the pointer has rested in this
 * card's centre long enough that a drop makes a disk set (src/lib/set-folder.ts).
 */
function SortableCard({ game: g, collectionId, fob, drives, armed, pendingHide }: {
  game: GameListItem; collectionId: string; fob: FobContext; drives: DriveContext; armed: boolean; pendingHide: PendingHide | null;
}) {
  const trailView = useTrailView();
  // See DraggableCard on why `role` is discarded rather than spread.
  const { attributes: dragAttributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: g.id,
    data: { type: 'game', id: g.id, title: g.title, diskCount: g.diskCount } satisfies GameDragData,
  });
  const attributes = { ...dragAttributes, role: undefined };
  // The same 200 ms glide for every card, the target included. A card slid
  // aside by a preview can no longer be entered through its centre while the
  // preview shows (its whole slot is edge until the pointer leaves), so the
  // instant snap that once covered that case is not needed, and a jump
  // amid gliding neighbours read as a glitch.
  //
  // pendingHideStyle spreads LAST: while a set-drop dialog is open (or
  // fading back) for this card, its own opacity/visibility and transition
  // replace the reorder glide above -- there is no reorder to glide through
  // on a card-on-card drop, and this card must not visibly move at all.
  const style = { ...dragStyle(CSS.Translate.toString(transform), isDragging), transition, ...pendingHideStyle(pendingHide) };

  return (
    <Link
      ref={setNodeRef}
      // Carries the collection you are standing in, so the title's breadcrumb
      // can lead back HERE rather than to the unfiltered library. It cannot
      // be derived on the far side: a game is in many collections and
      // collection_games is many-to-many.
      href={`/games/${g.id}${fromQuery(collectionId, trailView)}`}
      aria-label={titleLabel(g)}   // the title, not the card's every line and button (final review M5)
      data-testid="game-card"
      data-drive={driveState(drives, g.id)}
      aria-hidden={pendingHide ? true : undefined}
      // See DraggableCard on why an anchor must opt out of native dragging.
      draggable={false}
      className="glass-card relative flex flex-col p-2.5"
      style={style}
      {...attributes}
      {...listeners}
    >
      <CardBody game={g} collectionId={collectionId} fob={fob} drives={drives} />
      <DriveRing holds={drives?.holds[g.id]} />
      {armed && <SetDropHint />}
    </Link>
  );
}
