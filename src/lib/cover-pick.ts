// Which of a game's stored OpenRetro images should represent it in the
// library grid.
//
// Pure and separate from queries.ts so the rule is testable without a
// database: everything else about the cover needs a live Postgres, but the
// choice itself is ordinary logic and this is where it can be pinned.

export interface CoverCandidate { sha1: string; kind: string; ordinal: number }

/**
 * Front cover first, then the title screen, then the earliest screenshot.
 *
 * Box art is what a person scanning a shelf recognises; the title screen is
 * the next best thing; a screenshot is a last resort because two different
 * games' screenshots look far more alike than their covers do.
 */
const RANK: Record<string, number> = { front: 0, title: 1, screenshot: 2 };

export function pickCover(images: CoverCandidate[]): CoverCandidate | null {
  const usable = images.filter((i) => i.kind in RANK);
  if (usable.length === 0) return null;

  // sha1 is the final tiebreaker purely so the answer is stable. Two rows can
  // genuinely tie on (kind, ordinal), and a grid that reshuffled its covers
  // between two renders of unchanged data would look broken.
  return [...usable].sort((a, b) =>
    RANK[a.kind] - RANK[b.kind]
    || a.ordinal - b.ordinal
    || a.sha1.localeCompare(b.sha1),
  )[0];
}
