'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FolderInput } from 'lucide-react';
import { useCollectionsContext } from '@/components/collections/collection-provider';
import type { GameListItem } from '@/lib/queries';

const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };

/**
 * "Move to collection…" on a title (A3, the approved boards' title menu): a list of the org's collections; picking
 * one files the title there. From All titles or Uncategorized that is an add (which takes it out of Uncategorized);
 * inside a collection it is a move -- added there, then removed from the one you are standing in. A title can be in
 * several collections, so "move" means leaving this one, not every other.
 *
 * The existing routes only: POST /api/collections/[id]/games, then DELETE .../games/[gameId]. Add first, so a
 * failure between the two leaves the title in both rather than in neither.
 */
export function MoveToCollectionButton({ game: g, collectionId }: { game: GameListItem; collectionId?: string }) {
  const router = useRouter();
  const { collections } = useCollectionsContext();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const targets = collections.filter((c) => c.id !== collectionId);

  async function move(targetId: string, name: string) {
    setBusy(true);
    try {
      const added = await fetch(`/api/collections/${targetId}/games`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId: g.id }),
      });
      if (!added.ok) { toast.error(`Could not move ${g.title}`, { description: `The server answered ${added.status}.` }); return; }
      if (collectionId) {
        const removed = await fetch(`/api/collections/${collectionId}/games/${g.id}`, { method: 'DELETE' });
        if (!removed.ok) {
          toast.error(`${g.title} was added to ${name} but is still here too`, { description: 'Remove it from this collection to finish the move.' });
          return;
        }
      }
      toast.success(`Moved to ${name}`);
      setOpen(false);
    } catch {
      toast.error('Could not reach the server', { description: `${g.title} was not moved.` });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const trigger = (
    <button
      type="button"
      data-testid={`move-to-collection-${g.id}`}
      aria-label={`Move ${g.title} to a collection`}
      title="Move to collection…"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--hairline)] hover:text-[var(--ink)]"
      style={{ color: 'var(--faint)' }}
    >
      <FolderInput size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
  if (!open) return trigger;

  // Portalled for the same reason as the delete dialog (delete-disk-dialog.tsx): a card's backdrop-filter, or
  // dnd-kit's transform, would otherwise become the containing block of the fixed overlay.
  return (
    <>
      {trigger}
      {createPortal((
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgb(11 18 28 / 0.55)' }}
          onPointerDown={stop}
          onMouseDown={stop}
          onTouchStart={stop}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (e.target === e.currentTarget && !busy) setOpen(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setOpen(false); }}
        >
          <div role="dialog" aria-modal="true" aria-label={`Move ${g.title} to a collection`} data-testid="move-dialog"
               className="glass-card flex w-full max-w-[360px] flex-col gap-3 p-5 text-left">
            <h2 className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>Move to collection</h2>
            <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--ink)' }}>{g.title}</strong>
              {collectionId ? ' leaves this collection and goes into the one you pick.' : ' goes into the collection you pick.'}
            </p>
            {targets.length === 0 ? (
              <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
                {collectionId ? 'There is no other collection yet.' : 'There are no collections yet.'} Make one in the
                list beside the library.
              </p>
            ) : (
              <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
                {targets.map((c) => (
                  <li key={c.id}>
                    <button type="button" disabled={busy} autoFocus={c.id === targets[0].id}
                            onClick={() => void move(c.id, c.name)}
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-semibold hover:bg-[var(--hairline)] disabled:opacity-50"
                            style={{ color: 'var(--ink)' }}>
                      {c.name}
                      <span className="font-mono text-[10.5px] font-normal" style={{ color: 'var(--muted)' }} aria-hidden>
                        {c.gameCount} title{c.gameCount === 1 ? '' : 's'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <button type="button" disabled={busy} onClick={() => setOpen(false)}
                      className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50" style={{ color: 'var(--muted)' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </>
  );
}
