// The rules and words files from the Amiga still use (spec 2026-10-18 §4, U6): Add to library's test, a failed file's
// reason (STASH: marks) and the device card's line. The Upload page's list rules retired with it (Files increment 3).
// Pure, client-safe.
import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { UPLOAD_FILE_MAX, UPLOAD_FW } from '@/lib/amiga-upload-limits';
import { firmwareAtLeast } from '@/lib/firmware-version';

/** The library's extensions (= archive/disk-image.ts's DISK_IMAGE_PATTERN, which the client must not import). */
export const LIBRARY_EXT = /\.(adf|dsk|adz|dms|dmz|hfe)$/i;

/** Add to library is offered for the library's disk images only, at the sizes the library takes (spec §4). */
export function libraryEligible(path: string, size: number): boolean {
  const m = LIBRARY_EXT.exec(path.split('/').pop() ?? '');
  if (!m || size <= 0) return false;
  const ext = m[1].toLowerCase();
  return ext === 'adz' || ext === 'dms' || ext === 'dmz' ? size <= UPLOAD_FILE_MAX : size <= MAX_DISK_BYTES;
}

const FAILED: Record<string, string> = {
  crc: 'damaged on the way: send it again',
  expired: 'not finished within 24 hours: send it again',
};
/** Why a failed file did not arrive whole, in words. */
export const uploadFailureText = (errorCode: string | null): string => FAILED[errorCode ?? ''] ?? 'it did not arrive whole';
/** The device card (spec §4, §8): files stored within 24 h, or, on a Network board too old to send, the update. Nothing otherwise. */
export function cardUploadLine(count: number | undefined, fw: string | null, network: boolean): { text: string; href: boolean } | null {
  if (count && count > 0) return { text: `${count} ${count === 1 ? 'file' : 'files'} from the Amiga`, href: true };
  if (network && !firmwareAtLeast(fw, UPLOAD_FW)) return { text: `Update to ${UPLOAD_FW} to send files from the Amiga`, href: false };
  return null;
}
