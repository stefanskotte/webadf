'use client';

import { createPortal } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { DragOverlay, useDndContext, useDraggable, type Modifier } from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { CornerLeftUp, Folder } from 'lucide-react';
import { Link } from '@/components/shell/link';
import { fromQuery } from '@/lib/trail';
import type { GameListItem } from '@/lib/queries';
import { fmtSize } from '@/lib/format';
import { tableRows } from '@/lib/library-table';
import { viewModeHref } from '@/lib/library-view';
import { HdTag } from '@/components/disks/hd-tag';
import type { FobContext } from '@/components/nfc/fob-button';
import {
  useCollectionsContext, type CollectionSummary, type CollectionsDragData, type GameDragData, type PendingHide,
} from '@/components/collections/collection-provider';
import { DriveRing, type DriveContext } from './card-mount-button';
import { CoverThumb } from './cover';
import { EmptyLibrary, HoldsLabel, TitleControls, TitleName, driveState, pendingHideStyle } from './title-controls';

// The grid condensed (operator design 2026-10-21): one row per title with the
// card's features, and the collections as folders.
//
// TYPE sits between title and year: it qualifies what the row IS, so it
// belongs next to the name rather than out among the numbers.
// 104px, not 82: "Educational" is the longest label and at 82 its pill ran
// into the YEAR column. SIZE 96 so "1.72 MB HD" fits. The last track holds the
// card's five controls at their card size (24px each), right-aligned.
const COLS = 'grid-cols-[48px_1fr_104px_50px_128px_40px_96px_128px]';
const MIN_W = 'min-w-[800px]';
const ROW = `grid ${COLS} ${MIN_W} items-center border-b px-4 py-1.5 font-mono text-[11px] hover:bg-white/40`;
const ROW_BORDER = { borderColor: 'rgb(30 45 60 / 0.05)' };

export function GameTable({ games, collectionId = null, fob = null, drives = null, folderDisks = {} }: {
  games: GameListItem[];
  /**
   * The collection currently being viewed, carried into each title's link so
   * its breadcrumb can lead back here. Null in the unfiltered library.
   */
  collectionId?: string | null;
  /** As GameGrid's: null (no reader in the org) draws no fob button. */
  fob?: FobContext;
  /** As GameGrid's: null (no board in the org) draws no mount control or marker. */
  drives?: DriveContext;
  /** Each collection's disk count, for its folder row. */
  folderDisks?: Record<string, number>;
}) {
  // The collections from the shared context, not from the page: the rail
  // reorders them and bumps their counts optimistically, and the folders
  // must agree with the rail beside them.
  const { collections, view, pendingHide: hidden } = useCollectionsContext();
  const searchParams = useSearchParams();
  const rows = tableRows(view, collections, games);
  // Folder and up rows keep the table: they are the table's own navigation,
  // so they say view=table outright rather than leaning on the preference.
  const tableHref = (v: Parameters<typeof viewModeHref>[0]) =>
    viewModeHref(v, 'table', new URLSearchParams(searchParams.toString()));

  if (rows.length === 0) return <EmptyLibrary testId="game-table" />;

  return (
    <div className="glass-card mx-4 overflow-hidden sm:mx-7" data-testid="game-table">
      {/* The fixed tracks total ~770px, and the card above clips
          (overflow-hidden, which is what rounds its corners). So on a phone
          the last columns would not merely be cramped -- they would be cut
          off with no way to reach them. This wrapper scrolls them into reach,
          and the min-width is what gives it something to scroll: without it
          the grid would just compress the 1fr title column to nothing and
          never overflow. Both are inert at desktop. */}
      <div className="overflow-x-auto">
        <div className={`grid ${COLS} ${MIN_W} items-center border-b px-4 py-2 font-mono text-[9.5px] tracking-[0.06em]`}
             style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
          <span /><span>TITLE</span><span>TYPE</span><span>YEAR</span><span>PUBLISHER</span>
          <span className="text-right">DSK</span><span className="text-right">SIZE</span>
          <span className="sr-only">Actions</span>
        </div>
        {rows.map((row) => {
          if (row.kind === 'up') return <UpRow key="up" href={tableHref({ kind: 'uncategorized' })} />;
          if (row.kind === 'folder') {
            const c = row.collection;
            return <FolderRow key={c.id} collection={c} disks={folderDisks[c.id]}
                              href={tableHref({ kind: 'collection', id: c.id })} />;
          }
          const g = row.game;
          return (
            <TitleRow key={g.id} game={g} collectionId={collectionId ?? undefined} fob={fob} drives={drives}
                      pendingHide={hidden?.sourceId === g.id ? hidden : null} />
          );
        })}
      </div>
      <RowDragOverlay games={games} />
    </div>
  );
}

