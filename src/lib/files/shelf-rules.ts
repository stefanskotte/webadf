// src/lib/files/shelf-rules.ts
// LIBRARY: above the disks (Files 2 §3.2): the words a refusal carries and the pure rules the server and the manager
// share. CLIENT-SAFE: types and pure functions only.
import { parsePath } from './path';
import { addToLibraryReason, SELECT_IMAGES } from './pane-rules';
import { isNetVolume, NET_READ_ONLY } from './net-rules';
import { libraryEligible } from '@/lib/from-amiga-ui';
import type { FsEntry, Listing } from './types';

export const TITLES_ON_LIBRARY_PAGE = 'Rename or delete titles on the Library page';
export const IN_LIBRARY_ALREADY = 'It is in the library already';
export const NO_NESTED = 'Collections hold titles, not folders';
export const NO_COLLECTION_IN_COLLECTION = 'A collection cannot go inside another';
export const ONLY_TITLES_FILED = 'Only titles, and disk images from STASH:, go into the library here';
export const FILE_ON_SHELF = 'Open LIBRARY: or a collection to file titles';
/** Makedir in a title's disk list: folders are made on a disk or in STASH: (D13). */
export const MAKEDIR_IN_DISK = 'Open a disk or STASH: to make a folder in it';
/** A collection copied or moved anywhere but onto a shelf: collections are LIBRARY:'s folders and never leave it. */
export const COLLECTIONS_STAY = 'Collections stay in LIBRARY:';
/** A disk or title moved onto a NET: volume: it is copied there as a drawer per disk (spec 2026-11-02), never taken away. */
export const DISKS_STAY_IN_LIBRARY = 'Disks stay in the library: use Copy.';
/** DSK rows anywhere but a NET: volume: a shelf says its own words (ONLY_TITLES_FILED), everywhere else says this. */
export const DISKS_ONTO_VOLUME = 'Open a drawer on an Amiga volume to copy disks onto it';
export const COLLECTION_EXISTS = 'A collection with that name already exists';
/** A disk image added to the library while its target collection was deleted: in the library, filed nowhere. */
export const ADDED_UNFILED = 'The collection is gone; the disk was added to the library, in no collection';
/** A NET: drawer onto a shelf: refusalWords('not_a_disk_image', 'a folder'), the server's per-item words, written out
 *  (words.ts imports this module). Said before the copy walks the drawer (final review). */
export const NOT_A_FOLDER = 'Not a disk image the library takes — a folder.';
/** Create ADF in NET: (Files 2 §4): a blank disk is made in STASH: or LIBRARY:, never sent. */
export const NOT_ON_NET = 'Disks are made in STASH: or LIBRARY:';
/** Create ADF in a title's disk list or on a disk (§4): a new title is made on a shelf. */
export const GO_UP = 'Go up to the library or a collection';
/** The Library's own limit (`/api/collections`: trimmed, 1-80). */
export const COLLECTION_NAME_MAX = 80;

export function collectionNameProblem(name: string): 'empty' | 'collection-too-long' | null {
  const t = name.trim();
  if (!t) return 'empty';
  return t.length > COLLECTION_NAME_MAX ? 'collection-too-long' : null;
}

/** The refusal details that read as a sentence of their own. */
/** Why a disk stays behind: every surface puts the disk's name in front, so these do not repeat it. */
export const UNREADABLE_DISK = 'It cannot be read as files';
export const DAMAGED_DISK = 'Its directory is damaged, some files cannot be reached';

export const SHELF_WORDS: readonly string[] = [
  TITLES_ON_LIBRARY_PAGE, IN_LIBRARY_ALREADY, NO_NESTED, NO_COLLECTION_IN_COLLECTION, ONLY_TITLES_FILED, FILE_ON_SHELF,
  MAKEDIR_IN_DISK, COLLECTIONS_STAY, NOT_ON_NET, GO_UP, DISKS_STAY_IN_LIBRARY, UNREADABLE_DISK, DAMAGED_DISK,
];

/** Where titles are filed: the LIBRARY: root (`null`) or a collection. */
export type Shelf = { collectionId: string | null };

/** A pane on the LIBRARY: root or in a collection: a shelf. Anywhere else, null. */
export function shelfOf(l: Listing | null): Shelf | null {
  const at = l?.library;
  return at && (at.level === 'root' || at.level === 'collection') ? { collectionId: at.collectionId } : null;
}

/** A collection row as a drop target: its id is its path's last segment (the kind says it is a collection). */
export function shelfOfRow(e: FsEntry): Shelf | null {
  return e.kind === 'collection' ? { collectionId: parsePath(e.path)?.segments.at(-1) ?? null } : null;
}

const inStash = (l: Listing | null) => !!l && parsePath(l.path)?.device === 'STASH';
const isTitle = (e: FsEntry) => e.kind === 'title';

/**
 * Copy or Move onto a shelf (§3.2, R4, R5): null when it may go, the words when not, undefined when it is no filing
 * (nothing picked, or neither side is a shelf) and the file rules decide. `to` is the shelf it lands on (the other
 * pane's, or the collection row it was dropped on). Onto the collection the titles
 * are in already is offered (D11): the server skips them and says "Skipped N (already there)."
 */
