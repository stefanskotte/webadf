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

/** The control characters parsePath refuses in a segment. */
const CONTROL = /[\u0000-\u001f\u007f]/;
const SEGMENT_MAX = 255;
/** parsePath allows 40 segments in all; this leaves room for the STASH: folders and the archive's own name above it. */
export const MEMBER_DEPTH_MAX = 32;

/**
 * A member's names as STASH: shows them: '.' segments dropped. A name no STASH: path can carry ('..', a control
 * character, a segment over 255, deeper than MEMBER_DEPTH_MAX) is `bad`, shown at the archive's root under its last
 * name made safe, so every listed path parses and no copy ever hands a writer a '..'.
 */
export function memberPath(raw: string): { path: string[]; bad: boolean } {
  const segs = raw.split('/').filter((s) => s && s !== '.');
  const bad = segs.length > MEMBER_DEPTH_MAX || segs.some((s) => s === '..' || CONTROL.test(s) || s.length > SEGMENT_MAX);
  if (!bad) return { path: segs, bad };
  const last = (raw.split('/').filter(Boolean).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, SEGMENT_MAX);
  return { path: [last === '.' || last === '..' || !last ? '_' : last], bad };
}

/**
 * The archive's members as files (folders implicit), or null when it is over MAX_ARCHIVE_BYTES, unreadable, or any
 * member it was asked for is over the caps. `accept` (a member's '/'-path) limits the decoding to those members: a read
 * of one member inflates that member only. Without it every member is decoded -- the readers report sizes and dates
 * only for members they decode, so a listing pays the full (capped) inflate.
 */
export async function openArchive(name: string, bytes: Uint8Array, accept?: (path: string) => boolean): Promise<OpenedArchive | null> {
  if (!isArchiveName(name) || bytes.length > MAX_ARCHIVE_BYTES) return null;
  // `accept` judges the path as STASH: shows it (memberPath), the one a read or collect names.
  const caps = { maxEntryBytes: MAX_ZIP_MEMBER_BYTES, maxTotalBytes: MAX_ZIP_TOTAL_BYTES,
    accept: accept && ((raw: string) => accept(memberPath(raw).path.join('/'))) };
  let read: { entries: { path: string; bytes: Uint8Array; date: Date | null; protection: number | null }[]; skipped: { path: string; reason: string }[] };
  try {
    read = /\.zip$/i.test(name) ? await readZip(bytes, caps) : readLha(bytes, caps);
  } catch {
    return null;   // neither reader is meant to throw; a server route must not fall over if one does
  }
  const skipped = read.skipped.filter((s) => s.reason !== 'not selected');
  if (skipped.some((s) => isSizeReason(s.reason) || ARCHIVE_REASONS.has(s.reason))) return null;
  const files: ArchiveFile[] = [];
  const unreadable: ArchiveUnreadable[] = [];
  for (const e of read.entries) {
    const m = memberPath(e.path);
    if (m.bad) unreadable.push({ path: m.path, reason: 'bad name' });
    else if (m.path.length) files.push({ path: m.path, bytes: e.bytes, date: e.date, protection: e.protection, comment: null });
  }
  for (const k of skipped) {
    const m = memberPath(k.path);
    if (m.path.length) unreadable.push({ path: m.path, reason: k.reason });
  }
  // No members at all, or (opened whole) none it can read: not an archive this can open, never an empty folder that
  // looks fine. With `accept`, members set aside as not selected still prove it is one.
  if (read.entries.length === 0 && read.skipped.length === 0) return null;
  if (!accept && files.length === 0) return null;
  return { files, unreadable };
}
