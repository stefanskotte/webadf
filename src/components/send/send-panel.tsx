'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { SEND_FILE_MAX, XFER_FW } from '@/lib/send-limits';
import {
  canCancel, canRetry, clearableCount, formatSize, orderQueue, longOffline, orderTargets, receiverLine, sendErrorText, targetState, transferState,
  type SendTarget, type TransferView,
} from '@/lib/send-ui';
import { useSendBoard } from './use-send-board';

type Upload = { key: string; name: string; state: 'uploading' | 'failed'; note?: string };
type Snapshot = { target: SendTarget; transfers: TransferView[]; now: number };
const TONE = { ok: 'var(--success-fg)', busy: 'var(--amber-text)', bad: 'var(--danger-fg)', muted: 'var(--muted)' } as const;
// While anything waits or moves the queue is read every 3 s (progress is per 16 KB chunk); otherwise every 10 s.
const ACTIVE_MS = 3_000;
const IDLE_MS = 10_000;
const btn = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50';

/**
 * The Upload page's right column (spec §4): which board, whether Receive runs there, a drop zone for any file, and
 * every transfer for that board however it was sent. Reads its own queue route rather than the page's live
 * fingerprint, because progress moves on every chunk and the fingerprint moves on state changes only.
 */
export function SendPanel({ targets, initialBoard, serverNow }: { targets: SendTarget[]; initialBoard: string | null; serverNow: number }) {
  const [board, setBoard] = useSendBoard(targets, serverNow, initialBoard);
  const [showOffline, setShowOffline] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [clearing, setClearing] = useState(false);
  const seq = useRef(0);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    if (!board) return;
    try {
      const res = await fetch(`/api/transfers?deviceId=${encodeURIComponent(board)}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      setSnap((await res.json()) as Snapshot);
    } catch { /* offline, signed out or a deploy: the next tick tries again */ }
  }, [board]);

  useEffect(() => {
    active.current = snap?.transfers.some((t) => canCancel(t.status)) ?? false;
  }, [snap]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') await refresh();
      if (!stopped) timer = setTimeout(tick, active.current ? ACTIVE_MS : IDLE_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [refresh]);

  if (targets.length === 0) {
    return (
      <div className="glass-card mx-4 p-5 text-[13px] sm:mx-7 lg:ml-3.5" style={{ color: 'var(--muted)' }} data-testid="send-no-board">
        No board can receive files yet. Sending needs a board on firmware {XFER_FW} or newer.{' '}
        <Link href="/devices" className="font-semibold underline underline-offset-2">Devices</Link>
      </div>
    );
  }

  const view = snap && snap.target.id === board ? snap : null;
  const now = view?.now ?? serverNow;
  const ordered = orderTargets(targets);
  const shown = ordered.filter((t) => showOffline || !longOffline(t, now) || t.id === board);
  const hidden = ordered.length - shown.length;
  const current = view?.target ?? targets.find((t) => t.id === board) ?? null;
  const waiting = view?.transfers.filter((t) => t.status === 'queued').length ?? 0;
  const sending = view?.transfers.some((t) => t.status === 'sending') ?? false;
  const line = current ? receiverLine(current, { waiting, sending }, now) : null;
  const finished = view ? clearableCount(view.transfers) : 0;

  async function handleFiles(list: FileList) {
    const to = board;
    if (!to) return;
    for (const file of Array.from(list)) {
      const key = `u${++seq.current}`;
      if (file.size === 0 || file.size > SEND_FILE_MAX) {
        setUploads((u) => [...u, { key, name: file.name, state: 'failed', note: sendErrorText(file.size === 0 ? 'empty' : 'too_large', 0) }]);
        continue;
      }
      setUploads((u) => [...u, { key, name: file.name, state: 'uploading' }]);
      try {
        const res = await fetch(`/api/transfers?deviceId=${encodeURIComponent(to)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
        if (res.ok) { setUploads((u) => u.filter((x) => x.key !== key)); await refresh(); continue; }
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'failed', note: sendErrorText(b?.error, res.status) } : x)));
      } catch {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'failed', note: 'The upload did not finish. Check the connection and try again.' } : x)));
      }
    }
  }

  async function cancel(id: string) {
    const res = await fetch(`/api/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    if (!res) toast.error('Could not cancel', { description: 'Check the connection and try again.' });
    else if (res.status === 409) toast.info('Already finished', { description: 'It ended before the cancel arrived.' });
    else if (!res.ok) toast.error('Could not cancel', { description: `The server answered ${res.status}.` });
    await refresh();
  }

  async function retry(id: string) {
    const res = await fetch(`/api/transfers/${encodeURIComponent(id)}/retry`, { method: 'POST' }).catch(() => null);
    if (!res) toast.error('Could not retry', { description: 'Check the connection and try again.' });
    else if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error('Could not retry', { description: sendErrorText(b?.error, res.status) });
    }
    await refresh();
  }

  async function clearFinished() {
    const to = board;
    if (!to) return;
    setClearing(true);
    try {
      const res = await fetch(`/api/transfers?deviceId=${encodeURIComponent(to)}`, { method: 'DELETE' }).catch(() => null);
      if (!res) toast.error('Could not clear', { description: 'Check the connection and try again.' });
      else if (!res.ok) toast.error('Could not clear', { description: `The server answered ${res.status}.` });
      await refresh();
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="mx-4 flex min-w-0 flex-col gap-3 sm:mx-7 lg:ml-3.5">
      {targets.length === 1 ? (
        <p className="text-[12.5px]" style={{ color: 'var(--ink)' }} data-testid="send-board">
          To <strong>{(current ?? targets[0]).name}</strong> · {targetState(current ?? targets[0], now)}
        </p>
      ) : (
        <fieldset className="glass-card flex flex-col gap-1 p-3" data-testid="send-board-picker">
          <legend className="sr-only">Board to send to</legend>
          {shown.map((t) => (
            <label key={t.id} className="flex min-w-0 items-center gap-2 text-[12.5px]" data-testid={`send-board-${t.id}`}>
              <input type="radio" name="send-board" checked={t.id === board} onChange={() => setBoard(t.id)} />
              <span className="min-w-0 flex-1 font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{t.name}</span>
              <span className="shrink-0 text-[11px]" style={{ color: t.online ? 'var(--success-fg)' : 'var(--muted)' }}>{targetState(t, now)}</span>
              {t.defaultName && (
                <Link href={`/devices#device-${t.id}`} className="shrink-0 text-[11px] underline" style={{ color: 'var(--muted)' }}>Name it</Link>
              )}
            </label>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setShowOffline(true)} className="self-start text-[11px] underline"
                    style={{ color: 'var(--muted)' }} data-testid="send-show-offline">
              Show offline ({hidden})
            </button>
          )}
        </fieldset>
      )}

      {line && (
        <p role="status" className="text-[12.5px] font-semibold" data-testid="send-receiver" data-ok={String(line.ok)}
           style={{ color: line.ok ? 'var(--ink)' : 'var(--amber-text)' }}>
          {line.ok ? '✓ ' : '• '}{line.text}
        </p>
      )}

      <label data-testid="send-dropzone"
             onDragOver={(e) => e.preventDefault()}
             onDrop={(e) => { e.preventDefault(); void handleFiles(e.dataTransfer.files); }}
             className="glass-card flex h-32 cursor-pointer flex-col items-center justify-center gap-1 px-4 text-center"
             style={{ borderStyle: 'dashed', borderColor: 'rgb(245 130 46 / 0.55)' }}>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Drop any file here, or choose one</span>
        <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>Up to 4 MB each. It waits here until the Amiga takes it.</span>
        <input type="file" multiple className="sr-only" data-testid="send-file-input"
               onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); e.target.value = ''; }} />
      </label>

      {finished > 0 && (
        <button type="button" data-testid="send-clear-finished" disabled={clearing} onClick={() => void clearFinished()}
                className={`${btn} self-end`} style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}>
          Clear finished ({finished})
        </button>
      )}
      {/* About 10 rows on a wide screen, fewer on a phone; it scrolls inside, with waiting and sending rows on top. */}
      <ul aria-label="Files for this board" data-testid="send-queue" tabIndex={0}
          className="glass-card flex max-h-[26rem] flex-col overflow-y-auto overscroll-contain sm:max-h-[35rem]">
        {uploads.map((u) => (
          <li key={u.key} data-testid="send-upload" data-state={u.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2"
              style={{ borderColor: 'var(--hairline)' }}>
            <span className="min-w-0 flex-1 font-mono text-[12px]" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{u.name}</span>
            <span className="basis-full text-[12px]" style={{ color: u.state === 'failed' ? TONE.bad : TONE.busy }}>
              {u.state === 'uploading' ? 'Uploading…' : `Not sent · ${u.note}`}
            </span>
            {u.state === 'failed' && (
              <button type="button" className={btn} style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
                      onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>Dismiss</button>
            )}
          </li>
        ))}
        {view && orderQueue(view.transfers).map((t) => {
          const s = transferState(t);
          return (
            <li key={t.id} data-testid={`send-row-${t.id}`} data-status={t.status}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2" style={{ borderColor: 'var(--hairline)' }}>
              <span className="min-w-0 flex-1 font-mono text-[12px]" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{t.path}</span>
              <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>{formatSize(t.sizeBytes)}</span>
              <span className="basis-full text-[12px]" data-testid={`send-state-${t.id}`}
                    style={{ color: TONE[s.tone], overflowWrap: 'anywhere' }}>{s.text}</span>
              {canCancel(t.status) && (
                <button type="button" aria-label={`Cancel ${t.path}`} data-testid={`send-cancel-${t.id}`} onClick={() => void cancel(t.id)}
                        className={btn} style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}>Cancel</button>
              )}
              {canRetry(t.status) && (
                <button type="button" aria-label={`Retry ${t.path}`} data-testid={`send-retry-${t.id}`} onClick={() => void retry(t.id)}
                        className={`${btn} text-white`} style={{ background: 'var(--primary-action)' }}>Retry</button>
              )}
            </li>
          );
        })}
        {view === null && uploads.length === 0 && (
          <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }}>Reading the queue…</li>
        )}
        {view !== null && view.transfers.length === 0 && uploads.length === 0 && (
          <li className="px-4 py-3 text-[12.5px]" style={{ color: 'var(--muted)' }} data-testid="send-queue-empty">
            Nothing sent to this board in the last 7 days.
          </li>
        )}
      </ul>
    </div>
  );
}
