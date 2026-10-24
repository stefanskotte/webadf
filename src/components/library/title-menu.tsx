'use client';

// The ⋯ title menu on a library card and a table row (spec 2026-10-24-phase-c1-library-title-design.md §2; board:
// ModernLibrary `role=menu`). One trigger instead of the six inline icon buttons the card and row carried; every
// item keeps the old button's test id, accessible name and behaviour.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FolderMinus } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_ITEM_HIGHLIGHT } from '@/components/ui/menu-item-look';
import { FobDialog, type FobContext } from '@/components/nfc/fob-button';
import { DeleteDialog } from './delete-disk-dialog';
import { CardMountDialog, useCardMount, type DriveContext } from './card-mount-button';
import { MoveToCollectionDialog } from './move-to-collection';
import { holdAction, holdLabel } from '@/lib/drive-holds';
import { fromQuery, type TrailView } from '@/lib/trail';
import type { GameListItem } from '@/lib/queries';

/**
 * Stops an event before it bubbles any further up the REACT tree. The popup is portalled to <body>, but React
 * bubbles a portal's events through its React parents -- here the card's or row's <Link> (a click navigates) and
 * dnd-kit's listeners on it (a mousedown / touchstart starts a drag). Bubble phase only: Base UI's outside-press
 * and Escape listeners sit on the document in the CAPTURE phase or on keydown, which nothing here stops.
 */
const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };
const STOP_ALL = { onPointerDown: stop, onMouseDown: stop, onTouchStart: stop, onClick: stop } as const;

/** No board in the org: `useCardMount` still runs (hooks cannot be conditional) and reports nothing available. */
const NO_DRIVES: NonNullable<DriveContext> = { devices: [], holds: {}, disksByGame: {} };

type Which = null | 'mount' | 'fob' | 'move' | 'delete';

const ITEM = `h-11 gap-2.5 rounded-lg px-2.5 py-0 text-[13px] sm:h-9 ${MENU_ITEM_HIGHLIGHT} `
  + '[&_svg:not([class*=size-])]:size-4';

/** The board's glyphs, 16 px, `currentColor`. */
const Glyph = {
  mount: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 19l-7-9h14z" /><rect x="5" y="4" width="14" height="2.5" rx="1" /></svg>
  ),
  eject: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 5l7 9H5z" /><rect x="5" y="17.5" width="14" height="2.5" rx="1" /></svg>
  ),
  nfc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 8.5a5 5 0 0 1 0 7" /><path d="M10 6a9 9 0 0 1 0 12" /><path d="M14 3.5a13 13 0 0 1 0 17" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
    </svg>
  ),
  move: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16v12H4z" /><path d="M4 7l2-3h12l2 3" />
    </svg>
  ),
  delete: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" />
    </svg>
  ),
  more: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  ),
};

/**
 * A title's ⋯ menu. Items, in the board's order: Mount / Eject (with a board), Write to NFC tag (with a reader),
 * Version history (one disk), Move to collection…, Remove from collection (inside one), then Delete title.
 *
 * The dialogs live HERE, outside the popup: Base UI unmounts the popup when it closes, which is the moment an item
 * is picked, so a dialog owned by the item would vanish with it. `which` says which one is open; closing it puts
 * focus back on the ⋯ trigger.
 */
