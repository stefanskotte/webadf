// The header search's row words (C5 spec §5.4, §5.6): pure and client-safe -- search-box.tsx must not import
// '@/lib/search' (it reaches the database).

/** The title's kind; else Made here (authored); else Unidentified, so a cream disk is explained in words (Ruling 25). */
export function searchKindWord(t: { kind?: string | null; authored?: boolean }): string {
  return t.kind ?? (t.authored ? 'Made here' : 'Unidentified');
}

export function searchTitleSub(t: {
  kind?: string | null; authored?: boolean; year: number | null; publisher: string | null; diskCount: number;
  collections?: string[] | null;
}): string {
  const where = t.collections ? (t.collections.length > 0 ? `in ${t.collections.join(', ')}` : 'Uncategorized') : null;
  return [searchKindWord(t), t.year, t.publisher, `${t.diskCount} disk${t.diskCount === 1 ? '' : 's'}`, where]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');
}

/** Ruling 28: titles, collections and Help are all searched, so the line says so and names the query. */
export function searchEmptyText(q: string): string {
  return `Nothing in your library or Help matches “${q}”.`;
}