/** Back to the library root -- the folder listing -- from a collection or All titles. */
function UpRow({ href }: { href: string }) {
  return (
    <Link href={href} data-testid="up-row" aria-label="Up to Library" className={ROW} style={ROW_BORDER}>
      <span className="grid h-[32px] w-[40px] place-items-center" style={{ color: 'var(--muted-2)' }}>
        <CornerLeftUp size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <span className="col-span-7 font-sans text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
        ↑ Library
      </span>
    </Link>
  );
}

/**
 * A collection as a folder: opens it, at the same address the rail row
 * uses. Not a drop target -- in the table a title is filed by dropping it on
 * the rail, the one place every view shares.
 */
function FolderRow({ collection: c, disks, href }: { collection: CollectionSummary; disks?: number; href: string }) {
  const titles = `${c.gameCount} ${c.gameCount === 1 ? 'title' : 'titles'}`;
  const diskWords = disks === undefined ? '' : `, ${disks} ${disks === 1 ? 'disk' : 'disks'}`;
  return (
    <Link href={href} data-testid="folder-row" data-collection-id={c.id}
          aria-label={`Open collection ${c.name}, ${titles}${diskWords}`}
          className={ROW} style={ROW_BORDER}>
      <span className="grid h-[32px] w-[40px] place-items-center" style={{ color: 'var(--amber-text)' }}>
        <Folder size={18} strokeWidth={1.75} aria-hidden />
      </span>
      <span className="col-span-4 flex min-w-0 items-baseline gap-2 pr-3">
        <span className="truncate font-sans text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{c.name}</span>
        <span className="shrink-0" style={{ color: 'var(--muted-2)' }} data-testid="folder-titles">{titles}</span>
      </span>
      <span className="text-right font-semibold" style={{ color: 'var(--muted-2)' }} data-testid="folder-disks">
        {disks ?? ''}
      </span>
      <span className="col-span-2" />
    </Link>
  );
}

/**
 * One title, with the card's features (CardBody in game-grid.tsx) laid out
 * along a row. Draggable onto a rail collection only: no reordering and no
 * row-on-row disk set here (grid only), so a row is never a drop target, and
 * collection-provider's onDragEnd sees exactly the GameDragData a card sends.
 */
