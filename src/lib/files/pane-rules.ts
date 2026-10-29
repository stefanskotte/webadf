// What a pane's place allows, now that panes show STASH: as well as LIBRARY: (Files increment 2, Task 7).
// CLIENT-SAFE: no database import.
import { libraryEligible } from '@/lib/from-amiga-ui';
import { parsePath } from './path';
import type { FsEntry, Listing } from './types';

const inStash = (path: string) => parsePath(path)?.device === 'STASH';

/**
 * A place files and folders live in: inside a disk, or anywhere in STASH: (an archive too, read-only). Above the disks
 * (LIBRARY:, a title) the rows are titles and disks, which are not copied, moved or dropped into.
 */
export function holdsFiles(l: Listing | null): boolean {
  return !!l && (l.disk !== null || inStash(l.path));
}

/** A STASH: row the board or a commit has not finished, or one that failed: not a stored file yet (stash-driver marksOf). */
const unfinished = (e: FsEntry) => e.marks.some((m) => m.startsWith('arriving') || m.startsWith('failed'));

/** Add to library takes stored disk images in STASH: itself (R8), never members of an archive. */
export function addToLibraryReason(l: Listing | null, picked: FsEntry[]): string | null {
  if (!l || !inStash(l.path)) return 'Open STASH: to add its disk images to the library';
  if (picked.length === 0) return 'Select something first';
  if (l.readOnlyReason === 'archive') return 'Copy it out of the archive first';
  const image = (e: FsEntry) => (e.kind === 'file' || e.kind === 'archive') && !unfinished(e) && libraryEligible(e.name, e.size ?? 0);
  return picked.every(image) ? null : 'Select disk images (ADF, ADZ, DMS, DMZ, HFE) to add them';
}

/**
 * Undo puts a disk back a version; STASH: keeps no versions. So a copy or move that writes into STASH:, or a move that
 * takes files out of it, is never offered Undo: restoring the disk alone would leave half of it done (or, for a move
 * out of STASH:, lose the files).
 */
export function offersUndo(op: 'copy' | 'move', sources: readonly string[], dest: string): boolean {
  if (inStash(dest)) return false;
  return op === 'copy' || !sources.some(inStash);
}

/** The place a toast names: the disk's label, STASH:, else "the other side". */
export function placeOf(l: Listing | null): string {
  if (l?.disk) return l.disk.label;
  return l && inStash(l.path) ? 'STASH:' : 'the other side';
}
