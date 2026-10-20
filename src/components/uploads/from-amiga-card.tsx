'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { HelpTip } from '@/components/help/help-tip';
import { StatusChip } from '@/components/ui/status-chip';
import { ListFrame, UploadCard } from '@/components/ingest/upload-card';
import { formatSize, type SendTarget } from '@/lib/send-ui';
import type { UploadBoard, UploadView } from '@/lib/amiga-uploads';
import {
  anyArriving, clearBody, clearConfirm, clearable, downloadName, libraryEligible, tabTarget, uploadChip, uploadErrorText,
} from '@/lib/from-amiga-ui';

type Snapshot = { rows: UploadView[]; boards: UploadBoard[]; now: number };
// While a file arrives the list is read every 3 s (progress moves per 16 KB chunk); otherwise every 10 s.
const ACTIVE_MS = 3_000;
const IDLE_MS = 10_000;
const btn = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50';
const quiet = { background: 'var(--glass-strong)', color: 'var(--ink)', border: '1px solid var(--hairline-strong)' } as const;

/**
 * The From the Amiga area (spec 2026-10-18 §4, U6; ruling 8: a full-width card on the Upload page): what every board
 * of the org sent up, newest first, the board on each row, and Download, Add to library, Send to an Amiga, Delete and
 * Clear all. Reads its own route, like the Send to Amiga card.
 */
