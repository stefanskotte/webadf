import type { TransferStatus } from '@/lib/transfers';
import { SEND_FILE_MAX } from '@/lib/send-limits';

// Every word the web app says about sending to the Amiga (spec 2026-10-16 §4; plan 2026-10-17). Pure and
// client-safe: the type import above is erased, so nothing server-side reaches the bundle.

export type Rx = 'c' | 'r' | 'u' | '-';
/** R6: the board writes rx at most every 30 s and polls every 25 s, so a healthy reading can be ~56 s old. */
export const RX_FRESH_MS = 75_000;
/** R7: a board offline longer than a waiting file lives is behind "Show offline". */
export const LONG_OFFLINE_MS = 24 * 3600_000;
export const SEND_BOARD_KEY = 'webadf:send-board';

export type SendTarget = {
  id: string; name: string; macAddress: string | null; defaultName: boolean;
  online: boolean; lastSeenAt: number | null; network: boolean; rx: Rx | null; rxAt: number | null;
};
export type SendContext = { targets: SendTarget[]; now: number };
export type TransferView = {
  id: string; path: string; sizeBytes: number; status: TransferStatus; bytesSent: number;
  savedAs: string | null; errorCode: string | null; errorText: string | null; createdAt: number; finishedAt: number | null;
};
export type Tone = 'ok' | 'busy' | 'bad' | 'muted';
export type SendSummary = { waiting: number; sending: number; delivered: number; failed: number };

// Receive's error codes (spec §2), as a person would say them.
const REASONS: Record<string, string> = {
  space: 'not enough space on the Amiga',
  crc: 'damaged on the way',
  name: 'the Amiga refused the name',
  write: 'could not write it on the Amiga',
  folder: 'the folder on the Amiga is missing',
  busy: 'Receive was busy',
  size: 'too large for Receive',
};

export function failureText(code: string | null, text: string | null): string {
  if (code && REASONS[code]) return REASONS[code];
  return text?.trim() || code || 'unknown reason';
}

export function transferState(t: TransferView): { text: string; tone: Tone } {
  switch (t.status) {
    case 'queued': return { text: 'Waiting', tone: 'busy' };
    case 'sending': {
      // bytes_sent is the last chunk's offset, one chunk behind (increment 2): never 100 % before Delivered.
      const pct = t.sizeBytes > 0 ? Math.min(99, Math.floor((t.bytesSent * 100) / t.sizeBytes)) : 0;
      return { text: `Sending ${pct} %`, tone: 'busy' };
    }
    case 'delivered': return { text: `Delivered · saved as ${t.savedAs ?? t.path}`, tone: 'ok' };
    case 'failed': return { text: `Failed · ${failureText(t.errorCode, t.errorText)}`, tone: 'bad' };
    case 'cancelled': return { text: 'Cancelled', tone: 'muted' };
    case 'expired': return { text: 'Expired · the Amiga did not take it within 24 h', tone: 'bad' };
  }
}

/** A queue row's state as the Upload page draws it: a coloured chip, then the detail as secondary text. */
export type ChipKind = 'amber' | 'blue' | 'green' | 'red' | 'neutral';
export type StateChip = { kind: ChipKind; label: string; note: string | null; path: string | null };

/**
 * transferState split for the chip: `label · note path` reads back as exactly transferState's text, so the words
 * stay in one place. `path` is the saved name, kept apart so it can be drawn in monospace.
 */
export function stateChip(t: TransferView): StateChip {
  switch (t.status) {
    case 'queued': return { kind: 'amber', label: 'Waiting', note: null, path: null };
    case 'sending': return { kind: 'blue', label: transferState(t).text, note: null, path: null };
    case 'delivered': return { kind: 'green', label: 'Delivered', note: 'saved as', path: t.savedAs ?? t.path };
    case 'failed': return { kind: 'red', label: 'Failed', note: failureText(t.errorCode, t.errorText), path: null };
    case 'cancelled': return { kind: 'neutral', label: 'Cancelled', note: null, path: null };
    case 'expired': return { kind: 'red', label: 'Expired', note: 'the Amiga did not take it within 24 h', path: null };
  }
}

export const canCancel = (s: TransferStatus): boolean => s === 'queued' || s === 'sending';   // R9
export const canRetry = (s: TransferStatus): boolean => s === 'failed' || s === 'expired';   // R10

