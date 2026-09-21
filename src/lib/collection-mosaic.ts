/**
 * Which covers a collection's card tiles, given its members in order.
 *
 * Pure, and separate from the query that feeds it (src/lib/collections.ts),
 * for the same reason `collection-order.ts` is separate from the reorder
 * route: the choosing is where the rules live, and rules deserve tests that
 * do not need a database.
 */

/** Tiles in one mosaic. Four fills a 2x2 square; more would be unreadable at card size. */
export const MOSAIC_TILES = 4;

/**
 * How deep to look for those four. A collection whose first members happen to
 * be unidentified would otherwise show an empty mosaic while the fifth title
 * in it has perfectly good box art -- and that is the COMMON case, not an
 * edge one: OpenRetro recognises a small minority of a real archive.
 */
export const MOSAIC_CANDIDATES = 12;

/**
 * Up to `tiles` cover URLs, in membership order, for one collection.
 *
 * `coverOf` answers undefined for a title with no image, and those are simply
 * skipped -- a mosaic is built from what CAN be shown, not from the first four
 * members whatever they look like.
 *
 * Duplicates are dropped: two titles sharing one cover (a compilation's disks,
 * a re-release, two dumps of the same game) would otherwise tile the same
 * picture twice, which reads as a rendering bug rather than as two games.
 */
export function chooseMosaic(
  gameIds: readonly string[],
  coverOf: (gameId: string) => string | undefined,
  tiles: number = MOSAIC_TILES,
): string[] {
  const urls: string[] = [];
  for (const gameId of gameIds) {
    if (urls.length >= tiles) break;
    const url = coverOf(gameId);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * The members worth asking about, per collection: the first
 * `MOSAIC_CANDIDATES` of each, in order.
 *
 * This is the cap that bounds the cover lookup -- without it, the query behind
 * a library of 5,000 filed titles would resolve covers for all of them to
 * render a handful of 2x2 squares.
 */
export function mosaicCandidates(
  rows: ReadonlyArray<{ collectionId: string; gameId: string }>,
  limit: number = MOSAIC_CANDIDATES,
): Map<string, string[]> {
  const candidates = new Map<string, string[]>();
  for (const row of rows) {
    const list = candidates.get(row.collectionId) ?? [];
    if (list.length < limit) {
      list.push(row.gameId);
      candidates.set(row.collectionId, list);
    }
  }
  return candidates;
}
