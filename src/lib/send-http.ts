import { createHash } from 'node:crypto';
import { diskStore } from '@/lib/storage';
import type { QueueResult, TransferRow } from '@/lib/transfers';
import type { TransferView } from '@/lib/send-ui';

/** The code a refusal goes by on the wire: a blob that is no longer stored is "gone". */
export function refusalCode(reason: Extract<QueueResult, { ok: false }>['reason']): string {
  return reason === 'no_blob' ? 'gone' : reason;
}

/** Wire contract beyond the brief's list: POST /api/transfers and from-disk may also answer 413 too_large (per file,
 *  from-disk adds `path`), 400 invalid_query / invalid_body / invalid_json (client-malformed; sendErrorText lets them
 *  fall through), and from-disk can answer 409 {error, ids} when a race refuses mid-folder: `ids` were queued. */
/** One queued file as the user routes answer it: 201 {ids}, or the refusal as its own status and code. */
export function queueResponse(r: QueueResult): Response {
  if (r.ok) return Response.json({ ids: [r.id] }, { status: 201 });
  const status = { bad_name: 400, too_large: 413, queue_full: 409, no_device: 404, no_blob: 410 }[r.reason];
  return Response.json({ error: refusalCode(r.reason) }, { status });
}

const sha256Of = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * Store bytes the SERVER holds (a Send, a board's close, a STASH: write or URL fetch) in the disk store under their own
 * sha-256 (R2) and return that sha-256, which is what the queue is given: the queue's `bytes` option checks only the
 * length, so the hash must come from the same bytes. A blob already at the key is reused only when it is these bytes,
 * by size and by hash: anyone may presign a key and PUT other bytes there without committing, and a row must never name
 * bytes that are not its own. Anything else there is overwritten with the real bytes, which every row naming the key
 * is owed; a read that fails is no proof either way, so the bytes are put then too.
 */
export async function storeSendBytes(bytes: Uint8Array): Promise<string> {
  const sha256 = sha256Of(bytes);
  const held = await diskStore.stat(sha256);
  if (held && held.sizeBytes === bytes.byteLength) {
    const back = await diskStore.read(sha256).catch(() => null);
    if (back && sha256Of(back) === sha256) return sha256;
  }
  // Overwrite even when absent: a PUT planted between the stat and this put must not win by "already exists".
  await diskStore.put(sha256, bytes, { overwrite: true });
  return sha256;
}

/** A row as the browser sees it. A row still waiting or moving past its expiry reads 'expired' at once: the poll
 *  already skips it, and the daily cron only catches up the status. */
export function toView(r: TransferRow, now: number): TransferView {
  const lapsed = (r.status === 'queued' || r.status === 'sending') && r.expiresAt.getTime() <= now;
  return {
    id: r.id, path: r.path, sizeBytes: r.sizeBytes, status: lapsed ? 'expired' : (r.status as TransferView['status']),
    bytesSent: r.bytesSent, savedAs: r.savedAs, errorCode: r.errorCode, errorText: r.errorText,
    createdAt: r.createdAt.getTime(), finishedAt: r.finishedAt?.getTime() ?? null,
  };
}
