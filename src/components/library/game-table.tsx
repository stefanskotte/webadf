'use client';

import { createPortal } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { DragOverlay, useDndContext, useDraggable, type Modifier } from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { Link } from '@/components/shell/link';
import { fromQuery } from '@/lib/trail';
import { useTrailView } from './use-trail-view';
import type { GameListItem } from '@/lib/queries';
import { fmtSize } from '@/lib/format';
import { emptyTableNote, tableRows, titleMeta } from '@/lib/library-table';
import { viewModeHref } from '@/lib/library-view';
import { HdTag } from '@/components/disks/hd-tag';
import type { FobContext } from '@/components/nfc/fob-button';
import {
  useCollectionsContext, type CollectionSummary, type CollectionsDragData, type GameDragData, type PendingHide,
} from '@/components/collections/collection-provider';
import { DriveRing, type DriveContext } from './card-mount-button';
import { DiskIcon } from '@/components/ui/disk-icon';
import { collectionDot, kindTag, titleDiskColor } from '@/lib/library-look';
import { DriveBadge } from './cover';
import { useLibrarySelection } from './selection-provider';
import { PageSelectBox, SelectBox } from './select-box';
import { EmptyLibrary, HoldsLabel, TitleControls, TitleName, driveState, pendingHideStyle, titleLabel } from './title-controls';

// The grid condensed (operator design 2026-10-21), restyled to the approved board (InfLibraryTable, spec §3): one row
// per title with the card's features, and the collections as folders.
//
// TYPE sits between title and year: it qualifies what the row IS, so it belongs next to the name rather than out
// among the numbers. 104px, not the board's 96: "Educational" is the longest label and at 96 its pill ran into the
// YEAR column (Ruling 12). SIZE 96 so "1.72 MB HD" fits. The last track holds the ⋯ trigger.
//
// Below sm (C7 spec §4.3, Ruling 17) a row is three tracks -- the icon, the name over a line of the facts the other
// columns held (titleMeta), the ⋯ -- and nothing scrolls sideways; from sm it is today's 760 px table.
const COLS = 'grid-cols-[40px_minmax(0,1fr)_44px] sm:grid-cols-[36px_minmax(0,1fr)_104px_56px_150px_52px_96px_44px]';
const MIN_W = 'sm:min-w-[760px]';
// While selecting (multi-select spec §1.2, Ruling 3): a leading 28 px box track; the DiskIcon and its ring stay where
// they are, and the ⋯ track stays (empty), so nothing shifts sideways inside the row.
const COLS_SELECT = 'grid-cols-[28px_40px_minmax(0,1fr)_44px] sm:grid-cols-[28px_36px_minmax(0,1fr)_104px_56px_150px_52px_96px_44px]';
const MIN_W_SELECT = 'sm:min-w-[802px]';
const rowClass = (selecting: boolean) =>
  `grid ${selecting ? COLS_SELECT : COLS} ${selecting ? MIN_W_SELECT : MIN_W} items-center gap-x-3 border-b px-4 font-sans text-[13px] sm:gap-x-[14px] sm:px-[18px]`;
/** A column the phone row folds into its fact line. */
const WIDE = 'max-sm:hidden';
const HOVER = 'hover:bg-[color:var(--surface-2)]';
const ROW_BORDER = { borderColor: 'var(--hairline)' };

export function GameTable({ games, collectionId = null, fob = null, drives = null, folderDisks = {}, firstPage = true }: {
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
  /** Library paging: the folder rows are drawn on the first page only. */
  firstPage?: boolean;
}) {
  // The collections from the shared context, not from the page: the rail
  // reorders them and bumps their counts optimistically, and the folders
  // must agree with the rail beside them.
  const { collections, view, pendingHide: hidden } = useCollectionsContext();
  const { selecting } = useLibrarySelection();
  const searchParams = useSearchParams();
  const rows = tableRows(view, collections, games, { firstPage });
  const emptyNote = emptyTableNote(view, games.length);
  // Folder and up rows keep the table: they are the table's own navigation,
  // so they say view=table outright rather than leaning on the preference.
  const tableHref = (v: Parameters<typeof viewModeHref>[0]) =>
    viewModeHref(v, 'table', new URLSearchParams(searchParams.toString()));

  if (rows.length === 0) return <EmptyLibrary testId="game-table" />;

  return (
    <div className="glass-card mx-4 overflow-hidden sm:mx-7" data-testid="game-table">
      {/* From sm the fixed tracks total ~770px and the card clips (overflow-hidden rounds its corners), so this
          wrapper scrolls the last columns into reach. Below sm the row is three tracks and nothing overflows
          (C7 Ruling 17). */}
      <div className="overflow-x-auto">
        <div className={`grid ${selecting ? COLS_SELECT : COLS} ${selecting ? MIN_W_SELECT : MIN_W} h-11 items-center gap-x-[14px] border-b px-[18px] font-sans text-[12px] font-medium max-sm:hidden`}
             style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
          {selecting && (
            <span className="grid place-items-center">
              <PageSelectBox testId="table-select-page" label="Select all titles on this page" />
            </span>
          )}
          <span /><span>Name</span><span>Type</span><span>Year</span><span>Publisher</span>
          <span className="text-right">Disks</span><span className="text-right">Size</span>
          {/* The controls' column: no header, since the rows are links, not table cells (final review M5). */}
          <span />
        </div>
        {rows.map((row) => {
          if (row.kind === 'up') return <UpRow key="up" href={tableHref({ kind: 'uncategorized' })} selecting={selecting} />;
          if (row.kind === 'folder') {
            const c = row.collection;
            return <FolderRow key={c.id} collection={c} disks={c.diskCount ?? folderDisks[c.id]}
                              href={tableHref({ kind: 'collection', id: c.id })} selecting={selecting} />;
          }
          const g = row.game;
          return (
            <TitleRow key={g.id} game={g} collectionId={collectionId ?? undefined} fob={fob} drives={drives}
                      pendingHide={hidden?.sourceId === g.id ? hidden : null} />
          );
        })}
        {emptyNote && (
          <p data-testid="table-empty-note" className="px-[18px] py-3 font-sans text-[13px]" style={{ color: 'var(--muted)' }}>
            {emptyNote}
          </p>
        )}
      </div>
      <RowDragOverlay games={games} />
    </div>
  );
}

