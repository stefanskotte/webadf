// Every word and rule the From the Amiga card and the device card use (spec 2026-10-18 §4, U6). Pure, client-safe.
import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { UPLOAD_FILE_MAX, UPLOAD_FW } from '@/lib/amiga-upload-limits';
import { firmwareAtLeast } from '@/lib/firmware-version';
import type { UploadView } from '@/lib/amiga-uploads';

/** The library's extensions (= archive/disk-image.ts's DISK_IMAGE_PATTERN, which the client must not import). */
export const LIBRARY_EXT = /\.(adf|dsk|adz|dms|dmz|hfe)$/i;

/** Add to library is offered for the library's disk images only, at the sizes the library takes (spec §4). */
export function libraryEligible(path: string, size: number): boolean {
  const m = LIBRARY_EXT.exec(path.split('/').pop() ?? '');
  if (!m || size <= 0) return false;
  const ext = m[1].toLowerCase();
  return ext === 'adz' || ext === 'dms' || ext === 'dmz' ? size <= UPLOAD_FILE_MAX : size <= MAX_DISK_BYTES;
}

export type UploadChip = { kind: 'amber' | 'blue' | 'green' | 'red' | 'neutral'; label: string; note: string | null };
const FAILED: Record<string, string> = {
  crc: 'damaged on the way: send it again',
  expired: 'not finished within 24 hours: send it again',
};
export function uploadChip(r: UploadView): UploadChip {
  if (r.status === 'receiving') {
    const pct = r.sizeBytes ? Math.min(99, Math.floor((r.receivedBytes * 100) / r.sizeBytes)) : 0;
    return { kind: 'blue', label: `Arriving ${pct} %`, note: null };
  }
  if (r.status === 'failed') return { kind: 'red', label: 'Failed', note: FAILED[r.errorCode ?? ''] ?? 'it did not arrive whole' };
  return { kind: 'green', label: 'Stored', note: null };
}
/** The device card (spec §4, §8): files stored within 24 h, or, on a Network board too old to send, the update. Nothing otherwise. */
export function cardUploadLine(count: number | undefined, fw: string | null, network: boolean): { text: string; href: boolean } | null {
  if (count && count > 0) return { text: `${count} ${count === 1 ? 'file' : 'files'} from the Amiga`, href: true };
  if (network && !firmwareAtLeast(fw, UPLOAD_FW)) return { text: `Update to ${UPLOAD_FW} to send files from the Amiga`, href: false };
  return null;
}
export const clearConfirm = (n: number) => (n === 1 ? 'Clear 1 file from the Amiga?' : `Clear ${n} files from the Amiga?`);
export const clearable = (rows: UploadView[]) => rows.filter((r) => r.status !== 'receiving').length;
/** The greatest cursor in the list (fixed-width UTC strings compare as text): a row stored late can outrun the newest created. Null if empty. */
export const newestSeen = (rows: UploadView[]): string | null => rows.reduce<string | null>((m, r) => (m === null || r.cursor > m ? r.cursor : m), null);
/** The body of POST /api/uploads/clear: the newest row seen, and the board filter only when one is on. */
export function clearBody(rows: UploadView[], board: string | null): { cursor: string; board?: string } | null {
  const cursor = newestSeen(rows);
  if (!cursor) return null;
  return board ? { cursor, board } : { cursor };
}
export const anyArriving = (rows: UploadView[]) => rows.some((r) => r.status === 'receiving');
export function uploadErrorText(code: string | undefined, status: number): string {
  switch (code) {
    case 'not_a_disk_image': return 'Not a disk image the library takes.';
    case 'ingest_failed': return 'The library could not take it just now. Try again.';
    case 'not_found': return 'That file is no longer here.';
    case 'no_device': return 'That board cannot receive files.';
    case 'queue_full': return 'The queue for that board is full (32 files or 16 MB). Wait for some to arrive.';
    case 'too_large': return 'Over 4 MB: too large to send.';
    case 'bad_name': return 'That name cannot be used on the Amiga.';
    case 'invalid': return 'The list was out of date. Refresh the page and try again.';
    default: return `The server answered ${status}.`;
  }
}

/** The name a downloaded file is saved under: the last part of its Amiga path (what the file route sends too). */
export const downloadName = (path: string): string => path.split(/[/:]/).pop() || 'file';
/** Where Tab should send focus to keep it inside a dialog of `count` controls, or null to let the browser move it. */
export function tabTarget(index: number, count: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0) return shift ? count - 1 : 0;
  if (!shift && index === count - 1) return 0;
  if (shift && index === 0) return count - 1;
  return null;
}
