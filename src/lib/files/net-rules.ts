// src/lib/files/net-rules.ts
// NET: rules a pane and the engine share (Files spec 2026-10-29 §4.3, increment 3): how often a board's queue is
// re-read, whether a drop fits the board's queue, and the words NET: refuses with. CLIENT-SAFE: no server imports.
import { parsePath } from './path';
import type { Listing } from './types';
import { isActiveTransferText } from '@/lib/send-ui';
import { SEND_FILE_MAX, SEND_QUEUE_MAX_BYTES, SEND_QUEUE_MAX_FILES } from '@/lib/send-limits';
import { QUEUE_FOLDER } from '@/lib/remote-limits';

export const NET_REFRESH_ACTIVE_MS = 3_000;
export const NET_REFRESH_IDLE_MS = 10_000;

/** R5: nothing is copied, moved or downloaded out of NET: (the engine's `unsupported` detail; words.ts reads it as is). */
export const NET_COPY_OUT = 'Files waiting for the Amiga cannot be copied out';
/** C16: a move into NET: would delete the original once queued; only Copy sends. */
export const NET_MOVE_IN = 'Files sent to the Amiga stay where they are — use Copy';
/** The engine's `unsupported` detail for an empty file; words.ts adds "— nothing was sent". */
export const netEmpty = (path: string) => `${path} is empty`;
/** NET: itself lists boards and takes nothing: its `readOnlyReason`. */
export const NET_PICK_BOARD = 'Open a board to send files to it';

/**
 * How often a pane showing `l` re-reads it: a board's queue (NET:/<board>/Queue) only; faster while anything waits or
 * sends. A board's volumes are read on request (spec 2026-10-30), never polled.
 */
export function netPollMs(l: Listing | null): number | null {
  const p = l && parsePath(l.path);
  if (!p || p.device !== 'NET' || p.segments.length !== 2 || p.segments[1] !== QUEUE_FOLDER) return null;
  return l.entries.some((e) => e.marks[0] !== undefined && isActiveTransferText(e.marks[0])) ? NET_REFRESH_ACTIVE_MS : NET_REFRESH_IDLE_MS;
}

/**
 * Whether files of these sizes fit the board's queue as `queue` reports it (R3, R7): the queue first (the whole drop
 * against what already waits), then each file (`index`: the first that is empty or over 4 MB).
 */
export function planNetSend(sizes: number[], queue: { files: number; bytes: number }):
  { ok: true } | { ok: false; why: 'too_large' | 'queue_full' | 'empty'; index?: number } {
  if (sizes.length === 0) return { ok: false, why: 'empty' };
  const bytes = sizes.reduce((a, n) => a + n, 0);
  if (queue.files + sizes.length > SEND_QUEUE_MAX_FILES || queue.bytes + bytes > SEND_QUEUE_MAX_BYTES) return { ok: false, why: 'queue_full' };
  for (const [index, n] of sizes.entries()) {
    if (n <= 0) return { ok: false, why: 'empty', index };
    if (n > SEND_FILE_MAX) return { ok: false, why: 'too_large', index };
  }
  return { ok: true };
}