export function TitleMenu({ game: g, collectionId, fob, drives, view = null }: {
  game: GameListItem; collectionId?: string; fob: FobContext; drives: DriveContext;
  /** The library view to carry into the history link when it is not the person's default (trail.ts). */
  view?: TrailView;
}) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [which, setWhich] = useState<Which>(null);
  // Read by the popup's finalFocus as it closes, which is before React has re-rendered with the new `which`.
  const opening = useRef<Which>(null);
  const [removing, setRemoving] = useState(false);

  const singleDiskId = g.diskCount === 1 ? g.diskId : null;
  const mount = useCardMount({ gameId: g.id, diskCount: g.diskCount, singleDiskId, drives: drives ?? NO_DRIVES });
  const showMount = drives !== null && mount.available;

  // A single-disk title writes its one disk; a set asks which (its disks come from the page's own list, since
  // `diskId` is a min() aggregate that names a disk only on a single-disk title).
  const fobDisks = fob
    ? (g.diskCount === 1 && g.diskId ? [{ id: g.diskId, diskNo: 1 }] : fob.disksByGame[g.id] ?? [])
    : [];
  const showFob = fob !== null && fobDisks.length > 0;
  // "Which disk's history?" has no answer on a set; the title page lists each disk with its own Browse.
  const historyHref = g.diskCount === 1 && g.diskId
    ? `/disks/${g.diskId}/files${fromQuery(collectionId, view)}#disk-history`
    : null;

  // One click mounts when there is nothing to choose: one disk, one board, and that board's DF1 Off (DF1 On always
  // asks which drive).
  const direct = drives !== null && mount.disks.length === 1 && drives.devices.length === 1 && drives.devices[0].df1 === null;

  function openDialog(next: Exclude<Which, null>) {
    opening.current = next;
    setWhich(next);
  }

  function closeDialog() {
    opening.current = null;
    setWhich(null);
    triggerRef.current?.focus();
  }

  function onMount() {
    const { holds, disks, ejecting, act, undo } = mount;
    if (!drives) return;
    if (ejecting) {
      if (holds.length === 1) { void undo(holds[0]); return; }
      openDialog('mount');
      return;
    }
    if (direct) { void act(drives.devices[0].id, disks[0].id); return; }
    openDialog('mount');
  }

  async function onRemove() {
    if (!collectionId) return;
    setRemoving(true);
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
      }
    } finally {
      setRemoving(false);
      router.refresh();
    }
  }

  const single = mount.holds.length === 1 ? mount.holds[0] : null;
  const verb = single ? holdAction(single) : 'Eject';
  const mountTitle = mount.ejecting
    ? `${mount.holds.map((h) => holdLabel(h, g.diskCount)).join('; ')} · ${single ? verb : 'Eject or cancel'}`
    : 'Mount';
  const mountText = mount.ejecting
    ? (single ? (verb === 'Cancel' ? 'Cancel mount' : 'Eject from DF0') : 'Eject or cancel…')
    : (direct ? 'Mount in DF0' : 'Mount…');

  return (
    // `contents`: no box of its own. It catches what bubbles out of the menu's portalled parts that are not the
    // popup -- Base UI's modal backdrop -- before it reaches the card's Link or dnd-kit.
    <span className="contents" {...STOP_ALL}>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          data-testid={`title-menu-${g.id}`}
          aria-label={`More actions for ${g.title}`}
          // Inside the card's <a href>: the click must not navigate (preventDefault: the anchor's own default), and
          // the press must not reach dnd-kit's activators (stop on pointer/mouse/touch down).
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onPointerDown={stop}
          onMouseDown={stop}
          onTouchStart={stop}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg transition-colors hover:bg-[var(--track)] hover:text-[var(--ink)] data-popup-open:bg-[var(--track)] sm:h-8 sm:w-8"
          style={{ color: 'var(--muted)' }}
        >
          {Glyph.more}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-testid="title-menu-panel"
          // Back to the trigger, unless the item just picked opened a dialog: that dialog takes focus, and returns
          // it to the trigger itself when it closes.
          finalFocus={() => opening.current === null}
          className="w-[216px] max-w-[calc(100vw-2rem)] rounded-xl p-1.5 ring-0"
          style={{
            background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--line)',
            boxShadow: '0 20px 40px -12px rgb(36 33 27 / 0.3)',
          }}
          {...STOP_ALL}
        >
          {showMount && (
            <DropdownMenuItem
              data-testid={`${mount.ejecting ? 'card-eject' : 'card-mount'}-${g.id}`}
              aria-label={mount.ejecting
                ? (single ? `${verb} ${g.title} — ${holdLabel(single, g.diskCount)}` : `Eject or cancel ${g.title}`)
                : `Mount ${g.title}`}
              title={mountTitle}
              disabled={mount.busy}
              onClick={(e) => { e.stopPropagation(); onMount(); }}
              className={`${ITEM} font-semibold`}
            >
              {mount.ejecting ? Glyph.eject : Glyph.mount}{mountText}
            </DropdownMenuItem>
          )}
          {showFob && (
            <DropdownMenuItem
              data-testid={`fob-${g.id}`}
              aria-label={`Write ${g.title} to an NFC tag`}
              onClick={(e) => { e.stopPropagation(); openDialog('fob'); }}
              className={ITEM}
            >
              {Glyph.nfc}Write to NFC tag
            </DropdownMenuItem>
          )}
          {historyHref && (
            <DropdownMenuItem
              data-testid={`history-${g.id}`}
              aria-label={`Version history for ${g.title}`}
              onClick={(e) => { e.stopPropagation(); router.push(historyHref); }}
              className={ITEM}
            >
              {Glyph.history}Version history
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            data-testid={`move-to-collection-${g.id}`}
            aria-label={`Move ${g.title} to a collection`}
            onClick={(e) => { e.stopPropagation(); openDialog('move'); }}
            className={ITEM}
          >
            {Glyph.move}Move to collection…
          </DropdownMenuItem>
          {collectionId && (
            <DropdownMenuItem
              data-testid={`remove-from-collection-${g.id}`}
              aria-label={`Remove ${g.title} from collection`}
              disabled={removing}
              onClick={(e) => { e.stopPropagation(); void onRemove(); }}
              className={ITEM}
            >
              <FolderMinus strokeWidth={2} aria-hidden />Remove from collection
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="mx-1.5 my-1" style={{ background: 'var(--line)' }} />
          <DropdownMenuItem
            data-testid={`delete-game-${g.id}`}
            aria-label={`Delete ${g.title}`}
            variant="destructive"
            onClick={(e) => { e.stopPropagation(); openDialog('delete'); }}
            className={`${ITEM} *:[svg]:text-[var(--danger-fg)]`}
            style={{ color: 'var(--danger-fg)' }}
          >
            {Glyph.delete}Delete title
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {drives && (
        <CardMountDialog gameId={g.id} title={g.title} diskCount={g.diskCount} singleDiskId={singleDiskId}
                         drives={drives} mount={mount} open={which === 'mount'} onClose={closeDialog} />
      )}
      {fob && (
        <FobDialog title={g.title} disks={fobDisks} devices={fob.devices} open={which === 'fob'} onClose={closeDialog} />
      )}
      {which === 'move' && <MoveToCollectionDialog game={g} collectionId={collectionId} open onClose={closeDialog} />}
      <DeleteDialog kind="game" id={g.id} title={g.title} diskCount={g.diskCount} open={which === 'delete'}
                    onClose={closeDialog} />
    </span>
  );
}