function TitleRow({ game: g, collectionId, fob, drives, pendingHide }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext; pendingHide: PendingHide | null;
}) {
  // See DraggableCard (game-grid.tsx) on why `role` is discarded rather than spread.
  const data = { type: 'game', id: g.id, title: g.title, diskCount: g.diskCount } satisfies GameDragData;
  const { attributes: dragAttributes, listeners, setNodeRef, isDragging } = useDraggable({ id: g.id, data });
  const attributes = { ...dragAttributes, role: undefined };
  // The row itself stays put while it is dragged -- RowDragOverlay carries
  // the title to the rail -- so it only fades, like a card does.
  const style = { ...ROW_BORDER, opacity: isDragging ? 0.4 : 1, ...pendingHideStyle(pendingHide) };

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}${fromQuery(collectionId)}`}
      data-testid="game-row"
      data-drive={driveState(drives, g.id)}
      aria-hidden={pendingHide ? true : undefined}
      // See DraggableCard on why an anchor must opt out of native dragging.
      draggable={false}
      className={ROW}
      style={style}
      {...attributes}
      {...listeners}
    >
      <span className="relative w-[40px]">
        <CoverThumb id={g.id} coverUrl={g.coverUrl} />
        {/* The card's ring, drawn round the thumbnail; the label says it to
            a screen reader. Both inside this cell: a bare child of the row
            would take a grid column of its own. */}
        <DriveRing holds={drives?.holds[g.id]} compact />
        <HoldsLabel game={g} drives={drives} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 pr-3 font-sans">
        <TitleName game={g} className="truncate text-[13px] font-semibold" />
      </span>
      <span className="pr-3" data-testid="game-kind">
        {g.kind
          ? (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.02em]"
                  style={{ background: 'var(--hairline-strong)', color: 'var(--ink)' }}>
              {g.kind}
            </span>
            )
          /* An em dash, not a guess. TOSEC recognises 45.9% of a real
             archive, so "unknown" is the common case and must read as
             "not identified" rather than as a category of its own. */
          : <span style={{ color: 'var(--faint)' }}>—</span>}
      </span>
      <span style={{ color: 'var(--muted)' }}>{g.year ?? '—'}</span>
      <span className="truncate pr-3" style={{ color: 'var(--muted)' }}>{g.publisher ?? '—'}</span>
      <span className="text-right font-semibold"
            style={{ color: g.diskCount > 1 ? 'var(--amber-text)' : 'var(--muted-2)' }}>
        {g.diskCount}
      </span>
      <span className="flex items-center justify-end gap-1 text-right" style={{ color: 'var(--muted-2)' }}>
        {fmtSize(g.sizeBytes)}{g.hasHd && <HdTag testId="game-hd-tag" />}
      </span>
      {/* Inside the row's <a href>, as on the card: each control stops every
          pointer event before it reaches the anchor or dnd-kit. */}
      <span className="flex justify-end">
        <TitleControls game={g} collectionId={collectionId} fob={fob} drives={drives} />
      </span>
    </Link>
  );
}

/**
 * What follows the pointer while a row is dragged: a chip with the title.
 *
 * Not the row itself, moved by a transform as a card is. A row lives inside
 * the table's scroll box and its clipping card, so a translated row vanishes
 * the moment it leaves them -- long before it reaches the rail. The overlay
 * is portalled to <body> because the table card's backdrop-filter would
 * otherwise become the containing block of the overlay's fixed position.
 * Rendered only mid-drag (and so never on the server, where there is no
 * document). No drop animation: a title dropped on a rail collection must not
 * fly back to its row (collection-provider.tsx's pendingHide).
 */
/**
 * Puts the overlay's corner at the pointer. The overlay starts out the size
 * and place of the whole row (dnd-kit's default), so the chip in its corner
 * would otherwise trail the pointer by however far into the row it was
 * pressed -- up to most of the table's width.
 */
const chipAtPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  const p = activatorEvent ? getEventCoordinates(activatorEvent) : null;
  if (!p || !draggingNodeRect) return transform;
  return { ...transform, x: transform.x + p.x - draggingNodeRect.left + 8, y: transform.y + p.y - draggingNodeRect.top + 8 };
};

function RowDragOverlay({ games }: { games: GameListItem[] }) {
  const { active } = useDndContext();
  const data = active?.data.current as CollectionsDragData | undefined;
  if (!active || data?.type !== 'game' || !games.some((g) => g.id === data.id)) return null;
  return createPortal(
    <DragOverlay dropAnimation={null} modifiers={[chipAtPointer]}>
      <div data-testid="row-drag-overlay"
           className="inline-flex max-w-[260px] items-center rounded-full px-3 py-1 text-[12px] font-semibold text-white shadow-lg"
           style={{ background: 'var(--primary-action)' }}>
        <span className="truncate">{data.title}</span>
      </div>
    </DragOverlay>,
    document.body,
  );
}
