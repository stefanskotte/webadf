// The rule that makes it safe to accept a whole ordered list from a client.
//
// Reordering sends the COMPLETE list of ids rather than a move instruction,
// which is simple and cheap at this scale (design section 4) but means the
// request could otherwise add, remove or duplicate a member as a side effect
// of "reordering". This function is the guard: the submitted list must be a
// permutation of the current membership, nothing more and nothing less.
//
// Pure, so the rule is tested without a database -- everything the reorder
// endpoints do is this function plus a db.batch().

export type ReorderError =
  | { ok: false; reason: 'unknown-id'; id: string }
  | { ok: false; reason: 'duplicate-id'; id: string }
  | { ok: false; reason: 'missing-id'; id: string };

export type ReorderResult =
  | { ok: true; assignments: Array<{ id: string; sortKey: number }> }
  | ReorderError;

/**
 * @param current   ids currently in the collection, in any order
 * @param submitted the client's desired order
 */
export function planReorder(current: string[], submitted: string[]): ReorderResult {
  const members = new Set(current);
  const seen = new Set<string>();

  for (const id of submitted) {
    if (!members.has(id)) return { ok: false, reason: 'unknown-id', id };
    if (seen.has(id)) return { ok: false, reason: 'duplicate-id', id };
    seen.add(id);
  }

  // Checked AFTER the loop above so an unknown id is reported in preference
  // to a missing one -- an intruder is the more alarming of the two, and a
  // deterministic precedence keeps the same bad request producing the same
  // error every time.
  for (const id of current) {
    if (!seen.has(id)) return { ok: false, reason: 'missing-id', id };
  }

  return {
    ok: true,
    assignments: submitted.map((id, sortKey) => ({ id, sortKey })),
  };
}
