// src/lib/files/net-rules.ts
// NET: rules a pane and the engine share (Files spec 2026-10-29 §4.3, increment 3): how often a board's queue is
// re-read, whether a drop fits the board's queue, and the words NET: refuses with. CLIENT-SAFE: no server imports.
import { parsePath } from './path';
import type { Listing } from './types';
import { isActiveTransferText } from '@/lib/send-ui';
import { SEND_FILE_MAX, SEND_QUEUE_MAX_BYTES, SEND_QUEUE_MAX_FILES } from '@/lib/send-limits';
import { PANE_GIVE_UP_MS, QUEUE_FOLDER } from '@/lib/remote-limits';

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
/** A volume of a board's Amiga takes nothing in phase 1 (NET: volumes, spec 2026-10-30 §5): its `readOnlyReason`. */
export const NET_READ_ONLY = 'Read-only for now';
/** NET:/<board> lists places (its volumes and Queue), not files: its `readOnlyReason`, and what a copy out of it says. */
export const NET_OPEN_VOLUME = 'Open a volume or Queue';

/** A listing of a volume, or a drawer in one (`net.volume` set): read, read-only, through the board (spec 2026-10-30). */
export function isNetVolume(l: Listing | null): boolean {
  return !!l?.net?.volume;
}

/** The board NET:/<board> is the root of (its volumes and Queue); null for any other path. */
export function netBoardRoot(path: string): string | null {
  const p = parsePath(path);
  return p?.device === 'NET' && p.segments.length === 1 ? p.segments[0] : null;
}

/**
 * The board's name for a NET: path, from a listing on screen that knows it (a listing of that board, or NET: with the
 * board's row), else the board's id: the "didn't answer" words name it before anything of it was read.
 */
export function boardNameFor(path: string, l: Listing | null): string {
  const id = parsePath(path)?.segments[0] ?? path;
  if (l?.net?.board === id) return l.net.boardName;
  return l?.entries.find((e) => e.kind === 'board' && e.path === `NET:/${id}`)?.name ?? id;
}

/** The title bar of a volume pane (§5): "A500 · Work:Programs"; null at the board and anywhere else. */
export function netTitle(l: Listing): string | null {
  return l.net?.amigaPath ? `${l.net.boardName} · ${l.net.amigaPath}` : null;
}

/** "read 40 s ago" for a remembered listing (§5, V3); null when nothing was read or it is under 5 s old. */
export function readAgo(readAt: number | null, now: number): string | null {
  if (readAt === null) return null;
  const s = Math.floor((now - readAt) / 1000);
  if (s < 5) return null;
  return s < 60 ? `read ${s} s ago` : `read ${Math.floor(s / 60)} min ago`;
}

/** A pane asking for a pending listing (§4.4): ask again, or give up once PANE_GIVE_UP_MS have passed since it began. */
export function nextAsk(startedAt: number, now: number): 'ask' | 'give-up' {
  return now - startedAt >= PANE_GIVE_UP_MS ? 'give-up' : 'ask';
}

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
