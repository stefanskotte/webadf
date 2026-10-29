// What the Files manager carries over from the Browse page around an edit (Files increment 1, Task 9b): Undo, the
// TOSEC-identity confirm and the "new in vN" marks. CLIENT-SAFE: no database import.
import { parsePath } from './path';
import type { DiskInfo, FsEntry } from './types';

/** One history version an operation saved: the disk, and the version it was saved as. */
export type OpVersion = { diskId: string; seq: number };

/**
 * The version Undo puts back the disk before: only when the op wrote exactly ONE version of ONE disk. A move between
 * disks wrote two, and restoring one of them would undo half of it. Version 0 has nothing before it. Undo itself
 * restores `seq - 1` only while `seq` is still the disk's current version (the restore route's `ifHead`), so an edit
 * that landed in between is never thrown away.
 */
export function undoTarget(versions: readonly OpVersion[]): OpVersion | null {
  return versions.length === 1 && versions[0].seq > 0 ? versions[0] : null;
}

/**
 * The first of the disks a write is about to change that still carries a TOSEC identity (DiskInfo.tosecName: a real
 * match only) not yet confirmed away this visit -- the Browse page's D-W-3 confirm, asked once per disk.
 */
export function identityToConfirm(disks: readonly (DiskInfo | null | undefined)[], confirmed: ReadonlySet<string>): DiskInfo | null {
  return disks.find((d): d is DiskInfo => !!d?.tosecName && !confirmed.has(d.diskId)) ?? null;
}

/** A LIBRARY: path's place on its disk ('' for the disk itself, '/'-joined names below it); null above the disks. */
export function diskRelative(path: string): string | null {
  const p = parsePath(path);
  return p && p.segments.length >= 2 ? p.segments.slice(2).join('/') : null;
}

/** The entries with the version that added them (disk-history/added-in.ts, keyed by the path on the disk). */
export function withAddedIn(entries: FsEntry[], marks: ReadonlyMap<string, number>): FsEntry[] {
  if (marks.size === 0) return entries;
  return entries.map((e) => {
    const rel = diskRelative(e.path);
    const seq = rel === null ? undefined : marks.get(rel);
    return seq === undefined ? e : { ...e, addedIn: seq };
  });
}
