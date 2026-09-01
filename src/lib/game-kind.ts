// What KIND of thing a title is -- a game, a demo, an application -- derived
// from the TOSEC set that recognised its disks.
//
// TOSEC's seven Amiga [ADF] sets already ARE this taxonomy, so nothing here
// is inferred from a filename or a title. That is the whole reason this can
// exist at all: the identity scan shipped first.
//
// Pure, and separate from queries.ts, so the rule is testable without a
// database.

/**
 * Order matters. The match is substring-based, so the more specific word has
 * to be tested first -- a hypothetical "Games - Demos" set is a demo set, and
 * checking Games first would file it as a game.
 */
const RULES: Array<[RegExp, string]> = [
  [/demos?\b/i, 'Demo'],
  [/educational/i, 'Educational'],
  [/coverdisks?/i, 'Coverdisk'],
  [/applications?/i, 'App'],
  [/games?\b/i, 'Game'],
];

/** Only the Amiga ADF sets can describe anything this app stores. */
const AMIGA = /commodore amiga/i;

export function kindFromSetName(setName: string | null | undefined): string | null {
  if (!setName || !AMIGA.test(setName)) return null;
  for (const [pattern, kind] of RULES) {
    if (pattern.test(setName)) return kind;
  }
  return null;
}

/**
 * One kind for a whole game, from its disks' individual kinds.
 *
 * A multi-disk game CAN have disks matched into different sets, so a rule is
 * needed rather than "whichever row came back first". Most-common wins;
 * unmatched disks abstain rather than voting, so one recognised disk in four
 * still gives the game a type. Ties break alphabetically purely so the answer
 * is stable -- a column that changed between two renders of unchanged data
 * would look broken.
 */
export function pickKind(kinds: Array<string | null>): string | null {
  const votes = new Map<string, number>();
  for (const k of kinds) {
    if (k === null) continue;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}
