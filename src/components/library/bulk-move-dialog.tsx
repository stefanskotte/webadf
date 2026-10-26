'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import type { CollectionSummary } from '@/components/collections/collection-provider';
import type { MoveResult } from '@/lib/collections';
import { moveToast, titlesWord } from '@/lib/library-selection';

const FOOT_PLAIN = 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60';
const FOOT_PRIMARY = 'h-[38px] rounded-[10px] bg-(--primary-action) px-4 text-[13px] font-semibold text-white aria-disabled:opacity-50';

/**
 * Move to collection, for a selection (spec §2.1, Rulings 8, 9, 10, 11): one dialog picks the target and confirms.
 * The single move's meaning made plural: inside a collection the titles leave it; from All titles or Uncategorized
 * they only go in. Targets are every collection but the one you are in; Uncategorized is never one.
 *
 * Busy is aria-disabled plus a ref guard, the Modal not dismissible, the request in try/catch/finally (Ruling 16).
 * A failure keeps the dialog open so OK can be pressed again ("Trying again is safe": Ruling 15).
 */
export function BulkMoveDialog({
  open, onClose, ids, collectionId, collectionName, targets, busy, setBusy, onMoved, finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  ids: string[];
  collectionId: string | null;
  collectionName: string | null;
  targets: CollectionSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onMoved: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const guard = useRef(false);
  const n = ids.length;
  const off = busy || target === null;

  function close() {
    if (busy) return;
    setTarget(null);
    onClose();
  }

  async function confirm() {
    if (target === null || guard.current) return;
    guard.current = true;
    setBusy(true);
    const name = targets.find((t) => t.id === target)?.name ?? 'the collection';
    try {
      const res = await fetch('/api/games/bulk', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'move', gameIds: ids, to: target, ...(collectionId ? { from: collectionId } : {}) }),
      });
      if (!res.ok) {
        toast.error('Could not move the titles', { description: `The server answered ${res.status}.` });
        return;
      }
      let result: MoveResult | null = null;
      try { result = await res.json() as MoveResult; } catch { /* answered 200 but unreadable: the move may have happened */ }
      if (result === null) {
        toast.error("The server's answer could not be read. Check the library to see what was moved.");
      } else {
        toast.success(moveToast(result, name));
      }
      setTarget(null);
      onMoved();
    } catch {
      toast.error('Could not reach the server', { description: 'Trying again is safe.' });
    } finally {
      setBusy(false);
      guard.current = false;
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) close(); }}
      width={440}
      testId="bulk-move-dialog"
      closeTestId="bulk-move-close"
      title="Move to collection"
      dismissible={!busy}
      finalFocus={finalFocus}
      subtitle={collectionId
        ? <>{titlesWord(n)} leave <em>{collectionName}</em> and go into the collection you pick.</>
        : `${titlesWord(n)} go into the collection you pick. Titles already in other collections stay there too.`}
      footer={(
        <div className="flex w-full items-center justify-end gap-2.5">
          <button type="button" data-testid="bulk-move-cancel" aria-disabled={busy || undefined} onClick={close}
                  className={FOOT_PLAIN}>
            Cancel
          </button>
          <button type="button" data-testid="bulk-move-confirm" aria-disabled={off || undefined}
                  onClick={() => { if (!off) void confirm(); }} className={FOOT_PRIMARY}>
            {busy ? 'Moving…' : `Move ${titlesWord(n)}`}
          </button>
        </div>
      )}
    >
      <div role="radiogroup" aria-label="Collection" className="flex flex-col gap-1 px-4 py-3">
        {targets.map((c) => (
          <label key={c.id}
                 className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 hover:bg-(--track) has-checked:bg-(--track) sm:min-h-10">
            <input type="radio" name="bulk-move-target" value={c.id} checked={target === c.id}
                   aria-disabled={busy || undefined}
                   onChange={() => { if (!busy) setTarget(c.id); }}
                   className="size-4 accent-(--primary-action)" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-(--ink)">{c.name}</span>
            <span aria-hidden className="font-mono text-[12px] text-(--muted)">
              {c.gameCount} {c.gameCount === 1 ? 'title' : 'titles'}
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
