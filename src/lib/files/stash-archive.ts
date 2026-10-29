// src/lib/files/stash-archive.ts
// A .lha/.lzh/.zip in STASH: opened on the server as a read-only folder (Files spec 2026-10-29 §4.2, increment 2): its
// members as files, with the dates and protection the archive records, bounded by the caps archive/index.ts sets. SERVER ONLY.
import { isArchiveName, MAX_ARCHIVE_BYTES, MAX_ZIP_MEMBER_BYTES, MAX_ZIP_TOTAL_BYTES } from '@/lib/archive';
import { readLha } from '@/lib/archive/lha';
import { readZip } from '@/lib/archive/zip';

export type ArchiveFile = { path: string[]; bytes: Uint8Array; date: Date | null; protection: number | null; comment: string | null };
/** A member the reader would not decode for a reason other than size (encrypted, an unsupported method, cut short). */
export type ArchiveUnreadable = { path: string[]; reason: string };
export type OpenedArchive = { files: ArchiveFile[]; unreadable: ArchiveUnreadable[] };

/**
 * Reasons that refuse the WHOLE archive (ruling 5): a member over the caps, or a decode that hit the LZH work budget,
 * would otherwise leave a listing short with nothing to say so. The archive stays a file to download or copy.
 */
const isSizeReason = (r: string) => r === 'too large' || r === 'archive limit reached' || r.startsWith('corrupt (');
/** Reasons that are about the archive, not one member: nothing past them can be trusted. */
const ARCHIVE_REASONS = new Set(['not a zip', 'unsupported-header-level', 'truncated header']);

const split = (path: string) => path.split('/').filter(Boolean);

/**
 * The archive's members as files (folders implicit), or null when it is over MAX_ARCHIVE_BYTES, unreadable, or any
 * member it was asked for is over the caps. `accept` (a member's '/'-path) limits the decoding to those members: a read
 * of one member inflates that member only. Without it every member is decoded -- the readers report sizes and dates
 * only for members they decode, so a listing pays the full (capped) inflate.
 */
export async function openArchive(name: string, bytes: Uint8Array, accept?: (path: string) => boolean): Promise<OpenedArchive | null> {
  if (!isArchiveName(name) || bytes.length > MAX_ARCHIVE_BYTES) return null;
  const caps = { maxEntryBytes: MAX_ZIP_MEMBER_BYTES, maxTotalBytes: MAX_ZIP_TOTAL_BYTES, accept };
  let read: { entries: { path: string; bytes: Uint8Array; date: Date | null; protection: number | null }[]; skipped: { path: string; reason: string }[] };
  try {
    read = /\.zip$/i.test(name) ? await readZip(bytes, caps) : readLha(bytes, caps);
  } catch {
    return null;   // neither reader is meant to throw; a server route must not fall over if one does
  }
  const skipped = read.skipped.filter((s) => s.reason !== 'not selected');
  if (skipped.some((s) => isSizeReason(s.reason) || ARCHIVE_REASONS.has(s.reason))) return null;
  const files = read.entries.map((e) => ({ path: split(e.path), bytes: e.bytes, date: e.date, protection: e.protection, comment: null }))
    .filter((f) => f.path.length > 0);
  const unreadable = skipped.map((s) => ({ path: split(s.path), reason: s.reason })).filter((u) => u.path.length > 0);
  // No members at all, or (opened whole) none it can read: not an archive this can open, never an empty folder that
  // looks fine. With `accept`, members set aside as not selected still prove it is one.
  if (read.entries.length === 0 && read.skipped.length === 0) return null;
  if (!accept && files.length === 0) return null;
  return { files, unreadable };
}
