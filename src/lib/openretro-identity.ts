import { makeSortTitle } from '@/lib/tosec';

/**
 * Matching an OpenRetro entry by TOSEC IDENTITY (title + year) rather than by
 * content hash.
 *
 * WHY THIS EXISTS, AND WHAT IT IS WORTH -- measured 2026-09-11 against the
 * live catalogue, because the handoff proposed this as "the single change that
 * would make the enrichment increment pay for itself" and that turned out to
 * be wrong:
 *
 *   TOSEC-identified blobs        29
 *     already enriched by hash    13
 *     NEW via title+year          1     <- Lemmings, and nothing else
 *     ambiguous                   0
 *     no OpenRetro entry at all   15
 *
 * The 15 are the finding. They are not normalisation failures -- checked
 * against a punctuation-stripped index too -- they are World Construction Set
 * (an application), and 9 Fingers, State of the Art, Global Trash, Wayfarer,
 * Giana Sisters Special Edition, Ray of Hope 2: DEMOSCENE productions.
 * OpenRetro is a GAMES database. No amount of cleverness in this file will
 * make it enrich a demo, and the honest fix for that archive is a different
 * source (Demozoo, Pouet), not a better matcher.
 *
 * It is kept anyway, and deliberately: this library is about to hold other
 * people's collections, and a collection of GAMES is exactly the case where
 * title+year pays -- the one hit here was the one game in the sample. It costs
 * a single indexed lookup per blob that hashing already failed on.
 *
 * STRICT BY CONSTRUCTION. Exact normalised title AND exact year, unique hit or
 * nothing. No fuzzy distance, no year tolerance, no "closest match". A wrong
 * title written into somebody's library is worse than a missing one, and
 * unlike a hash match there is no second signal to catch it.
 */

/** Trailing "[Eurosoft]" or "(AGA)" -- OpenRetro qualifies names this way,
 *  TOSEC does not, and the two must be compared on the same shape. */
const TRAILING_QUALIFIER = /\s*[[(][^\])]*[\])]\s*$/;

/**
 * An OpenRetro `game_name` reduced to the same form TOSEC stores in
 * `sort_title`, so the two can be compared as equals. makeSortTitle is shared
 * with the TOSEC side rather than reimplemented -- if article handling ever
 * changes, both sides must move together or every comparison silently fails.
 */
export function openretroSortTitle(gameName: string): string {
  return makeSortTitle(gameName.replace(TRAILING_QUALIFIER, '').trim());
}

export interface IdentityCandidate { uuid: string; gameName: string; year: number | null }
export type IdentityVerdict =
  | { state: 'matched'; uuid: string }
  | { state: 'ambiguous' }
  | { state: 'none' };

/**
 * Decide which OpenRetro entry, if any, IS this TOSEC identity.
 *
 * `candidates` are the entries already narrowed by normalised title; this
 * applies the year rule and the uniqueness rule. Pure, so the interesting
 * cases are testable without a database.
 */
export function matchIdentity(
  tosecSortTitle: string,
  tosecYear: number | null,
  candidates: IdentityCandidate[],
): IdentityVerdict {
  const sameTitle = candidates.filter(
    (c) => openretroSortTitle(c.gameName) === tosecSortTitle,
  );
  if (sameTitle.length === 0) return { state: 'none' };

  // A TOSEC name with no year cannot be told apart from another edition of the
  // same title, so it only ever matches when the title itself is unique in
  // OpenRetro. Falling back to "any entry with this title" is exactly how a
  // 1988 original gets a 1992 remake's screenshots.
  if (tosecYear === null) {
    return sameTitle.length === 1
      ? { state: 'matched', uuid: sameTitle[0].uuid }
      : { state: 'ambiguous' };
  }

  const sameYear = sameTitle.filter((c) => c.year === tosecYear);
  if (sameYear.length === 1) return { state: 'matched', uuid: sameYear[0].uuid };
  if (sameYear.length > 1) return { state: 'ambiguous' };

  // Title matched, year did not. NOT a match: OpenRetro carrying a different
  // year for the same title usually means a different release, and guessing
  // between them is the one thing this file refuses to do.
  return { state: 'none' };
}
