import type { AdfEntry } from '@/lib/adffs';
import { DEFAULT_PREFS, type BrowseSort } from '@/lib/user-prefs-schema';

/**
 * One level of a disk's Browse list in the person's chosen order (user prefs
 * browse.sort). Folders always come first, whatever the key -- that is how
 * the list has always read, and it keeps a folder findable under any sort.
 *
 * AmigaDOS stores entries by hash chain, not alphabetically -- a raw listing
 * looks shuffled -- so every level is sorted, never shown as stored. Ties
 * (and folders under a size sort) fall back to case-insensitive name order;
 * an entry with no date goes last in both directions.
 */
export function sortEntries(entries: AdfEntry[], sort: BrowseSort = DEFAULT_PREFS.browse.sort): AdfEntry[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  const byName = (a: AdfEntry, b: AdfEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (sort.key === 'name') return byName(a, b) * mul;
    if (sort.key === 'size') return (a.sizeBytes - b.sizeBytes) * mul || byName(a, b);
    const ta = a.modifiedAt ? new Date(a.modifiedAt).getTime() : null;
    const tb = b.modifiedAt ? new Date(b.modifiedAt).getTime() : null;
    if (ta === null || tb === null) return ta === tb ? byName(a, b) : ta === null ? 1 : -1;
    return (ta - tb) * mul || byName(a, b);
  });
}
