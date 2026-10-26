'use client';
import { useRef, useState } from 'react';
import { Link } from '@/components/shell/link';
import { SEND_FILE_MAX, XFER_FW } from '@/lib/send-limits';
import { longOffline, orderTargets, receiverLine, sendErrorText, targetState, type SendTarget } from '@/lib/send-ui';
import { useSendBoard } from './use-send-board';
import { HelpTip } from '@/components/help/help-tip';
import { DropCard, INK_LABEL, INK_STYLE, TILE, TILE_LOOK } from '@/components/ingest/drop-card';
import { useStaging } from '@/components/ingest/staging-provider';
import { SIGNED_OUT_TEXT, isSignedOutAnswer } from '@/lib/upload-staging';

/** Below sm the "?" sits in the Send tile's top-right corner (C7 spec §7): a sibling of the label, so a tap on it
 *  opens its popover and not the file chooser. */
const SEND_HELP = 'max-sm:z-20 max-sm:col-start-2 max-sm:row-start-1 max-sm:m-1.5 max-sm:self-start max-sm:justify-self-end';

/**
 * The Upload page's Send drop area (spec 2026-10-23 §1): which board new files go to, whether Transfer runs there,
 * and a drop zone for any file. What it sends shows in the Staging list (every board's rows), which also reads the
 * targets live; `targets` here is the server-rendered list, used until the list's first answer.
 */
