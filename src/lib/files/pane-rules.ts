// What a pane's place allows, now that panes show STASH: and NET: as well as LIBRARY: (Files increment 2, Task 7;
// increment 3, Task 2). CLIENT-SAFE: no database import.
import { libraryEligible } from '@/lib/from-amiga-ui';
import { isActiveTransferText } from '@/lib/send-ui';
import { parsePath } from './path';
import { NET_COPY_OUT } from './net-rules';
import { QUEUE_FOLDER } from '@/lib/remote-limits';
import type { FsEntry, Listing } from './types';

const inStash = (path: string) => parsePath(path)?.device === 'STASH';
const inNet = (path: string) => parsePath(path)?.device === 'NET';

/**
 * A place files and folders live in: inside a disk, or anywhere in STASH: (an archive too, read-only). Above the disks
 * (LIBRARY:, a title) the rows are titles and disks, which are not copied, moved or dropped into.
 */
export function holdsFiles(l: Listing | null): boolean {
  return !!l && (l.disk !== null || inStash(l.path));
}

/**
 * The board a NET:/<board>/Queue listing is the queue of (NET: volumes, spec 2026-10-30 §4.3); null for NET: itself, a
 * board's root, its volumes and anywhere else.
 */
export function netBoardOf(l: Listing | null): string | null {
  const p = l ? parsePath(l.path) : null;
  return p?.device === 'NET' && p.segments.length === 2 && p.segments[1] === QUEUE_FOLDER ? p.segments[0] : null;
}

/**
 * Where a copy or a drop may land (C2): a place that holds files, or a board under NET: (a copy into it queues the files
 * for the Amiga). NET:/<board> is not a folder: nothing is made in it, dragged out of it or committed to STASH: from it,
 * so holdsFiles stays false there.
 */
export function acceptsCopies(l: Listing | null): boolean {
  return holdsFiles(l) || netBoardOf(l) !== null;
}

/** R5: nothing is copied, moved or downloaded out of NET:. */
export function copyOutReason(l: Listing | null): string | null {
  return l && inNet(l.path) ? NET_COPY_OUT : null;
}

/** NET: rows are queue rows: nothing renames them, makes folders, sets protection or edits a comment there. */
export function netReadOnly(l: Listing | null): boolean {
  return !!l && inNet(l.path);
}

/** A STASH: row the board or a commit has not finished, or one that failed: not a stored file yet (stash-driver marksOf). */
const unfinished = (e: FsEntry) => e.marks.some((m) => m.startsWith('arriving') || m.startsWith('failed'));

/** The reason a STASH: file that failed to arrive is not copied, moved or downloaded: it holds no bytes (Delete clears it). */
export const FAILED_ROW = 'It did not arrive whole — nothing to copy; delete it and send it again';

/** FAILED_ROW when any picked row failed to arrive (its `failed — …` mark), else null. */
export function failedReason(picked: FsEntry[]): string | null {
  return picked.some((e) => e.marks.some((m) => m.startsWith('failed'))) ? FAILED_ROW : null;
}

/** Add to library takes stored disk images in STASH: itself (R8), never members of an archive. */
/** `filing`: Copy or Move onto LIBRARY: (Files 2 R4), which also files a disk image the library already has. */
export function addToLibraryReason(l: Listing | null, picked: FsEntry[], opts: { filing?: boolean } = {}): string | null {
  if (!l || !inStash(l.path)) return 'Open STASH: to add its disk images to the library';
  if (picked.length === 0) return 'Select something first';
  if (l.readOnlyReason === 'archive') return 'Copy it out of the archive first';
  if (!opts.filing && picked.some((e) => e.marks.includes('in the library'))) return 'Already in the library';
  const image = (e: FsEntry) => (e.kind === 'file' || e.kind === 'archive') && !unfinished(e) && libraryEligible(e.name, e.size ?? 0);
  return picked.every(image) ? null : 'Select disk images (ADF, ADZ, DMS, DMZ, HFE) to add them';
}

/**
 * Undo puts a disk back a version; STASH: keeps no versions. So a copy or move that writes into STASH:, or a move that
 * takes files out of it, is never offered Undo: restoring the disk alone would leave half of it done (or, for a move
 * out of STASH:, lose the files).
 */
