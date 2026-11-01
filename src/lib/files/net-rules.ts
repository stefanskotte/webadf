// src/lib/files/net-rules.ts
// NET: rules a pane and the engine share (Files spec 2026-10-29 §4.3, increment 3): how often a board's queue is
// re-read, whether a drop fits the board's queue, and the words NET: refuses with. CLIENT-SAFE: no server imports.
import { formatPath, parsePath } from './path';
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
/** Phase 2: what a drop of files from the computer onto a volume says (they go up to STASH: first). */
export const NET_DROP_TO_STASH = 'Drop files into STASH: first, then copy them onto the Amiga';

/**
 * The details of a NET: refusal that read as a sentence of their own (words.ts says them with a full stop): why a board
 * cannot be browsed or written to, and phase 2's own refusals (spec 2026-10-31 §4.1-4.2).
 */
export function isNetWords(detail: string): boolean {
  return /^(Tick Read in Transfer on |Switch on browsing in Transfer on |Transfer is not running on |Transfer 2\.3 or newer is needed on |Firmware 1\.22 or newer is needed$|Writing is off in Transfer$|Transfer 2\.5 or newer writes to the Amiga$|Board firmware 1\.23\.0 or newer writes to the Amiga$|List the drawer again and retry$|Move within one volume$|Rename a volume on the Amiga$|Move needs Transfer 2\.6 — use Copy$|offline |never seen$)/.test(detail);
}

/**
 * Transfer 2.6 renames a drawer it deletes to `.webadf-del-<8 hex>` first (spec 2026-10-31 §9); an Amiga reset mid-delete
 * leaves it. It is the owner's data: listed as it is, with this mark, so it can be deleted or renamed back.
 */
export const DELETE_LEFTOVER = 'Left by an interrupted delete';
export const isDeleteLeftover = (name: string) => /^\.webadf-del-[0-9a-f]{8}$/i.test(name);

/** The crumbs of a NET: path a pane has no listing for (a pending or failed one, §4.4 minor 3): NET: › board › Volume: › drawers. */
export function netCrumbs(path: string, boardName: string): { label: string; path: string }[] {
  const p = parsePath(path);
  if (p?.device !== 'NET') return [];
  const at = (n: number) => formatPath({ device: 'NET', segments: p.segments.slice(0, n) });
  return [{ label: 'NET:', path: 'NET:' }, ...p.segments.map((s, i) => ({ label: i === 0 ? boardName : i === 1 ? `${s}:` : s, path: at(i + 1) }))];
}

/** A listing of a volume, or a drawer in one (`net.volume` set): read, read-only, through the board (spec 2026-10-30). */
export function isNetVolume(l: Listing | null): boolean {
  return !!l?.net?.volume;
}

/** NET:/<board>/<Volume>[/…]: a volume or a drawer on one (phase 2: where copies onto the Amiga land). */
export function isVolumePlace(path: string): boolean {
  const p = parsePath(path);
  return p?.device === 'NET' && p.segments.length >= 2 && p.segments[1] !== QUEUE_FOLDER;
}

/** The board NET:/<board> is the root of (its volumes and Queue); null for any other path. */
export function netBoardRoot(path: string): string | null {
  const p = parsePath(path);
  return p?.device === 'NET' && p.segments.length === 1 ? p.segments[0] : null;
}

/**
 * The board's name for a NET: path, from a listing on screen that knows it (a listing of that board, or NET: with the
 * board's row), else `boards`, else the board's id: the "didn't answer" words name it before anything of it was read.
 */
export function boardNameFor(path: string, l: Listing | null, boards: readonly { id: string; name: string }[] = []): string {
  const id = parsePath(path)?.segments[0] ?? path;
  if (l?.net?.board === id) return l.net.boardName;
  // `boards`: the page's boards (its Send targets), for a pane opened straight at a volume nothing on screen names.
  return l?.entries.find((e) => e.kind === 'board' && e.path === `NET:/${id}`)?.name ?? boards.find((b) => b.id === id)?.name ?? id;
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

/**
 * A refused listing (`/api/files/list`'s status and detail) in the pane: gone (404, 400: "This place no longer
 * exists."), or its words -- a NET: refusal's detail is the pane's whole sentence ("Object not found", "Switch on
 * browsing in Transfer on A500"), a 404 with one included (a drawer the Amiga refused, final review); `words` null
 * elsewhere, where the refusal's code decides.
 */
export function listingRefusal(path: string, status: number, detail: unknown): { gone: true } | { words: string | null } {
  const net = parsePath(path)?.device === 'NET' && typeof detail === 'string' ? detail : null;
  if (status === 400 || (status === 404 && net === null)) return { gone: true };
  return { words: net };
}

/** A pane asking for a pending listing (§4.4): ask again, or give up once PANE_GIVE_UP_MS have passed since it began. */
export function nextAsk(startedAt: number, now: number): 'ask' | 'give-up' {
  return now - startedAt >= PANE_GIVE_UP_MS ? 'give-up' : 'ask';
}

/**
 * How often a pane showing `l` re-reads it: a board's queue (NET:/<board>/Queue), faster while anything waits or
 * sends; a volume's drawer only while files of a copy are arriving in it (phase 2). Otherwise a board's volumes are read
 * on request (spec 2026-10-30), never polled.
 */
export function netPollMs(l: Listing | null): number | null {
  const p = l && parsePath(l.path);
  if (!p || p.device !== 'NET') return null;
  const active = l.entries.some((e) => e.marks[0] !== undefined && isActiveTransferText(e.marks[0]));
  // A drawer a copy onto the Amiga is arriving in (phase 2, spec 2026-10-31 §4.1) follows its rows while they move.
  if (p.segments.length >= 2 && p.segments[1] !== QUEUE_FOLDER) return active ? NET_REFRESH_ACTIVE_MS : null;
  if (p.segments.length !== 2 || p.segments[1] !== QUEUE_FOLDER) return null;
  return active ? NET_REFRESH_ACTIVE_MS : NET_REFRESH_IDLE_MS;
}

/**
 * Whether a pane at `panePath` shows a copy onto `dest` arriving (spec 2026-10-31 §4.1): it is the destination drawer,
 * or a drawer of the same volume above it, where the copy is a row of its top-level entry. Case as AmigaDOS: ignored.
 */
export function arrivesIn(panePath: string, dest: string): boolean {
  const p = parsePath(panePath);
  const d = parsePath(dest);
  if (!p || !d || p.device !== 'NET' || d.device !== 'NET' || p.segments.length < 2 || p.segments[1] === QUEUE_FOLDER) return false;
  if (p.segments.length > d.segments.length) return false;
  return p.segments.every((s, k) => s.toLowerCase() === d.segments[k].toLowerCase());
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
