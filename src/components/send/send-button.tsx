'use client';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { orderTargets, sendErrorText, targetState, type SendContext } from '@/lib/send-ui';
import { useSendBoard } from './use-send-board';

type FromDisk = { diskId: string; blocks?: number[]; whole?: true };

/**
 * Send from a disk page to the board chosen on the Upload page (spec §4 "Shortcuts on the disk pages"), confirmed
 * "Queued for <board> · See queue". Null when this org has no board that can take files: no button is drawn.
 */
export function useSendAction(ctx: SendContext | null) {
  const router = useRouter();
  const [board] = useSendBoard(ctx?.targets ?? [], ctx?.now ?? 0);
  const [busy, setBusy] = useState(false);
  const send = useCallback(async (body: FromDisk, what: string) => {
    if (!ctx || !board) return;
    const name = ctx.targets.find((t) => t.id === board)?.name ?? 'the board';
    const seeQueue = { label: 'See queue', onClick: () => router.push(`/ingest?board=${encodeURIComponent(board)}`) };
    setBusy(true);
    try {
      const res = await fetch('/api/transfers/from-disk', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: board, ...body }),
      });
      const json = (await res.json().catch(() => null)) as { ids?: string[]; error?: string } | null;
      const queued = json?.ids?.length ?? 0;
      if (res.status === 409 && queued > 0) {
        // Part-way through a folder the queue filled up: some files are queued, the rest were not.
        toast.warning(`Queued ${queued} ${queued === 1 ? 'file' : 'files'} for ${name}, then the queue was full`, {
          description: `${what}: the rest were not sent. ${sendErrorText(json?.error, res.status)}`,
          action: seeQueue,
        });
        return;
      }
      if (!res.ok) { toast.error(`Could not send ${what}`, { description: sendErrorText(json?.error, res.status) }); return; }
      const n = queued || 1;
      toast.success(`Queued for ${name}`, { description: n > 1 ? `${what} (${n} files)` : what, action: seeQueue });
    } catch {
      toast.error(`Could not send ${what}`, { description: 'Check the connection and try again.' });
    } finally {
      setBusy(false);
    }
  }, [ctx, board, router]);
  return ctx && ctx.targets.length > 0 && board ? { send, busy } : null;
}

/** "a small menu changes it" (spec §4): drawn only with two or more boards to choose from. */
export function SendBoardPicker({ ctx }: { ctx: SendContext | null }) {
  const [board, setBoard] = useSendBoard(ctx?.targets ?? [], ctx?.now ?? 0);
  if (!ctx || ctx.targets.length < 2) return null;
  return (
    <label className="flex min-w-0 items-center gap-2 text-[13px]" style={{ color: 'var(--muted)' }}>
      Send to
      <select value={board ?? ''} onChange={(e) => setBoard(e.target.value)} data-testid="send-board-select"
              className="min-w-0 max-w-[60vw] rounded-[10px] border bg-transparent px-2 py-1 text-[13px]"
              style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}>
        {orderTargets(ctx.targets).map((t) => (
          <option key={t.id} value={t.id}>{t.name} · {targetState(t, ctx.now)}</option>
        ))}
      </select>
    </label>
  );
}

/** The disk row's "Send .adf to Amiga" (spec §4): the disk's own blob, named <disk name>.adf by the server. */
export function SendAdfButton({ ctx, diskId }: { ctx: SendContext; diskId: string }) {
  const s = useSendAction(ctx);
  if (!s) return null;
  return (
    <button type="button" disabled={s.busy} onClick={() => void s.send({ diskId, whole: true }, 'the whole disk')}
            data-testid={`send-adf-${diskId}`}
            className="btn-like inline-flex h-[38px] shrink-0 items-center rounded-[10px] border px-3 text-[13px] font-medium disabled:opacity-50"
            style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
      Send .adf to Amiga
    </button>
  );
}
