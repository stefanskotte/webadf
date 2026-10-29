// What the Files manager carries over from the Browse page around an edit (Files increment 1, Task 9b): Undo, the
// TOSEC-identity confirm and the "new in vN" marks. CLIENT-SAFE: no database import.
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

/**
 * A path's place on its disk ('' for the disk itself, '/'-joined names below it); null outside `base` or without one.
 * `base` is the listing's diskBase (Files 2 R2): a disk reached through a collection has one more segment, so the
 * place is never read from fixed positions of the path.
 */
export function diskRelative(path: string, base: string | null | undefined): string | null {
  if (!base) return null;
  if (path === base) return '';
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/** The entries with the version that added them (disk-history/added-in.ts, keyed by the path under `base`). */
export function withAddedIn(entries: FsEntry[], marks: ReadonlyMap<string, number>, base: string | null | undefined): FsEntry[] {
  if (marks.size === 0) return entries;
  return entries.map((e) => {
    const rel = diskRelative(e.path, base);
    const seq = rel === null ? undefined : marks.get(rel);
    return seq === undefined ? e : { ...e, addedIn: seq };
  });
}
