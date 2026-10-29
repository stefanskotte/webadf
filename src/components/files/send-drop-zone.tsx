'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { HelpTip } from '@/components/help/help-tip';
import { DropCard, INK_LABEL, INK_STYLE, TILE, TILE_LOOK } from '@/components/ingest/drop-card';
import { useSendBoard } from '@/components/send/use-send-board';
import { XFER_FW } from '@/lib/send-limits';
import { longOffline, orderTargets, receiverLine, targetState, type SendTarget } from '@/lib/send-ui';
import { readDroppedItems, type DroppedItem } from '@/lib/drop-reader';
import { planNetSend } from '@/lib/files/net-rules';
import { sendToBoard, type NetSendResult } from '@/lib/files/net-send';
import { refusalWords } from '@/lib/files/words';
import { SIGNED_OUT_TEXT } from '@/lib/signed-out';
import type { Listing } from '@/lib/files/types';

/** Below sm the "?" sits in the tile's top-right corner: a sibling of the label, so a tap on it does not open the chooser. */
const SEND_HELP = 'max-sm:z-20 max-sm:col-start-2 max-sm:row-start-1 max-sm:m-1.5 max-sm:self-start max-sm:justify-self-end';

type Sendable = { path: string; file: File; size: number };

/** Why a drop is refused whole, in words naming the file at fault; null when it fits the board's queue (R7). */
export function sendRefusal(files: { path: string; size: number }[], queue: { files: number; bytes: number }): string | null {
  if (files.length === 0) return 'Nothing to send — the drop held no files.';
  const plan = planNetSend(files.map((f) => f.size), queue);
  if (plan.ok) return null;
  if (plan.why === 'queue_full') return refusalWords('queue_full');
  const name = files[plan.index ?? 0].path;
  return plan.why === 'too_large' ? `${name} is over 4 MB — nothing was sent` : `${name} is empty — nothing was sent`;
}

/** The toast after the uploads: all queued, or how many of how many and why the rest stopped. */
export function sentReport(r: NetSendResult, total: number, boardName: string): { ok: boolean; title: string; lines: string[] } {
  const lines = [...r.failed.map((f) => `${f.path}: ${f.why}`), ...(r.stopped ? [r.stopped] : [])];
  if (r.queued === total && lines.length === 0) {
    return { ok: true, title: `Queued ${total === 1 ? '1 file' : `${total} files`} for ${boardName}`, lines };
  }
  const why = r.stopped ?? r.failed[0]?.why ?? '';
  return { ok: false, title: `Queued ${r.queued} of ${total} for ${boardName}${why ? ` — ${why}` : ''}`, lines: lines.filter((l) => l !== why) };
}

/**
 * "Send files to the Amiga" (Files spec 2026-10-29 §5.1, R7): the Send card of the old Upload page on the Files page.
 * A drop or pick (files and folders) is checked whole against the board's queue and the 4 MB cap, then goes up one
 * file a POST; the board is the one useSendBoard remembers. What it queued shows under NET:/<board>.
 */
