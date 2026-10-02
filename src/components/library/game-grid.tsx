'use client';

import { Link } from '@/components/shell/link';
import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable, type SortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { History, Minus } from 'lucide-react';
import { DeleteDiskDialog } from '@/components/library/delete-disk-dialog';
import { FobButton, type FobContext } from '@/components/nfc/fob-button';
import { CardMountButton, driveRingStyle, type DriveContext } from './card-mount-button';
import { holdLabel } from '@/lib/drive-holds';
import { fromQuery } from '@/lib/trail';
import { ejectMessage, isMountedReason, mountedReason } from '@/lib/mount-wording';
import { Cover } from './cover';
import type { GameListItem } from '@/lib/queries';
import { useCollectionsContext, type GameDragData, type PendingHide, SET_DROP_RETURN_MS } from '@/components/collections/collection-provider';

export function GameGrid({ games, fob = null, drives = null }: {
  games: GameListItem[];
  /** The fob button's boards and multi-disk lists; null (no reader in the org) draws no button. */
  fob?: FobContext;
  /** Boards, what each holds, and sets' disks; null (no board in the org) draws no mount control or ring. */
  drives?: DriveContext;
}) {
  const { gameIds, filteredCollectionId, previewGameId, armedGameId, pendingHide: hidden } = useCollectionsContext();

  if (games.length === 0) {
    return (
      <div className="glass-card mx-4 flex flex-col items-center gap-3 p-12 text-center sm:mx-7" data-testid="game-grid">
        <p className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>No disks yet</p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Drop some ADFs on the ingest page, or run <code className="font-mono">webadf push</code>.
        </p>
        <Link href="/ingest" className="btn-like rounded-lg px-4 py-2 text-sm font-semibold text-white"
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

/** 'mounted' / 'fetching' for a card whose disk is in a drive (the ring's state), else absent. */
function driveState(drives: DriveContext, gameId: string): 'mounted' | 'fetching' | undefined {
  const holds = drives?.holds[gameId];
  if (!holds || holds.length === 0) return undefined;
  return holds.some((h) => h.state === 'mounted') ? 'mounted' : 'fetching';
}

/** SET_DROP_RETURN_MS (collection-provider.tsx) is the one place this duration lives. */
const RETURN_TRANSITION = `opacity ${SET_DROP_RETURN_MS}ms ease`;

/**
 * Overrides `dragStyle`'s opacity while the card is the one named by
 * `pendingHide` (collection-provider.tsx): the "Add to a disk set" dialog
 * is open for a drop THIS card was the source of, or it was dropped on a
 * rail collection and that add has not resolved yet.
 *
 * `visibility`, not `display`, so the card's slot in the grid keeps its
 * space -- the sibling the drop landed on must not shift. It is set
 * alongside `opacity` rather than instead of it: Playwright (and a person)
 * both read `visibility:hidden` as "not visible", but only `opacity` can be
 * animated smoothly, which is what the fade-back needs.
 *
 * Not returning (the drop just happened, or a success is awaiting
 * router.refresh()): hidden with NO transition -- dnd-kit's own drop
 * animation is exactly the flight back to this slot that this feature
 * exists to suppress, and animating opacity down would still show it
 * happening underneath the fade.
 *
 * Returning (Cancel, Escape, the backdrop, or an error that closed the
 * dialog; a collection add that failed, or whose refresh has landed): `visibility` flips back to `visible` in the same instant --
 * invisible on its own, since opacity is still 0 -- and THAT change is what
 * carries the transition, fading the card back in instead of popping it.
 */
function pendingHideStyle(pendingHide: PendingHide | null): React.CSSProperties | undefined {
  if (!pendingHide) return undefined;
  return pendingHide.returning
    ? { visibility: 'visible', opacity: 1, transition: RETURN_TRANSITION, pointerEvents: 'none' }
    : { visibility: 'hidden', opacity: 0, transition: 'none', pointerEvents: 'none' };
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
 *
 * A disk a board holds cannot be renamed (operator decision 2026-09-18: a
 * mounted volume is changed only from the Amiga side). The field is still
 * drawn -- disabled, with the reason written under it -- rather than hidden:
 * an absent field would read the same as "this title cannot be renamed".
 */
function VolumeNameField({ game: g }: { game: GameListItem }) {
  const router = useRouter();
  const [name, setName] = useState(g.title);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const locked = g.holderName !== null
    ? ejectMessage(mountedReason(g.holderName), 'renaming')
    : null;

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
        // Mounted between this page loading and the edit: say where, and
        // refresh so the card shows the lock instead of the field.
        const body = await res.json().catch(() => null) as { error?: string; reason?: string } | null;
        if (res.status === 409 && body?.error === 'mounted' && body.reason && isMountedReason(body.reason)) {
          toast.error(ejectMessage(body.reason, 'renaming'));
          setName(g.title);
          router.refresh();
          return;
        }
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
    <>
    <input
      data-testid={`volume-name-${g.id}`}
      aria-label={`Volume name for ${g.title}`}
      aria-describedby={locked ? reasonId : undefined}
      title={locked ?? undefined}
      value={name}
      disabled={busy || locked !== null}
      onChange={(e) => setName(e.target.value)}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setName(g.title); e.currentTarget.blur(); }
      }}
      onBlur={commit}
      className="w-full truncate rounded border bg-transparent px-1 py-0.5 text-[13px] font-semibold disabled:opacity-60"
      style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}
    />
    {locked && (
      <span id={reasonId} data-testid={`volume-name-locked-${g.id}`}
            className="text-[10.5px] leading-snug" style={{ color: 'var(--amber-text)' }}>
        {locked}
      </span>
    )}
    </>
  );
}