export function filingReason(op: 'copy' | 'move', src: Listing | null, picked: FsEntry[], to: Shelf | null): string | null | undefined {
  if (picked.length === 0) return undefined;
  const from = shelfOf(src);
  if (from) {
    const collections = picked.some((e) => e.kind === 'collection');
    // Titles go only onto a shelf; a collection never leaves LIBRARY: and never goes inside another.
    if (!to) return collections ? COLLECTIONS_STAY : picked.every(isTitle) ? FILE_ON_SHELF : undefined;
    if (collections) return NO_COLLECTION_IN_COLLECTION;
    if (!picked.every(isTitle)) return undefined;
    if (to.collectionId === null) return op === 'copy' || from.collectionId === null ? IN_LIBRARY_ALREADY : null;
    return null;
  }
  if (!to) return undefined;
  if (inStash(src)) return addToLibraryReason(src, picked, { filing: true });
  // Out of a NET: volume (spec 2026-10-30 §4.5, §5): disk images are copied in through the board; a drawer is refused
  // here as the server refuses it (not_a_disk_image, a folder), before anything is walked; a volume is never moved from.
  if (isNetVolume(src)) {
    if (op === 'move' && !src!.writable) return src!.readOnlyReason ?? NET_READ_ONLY;
    if (picked.some((e) => e.kind === 'dir')) return NOT_A_FOLDER;
    return picked.every((e) => e.kind === 'file' && libraryEligible(e.name, e.size ?? 0)) ? null : SELECT_IMAGES;
  }
  return ONLY_TITLES_FILED;
}

/**
 * DSK or TTL rows onto a NET: volume (big copies, spec 2026-11-02): null when they may go, the words when not, undefined
 * when this is no such copy (`dst` is no volume, or something else is picked, a collection above all, so that
 * COLLECTIONS_STAY still answers). Asked before filingReason, which would send titles to a shelf.
 */
export function diskCopyReason(op: 'copy' | 'move', picked: FsEntry[], dst: Listing | null): string | null | undefined {
  if (!isNetVolume(dst) || picked.length === 0 || !picked.every((e) => e.kind === 'title' || e.kind === 'disk')) return undefined;
  if (op === 'move') return DISKS_STAY_IN_LIBRARY;
  return dst!.writable ? null : dst!.readOnlyReason ?? NET_READ_ONLY;
}

/** A pane on a title's disk list: its rows are DSK rows. */
export const listsDisks = (l: Listing | null) => l?.library?.level === 'title';

/**
 * DSK rows picked on a title's disk list: Copy, Copy to… and a drag offer them, and only a volume takes them (the place
 * is checked by placeReason, or at the drop).
 */
export const disksPicked = (src: Listing | null, picked: FsEntry[]) => listsDisks(src) && picked.length > 0 && picked.every((e) => e.kind === 'disk');

/**
 * What is picked onto a place, the desktop's Copy and the phone's Copy to… alike: null when it may go there, the words
 * when not, undefined when the file rules decide. Disks never move; then a volume for disks and titles, then a shelf.
 */
export function placeReason(op: 'copy' | 'move', src: Listing | null, picked: FsEntry[], l: Listing | null): string | null | undefined {
  if (op === 'move' && disksPicked(src, picked)) return DISKS_STAY_IN_LIBRARY;
  const onto = diskCopyReason(op, picked, l);
  if (onto !== undefined) return onto;
  const filing = filingReason(op, src, picked, shelfOf(l));
  if (filing !== undefined) return filing;
  return disksPicked(src, picked) ? DISKS_ONTO_VOLUME : undefined;
}

/** Makedir, Rename and Delete above the disks (§3.2); null when the pane is not on LIBRARY: above a disk. */
export function shelfReasons(src: Listing | null, picked: FsEntry[]): { delete: string | null; rename: string | null; makedir: string | null } | null {
  const level = src?.library?.level;
  if (!level || level === 'disk') return null;
  const collections = picked.length > 0 && picked.every((e) => e.kind === 'collection');
  const del = picked.length === 0 ? 'Select something first' : collections ? null : TITLES_ON_LIBRARY_PAGE;
  const rename = picked.length !== 1 ? 'Select one item to rename it' : collections ? null : TITLES_ON_LIBRARY_PAGE;
  const makedir = level === 'root' ? null : level === 'collection' ? NO_NESTED : MAKEDIR_IN_DISK;
  return { delete: del, rename, makedir };
}

/** What a filing's toast counts (fix round 1): titles from LIBRARY: or a collection, disk images from STASH:. */
export function filingNoun(src: Listing | null): (n: number) => string {
  const word = shelfOf(src) ? 'title' : 'disk';
  return (n) => `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Why Create ADF… cannot make a disk where `l` is (§4), or null. The archive words are refusalWords('read_only',
 *  'archive')'s, written out: words.ts imports this module, so this module never imports words.ts. */
export function createAdfReason(l: Listing | null): string | null {
  if (!l) return 'Open STASH: or LIBRARY: first';
  const device = parsePath(l.path)?.device;
  if (device === 'NET') return NOT_ON_NET;
  if (device === 'STASH') return l.readOnlyReason === 'archive' ? 'Archives are read-only — copy files out of them.' : null;
  return l.library?.level === 'root' || l.library?.level === 'collection' ? null : GO_UP;
}