export function SendDropZone({ targets, initialBoard, serverNow, onSent, onShowQueue }: {
  targets: SendTarget[]; initialBoard: string | null; serverNow: number;
  /** Files were queued for this board: any pane showing it reloads. */
  onSent(deviceId: string): void;
  /** The toast's Show queue: the right pane goes to NET:/<deviceId>. */
  onShowQueue?(deviceId: string): void;
}) {
  const [board, setBoard] = useSendBoard(targets, serverNow, initialBoard);
  const [showOffline, setShowOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // What waits on the chosen board, for the receiver line ("Start Transfer on the Amiga" needs to know files wait).
  const [waiting, setWaiting] = useState(0);
  const current = targets.find((t) => t.id === board) ?? null;

  useEffect(() => {
    if (!board) return;
    let live = true;
    void fetch(`/api/files/list?path=${encodeURIComponent(`NET:/${board}`)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<Listing>) : null))
      .then((l) => { if (live) setWaiting(l?.queue?.files ?? 0); })
      .catch(() => {});
    return () => { live = false; };
  }, [board]);

  if (targets.length === 0) {
    return (
      <DropCard testId="files-drop-send" headingId="files-drop-send-heading" title="Send files to the Amiga"
        help={<HelpTip topic="send" className={SEND_HELP} />}
        disk={{ color: 'grey', set: 'Any file · 4 MB', title: 'To the Amiga' }} tileCol={2}
        hint={
          <p data-testid="files-send-no-board">
            No board can receive files yet. Sending needs a board on firmware {XFER_FW} or newer.{' '}
            <Link href="/devices" className="font-semibold underline underline-offset-2" style={{ color: 'var(--ink)' }}>Devices</Link>
          </p>
        }>
        {/* Below sm the tile, unpressable: it says why, and the hint under the tiles names the fix. */}
        <div data-tile="Pair a board first" aria-hidden="true" className={`hidden ${TILE_LOOK} ${TILE[2]} max-sm:flex max-sm:items-center`} />
      </DropCard>
    );
  }

  const ordered = orderTargets(targets);
  const shown = ordered.filter((t) => showOffline || !longOffline(t, serverNow) || t.id === board);
  const hidden = ordered.length - shown.length;
  const line = current ? receiverLine(current, { waiting, sending: false }, serverNow) : null;
  const single = targets.length === 1 ? (current ?? targets[0]) : null;

  async function send(reading: Promise<Sendable[]>) {
    const to = current;
    if (!to) { void reading.catch(() => {}); return; }
    if (busy) { void reading.catch(() => {}); toast.error('Wait for the files being sent to finish.'); return; }
    setBusy('Reading the drop…');
    try {
      let files: Sendable[];
      try { files = await reading; } catch { toast.error('The dropped files could not be read.'); return; }
      let queue = { files: 0, bytes: 0 };
      try {
        const res = await fetch(`/api/files/list?path=${encodeURIComponent(`NET:/${to.id}`)}`, { cache: 'no-store' });
        if (res.redirected) { toast.error(SIGNED_OUT_TEXT); return; }
        const l = res.ok ? ((await res.json()) as Listing) : null;
        if (!l?.queue) { toast.error(`${to.name} cannot take files now. Check Devices.`); return; }
        queue = l.queue;
      } catch { toast.error('The board\'s queue could not be read. Check the connection and try again.'); return; }
      const refusal = sendRefusal(files, queue);
      if (refusal) { toast.error(refusal); return; }
      setBusy(`Sending ${files.length === 1 ? '1 file' : `${files.length} files`}…`);
      const r = await sendToBoard(to.id, files);
      if (r.queued > 0) onSent(to.id);
      const rep = sentReport(r, files.length, to.name);
      if (rep.ok) {
        toast.success(rep.title, onShowQueue ? { action: { label: 'Show queue', onClick: () => onShowQueue(to.id) } } : undefined);
      } else {
        toast.error(rep.title, rep.lines.length ? { description: <ul data-testid="files-send-report">{rep.lines.map((x, i) => <li key={i}>{x}</li>)}</ul> } : undefined);
      }
      setWaiting((w) => w + r.queued);
    } finally {
      setBusy(null);
    }
  }

  /** Files only: NET: has no folders, a dropped folder's files go by their path inside the drop (R1). */
  const fromItems = async (reading: Promise<DroppedItem[]>): Promise<Sendable[]> =>
    (await reading).filter((i) => i.kind === 'file' && i.file).map((i) => ({ path: i.path, file: i.file!, size: i.sizeBytes }));

  return (
    <DropCard testId="files-drop-send" headingId="files-drop-send-heading" title="Send files to the Amiga"
      help={<HelpTip topic="send" className={SEND_HELP} />} disabled={busy !== null}
      disk={{ color: 'blue', set: 'Any file · 4 MB', title: 'To the Amiga' }} tileCol={2}
      hint="Any file up to 4 MB, or a folder. It waits in NET: until Transfer on the Amiga takes it."
      // Read before this handler returns: the browser empties the DataTransfer after it (drop-reader.ts).
      onItems={(items) => void send(fromItems(readDroppedItems(items)))}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 max-sm:contents">
        <label htmlFor="files-send-input" data-testid="files-send-browse" data-tile={busy ? 'Working…' : 'Send to Amiga'}
               className={`${INK_LABEL} ${TILE_LOOK} ${TILE[2]}`} style={INK_STYLE}>
          <span className="max-sm:hidden">{busy ? 'Working…' : 'Choose files'}</span>
          <input id="files-send-input" type="file" multiple aria-label="Choose files to send" className="sr-only" data-testid="files-send-input"
                 disabled={busy !== null}
                 onChange={(e) => {
                   const picked = [...(e.target.files ?? [])].map((file) => ({ path: file.name, file, size: file.size }));
                   e.target.value = '';
                   if (picked.length) void send(Promise.resolve(picked));
                 }} />
        </label>
        {single && (
          <span className="text-[13px] max-sm:order-3 max-sm:col-span-2" data-testid="files-send-board" style={{ color: 'var(--muted)' }}>
            To <strong className="font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{single.name}</strong> · {targetState(single, serverNow)}
          </span>
        )}
        {line && (
          <span role="status" data-testid="files-send-receiver" data-ok={String(line.ok)}
                className="text-[13px] font-medium max-sm:order-3 max-sm:col-span-2"
                style={{ color: line.ok ? 'var(--success-fg)' : 'var(--warning-fg)' }}>
            {line.ok ? '✓ ' : '• '}{line.text}
          </span>
        )}
        <p role="status" aria-live="polite" data-testid="files-send-progress"
           className="basis-full text-[12px] empty:hidden max-sm:order-3 max-sm:col-span-2" style={{ color: 'var(--muted)' }}>
          {busy ?? ''}
        </p>
      </div>
      {!single && (
        <fieldset className="flex flex-col gap-1 rounded-[12px] p-2.5 max-sm:order-4 max-sm:col-span-2" data-testid="files-send-board-picker"
                  style={{ background: 'var(--surface-2)' }}>
          <legend className="sr-only">Board to send to</legend>
          {shown.map((t) => (
            <label key={t.id} className="flex min-h-11 min-w-0 items-center gap-2 text-[13px] sm:min-h-8" data-testid={`files-send-board-${t.id}`}>
              <input type="radio" name="files-send-board" checked={t.id === board} onChange={() => setBoard(t.id)}
                     style={{ accentColor: 'var(--ink)' }} />
              <span className="min-w-0 flex-1 font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{t.name}</span>
              <span className="shrink-0 text-[12px]" style={{ color: t.online ? 'var(--success-fg)' : 'var(--muted-2)' }}>{targetState(t, serverNow)}</span>
              {t.defaultName && (
                <Link href={`/devices#device-${t.id}`} className="shrink-0 text-[12px] underline" style={{ color: 'var(--muted)' }}>Name it</Link>
              )}
            </label>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setShowOffline(true)} className="min-h-11 self-start text-[12px] underline sm:min-h-0"
                    style={{ color: 'var(--muted)' }} data-testid="files-send-show-offline">
              Show offline ({hidden})
            </button>
          )}
        </fieldset>
      )}
    </DropCard>
  );
}