/**
 * The card controls, in the order they read: history, write to an NFC tag
 * (the fob button, only when the org has a reader), remove from the
 * collection, delete. All of them are BUTTONS, including the history one that
 * is really a navigation -- the card itself is an <a href>, and an anchor
 * inside an anchor is invalid HTML that browsers "fix" by closing the outer
 * one early, which would break the card it sits in. Every one of them stops
 * its pointer, mouse and touch-start events before they reach the card's
 * link or dnd-kit's drag listeners (stopDrag), the same way the inline
 * rename field does.
 *
 * They share one subdued resting colour (`--faint`) and take their meaning
 * from hover: destructive controls go red, the history one does not.
 */
/** A card control's press must not reach dnd-kit's activators on the card:
 *  mousedown for the MouseSensor, touchstart for the TouchSensor. */
const stopDrag = (e: React.SyntheticEvent) => { e.stopPropagation(); };

function HistoryButton({ game: g, collectionId }: { game: GameListItem; collectionId?: string }) {
  const router = useRouter();

  // `diskId` is a min() aggregate, so it names a real disk only on a
  // single-disk title -- the same reason the inline rename is offered only
  // there. "Which disk's history?" has no answer on a multi-disk set, and the
  // card already leads to the title page where each disk is listed with its
  // own Browse.
  if (g.diskCount !== 1 || !g.diskId) return null;
  const href = `/disks/${g.diskId}/files${fromQuery(collectionId)}#disk-history`;

  return (
    <button
      type="button"
      data-testid={`history-${g.id}`}
      aria-label={`Version history for ${g.title}`}
      title="Version history"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        router.push(href);
      }}
      onPointerDown={stopDrag}
      onMouseDown={stopDrag}
      onTouchStart={stopDrag}
      className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--glass-strong)] hover:text-[var(--ink)]"
      style={{ color: 'var(--faint)' }}
    >
      <History size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function RemoveFromCollectionButton({ game: g, collectionId }: { game: GameListItem; collectionId: string }) {
  const router = useRouter();
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
    <button
      type="button"
      data-testid={`remove-from-collection-${g.id}`}
      aria-label={`Remove ${g.title} from collection`}
      title="Remove from collection"
      disabled={busy}
      onClick={onRemove}
      onPointerDown={stopDrag}
      onMouseDown={stopDrag}
      onTouchStart={stopDrag}
      className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--danger-bg)] hover:text-[var(--danger-fg)] disabled:opacity-50"
      style={{ color: 'var(--faint)' }}
    >
      <Minus size={14} strokeWidth={2.25} aria-hidden />
    </button>
  );
}

/**
 * The fob button on a card. A single-disk title writes its one disk; a set
 * asks which disk first. `diskId` is a min() aggregate and names the disk
 * only on a single-disk title (see HistoryButton), so a set's disks come
 * from the page's own list instead.
 */
function CardFobButton({ game: g, fob }: { game: GameListItem; fob: NonNullable<FobContext> }) {
  const disks = g.diskCount === 1 && g.diskId
    ? [{ id: g.diskId, diskNo: 1 }]
    : fob.disksByGame[g.id] ?? [];
  if (disks.length === 0) return null;
  return <FobButton testId={`fob-${g.id}`} title={g.title} disks={disks} devices={fob.devices} />;
}

function CardBody({ game: g, collectionId, fob, drives }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext;
}) {
  const holds = drives?.holds[g.id];
  return (
    <>
      <Cover id={g.id} title={g.title} diskCount={g.diskCount} coverUrl={g.coverUrl} kind={g.kind} />
      {/* The ring says it visually; this says it to a screen reader. */}
      {holds && <span className="sr-only">{holds.map((h) => holdLabel(h, g.diskCount)).join('; ')}</span>}
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
          {/* Inside the card's <a href>, like the rename field, and safe the
              same way: each control stops every pointer event before it
              reaches the anchor or dnd-kit's drag listeners. */}
          <div className="flex shrink-0 items-center">
            <HistoryButton game={g} collectionId={collectionId} />
            {drives && (
              <CardMountButton gameId={g.id} title={g.title} diskCount={g.diskCount}
                               singleDiskId={g.diskCount === 1 ? g.diskId : null} drives={drives} />
            )}
            {fob && <CardFobButton game={g} fob={fob} />}
            {collectionId && <RemoveFromCollectionButton game={g} collectionId={collectionId} />}
            <DeleteDiskDialog kind="game" id={g.id} title={g.title} diskCount={g.diskCount} />
          </div>
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
  const style = { ...driveRingStyle(drives?.holds[g.id]), ...dragStyle(CSS.Translate.toString(transform), isDragging), ...pendingHideStyle(pendingHide) };
  const hinting = isOver && active !== null && active.id !== g.id
    && (active.data.current as { type?: string } | undefined)?.type === 'game';

  return (
    <Link
      ref={setNodeRef}
      href={`/games/${g.id}`}
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
  const style = { ...driveRingStyle(drives?.holds[g.id]), ...dragStyle(CSS.Translate.toString(transform), isDragging), transition, ...pendingHideStyle(pendingHide) };

  return (
    <Link
      ref={setNodeRef}
      // Carries the collection you are standing in, so the title's breadcrumb
      // can lead back HERE rather than to the unfiltered library. It cannot
      // be derived on the far side: a game is in many collections and
      // collection_games is many-to-many.
      href={`/games/${g.id}${fromQuery(collectionId)}`}
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
      {armed && <SetDropHint />}
    </Link>
  );
}
