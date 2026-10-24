'use client';

// "Add to a disk set": what a library card dropped on another card asks
// before anything moves (approved 2026-09-29). The TARGET is the title whose
// disks come first and which becomes the set; the other title's disks follow
// and that title is emptied and deleted by the server. Swap flips the two.
//
// Portalled, like AddDisksDialog: a glass card sets backdrop-filter, which
// would otherwise be the containing block of this `fixed` overlay. Below `sm`
// it is a full-width sheet at the bottom of the screen with 44px targets.
//
// Every pointer, mouse and touch event is stopped at the overlay: it renders
// inside the library's DndContext tree (React portals still bubble through
// the component tree), and a press here must never start a card drag.

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowUpDown } from 'lucide-react';
import type { UndoSnapshot } from '@/lib/disk-set-store';
import { addErrorText } from '@/lib/disk-set-errors';
import { movedToast } from '@/components/games/moved-toast';

export interface DropTitle {
  id: string;
  title: string;
  diskCount: number;
}

// 44px below `sm` (touch), the house 30px pill from `sm` up.
const PILL =
  'inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-full border px-4 text-[12.5px] font-semibold disabled:opacity-50 sm:h-[30px]';

function disks(n: number): string {
  return `${n} ${n === 1 ? 'disk' : 'disks'}`;
}

/**
 * Render only while open. `target` is the card that was dropped ON, `source`
 * the card that was dragged. `onClose` is called for Cancel, Escape, a
 * backdrop press and after a successful add -- the last one, and only that
 * one, passes `true`, so the caller (collection-provider.tsx) can tell a
 * close that leaves the source card hidden (awaiting router.refresh()) apart
 * from one that fades it back into view.
 */
export function SetDropDialog({ target: dropTarget, source: dropSource, onClose }: {
  target: DropTitle;
  source: DropTitle;
  onClose: (success?: boolean) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const nameId = useId();
  const [swapped, setSwapped] = useState(false);
  const target = swapped ? dropSource : dropTarget;
  const source = swapped ? dropTarget : dropSource;
  // The name follows the target's title until the person types their own;
  // after that a Swap leaves what they typed alone.
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? target.title;
  const [busy, setBusy] = useState(false);
  const canConfirm = !busy && name.trim() !== '';

  // Escape closes, also with focus left on the page behind (the overlay's own
  // onKeyDown covers focus inside the dialog).
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busyRef.current) closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function confirm() {
    if (!canConfirm) return;
    const setName = name.trim();
    setBusy(true);
    let res: Response;
    try {
      res = await fetch(`/api/games/${target.id}/disks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceGameIds: [source.id], rename: setName }),
      });
    } catch {
      setBusy(false);
      toast.error('Could not reach the server', { description: 'Nothing was moved.' });
      return;
    }
    if (!res.ok) {
      setBusy(false);
      const body = await res.json().catch(() => ({}));
      toast.error('Could not make the disk set', {
        description: addErrorText((body as { error?: unknown }).error),
      });
      // A title that has gone (another tab, a delete) is best shown as it is now.
      router.refresh();
      return;
    }
    const { undo } = (await res.json()) as { undo: UndoSnapshot[] };
    onClose(true);
    // Undo from the library stays in the library: the restored card reappears.
    movedToast(setName, undo, router, 'stay');
    router.refresh();
  }

  const row = (t: DropTitle, n: number) => (
    <li className="flex min-w-0 items-baseline gap-2" data-testid={`set-drop-order-${n}`}>
      <span className="font-mono text-[11px]" style={{ color: 'var(--muted)' }}>{n}.</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-bold" title={t.title}>{t.title}</span>
      <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>{disks(t.diskCount)}</span>
    </li>
  );

  return createPortal((
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center sm:p-4"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose(); }}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' && !busy) onClose(); }}
    >
      <div
        role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="set-drop-dialog"
        className="wf-modal flex w-full min-w-0 flex-col gap-3 rounded-t-[14px] border p-4 text-left shadow-xl backdrop-blur-xl sm:max-w-[440px] sm:rounded-[14px] sm:p-5"
        style={{ background: 'var(--glass-strong)', borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}
      >
        <h2 id={titleId} className="text-[15px] font-bold">Add to a disk set</h2>

        <div className="flex min-w-0 items-center gap-2">
          <ol className="flex min-w-0 flex-1 flex-col gap-1" aria-label="Disk order">
            {row(target, 1)}
            {row(source, 2)}
          </ol>
          <button type="button" data-testid="set-drop-swap" onClick={() => setSwapped((s) => !s)} disabled={busy}
                  aria-label="Swap which title comes first"
                  className={PILL} style={{ borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}>
            <ArrowUpDown size={14} aria-hidden />
            Swap
          </button>
        </div>
        <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
          {`“${target.title}”’s disks come first, then “${source.title}”’s. “${source.title}” is then removed from the library as a title of its own, and its cover, Demozoo link and collection memberships go with it.`}
        </p>

        <label htmlFor={nameId} className="text-[12px] font-semibold">Set name</label>
        <input
          id={nameId} data-testid="set-drop-name" autoFocus required maxLength={80}
          value={name} onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void confirm(); } }}
          className="h-11 min-w-0 rounded-[10px] border px-3 text-[13px] outline-none sm:h-[34px]"
          style={{ borderColor: 'var(--hairline-strong)', background: 'var(--glass)', color: 'var(--ink)' }}
        />

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" data-testid="set-drop-cancel" onClick={() => onClose()} disabled={busy}
                  className={PILL} style={{ borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}>
            Cancel
          </button>
          <button type="button" data-testid="set-drop-confirm" onClick={() => { void confirm(); }}
                  disabled={!canConfirm} className={`${PILL} text-white`}
                  style={{ borderColor: 'var(--primary-action)', background: 'var(--primary-action)' }}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
