'use client';
import { Trash2 } from 'lucide-react';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Confirming the removal of a title, or of one disk.
 *
 * NO TYPED-NAME GATE, unlike delete-user-dialog. That gate exists because
 * deleting a user destroys someone else's whole library and cannot be undone
 * by re-doing anything. This is the person's own disk, and an ADF they
 * uploaded can be uploaded again -- so the protection that fits is naming
 * exactly what is about to happen, not making them type it out.
 *
 * WHAT IT MUST SAY, because none of it is guessable from a Delete button:
 * that a device holding the disk will be ejected, and that the bytes are not
 * destroyed for anyone else who has them.
 */
export function DeleteDiskDialog({
  kind, id, title, diskCount, onDeleted, redirectWhenGone,
}: {
  kind: 'game' | 'disk';
  id: string;
  title: string;
  /** Only meaningful for a title: how many disks go with it. */
  diskCount?: number;
  onDeleted?: () => void;
  /**
   * Where to go when this deletion removes the subject of the CURRENT page.
   *
   * Set by the title page, where deleting the last disk empties the title and
   * the server deletes it too. Left unset on the library grid, where the page
   * is the library and outlives any card on it.
   */
  redirectWhenGone?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const url = kind === 'game' ? `/api/games/${id}` : `/api/disks/${id}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(kind === 'game' ? 'Could not delete the title' : 'Could not delete the disk');
        return;
      }
      const body = await res.json().catch(() => null);
      const ejected: string[] = body?.ejected ?? [];
      toast.success(kind === 'game' ? 'Title deleted' : 'Disk deleted', {
        // Named because it is a real side effect on hardware, not a detail.
        description: ejected.length > 0
          ? `Ejected from ${ejected.join(', ')}.`
          : undefined,
      });
      setOpen(false);
      onDeleted?.();

      // THE SERVER TELLS US WHETHER THE TITLE STILL EXISTS, so we do not have
      // to guess from `kind`: deleting the LAST disk of a title removes the
      // title too (disk-delete.ts), and `gameDeleted` reports exactly that.
      // Refreshing in that case re-runs a page whose subject is gone, which
      // is a 404 on the page someone was just using.
      //
      // REPLACE, not push: the deleted title's URL must not stay in history,
      // or Back returns to the 404 this exists to avoid.
      if (body?.gameDeleted && redirectWhenGone) router.replace(redirectWhenGone);
      else router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`delete-${kind}-${id}`}
        aria-label={`Delete ${title}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        /*
         * A quiet icon, not a red pill.
         *
         * The red box was doing danger-signalling on a control that cannot do
         * damage on its own: every path through here opens a confirmation
         * that names what will be deleted and cannot be dismissed by accident
         * (see the dialog's own comment on what it must say). Shouting at the
         * trigger buys nothing and costs a red rectangle on every card in the
         * library, which crowds the thing people are actually looking at --
         * the titles. The confirmation is where the danger colour belongs,
         * and it is still there on the confirm button.
         *
         * The hit area stays the size it was; only the paint changed. The
         * accessible name still says what will be deleted, because "trash
         * icon" is not a description of anything to a screen reader.
         */
        className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--danger-bg)] hover:text-[var(--danger-fg)]"
        style={{ color: 'var(--faint)' }}
        title={`Delete ${title}`}
      >
        <Trash2 size={14} strokeWidth={1.75} aria-hidden />
      </button>
    );
  }

  const disks = diskCount ?? 1;

  // No "am I mounted yet" guard is needed, and adding one would trip this
  // repo's set-state-in-effect rule for nothing: `open` starts false and can
  // only be set by a click, so the server never renders this branch and
  // document is always there by the time it does.
  //
  // PORTALLED TO document.body, and it has to be.
  //
  // This dialog is rendered from inside a library card, and .glass-card sets
  // backdrop-filter. A filtered ancestor becomes the CONTAINING BLOCK for its
  // fixed-position descendants, so `fixed inset-0` resolved against the card
  // rather than the viewport: the overlay came out about 145px wide, wedged
  // inside the card, with the text in a column one word across. A transform
  // on the same ancestor (dnd-kit sets one while dragging) does the same
  // thing. The portal is what escapes both.
  return createPortal((
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgb(11 18 28 / 0.55)' }}
      // The dialog is rendered from inside a draggable card on the library, so
      // every event that could reach the card is stopped at the overlay.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      // touchstart too: dnd-kit's TouchSensor activates on it, and without
      // this a press-and-hold inside the dialog dragged the card behind it.
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${title}`}
        data-testid="delete-dialog"
        className="glass-card w-full max-w-[440px] p-6 text-left"
      >
        <h2 className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>
          Delete {kind === 'game' ? 'this title' : 'this disk'}?
        </h2>
        <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
          <strong style={{ color: 'var(--ink)' }}>{title}</strong>
          {kind === 'game' && disks > 1 ? ` and its ${disks} disks` : ''} will be removed from
          your library.
        </p>
        <ul className="mt-3 flex flex-col gap-1 text-[12.5px]" style={{ color: 'var(--muted)' }}>
          <li>Any device holding it will be ejected.</li>
          {/* Content addressing is not obvious, and someone deleting a disk
              deserves to know it is not being destroyed for anyone else. */}
          <li>The disk image itself is kept if anyone else has the same one.</li>
          <li>You can upload it again.</li>
        </ul>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="delete-cancel"
            disabled={busy}
            onClick={() => setOpen(false)}
            className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
            style={{ color: 'var(--muted)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="delete-confirm"
            disabled={busy}
            onClick={confirm}
            className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--danger-fg)' }}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
