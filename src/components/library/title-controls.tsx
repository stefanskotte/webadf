'use client';

// The pieces a library title carries in BOTH views -- a grid card
// (game-grid.tsx) and a table row (game-table.tsx): its name with the inline
// rename, its controls in their order, the drive-state label, and the drag
// and hide styles. One copy, so the two views cannot drift apart: the table is
// the grid condensed, with the same features (operator design 2026-10-21).

import { Link } from '@/components/shell/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { History, Minus } from 'lucide-react';
import { DeleteDiskDialog } from '@/components/library/delete-disk-dialog';
import { DiskIcon } from '@/components/ui/disk-icon';
import { FobButton, type FobContext } from '@/components/nfc/fob-button';
import { CardMountButton, type DriveContext } from './card-mount-button';
import { MoveToCollectionButton } from './move-to-collection';
import { holdLabel } from '@/lib/drive-holds';
import { fromQuery, type TrailView } from '@/lib/trail';
import { ejectMessage, isMountedReason, mountedReason } from '@/lib/mount-wording';
import type { GameListItem } from '@/lib/queries';
import { type PendingHide, SET_DROP_RETURN_MS } from '@/components/collections/collection-provider';

/**
 * The library with nothing in it. `testId` is the view's own (game-grid or
 * game-table), so a check for "which view is this" holds on an empty library
 * too. The cream "New box" disk is the board's empty collection (Phase B).
 */
export function EmptyLibrary({ testId }: { testId: string }) {
  return (
    <div className="glass-card mx-4 flex flex-col items-center gap-3 p-12 text-center sm:mx-7" data-testid={testId}>
      <DiskIcon color="cream" set="Empty" title="New box" size={96} />
      <p className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>No disks yet</p>
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Drop some ADFs on the ingest page, or run <code className="font-mono">webadf push</code>.
      </p>
      <Link href="/ingest" className="btn-like rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ background: 'var(--primary-action)' }}>Add disks</Link>
    </div>
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
export function dragStyle(translate: string | undefined, isDragging: boolean) {
  return {
    transform: isDragging ? `${translate ?? ''} scale(0.55)`.trim() : translate,
    opacity: isDragging ? 0.4 : 1,
  };
}

/** 'mounted' / 'fetching' for a card whose disk is in a drive (the ring's state), else absent. */
export function driveState(drives: DriveContext, gameId: string): 'mounted' | 'fetching' | undefined {
  const holds = drives?.holds[gameId];
  if (!holds || holds.length === 0) return undefined;
  return holds.some((h) => h.state === 'mounted') ? 'mounted' : 'fetching'; // requested reads as fetching: dashed
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
export function pendingHideStyle(pendingHide: PendingHide | null): React.CSSProperties | undefined {
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
 * The title controls, in the order they read (TitleControls below): history,
 * mount, write to an NFC tag (the fob button, only when the org has a
 * reader), move to a collection (A3), remove from the collection, delete. All of them are BUTTONS,
 * including the history one that is really a navigation -- the card, and a
 * table row, is itself an <a href>, and an anchor inside an anchor is invalid
 * HTML that browsers "fix" by closing the outer one early, which would break
 * the card it sits in. Every one of them stops
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

function HistoryButton({ game: g, collectionId, view }: { game: GameListItem; collectionId?: string; view: TrailView }) {
  const router = useRouter();

  // `diskId` is a min() aggregate, so it names a real disk only on a
  // single-disk title -- the same reason the inline rename is offered only
  // there. "Which disk's history?" has no answer on a multi-disk set, and the
  // card already leads to the title page where each disk is listed with its
  // own Browse.
  if (g.diskCount !== 1 || !g.diskId) return null;
  const href = `/disks/${g.diskId}/files${fromQuery(collectionId, view)}#disk-history`;

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

/** The title's name: the inline rename on an authored single-disk title, else plain text. */
export function TitleName({ game: g, className }: { game: GameListItem; className: string }) {
  if (g.authored && g.diskId) return <VolumeNameField game={g} />;
  return <span className={className} style={{ color: 'var(--ink)' }}>{g.title}</span>;
}

/** What the drive marker (the card's ring, the row's marker) shows visually, said to a screen reader. */
export function HoldsLabel({ game: g, drives }: { game: GameListItem; drives: DriveContext }) {
  const holds = drives?.holds[g.id];
  if (!holds) return null;
  return <span className="sr-only">{holds.map((h) => holdLabel(h, g.diskCount)).join('; ')}</span>;
}

/**
 * A title's controls, in the order they read on the card and on a table row:
 * history, mount, NFC fob, remove from the collection (inside one), delete.
 * Each one stops every pointer event before it reaches the card's or row's
 * link or dnd-kit's drag listeners (see stopDrag above).
 */
/**
 * A card's or a row's accessible name: the title, and its year when known (final review M5). Without it the link's
 * name is everything inside it -- every cell and every button's label read as one long name.
 */
export function titleLabel(g: Pick<GameListItem, 'title' | 'year'>): string {
  return g.year ? `${g.title}, ${g.year}` : g.title;
}

export function TitleControls({ game: g, collectionId, fob, drives, view = null }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext;
  /** The library view to carry into the history link when it is not the person's default (trail.ts, final review M1). */
  view?: TrailView;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <HistoryButton game={g} collectionId={collectionId} view={view} />
      {drives && (
        <CardMountButton gameId={g.id} title={g.title} diskCount={g.diskCount}
                         singleDiskId={g.diskCount === 1 ? g.diskId : null} drives={drives} />
      )}
      {fob && <CardFobButton game={g} fob={fob} />}
      <MoveToCollectionButton game={g} collectionId={collectionId} />
      {collectionId && <RemoveFromCollectionButton game={g} collectionId={collectionId} />}
      <DeleteDiskDialog kind="game" id={g.id} title={g.title} diskCount={g.diskCount} />
    </div>
  );
}
