'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCollectionsContext } from '@/components/collections/collection-provider';
import { countText, offPageCount, offPageText } from '@/lib/library-selection';
import { useLibrarySelection } from './selection-provider';
import { PageSelectBox } from './select-box';
import { BulkMoveDialog } from './bulk-move-dialog';
import { BulkDeleteDialog } from './bulk-delete-dialog';

// 30 px from sm, 44 px below; flex-1 on the phone's second line (spec §1.3, §6, Ruling 20).
const BTN = 'grid h-11 flex-1 place-items-center rounded-[7px] px-3 text-[13px] font-semibold sm:h-[30px] sm:flex-none '
  + 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--surface) '
  + 'aria-disabled:cursor-default aria-disabled:opacity-50';
const PLAIN = `${BTN} bg-(--on-ink-fill) text-(--surface)`;
const DANGER = `${BTN} bg-(--danger-fg) text-white`;

/**
 * The selection bar (spec §1.3, Rulings 2, 5, 6) and the host of its dialogs. Always in the DOM while the page has
 * titles, hidden while not selecting (Plan ruling, Task 4): the count's live region exists before it first changes,
 * and the dialogs stay mounted through their close. Sticky at the top of the grid/table column, so the operations stay
 * in reach down a 48-title page. Nothing is sent from here: only a dialog's confirm writes.
 */
export function LibrarySelectionBar({ collectionId, collectionName }: {
  /** The collection you are in, or null in All titles / Uncategorized. */
  collectionId: string | null;
  collectionName: string | null;
}) {
  const router = useRouter();
  const sel = useLibrarySelection();
  const { collections } = useCollectionsContext();
  const [dialog, setDialog] = useState<'move' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpens, setDeleteOpens] = useState(0);
  const pageBox = useRef<HTMLInputElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  // Set by a successful OK: the dialog's close then hands focus to the toggle (or the h1), not to its opener.
  const done = useRef(false);

  const ids = useMemo(() => [...sel.selected.keys()], [sel.selected]);
  const n = ids.length;
  const off = offPageCount(sel.selected, sel.pageTitles.map((t) => t.id));
  const targets = collections.filter((c) => c.id !== collectionId);
  const moveReason = n === 0 ? 'Select titles first' : targets.length === 0 ? 'Make a collection first' : null;
  const deleteReason = n === 0 ? 'Select titles first' : null;

  // Toggle on puts focus on "All on this page" (spec §1.1). Focus only; no state is set here.
  useEffect(() => { if (sel.selecting) pageBox.current?.focus(); }, [sel.selecting]);

  function open(which: 'move' | 'delete', reason: string | null) {
    if (reason || busy) return;
    done.current = false;
    // A fresh Delete dialog per open: its preview starts again from "Checking the drives…".
    if (which === 'delete') setDeleteOpens((n) => n + 1);
    setDialog(which);
  }
  /** After a successful OK (spec §1.6): selecting ends, the dialog closes, the library refreshes. */
  function finished() {
    done.current = true;
    setDialog(null);
    sel.end();
    router.refresh();
  }
  // After a successful OK the dialog's close hands focus to the toggle (or the h1); a cancel gives it back to the opener.
  // Written inline per dialog: a helper that reads the refs would be called during render (react-hooks/refs).

  return (
    <>
      <div
        role="region"
        aria-label="Selected titles"
        data-testid="library-selection-bar"
        hidden={!sel.selecting}
        className="sticky top-0 z-20 mx-4 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-(--ink) px-4 py-2 text-[13px] text-(--surface) sm:mx-7"
      >
        <label className="flex min-h-11 cursor-pointer items-center gap-2 font-semibold sm:min-h-[30px]">
          <PageSelectBox testId="library-select-page" onInk inputRef={pageBox} />
          All on this page
        </label>
        <span role="status" aria-live="polite" data-testid="library-selection-count" className="min-w-0 flex-1 font-semibold">
          {countText(n)}
          {off > 0 && <span data-testid="library-selection-offpage">{offPageText(off)}</span>}
        </span>
        <div className="flex w-full gap-2 sm:w-auto">
          <button ref={moveRef} type="button" data-testid="library-bulk-move" className={PLAIN}
                  aria-disabled={moveReason || busy ? 'true' : undefined} title={moveReason ?? undefined}
                  onClick={() => open('move', moveReason)}>
            Move to collection…
          </button>
          <button ref={deleteRef} type="button" data-testid="library-bulk-delete" className={DANGER}
                  aria-disabled={deleteReason || busy ? 'true' : undefined} title={deleteReason ?? undefined}
                  onClick={() => open('delete', deleteReason)}>
            Delete…
          </button>
          <button type="button" data-testid="library-selection-cancel" className={PLAIN}
                  aria-disabled={busy || undefined} onClick={() => { if (!busy) sel.cancel(); }}>
            Cancel
          </button>
        </div>
      </div>
      <BulkMoveDialog
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        ids={ids}
        collectionId={collectionId}
        collectionName={collectionName}
        targets={targets}
        busy={busy}
        setBusy={setBusy}
        onMoved={finished}
        finalFocus={() => (done.current ? sel.focusTarget() : moveRef.current)}
      />
      <BulkDeleteDialog
        key={deleteOpens}
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        ids={ids}
        busy={busy}
        setBusy={setBusy}
        onDeleted={finished}
        finalFocus={() => (done.current ? sel.focusTarget() : deleteRef.current)}
      />
    </>
  );
}
