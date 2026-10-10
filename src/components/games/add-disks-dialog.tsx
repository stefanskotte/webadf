'use client';

// The "Add disks…" dialog (disk-sets spec §5, mockup view 3), in two modes:
//
//  - 'add': opened from a set's "Add disks…". Pick any number of other titles;
//    every disk of each joins THIS title, at the end, in their own order.
//  - 'target': opened from a lone disk's "Add to a disk set…" (view 4). Pick
//    exactly ONE title; this disk joins it, and the page goes there.
//
// Either way the server moves whole titles (a picked title is emptied and
// deleted), so it answers with one undo snapshot per title it removed, and the
// toast offers Undo for all of them.
//
// Portalled, like FobButton and DeleteDiskDialog: a glass card sets
// backdrop-filter, which would otherwise be the containing block of this
// `fixed` overlay. Below `sm` it is a full-screen sheet with 44px targets.

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import type { CandidateTitle } from '@/lib/disk-set-search';
import type { UndoSnapshot } from '@/lib/disk-set-store';
import { addErrorText } from '@/lib/disk-set-errors';
import { movedToast } from './moved-toast';

export type AddDisksMode =
  /** Add other titles' disks to `gameId` (a set). */
  | { kind: 'add'; gameId: string; title: string }
  /** Move lone disk `diskId` (of title `gameId`) into a set picked here. */
  | { kind: 'target'; gameId: string; diskId: string };

const DEBOUNCE_MS = 250;
// One page of the list; "Show more" asks for another. The server's
// CANDIDATE_PAGE (src/lib/disk-set-search.ts, not importable here: it is
// server code) is the same number, and the server clamps whatever is sent.
const PAGE = 20;

// 44px below `sm` (touch), the house 30px pill from `sm` up.
const PILL =
  'inline-flex h-11 shrink-0 items-center justify-center rounded-full border px-4 text-[12.5px] font-semibold disabled:opacity-50 sm:h-[30px]';

