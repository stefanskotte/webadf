'use client';
import { useRef, useState } from 'react';
import { Link } from '@/components/shell/link';
import { SEND_FILE_MAX, XFER_FW } from '@/lib/send-limits';
import { longOffline, orderTargets, receiverLine, sendErrorText, targetState, type SendTarget } from '@/lib/send-ui';
import { useSendBoard } from './use-send-board';
import { HelpTip } from '@/components/help/help-tip';
import { StatusChip } from '@/components/ui/status-chip';
import { DropArea } from '@/components/ingest/drop-area';
import { UploadCard } from '@/components/ingest/upload-card';
import { useStaging } from '@/components/ingest/staging-provider';

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
      <UploadCard id="send-heading" title="Send files to the Amiga" help={<HelpTip topic="send" />}>
        <p className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid="send-no-board">
          No board can receive files yet. Sending needs a board on firmware {XFER_FW} or newer.{' '}
          <Link href="/devices" className="font-semibold underline underline-offset-2" style={{ color: 'var(--ink)' }}>Devices</Link>
        </p>
      </UploadCard>
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
      try {
        const res = await fetch(`/api/transfers?deviceId=${encodeURIComponent(to.id)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
        if (res.ok) {
          // Its transfer row takes its place: read the list first, then drop the upload row, so the file never vanishes.
          staging.changed();
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
  const meta = (
    <>
      {single && (
        <p className="text-[12.5px]" style={{ color: 'var(--muted)' }} data-testid="send-board">
          To <strong style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{single.name}</strong> · {targetState(single, now)}
        </p>
      )}
      {line && (
        <span role="status" data-testid="send-receiver" data-ok={String(line.ok)}>
          <StatusChip kind={line.ok ? 'green' : 'amber'}>{line.ok ? '✓ ' : '• '}{line.text}</StatusChip>
        </span>
      )}
    </>
  );

  return (
    <UploadCard id="send-heading" title="Send files to the Amiga" help={<HelpTip topic="send" />} meta={meta}>
      {!single && (
        <fieldset className="flex flex-col gap-1 rounded-xl p-3" data-testid="send-board-picker"
                  style={{ border: '1px solid var(--hairline-strong)', background: 'var(--glass-subtle)' }}>
          <legend className="sr-only">Board to send to</legend>
          {shown.map((t) => (
            <label key={t.id} className="flex min-w-0 items-center gap-2 text-[12.5px]" data-testid={`send-board-${t.id}`}>
              <input type="radio" name="send-board" checked={t.id === board} onChange={() => setBoard(t.id)} />
              <span className="min-w-0 flex-1 font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{t.name}</span>
              <span className="shrink-0 text-[11.5px]" style={{ color: t.online ? 'var(--success-fg)' : 'var(--muted)' }}>{targetState(t, now)}</span>
              {t.defaultName && (
                <Link href={`/devices#device-${t.id}`} className="shrink-0 text-[11.5px] underline" style={{ color: 'var(--muted)' }}>Name it</Link>
              )}
            </label>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setShowOffline(true)} className="self-start text-[11.5px] underline"
                    style={{ color: 'var(--muted)' }} data-testid="send-show-offline">
              Show offline ({hidden})
            </button>
          )}
        </fieldset>
      )}

      <DropArea testId="send-dropzone" inputTestId="send-file-input" resetAfterPick
                title="Drop any file here, or choose one"
                hint="Up to 4 MB each. It waits in Staging until the Amiga takes it."
                onFiles={(f) => void handleFiles(f)} />
    </UploadCard>
  );
}