/** The Upload page's list: what waits or moves first, then what finished; each group keeps its order (newest first). */
export const orderQueue = (rows: TransferView[]): TransferView[] =>
  [...rows.filter((r) => canCancel(r.status)), ...rows.filter((r) => !canCancel(r.status))];
/** What "Clear finished" removes: a view's status already reads a lapsed waiting row as expired, as the server does. */
export const clearableCount = (rows: TransferView[]): number => rows.filter((r) => !canCancel(r.status)).length;

export function receiverRunning(t: Pick<SendTarget, 'rx' | 'rxAt'>, sending: boolean, now: number): boolean {
  return t.rx === 'c' && (sending || (t.rxAt !== null && now - t.rxAt <= RX_FRESH_MS));
}

export function receiverLine(t: SendTarget, q: { waiting: number; sending: boolean }, now: number): { ok: boolean; text: string } {
  if (!t.online) return { ok: false, text: 'The board is offline. Files wait until it is back.' };
  if (!t.network) return { ok: false, text: 'The board is not in Network mode. Files wait until it is.' };
  if (receiverRunning(t, q.sending, now)) return { ok: true, text: 'Receive is running on the Amiga' };
  if (t.rx === null || t.rx === '-') return { ok: false, text: 'The board has not seen the Amiga on the network yet' };
  if (q.waiting > 0) return { ok: false, text: 'Start Receive on the Amiga' };
  if (t.rx === 'u') return { ok: false, text: 'The Amiga does not answer' };
  return { ok: false, text: 'Receive is not running on the Amiga' };
}

export function offlineFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export function targetState(t: SendTarget, now: number): string {
  if (t.online) return 'online';
  return t.lastSeenAt === null ? 'never seen' : `offline ${offlineFor(now - t.lastSeenAt)}`;
}

export function longOffline(t: SendTarget, now: number): boolean {
  return !t.online && (t.lastSeenAt === null || now - t.lastSeenAt > LONG_OFFLINE_MS);
}

export function orderTargets(ts: readonly SendTarget[]): SendTarget[] {
  return [...ts].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The wanted board while it is still a target; else the first online one; else the first one; else none. */
export function pickTarget(ts: readonly SendTarget[], wanted: string | null, now: number): string | null {
  if (wanted && ts.some((t) => t.id === wanted)) return wanted;
  const ordered = orderTargets(ts);
  return ordered.find((t) => !longOffline(t, now))?.id ?? ordered[0]?.id ?? null;
}

export function cardSendLine(s: SendSummary | undefined, running: boolean): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.waiting) parts.push(`${s.waiting} ${s.waiting === 1 ? 'file' : 'files'} waiting`);
  if (s.sending) parts.push('1 sending');                // one file moves at a time
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.delivered && !s.waiting && !s.sending) parts.push(`${s.delivered} delivered`);
  if (parts.length === 0) return null;
  return `${parts.join(' · ')} · Receive ${running ? 'running' : 'not running'}`;
}

export function adfSendName(d: { tosecName: string | null; sourceFilename: string | null; diskNo: number }): string {
  const base = (d.tosecName ?? d.sourceFilename ?? '').replace(/\.(adf|adz|dms|dmz|hfe)$/i, '').trim();
  return `${base || `Disk ${d.diskNo}`}.adf`;
}

export function sendErrorText(code: string | undefined, status: number): string {
  switch (code) {
    case 'too_large': return `Over ${SEND_FILE_MAX / 1_048_576} MB: too large to send.`;
    case 'queue_full': return 'The queue for this board is full (32 files or 16 MB). Wait for some to arrive.';
    case 'bad_name': return 'That name cannot be used on the Amiga.';
    case 'empty': return 'The file is empty.';
    case 'no_device': return 'That board cannot receive files.';
    case 'not_waiting': return 'Already finished.';
    case 'unreadable': return 'A file on this disk could not be read whole.';
    case 'no_filesystem': return 'This disk has no files to send.';
    case 'not_adf': return 'Only ADF disks can be sent whole.';
    case 'not_finished': return 'It is still waiting or on its way.';
    case 'not_found': return 'That file or disk is no longer there.';
    case 'blob_unavailable': return 'The disk could not be read just now. Try again.';
    case 'gone': return 'The file is no longer stored. Send it again.';
    default: return `The server answered ${status}.`;
  }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}
