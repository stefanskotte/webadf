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
export const COLLECTION_EXISTS = 'A collection with that name already exists';
/** A disk image added to the library while its target collection was deleted: in the library, filed nowhere. */
export const ADDED_UNFILED = 'The collection is gone; the disk was added to the library, in no collection';
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
export const SHELF_WORDS: readonly string[] = [
  TITLES_ON_LIBRARY_PAGE, IN_LIBRARY_ALREADY, NO_NESTED, NO_COLLECTION_IN_COLLECTION, ONLY_TITLES_FILED, FILE_ON_SHELF,
  MAKEDIR_IN_DISK, COLLECTIONS_STAY, NOT_ON_NET, GO_UP,
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
  // Out of a NET: volume (spec 2026-10-30 §4.5, §5): disk images are copied in through the board, a drawer's images
  // too (the server refuses anything else in it, file by file); a volume is never moved from.
  if (isNetVolume(src)) {
    if (op === 'move') return NET_READ_ONLY;
    return picked.every((e) => e.kind === 'dir' || (e.kind === 'file' && libraryEligible(e.name, e.size ?? 0))) ? null : SELECT_IMAGES;
  }
  return ONLY_TITLES_FILED;
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
  if (device === 'NET') return isNetVolume(l) ? NET_READ_ONLY : NOT_ON_NET;
  if (device === 'STASH') return l.readOnlyReason === 'archive' ? 'Archives are read-only — copy files out of them.' : null;
  return l.library?.level === 'root' || l.library?.level === 'collection' ? null : GO_UP;
}
