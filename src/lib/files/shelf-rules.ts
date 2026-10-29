// src/lib/files/shelf-rules.ts
// LIBRARY: above the disks (Files 2 §3.2): the words a refusal carries and the pure rules the server and the manager
// share. CLIENT-SAFE: types and pure functions only.
export const TITLES_ON_LIBRARY_PAGE = 'Rename or delete titles on the Library page';
export const IN_LIBRARY_ALREADY = 'It is in the library already';
export const NO_NESTED = 'Collections hold titles, not folders';
export const NO_COLLECTION_IN_COLLECTION = 'A collection cannot go inside another';
export const ONLY_TITLES_FILED = 'Only titles, and disk images from STASH:, go into the library here';
export const FILE_ON_SHELF = 'Open LIBRARY: or a collection to file titles';
/** Makedir in a title's disk list: folders are made on a disk or in STASH: (D13). */
export const MAKEDIR_IN_DISK = 'Open a disk or STASH: to make a folder in it';
export const COLLECTION_EXISTS = 'A collection with that name already exists';
/** A disk image added to the library while its target collection was deleted: in the library, filed nowhere. */
export const ADDED_UNFILED = 'The collection is gone; the disk was added to the library, in no collection';
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
  MAKEDIR_IN_DISK,
];