/** Back to the library root -- the folder listing -- from a collection or All titles. */
function UpRow({ href, selecting }: { href: string; selecting: boolean }) {
  return (
    <Link href={href} data-testid="up-row" aria-label="Up to Library" className={`${rowClass(selecting)} ${HOVER} h-11`} style={ROW_BORDER}>
      {/* The box track, empty: a navigation row is not selectable (it ends selecting, Ruling 4). */}
      {selecting && <span />}
      {/* One arrow, the text's (final review M8: the icon and "↑" drew two; Ruling 13). */}
      <span />
      <span className="col-span-2 text-[14px] font-medium sm:col-span-7" style={{ color: 'var(--muted)' }}>
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
function FolderRow({ collection: c, disks, href, selecting }: { collection: CollectionSummary; disks?: number; href: string; selecting: boolean }) {
  const titles = `${c.gameCount} ${c.gameCount === 1 ? 'title' : 'titles'}`;
  const diskWords = disks === undefined ? '' : `, ${disks} ${disks === 1 ? 'disk' : 'disks'}`;
  return (
    <Link href={href} data-testid="folder-row" data-collection-id={c.id}
          aria-label={`Open collection ${c.name}, ${titles}${diskWords}`}
          className={`${rowClass(selecting)} ${HOVER} min-h-[56px] py-2 sm:h-[46px] sm:min-h-0 sm:py-0`} style={ROW_BORDER}>
      {selecting && <span />}
      {/* The board's folder: the collection's dot colour with a light overlay on the front face. */}
      <svg data-testid="folder-glyph" width="24" height="20" viewBox="0 0 24 20" aria-hidden>
        <path d="M1 3a2 2 0 0 1 2-2h6l2 2.5h10a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill={collectionDot(c.id)} />
        <path d="M1 6.5h22V17a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill="#FFFDF8" opacity="0.25" />
      </svg>
      <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
        <span className="text-[14px] font-semibold [overflow-wrap:anywhere] sm:truncate" style={{ color: 'var(--ink)' }}>{c.name}</span>
        {/* Below sm the fact line (Plan ruling, C7 Task 5); from sm the count beside the name, as before. */}
        <span data-meta="" className="text-[12px] sm:shrink-0 sm:whitespace-nowrap" style={{ color: 'var(--muted-2)' }}>
          <span className="sm:hidden">Collection · </span>
          <span data-testid="folder-titles">{titles}</span>
        </span>
      </span>
      <span className={`text-[12px] ${WIDE}`} style={{ color: 'var(--muted-2)' }}>Collection</span>
      <span className={WIDE} /><span className={WIDE} />
      <span className={`text-right font-mono ${WIDE}`} style={{ color: 'var(--muted)' }} data-testid="folder-disks">
        {disks ?? ''}
      </span>
      {/* Size is blank: no folder aggregate yet (Ruling 14). */}
      <span className={WIDE} />
      <span aria-hidden className="text-right" style={{ color: 'var(--muted-2)' }}>›</span>
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
  const trailView = useTrailView();
  const { selecting, selected } = useLibrarySelection();
  // See DraggableCard (game-grid.tsx) on why `role` is discarded rather than spread.
  const data = { type: 'game', id: g.id, title: g.title, diskCount: g.diskCount } satisfies GameDragData;
  const { attributes: dragAttributes, listeners, setNodeRef, isDragging } = useDraggable({ id: g.id, data, disabled: selecting });
  const attributes = { ...dragAttributes, role: undefined };
  // The row itself stays put while it is dragged -- RowDragOverlay carries
  // the title to the rail -- so it only fades, like a card does.
  const held = drives?.holds[g.id]?.some((h) => h.state === 'mounted');
  const style = { ...ROW_BORDER, ...(held ? { background: 'var(--mounted-bg)' } : {}), opacity: isDragging ? 0.4 : 1, ...pendingHideStyle(pendingHide) };
  const cls = `${rowClass(selecting)} ${HOVER} min-h-[56px] py-2 sm:h-[46px] sm:min-h-0 sm:py-0`;

  if (selecting) {
    // Multi-select (spec §1.2, Ruling 3): a <label> wrapping the box in the leading track, so a click anywhere on the
    // row ticks it and never navigates; drag is off.
    const checked = selected.has(g.id);
    return (
      <label ref={setNodeRef} data-testid="game-row" data-game-id={g.id} data-selected={checked ? 'true' : 'false'}
             data-drive={driveState(drives, g.id)}
             className={`${cls} cursor-pointer ${checked ? 'outline-2 -outline-offset-2 outline-(--primary-action)' : ''}`}
             style={style}>
        <span className="grid place-items-center"><SelectBox game={g} /></span>
        <RowCells game={g} collectionId={collectionId} fob={fob} drives={drives} selecting />
      </label>
    );
  }

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}${fromQuery(collectionId, trailView)}`}
      // The title, not the whole row: a screen reader otherwise reads every cell and every button as the link's name
      // (final review M5).
      aria-label={titleLabel(g)}
      data-testid="game-row"
      data-game-id={g.id}
      data-drive={driveState(drives, g.id)}
      aria-hidden={pendingHide ? true : undefined}
      // See DraggableCard on why an anchor must opt out of native dragging.
      draggable={false}
      className={cls}
      style={style}
      {...attributes}
      {...listeners}
    >
      <RowCells game={g} collectionId={collectionId} fob={fob} drives={drives} selecting={false} />
    </Link>
  );
}

/** A title row's cells after the box track: the same in both modes but for the plain name and the ⋯ spacer. */
function RowCells({ game: g, collectionId, fob, drives, selecting }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext; selecting: boolean;
}) {
  const trailView = useTrailView();
  return (
    <>
      <div className="relative h-[27px] w-[26px]">
        {/* mounted={false}: the row's one DF0 mark is the pill after the name (the grid card's rule, Task 2). */}
        <DiskIcon color={titleDiskColor(g)} size={26} hd={g.hasHd} stack={g.diskCount} mounted={false} />
        {/* The card's ring, drawn round the disk; the label says it to a screen reader. Both inside this cell: a
            bare child of the row would take a grid column of its own. */}
        <DriveRing holds={drives?.holds[g.id]} compact />
        <HoldsLabel game={g} drives={drives} />
      </div>
      <span className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {/* Below sm the whole name wraps (no ellipsis); from sm it truncates in its column, as before. */}
          <TitleName game={g} plain={selecting} className="text-[14px] font-semibold [overflow-wrap:anywhere] sm:truncate sm:text-[13px] sm:font-medium" />
          <DriveBadge holds={drives?.holds[g.id]} diskCount={g.diskCount} inline />
        </span>
        <span data-meta="" className="text-[12px] sm:hidden" style={{ color: 'var(--muted-2)' }}>{titleMeta(g)}</span>
      </span>
      <span data-testid="game-kind" className={WIDE}>
        {g.kind
          ? (
            <span className="rounded-full px-2 py-0.5 text-[12px] font-medium"
                  style={{ background: kindTag(g.kind).bg, color: kindTag(g.kind).fg }}>
              {g.kind}
            </span>
            )
          /* An em dash, not a guess. TOSEC recognises 45.9% of a real
             archive, so "unknown" is the common case and must read as
             "not identified" rather than as a category of its own. */
          : <span style={{ color: 'var(--muted-2)' }}>—</span>}
      </span>
      <span className={WIDE} style={{ color: g.year ? 'var(--ink)' : 'var(--muted-2)' }}>{g.year ?? '—'}</span>
      <span className={`truncate ${WIDE}`} style={{ color: g.publisher ? 'var(--muted)' : 'var(--muted-2)' }}>{g.publisher ?? '—'}</span>
      <span className={`text-right font-mono ${WIDE}`}
            style={{ color: g.diskCount > 1 ? 'var(--amber-text)' : 'var(--ink)' }}>
        {g.diskCount}
      </span>
      <span className={`flex items-center justify-end gap-1.5 text-right font-mono ${WIDE}`} style={{ color: 'var(--ink)' }}>
        {fmtSize(g.sizeBytes)}{g.hasHd && <HdTag testId="game-hd-tag" />}
      </span>
      {/* Inside the row's <a href>, as on the card: each control stops every
          pointer event before it reaches the anchor or dnd-kit. */}
      <span className="flex justify-self-end">
        <TitleControls game={g} collectionId={collectionId} fob={fob} drives={drives} view={trailView} selecting={selecting} />
      </span>
    </>
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