export function SendPanel({ targets: initialTargets, initialBoard, serverNow }: { targets: SendTarget[]; initialBoard: string | null; serverNow: number }) {
  const staging = useStaging();
  const targets = staging.targets ?? initialTargets;
  const now = staging.now ?? serverNow;
  const [board, setBoard] = useSendBoard(targets, now, initialBoard);
  const [showOffline, setShowOffline] = useState(false);
  const seq = useRef(0);

  if (targets.length === 0) {
    return (
      <DropCard testId="send-dropzone" headingId="send-heading" title="Send files to the Amiga" help={<HelpTip topic="send" className={SEND_HELP} />}
        disk={{ color: 'grey', set: 'Any file · 4 MB', title: 'To the Amiga' }} tileCol={2}
        hint={
          <p data-testid="send-no-board">
            No board can receive files yet. Sending needs a board on firmware {XFER_FW} or newer.{' '}
            <Link href="/devices" className="font-semibold underline underline-offset-2" style={{ color: 'var(--ink)' }}>Devices</Link>
          </p>
        }>
        {/* Below sm the Send tile, unpressable: it says why, and the hint under the tiles names the fix (C7 Task 7). */}
        <div data-tile="Pair a board first" className={`hidden ${TILE_LOOK} ${TILE[2]} max-sm:flex max-sm:items-center`} />
      </DropCard>
    );
  }

  const ordered = orderTargets(targets);
  const shown = ordered.filter((t) => showOffline || !longOffline(t, now) || t.id === board);
  const hidden = ordered.length - shown.length;
  const current = targets.find((t) => t.id === board) ?? null;
  const mine = staging.serverRows.filter((r) => r.kind === 'out' && r.board.id === board);
  const waiting = mine.filter((r) => r.status === 'queued').length;
  const sending = mine.some((r) => r.status === 'sending');
  const line = current ? receiverLine(current, { waiting, sending }, now) : null;

  async function handleFiles(list: FileList) {
    const to = current;
    if (!to) return;
    for (const file of Array.from(list)) {
      const key = `up:${++seq.current}`;
      const row = { source: 'up' as const, key, kind: 'out' as const, name: file.name, sizeBytes: file.size, boardName: to.name, at: Date.now() };
      if (file.size === 0 || file.size > SEND_FILE_MAX) {
        staging.addUp({ ...row, state: 'failed', note: sendErrorText(file.size === 0 ? 'empty' : 'too_large', 0) });
        continue;
      }
      staging.addUp({ ...row, state: 'uploading' });
      // Not a begin()/end() change: the transfer row exists only once this POST succeeds, so no read made while the
      // file goes up can bring back or hide anything -- and holding reads for a 4 MB upload would freeze the list.
      try {
        const res = await fetch(`/api/transfers?deviceId=${encodeURIComponent(to.id)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
        if (isSignedOutAnswer(res)) {
          staging.patchUp(key, { state: 'failed', note: SIGNED_OUT_TEXT });
          continue;
        }
        if (res.ok) {
          // Its transfer row takes its place: read the list first, then drop the upload row, so the file never vanishes.
          // A read that began before the POST and lands after this one is not painted (the provider's read order).
          await staging.refreshNow();
          staging.removeLocal([key]);
          continue;
        }
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        staging.patchUp(key, { state: 'failed', note: sendErrorText(b?.error, res.status) });
      } catch {
        staging.patchUp(key, { state: 'failed', note: 'The upload did not finish. Check the connection and try again.' });
      }
    }
  }

  const single = targets.length === 1 ? (current ?? targets[0]) : null;
  return (
    <DropCard testId="send-dropzone" headingId="send-heading" title="Send files to the Amiga" help={<HelpTip topic="send" className={SEND_HELP} />}
      disk={{ color: 'blue', set: 'Any file · 4 MB', title: 'To the Amiga' }} tileCol={2}
      hint="Any file up to 4 MB. It waits here until Transfer on the Amiga takes it, into the folder Transfer saves to."
      onFiles={(f) => void handleFiles(f)}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 max-sm:contents">
        <label htmlFor="send-file-input" data-testid="send-browse" data-tile="Send to Amiga"
               className={`${INK_LABEL} ${TILE_LOOK} ${TILE[2]}`} style={INK_STYLE}>
          <span className="max-sm:hidden">Choose files</span>
          <input id="send-file-input" type="file" multiple className="sr-only" data-testid="send-file-input"
                 onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); e.target.value = ''; }} />
        </label>
        {single && (
          <span className="text-[13px] max-sm:order-3 max-sm:col-span-2" data-testid="send-board" style={{ color: 'var(--muted)' }}>
            To <strong className="font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{single.name}</strong> · {targetState(single, now)}
          </span>
        )}
        {line && (
          <span role="status" data-testid="send-receiver" data-ok={String(line.ok)} className="text-[13px] font-medium max-sm:order-3 max-sm:col-span-2"
                style={{ color: line.ok ? 'var(--success-fg)' : 'var(--warning-fg)' }}>
            {line.ok ? '✓ ' : '• '}{line.text}
          </span>
        )}
      </div>
      {!single && (
        <fieldset className="flex flex-col gap-1 rounded-[12px] p-2.5 max-sm:order-4 max-sm:col-span-2" data-testid="send-board-picker"
                  style={{ background: 'var(--surface-2)' }}>
          <legend className="sr-only">Board to send to</legend>
          {shown.map((t) => (
            <label key={t.id} className="flex min-h-8 min-w-0 items-center gap-2 text-[13px]" data-testid={`send-board-${t.id}`}>
              <input type="radio" name="send-board" checked={t.id === board} onChange={() => setBoard(t.id)}
                     style={{ accentColor: 'var(--ink)' }} />
              <span className="min-w-0 flex-1 font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{t.name}</span>
              <span className="shrink-0 text-[12px]" style={{ color: t.online ? 'var(--success-fg)' : 'var(--muted-2)' }}>{targetState(t, now)}</span>
              {t.defaultName && (
                <Link href={`/devices#device-${t.id}`} className="shrink-0 text-[12px] underline" style={{ color: 'var(--muted)' }}>Name it</Link>
              )}
            </label>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setShowOffline(true)} className="self-start text-[12px] underline"
                    style={{ color: 'var(--muted)' }} data-testid="send-show-offline">
              Show offline ({hidden})
            </button>
          )}
        </fieldset>
      )}
    </DropCard>
  );
}
