import { createHash } from 'node:crypto';
import { diskStore } from '@/lib/storage';
import type { QueueResult, TransferRow } from '@/lib/transfers';
import type { TransferView } from '@/lib/send-ui';

/** The code a refusal goes by on the wire: a blob that is no longer stored is "gone". */
export function refusalCode(reason: Extract<QueueResult, { ok: false }>['reason']): string {
  return reason === 'no_blob' ? 'gone' : reason;
}

/** One queued file as the user routes answer it: 201 {ids}, or the refusal as its own status and code. */
export function queueResponse(r: QueueResult): Response {
  if (r.ok) return Response.json({ ids: [r.id] }, { status: 201 });
  const status = { bad_name: 400, too_large: 413, queue_full: 409, no_device: 404, no_blob: 410 }[r.reason];
  return Response.json({ error: refusalCode(r.reason) }, { status });
}

/** Store bytes in the disk store under their own sha-256 (R2) and return that sha-256, which is what the queue
 *  is given: the queue's `bytes` option checks only the length, so the hash must come from the same bytes. */
export async function storeSendBytes(bytes: Uint8Array): Promise<string> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!(await diskStore.stat(sha256))) await diskStore.put(sha256, bytes);
  return sha256;
}

/** A row as the browser sees it. A row still waiting or moving past its expiry reads 'expired' at once, as
 *  retryTransfer treats a lapsed queued row: the poll already skips it, and the daily cron only catches up the status. */
export function toView(r: TransferRow, now: number): TransferView {
  const lapsed = (r.status === 'queued' || r.status === 'sending') && r.expiresAt.getTime() <= now;
  return {
    id: r.id, path: r.path, sizeBytes: r.sizeBytes, status: lapsed ? 'expired' : (r.status as TransferView['status']),
    bytesSent: r.bytesSent, savedAs: r.savedAs, errorCode: r.errorCode, errorText: r.errorText,
    createdAt: r.createdAt.getTime(), finishedAt: r.finishedAt?.getTime() ?? null,
  };
}