function diskName(d: CandidateTitle['disks'][number]): string {
  return d.tosecName ?? d.sourceFilename ?? `Disk ${d.diskNo}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Render only while open: every opening then starts from an empty search and
 * nothing picked. `onClose` is called for Cancel, Escape, a backdrop click and
 * after a successful add.
 */
export function AddDisksDialog({ mode, onClose }: { mode: AddDisksMode; onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CandidateTitle[] | null>(null);
  // How many titles to ask for, and whether the server has more than that.
  // A list cut at 20 with no sign of it looked complete (2026-10-10).
  const [limit, setLimit] = useState(PAGE);
  const [more, setMore] = useState(false);
  const lastQ = useRef(q);
  const [searchFailed, setSearchFailed] = useState(false);
  // Picked titles by id, kept whole so a pick survives a search that no
  // longer lists it, and the count stays right.
  const [picked, setPicked] = useState<Map<string, CandidateTitle>>(new Map());
  const [busy, setBusy] = useState(false);
  const first = useRef(true);

  // Debounced search; each new query aborts the one before, so a slow answer
  // for "fo" can never overwrite the list for "fonts". The first (empty)
  // query goes at once: it is the "20 newest" list the dialog opens on.
  useEffect(() => {
    const ctrl = new AbortController();
    // Typing is debounced; the first load and a "Show more" go at once.
    const delay = first.current || lastQ.current === q ? 0 : DEBOUNCE_MS;
    first.current = false;
    lastQ.current = q;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: q.trim(), exclude: mode.gameId, limit: String(limit) });
        const res = await fetch(`/api/disk-sets/candidates?${params}`, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { titles: CandidateTitle[]; more?: boolean };
        if (ctrl.signal.aborted) return;
        setResults(body.titles);
        setMore(body.more === true);
        setSearchFailed(false);
      } catch {
        if (ctrl.signal.aborted) return;
        setSearchFailed(true);
      }
    }, delay);
    return () => { window.clearTimeout(timer); ctrl.abort(); };
  }, [q, mode.gameId, limit]);

  // Escape closes, also with focus left on the page behind (the overlay's own
  // onKeyDown covers focus inside the dialog).
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Focus goes back to whatever opened the dialog (the button or the ⋯
  // trigger) when it closes. Read during the first render, before the search
  // field's autoFocus has moved focus into the dialog.
  const [opener] = useState(
    () => (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null));
  useEffect(() => () => { if (opener && opener.isConnected) opener.focus(); }, [opener]);

  function toggle(t: CandidateTitle) {
    setPicked((prev) => {
      if (mode.kind === 'target') {
        return prev.has(t.gameId) ? new Map() : new Map([[t.gameId, t]]);
      }
      const next = new Map(prev);
      if (next.has(t.gameId)) next.delete(t.gameId); else next.set(t.gameId, t);
      return next;
    });
  }

  const pickedTitles = [...picked.values()];
  const diskCount = pickedTitles.reduce((n, t) => n + t.disks.length, 0);
  const canConfirm = !busy && (mode.kind === 'target' ? pickedTitles.length === 1 : diskCount > 0);

  async function confirm() {
    if (!canConfirm) return;
    const target = mode.kind === 'add' ? mode.gameId : pickedTitles[0].gameId;
    const setTitle = mode.kind === 'add' ? mode.title : pickedTitles[0].title;
    // Every disk of each picked title: the server moves a source's disks
    // together regardless, and sending them all states that intent.
    const diskIds = mode.kind === 'add' ? pickedTitles.flatMap((t) => t.disks.map((d) => d.id)) : [mode.diskId];

    setBusy(true);
    let res: Response;
    try {
      res = await fetch(`/api/games/${target}/disks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diskIds }),
      });
    } catch {
      setBusy(false);
      toast.error('Could not reach the server', { description: 'Nothing was moved.' });
      return;
    }
    if (!res.ok) {
      setBusy(false);
      const body = await res.json().catch(() => ({}));
      toast.error(mode.kind === 'add' ? 'Could not add the disks' : 'Could not add the disk to that set', {
        description: addErrorText((body as { error?: unknown }).error),
      });
      return;
    }
    const { undo } = (await res.json()) as { undo: UndoSnapshot[] };
    onClose();
    movedToast(setTitle, undo, router);
    if (mode.kind === 'target') router.push(`/games/${target}`);
    else router.refresh();
  }

  const heading = mode.kind === 'add' ? `Add disks to “${mode.title}”` : 'Add to a disk set';
  const confirmLabel = mode.kind === 'add'
    ? (diskCount === 0 ? 'Add disks' : `Add ${plural(diskCount, 'disk', 'disks')}`)
    : (pickedTitles[0] ? `Add to “${pickedTitles[0].title}”` : 'Add to set');

  return createPortal((
    <div
      className="fixed inset-0 z-50 flex sm:items-center sm:justify-center sm:p-4"
      style={{ background: 'rgb(11 18 28 / 0.55)' }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose(); }}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}
    >
      <div
        role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="add-disks-dialog"
        className="flex h-full w-full flex-col gap-3 overflow-hidden border p-4 text-left shadow-xl backdrop-blur-xl sm:h-auto sm:max-h-[min(640px,100%)] sm:max-w-[480px] sm:rounded-[14px] sm:p-5"
        style={{ background: 'var(--glass-strong)', borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}
      >
        <h2 id={titleId} className="break-words text-[15px] font-bold">{heading}</h2>
        {mode.kind === 'target' && (
          <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Pick the title this disk joins. It is added as that set&apos;s last disk.
          </p>
        )}

        <label className="flex h-11 items-center gap-2 rounded-[10px] border px-3 sm:h-[34px]"
               style={{ borderColor: 'var(--hairline-strong)', background: 'var(--glass)' }}>
          <Search size={14} aria-hidden style={{ color: 'var(--muted)' }} />
          <input
            type="search" autoFocus data-testid="add-disks-search"
            aria-label="Search titles, file names and TOSEC names"
            placeholder="Search titles or file names"
            value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
          />
        </label>

        <div className="min-h-0 flex-1 overflow-y-auto" role="group" aria-label="Titles"
             data-testid="add-disks-results">
          {searchFailed ? (
            <p className="py-3 text-[12.5px]" style={{ color: 'var(--danger-fg)' }}>Could not search your library.</p>
          ) : results === null ? (
            <p className="py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>Searching…</p>
          ) : results.length === 0 ? (
            <p className="py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>No other titles match.</p>
          ) : results.map((t) => {
            const on = picked.has(t.gameId);
            const detail = t.disks.length > 1
              ? `${t.disks.length} disks — adds all`
              : t.disks[0] ? diskName(t.disks[0]) : '';
            return (
              <label key={t.gameId}
                     className="flex min-h-11 cursor-pointer items-center gap-3 border-b px-1 py-1.5 sm:min-h-0"
                     style={{ borderColor: 'var(--hairline)' }}>
                <input
                  type={mode.kind === 'target' ? 'radio' : 'checkbox'}
                  name={mode.kind === 'target' ? `${titleId}-target` : undefined}
                  data-testid={`add-disks-pick-${t.gameId}`}
                  checked={on} onChange={() => toggle(t)}
                  className="h-5 w-5 shrink-0 sm:h-4 sm:w-4"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-bold" title={t.title}>{t.title}</span>
                  {detail && (
                    <span className="truncate font-mono text-[11px]" style={{ color: 'var(--muted)' }} title={detail}>
                      {detail}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {more && !searchFailed && results !== null && (
            <div className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid="add-disks-more-note">
                {`Showing ${results.length} titles — there are more.`}
              </span>
              <button type="button" data-testid="add-disks-more" onClick={() => setLimit((n) => n + PAGE)}
                      className={PILL} style={{ borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}>
                Show more
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" data-testid="add-disks-cancel" onClick={onClose} disabled={busy}
                  className={PILL} style={{ borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}>
            Cancel
          </button>
          <button type="button" data-testid="add-disks-confirm" onClick={() => { void confirm(); }}
                  disabled={!canConfirm} className={`${PILL} min-w-0 text-white`}
                  style={{ borderColor: 'var(--primary-action)', background: 'var(--primary-action)' }}>
            <span className="truncate">{busy ? 'Adding…' : confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
