// The Files page's first listing of a pane (page.tsx), when its place throws instead of listing. Pure; the page lists.
import { Pending, Refused } from './driver';
import { refusalWords } from './words';
import type { Device } from './path';
import type { Listing } from './types';

/**
 * A pane's first state: its listing, or null when the place is gone; `error` the words when it cannot be read (and
 * `errorDisk` the disk an unreadable image's refusal named, for its strip); `pending` the label of a NET: listing the
 * Amiga has been asked for and not answered yet (NET: volumes, spec 2026-10-30 §4.4), which the pane asks again for.
 */
export type First = { listing: Listing | null; error?: string; errorDisk?: string; pending?: string };

/**
 * What a pane opens with when its first listing threw `e`; null for anything to throw on. An unreadable image or
 * archive, and since NET: volumes any NET: refusal (a reload or an old tab at a volume): its words, never a failed page.
 */
export function firstFromThrown(e: unknown, device: Device): First | null {
  if (e instanceof Pending) return { listing: null, pending: e.label };
  if (!(e instanceof Refused)) return null;
  const { code, detail } = e.refusal;
  if (code === 'blob_unavailable' || code === 'archive_unreadable') {
    return { listing: null, error: refusalWords(code), errorDisk: code === 'blob_unavailable' ? detail : undefined };
  }
  if (device === 'NET') return { listing: null, error: detail ?? refusalWords(code) };
  return null;
}