export function offersUndo(op: 'copy' | 'move', sources: readonly string[], dest: string): boolean {
  // A send to the Amiga is no disk version either (increment 3): Delete in NET: cancels it.
  if (inStash(dest) || inNet(dest)) return false;
  return op === 'copy' || !sources.some(inStash);
}

/**
 * The place a toast names: the disk's label, a LIBRARY: shelf or title by its last crumb ("Demos", "LIBRARY:"),
 * STASH:, a board by its name (the last crumb), else "the other side".
 */
export function placeOf(l: Listing | null): string {
  if (l?.disk) return l.disk.label;
  if (l?.library) return l.crumbs.at(-1)?.label ?? 'LIBRARY:';
  // The board's crumb, before its Queue crumb (NET: volumes, spec 2026-10-30 §4.3).
  if (netBoardOf(l)) return l!.crumbs.at(-2)?.label ?? 'the board';
  return l && inStash(l.path) ? 'STASH:' : 'the other side';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Disk 1" or "SysInfo · Disk 1": the place a disk-side dialog names. */
export function placeName(where: { title: string; label: string } | null): string {
  return where ? `${where.title} · ${where.label}` : 'this disk';
}

/**
 * What a delete of `entries` removes, counting everything inside a folder (the Browse page's bulk-delete words):
 * "“ReadMe”", "“C” and the 2 files in it", "3 files and 1 folder".
 */
export function deleteWhat(entries: FsEntry[]): string {
  let files = 0; let folders = 0;
  for (const e of entries) {
    if (e.kind === 'file') { files++; continue; }
    folders += 1 + (e.inside?.folders ?? 0); files += e.inside?.files ?? 0;
  }
  const counted = [files ? plural(files, 'file') : '', folders ? plural(folders, 'folder') : ''].filter(Boolean).join(' and ');
  if (entries.length !== 1) return counted;
  const e = entries[0];
  const within = e.inside ? [e.inside.files ? plural(e.inside.files, 'file') : '', e.inside.folders ? plural(e.inside.folders, 'folder') : '']
    .filter(Boolean).join(' and ') : '';
  return within ? `“${e.name}” and the ${within} in it` : `“${e.name}”`;
}

/**
 * Delete in NET: (R4) cancels what still waits or is on its way and clears what finished, by each row's state mark
 * (transferState's words). No versions are kept, and the words promise none.
 */
function netDeleteText(entries: FsEntry[]): string {
  const active = entries.filter((e) => e.marks[0] !== undefined && isActiveTransferText(e.marks[0])).length;
  const done = entries.length - active;
  if (active && done) return `Cancel ${plural(active, 'waiting file')} and clear ${done} finished?`;
  return active ? `Cancel ${plural(active, 'waiting file')}?` : `Clear ${plural(done, 'finished file')}?`;
}

/**
 * The delete confirm's sentence. A disk keeps every version, so its delete can be undone from History; STASH: keeps no
 * versions (ruling 8), so it says so and counts the items picked (a STASH: folder does not say what it holds); NET:
 * cancels or clears; LIBRARY: above the disks deletes collections, never their titles.
 */
export type DeleteWhere = { title: string; label: string } | 'STASH:' | 'NET:' | 'LIBRARY:' | null;

export function deleteText(entries: FsEntry[], where: DeleteWhere): string {
  // Above the disks only collections are deleted (Files 2 §3.2): their titles stay.
  if (where === 'LIBRARY:') {
    return entries.length === 1 ? `Delete the collection “${entries[0].name}”? Its titles stay in the library.`
      : `Delete ${entries.length} collections? Their titles stay in the library.`;
  }
  if (where === 'NET:') return netDeleteText(entries);
  if (where === 'STASH:') {
    const what = entries.length === 1 ? `“${entries[0].name}”` : `${entries.length} items`;
    return `Delete ${what} from STASH:? This cannot be undone.`;
  }
  return `Delete ${deleteWhat(entries)} from ${placeName(where)}? A new version keeps the old ones.`;
}

/** What a delete in the place `l` shows (deleteText's `where` from the listing). */
export function deleteWhere(l: Listing | null): DeleteWhere {
  if (!l) return null;
  if (inNet(l.path)) return 'NET:';
  if (l.library && !l.disk) return 'LIBRARY:';
  return inStash(l.path) ? 'STASH:' : l.disk;
}

export function deleteWords(entries: FsEntry[], l: Listing): string {
  return deleteText(entries, deleteWhere(l));
}
