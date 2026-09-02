/**
 * Turning a keystroke into a SQL pattern, with no database in sight.
 *
 * Separate from search.ts so the rules are testable without a connection --
 * Vitest has no DATABASE_URL and never opens one.
 */

/** Long enough for any real title, short enough that one request stays small. */
export const MAX_QUERY_LEN = 100;

/**
 * Trim, collapse runs of whitespace, cap the length.
 *
 * Deliberately does NOT change case: the predicate uses ILIKE, which is
 * already case-insensitive, and lowercasing here would imply case matters
 * somewhere that it does not.
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LEN);
}

/**
 * Escape the three characters LIKE treats as special.
 *
 * The backslash MUST be escaped first. Escaping `%` first would turn `\` into
 * `\\` afterwards and double-escape the escapes this function just added.
 *
 * This is not a tenancy control -- orgFilter() is a separate conjunct and no
 * wildcard can cross an org boundary. It exists because a single unescaped
 * `%` makes every keystroke match the caller's entire library, which is the
 * wrong shape for an endpoint fired once per character.
 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * The infix pattern for a raw query, or null when there is nothing to search.
 *
 * null is the caller's signal to return empty results WITHOUT querying: an
 * empty query would otherwise become '%%' and match every row the caller owns.
 */
export function likePattern(raw: string): string | null {
  const q = normalizeQuery(raw);
  if (q === '') return null;
  return `%${escapeLike(q)}%`;
}
