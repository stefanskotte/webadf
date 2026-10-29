'use client';

// The pieces a library title carries in BOTH views -- a grid card
// (game-grid.tsx) and a table row (game-table.tsx): its name with the inline
// rename, its ⋯ menu, the drive-state label, and the drag
// and hide styles. One copy, so the two views cannot drift apart: the table is
// the grid condensed, with the same features (operator design 2026-10-21).

import { Link } from '@/components/shell/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { DiskIcon } from '@/components/ui/disk-icon';
import type { FobContext } from '@/components/nfc/fob-button';
import type { DriveContext } from './card-mount-button';
import { TitleMenu } from './title-menu';
import { holdLabel } from '@/lib/drive-holds';
import type { TrailView } from '@/lib/trail';
import { ejectMessage, isMountedReason, mountedReason } from '@/lib/mount-wording';
import type { GameListItem } from '@/lib/queries';
import { type PendingHide, SET_DROP_RETURN_MS } from '@/components/collections/collection-provider';
import { useOptionalLibraryIngest } from '@/components/library-ingest/library-ingest-provider';

/**
 * The library with nothing in it (spec §8, board InfStates). `testId` is the view's own (game-grid or game-table), so
 * a check for "which view is this" holds on an empty library too. `variant` is what is empty: the whole library, or
 * one collection (the grid only; the table keeps its own note). `data-empty` names it.
 */
const EMPTY_TEXT = {
  library: {
    set: 'Your library', title: 'Empty', heading: 'No disks yet',
    body: 'Drop disks anywhere on this page, or use Add disks.', action: 'Add disks',
  },
  collection: {
    set: 'Empty', title: 'New box', heading: 'Nothing in this collection yet',
    body: 'Drag titles here, or move them from a title\u2019s \u22EF menu.', action: 'Upload disks',
  },
} as const;

export function EmptyLibrary({ testId, variant = 'library' }: { testId: string; variant?: 'library' | 'collection' }) {
  const t = EMPTY_TEXT[variant];
  // On the Library page the button opens the header's Add disks ▾ menu (R11); anywhere else it links there.
  const ingest = useOptionalLibraryIngest();
  const BUTTON = 'btn-like inline-flex h-10 items-center rounded-[10px] px-4 text-[14px] font-semibold text-white';
  return (
    <div className="mx-4 flex flex-col items-center gap-3.5 px-8 py-16 text-center sm:mx-7" data-testid={testId}
         data-empty={variant}
         style={{ background: 'var(--surface)', border: '1px dashed var(--line-strong)', borderRadius: 20 }}>
      <DiskIcon color="cream" set={t.set} title={t.title} size={96} />
      <p className="text-[22px] font-bold leading-tight"
         style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>{t.heading}</p>
      <p className="text-[14px]" style={{ color: 'var(--muted)' }}>{t.body}</p>
      {ingest ? (
        <button type="button" data-testid="empty-add-disks" onClick={() => ingest.setMenuOpen(true)}
                className={BUTTON} style={{ background: 'var(--primary-action)' }}>{t.action}</button>
      ) : (
        <Link href="/library#add-disks" data-testid="empty-add-disks"
              className={BUTTON} style={{ background: 'var(--primary-action)' }}>{t.action}</Link>
      )}
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
 * INSIDE the card's <a>, like the ⋯ menu trigger (title-menu.tsx), and safe for the
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
 * The title's name: the inline rename on an authored single-disk title, else plain text. `plain` while selecting
 * (spec §1.4): the card is a <label>, and nothing interactive sits inside it.
 */
export function TitleName({ game: g, className, plain = false }: { game: GameListItem; className: string; plain?: boolean }) {
  if (!plain && g.authored && g.diskId) return <VolumeNameField game={g} />;
  return <span className={className} style={{ color: 'var(--ink)' }}>{g.title}</span>;
}

/** What the drive marker (the card's ring, the row's marker) shows visually, said to a screen reader. */
export function HoldsLabel({ game: g, drives }: { game: GameListItem; drives: DriveContext }) {
  const holds = drives?.holds[g.id];
  if (!holds) return null;
  return <span className="sr-only">{holds.map((h) => holdLabel(h, g.diskCount)).join('; ')}</span>;
}

/**
 * A card's or a row's accessible name: the title, and its year when known (final review M5). Without it the link's
 * name is everything inside it -- every cell and every button's label read as one long name.
 */
export function titleLabel(g: Pick<GameListItem, 'title' | 'year'>): string {
  return g.year ? `${g.title}, ${g.year}` : g.title;
}

/**
 * A title's controls on a card and on a table row: the ⋯ menu (title-menu.tsx, spec §2), which holds Mount / Eject,
 * Write to NFC tag, Version history, Move to collection…, Remove from collection and Delete title in that order.
 * While selecting (multi-select spec §1.4, Ruling 7) it is a spacer the trigger's size: hidden rather than inert, so
 * nothing interactive sits inside the card's <label>, and the footer and the table's ⋯ track keep their size.
 */
export function TitleControls({ game: g, collectionId, fob, drives, view = null, selecting = false }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext;
  /** The library view to carry into the history link when it is not the person's default (trail.ts, final review M1). */
  view?: TrailView;
  selecting?: boolean;
}) {
  if (selecting) return <span aria-hidden data-controls-spacer="" className="h-11 w-11 shrink-0 sm:h-8 sm:w-8" />;
  return <TitleMenu game={g} collectionId={collectionId} fob={fob} drives={drives} view={view} />;
}
