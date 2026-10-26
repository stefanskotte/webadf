'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import type { BulkDeletePreview, BulkDeleteResult } from '@/lib/disk-delete';
import {
  deleteToast, disksWord, keptGroups, keptIntro, keptLine, nothingToDeleteText, stuckIntro, titlesWord,
} from '@/lib/library-selection';

const FOOT_PLAIN = 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60';
const FOOT_DANGER = 'h-[38px] rounded-[10px] bg-(--danger-fg) px-4 text-[13px] font-semibold text-white aria-disabled:opacity-50';

type Preview = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: BulkDeletePreview };

/**
 * Delete, for a selection (spec §2.2, Rulings 12, 13, 14): on open it previews through the same route (`dryRun`),
 * which changes nothing and covers the titles on other pages too. Titles a board holds are KEPT and named with where
 * they are; the confirm counts only the rest. OK sends only the titles the preview listed as deletable (a title shown
 * as kept stays kept even if its drive empties first) and the server re-decides, so a disk mounted since is still
 * protected, and the toast reports what really happened.
 *
 * Mounted fresh on every open (the bar bumps its key), so the preview starts at "Checking the drives…" without an
 * effect setting state; the fetch sets state only after it answers. Busy as in the Move dialog (Ruling 16).
 */
export function BulkDeleteDialog({ open, onClose, ids, busy, setBusy, onDeleted, finalFocus }: {
  open: boolean;
  onClose: () => void;
  ids: string[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  onDeleted: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const guard = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    void (async () => {
      let next: Preview = { state: 'failed' };
      try {
        const res = await fetch('/api/games/bulk', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'delete', gameIds: ids, dryRun: true }), signal: ctl.signal,
        });
        if (res.ok) next = { state: 'ready', data: await res.json() as BulkDeletePreview };
      } catch {
        // A dropped connection, an unreadable answer, or this effect cleaned up: "Could not check the drives." unless aborted.
      } finally {
        if (!ctl.signal.aborted) setPreview(next);
      }
    })();
    return () => ctl.abort();
  }, [open, attempt, ids]);

  const deletable = preview.state === 'ready' ? preview.data.deletable.titles : 0;
  const off = busy || deletable === 0;

  function close() { if (!busy) onClose(); }

  async function confirm() {
    if (off || guard.current || preview.state !== 'ready') return;
    guard.current = true;
    const sendIds = preview.data.titles.map((t) => t.id);
    setBusy(true);
    try {
      const res = await fetch('/api/games/bulk', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'delete', gameIds: sendIds }),
      });
      if (!res.ok) {
        toast.error('Could not delete the titles', { description: `The server answered ${res.status}.` });
        return;
      }
      let result: BulkDeleteResult | null = null;
      try { result = await res.json() as BulkDeleteResult; } catch { /* answered 200 but unreadable: the delete may have happened */ }
      if (result === null) {
        toast.error("The server's answer could not be read. Check the library to see what was deleted.");
      } else {
        const t = deleteToast(result);
        const opts = t.description ? { description: t.description } : undefined;
        if (result.deleted.length === 0) toast.info(t.title, opts);
        else toast.success(t.title, opts);
      }
      onDeleted();
    } catch {
      toast.error('Could not reach the server', { description: 'Trying again is safe.' });
    } finally {
      setBusy(false);
      guard.current = false;
    }
  }

  const kept = preview.state === 'ready' ? keptGroups(preview.data.kept) : { held: [], stuck: [] };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) close(); }}
      width={440}
      testId="bulk-delete-dialog"
      closeTestId="bulk-delete-close"
      title="Delete titles?"
      dismissible={!busy}
      initialFocus={cancelRef}
      finalFocus={finalFocus}
      footer={(
        <div className="flex w-full items-center justify-end gap-2.5">
          <button ref={cancelRef} type="button" data-testid="bulk-delete-cancel" aria-disabled={busy || undefined}
                  onClick={close} className={FOOT_PLAIN}>
            Cancel
          </button>
          <button type="button" data-testid="bulk-delete-confirm" aria-disabled={off || undefined}
                  onClick={() => { if (!off) void confirm(); }} className={FOOT_DANGER}>
            {busy ? 'Deleting…' : `Delete ${titlesWord(deletable)}`}
          </button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3 px-6 py-5 text-[14px] text-(--muted)">
        {preview.state === 'loading' && <p role="status">Checking the drives…</p>}
        {preview.state === 'failed' && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert">Could not check the drives.</p>
            <button type="button" data-testid="bulk-delete-retry" className={FOOT_PLAIN}
                    onClick={() => { setPreview({ state: 'loading' }); setAttempt((n) => n + 1); }}>
              Try again
            </button>
          </div>
        )}
        {preview.state === 'ready' && (
          <>
            {deletable === 0
              ? <p className="text-(--ink)">{nothingToDeleteText(preview.data.kept, preview.data.missing.length)}</p>
              : (
                <p>
                  <strong className="text-(--ink)">{titlesWord(deletable)}</strong> and {deletable === 1 ? 'its' : 'their'}{' '}
                  <strong className="text-(--ink)">{disksWord(preview.data.deletable.disks)}</strong> will be removed from your library.
                </p>
                )}
            {preview.data.titles.length > 0 && (
              <ul data-testid="bulk-delete-list" className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto text-[13px]">
                {preview.data.titles.map((t) => (
                  <li key={t.id} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate text-(--ink)">{t.title}</span>
                    <span className="shrink-0 font-mono text-[12px]">{t.year ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
            {kept.held.length > 0 && (
              <div data-testid="bulk-delete-kept" className="flex flex-col gap-1 text-[13px]">
                <p className="font-semibold text-(--ink)">{keptIntro(kept.held.length)}</p>
                <ul className="flex flex-col gap-0.5">
                  {kept.held.map((k) => <li key={k.id}>{keptLine(k)}</li>)}
                </ul>
              </div>
            )}
            {kept.stuck.length > 0 && (
              <div data-testid="bulk-delete-stuck" className="flex flex-col gap-1 text-[13px]">
                <p className="font-semibold text-(--ink)">{stuckIntro(kept.stuck.length)}</p>
                <ul className="flex flex-col gap-0.5">
                  {kept.stuck.map((k) => <li key={k.id}>{keptLine(k)}</li>)}
                </ul>
              </div>
            )}
            {deletable > 0 && (
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {/* Not "Any device holding it will be ejected": a held title is kept (Ruling 12). */}
                <li>The disk image itself is kept if anyone else has the same one.</li>
                <li>You can upload it again.</li>
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