export function FromAmigaCard({ targets, initialBoard }: { targets: SendTarget[]; initialBoard: string | null }) {
  const [board, setBoard] = useState<string | null>(initialBoard);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [confirming, setConfirming] = useState<{ n: number; body: { cursor: string; board?: string } } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // a row's id, or 'clear', while its request runs
  const active = useRef(false);
  const clearBtn = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const boardNow = useRef(board);   // a late answer for a board the person has left must not fill the list

  const refresh = useCallback(async () => {
    try {
      const q = board ? `?board=${encodeURIComponent(board)}` : '';
      const res = await fetch(`/api/uploads${q}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (res.ok) { const next = (await res.json()) as Snapshot; if (boardNow.current === board) setSnap(next); }
    } catch { /* offline, signed out or a deploy: the next tick tries again */ }
  }, [board]);

  useEffect(() => { active.current = snap ? anyArriving(snap.rows) : false; }, [snap]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One loop at a time: a tick still awaiting its fetch when the tab comes back belongs to an older generation, and
    // does not schedule the next one (clearing the timer alone misses it -- that timer has already fired).
    let gen = 0;
    const tick = async (g: number) => {
      if (stopped || g !== gen) return;
      if (document.visibilityState === 'visible') await refresh();
      if (!stopped && g === gen) timer = setTimeout(() => tick(g), active.current ? ACTIVE_MS : IDLE_MS);
    };
    void tick(gen);
    // Coming back to the tab reads the list at once, and restarts the loop.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      if (timer) clearTimeout(timer);
      void tick(++gen);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  async function run(id: string, what: string, request: () => Promise<Response>, done: (res: Response) => Promise<void>) {
    setBusy(id);
    try {
      const res = await request();
      if (res.ok) await done(res);
      else {
        const b = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
        toast.error(what, { description: b?.reason ?? uploadErrorText(b?.error, res.status) });
      }
      await refresh();
    } catch {
      toast.error(what, { description: 'Check the connection and try again.' });
    } finally {
      setBusy(null);
    }
  }
  const addToLibrary = (r: UploadView) => run(r.id, 'Not added to the library',
    () => fetch(`/api/uploads/${encodeURIComponent(r.id)}/library`, { method: 'POST' }),
    async () => { toast.success('Added to the library', { description: r.path }); });
  const sendTo = (r: UploadView, t: SendTarget) => run(r.id, 'Not sent',
    () => fetch(`/api/uploads/${encodeURIComponent(r.id)}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: t.id }) }),
    async () => { toast.success(`Queued for ${t.name}`, { description: 'It shows under Send to Amiga.' }); });
  // A fetch first, so a 404 is a toast and not a saved file called "not found"; the bytes then save under the Amiga name.
  async function download(r: UploadView) {
    setBusy(r.id);
    try {
      const res = await fetch(`/api/uploads/${encodeURIComponent(r.id)}/file`, { cache: 'no-store' });
      if (!res.ok) {
        toast.error('Not downloaded', { description: res.status === 404 ? uploadErrorText('not_found', 404) : uploadErrorText(undefined, res.status) });
        await refresh();
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = downloadName(r.path);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast.error('Not downloaded', { description: 'Check the connection and try again.' });
    } finally {
      setBusy(null);
    }
  }
  const remove = (r: UploadView) => run(r.id, 'Not deleted',
    () => fetch(`/api/uploads/${encodeURIComponent(r.id)}`, { method: 'DELETE' }), async () => undefined);
  const clearAll = (body: { cursor: string; board?: string }) => run('clear', 'Not cleared',
    () => fetch('/api/uploads/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    async (res) => {
      const { deleted } = (await res.json()) as { deleted: number };
      toast.success(deleted === 1 ? '1 file cleared' : `${deleted} files cleared`);
    }).finally(() => setConfirming(null));

  // The confirm is a modal: Cancel takes focus when it opens, Escape closes it, Tab stays inside, and the Clear all
  // button gets focus back when it closes.
  const open = confirming !== null;
  useEffect(() => {
    if (!open) return;
    const opener = clearBtn.current;
    cancelBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setConfirming(null); return; }
      if (e.key !== 'Tab' || !dialog.current) return;
      const items = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
      const to = tabTarget(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
      if (to !== null) { e.preventDefault(); items[to].focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus(); };
  }, [open]);

  const rows = snap?.rows ?? [];
  const boards = snap?.boards ?? [];
  const n = clearable(rows);
  const shown = board ? boards.find((b) => b.id === board) : boards.length === 1 ? boards[0] : undefined;
  const meta = (
    <>
      {boards.length > 1 && (
        <select aria-label="Board" data-testid="from-amiga-board" value={board ?? ''} onChange={(e) => { const b = e.target.value || null; boardNow.current = b; setSnap(null); setBoard(b); }}
                className="rounded-lg px-2 py-1 text-[12px]" style={quiet}>
          <option value="">All boards</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}{b.key ? ` (key ${b.key})` : ''}</option>)}
        </select>
      )}
      {shown?.key && (
        <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid="from-amiga-key">
          {shown.name}: board key <strong style={{ color: 'var(--ink)' }}>{shown.key}</strong>
        </span>
      )}
    </>
  );

  return (
    <section id="from-amiga" aria-labelledby="from-amiga-heading" className="mx-4 pb-10 sm:mx-7">
      <UploadCard id="from-amiga-heading" title="From the Amiga" help={<HelpTip topic="from-amiga" />} meta={meta} testId="from-amiga">
        <ListFrame
          title="Files"
          counts={rows.length ? `${rows.length} ${rows.length === 1 ? 'file' : 'files'}` : undefined}
          action={n > 0 && (
            <button type="button" ref={clearBtn} data-testid="from-amiga-clear" disabled={busy === 'clear'} className={btn} style={quiet}
                    onClick={() => { const body = clearBody(rows, board); if (body) setConfirming({ n, body }); }}>
              Clear all ({n})
            </button>
          )}
        >
          <ul aria-label="Files from the Amiga" data-testid="from-amiga-list" tabIndex={0}
              className="flex max-h-[30rem] min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset">
            {rows.map((r) => {
              const c = uploadChip(r);
              const stored = r.status === 'stored';
              return (
                <li key={r.id} data-testid={`from-amiga-row-${r.id}`} data-status={r.status}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5" style={{ borderBottom: '1px solid var(--hairline)' }}>
                  <span className="min-w-0 flex-1 font-mono text-[12px]" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{r.path}</span>
                  <span className="shrink-0 font-mono text-[11.5px]" style={{ color: 'var(--muted)' }}>{formatSize(r.sizeBytes)}</span>
                  <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--muted)' }}>from {r.deviceName}</span>
                  <span className="flex min-w-0 basis-full flex-wrap items-center gap-2">
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" data-testid={`from-amiga-state-${r.id}`}>
                      <StatusChip kind={c.kind}>{c.label}</StatusChip>
                      {c.note && <><span className="sr-only"> · </span><span style={{ color: 'var(--muted)' }}>{c.note}</span></>}
                    </span>
                    {stored && (
                      <button type="button" data-testid={`from-amiga-download-${r.id}`} disabled={busy === r.id} className={btn} style={quiet}
                              aria-label={`Download ${r.path}`} onClick={() => void download(r)}>Download</button>
                    )}
                    {stored && r.libraryGameId && (
                      <Link href={`/games/${encodeURIComponent(r.libraryGameId)}`} data-testid={`from-amiga-in-library-${r.id}`}
                            className="text-[12px] font-semibold underline underline-offset-2" style={{ color: 'var(--ink)' }}>In library</Link>
                    )}
                    {stored && !r.libraryDiskId && libraryEligible(r.path, r.sizeBytes) && (
                      <button type="button" data-testid={`from-amiga-library-${r.id}`} disabled={busy === r.id} className={btn} style={quiet}
                              aria-label={`Add ${r.path} to the library`} onClick={() => void addToLibrary(r)}>Add to library</button>
                    )}
                    {stored && targets.length > 0 && (
                      <select aria-label={`Send ${r.path} to an Amiga`} data-testid={`from-amiga-send-${r.id}`} value="" disabled={busy === r.id}
                              className="rounded-lg px-2 py-1 text-[12px]" style={quiet}
                              onChange={(e) => { const t = targets.find((x) => x.id === e.target.value); if (t) void sendTo(r, t); }}>
                        <option value="">Send to an Amiga…</option>
                        {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    )}
                    {r.status !== 'receiving' && (
                      <button type="button" data-testid={`from-amiga-delete-${r.id}`} disabled={busy === r.id} className={btn} style={quiet}
                              aria-label={`Delete ${r.path}`} onClick={() => void remove(r)}>Delete</button>
                    )}
                  </span>
                </li>
              );
            })}
            {snap === null && <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>Reading the list…</li>}
            {snap !== null && rows.length === 0 && (
              <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }} data-testid="from-amiga-empty">
                Nothing from the Amiga yet. Drop files on Receive&apos;s window, or type Receive SEND in a Shell.
              </li>
            )}
          </ul>
        </ListFrame>
      </UploadCard>
      {confirming && createPortal((
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgb(11 18 28 / 0.55)' }}>
          <div ref={dialog} role="dialog" aria-modal="true" aria-label="Clear all" data-testid="from-amiga-confirm" className="glass-card w-full max-w-[440px] p-6 text-left">
            <h2 className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>{clearConfirm(confirming.n)}</h2>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
              They go from this list for everyone in your organization. A file still arriving stays, and a disk you added to
              the library stays there.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" ref={cancelBtn} data-testid="from-amiga-confirm-cancel" disabled={busy === 'clear'} onClick={() => setConfirming(null)}
                      className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50" style={{ color: 'var(--muted)' }}>Cancel</button>
              <button type="button" data-testid="from-amiga-confirm-yes" disabled={busy === 'clear'} onClick={() => void clearAll(confirming.body)}
                      className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--danger-fg)' }}>
                {busy === 'clear' ? 'Clearing…' : 'Clear all'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </section>
  );
}
