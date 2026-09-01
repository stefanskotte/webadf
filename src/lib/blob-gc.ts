// Which stored blobs nothing points at any more.
//
// `blobs` is global and content-addressed, and the standing rule in this
// codebase is that a blob is never deleted -- deleting one because ONE tenant
// stopped referencing it would destroy a disk belonging to another tenant
// holding the same bytes. 26 blobs are already shared this way, and
// admin-delete.ts refuses to touch the table for exactly this reason.
//
// The one safe exception is a blob that NOTHING references: no disk anywhere,
// no entitlement in any organization. That is what the e2e teardown reclaims,
// and what the backlog's "blob garbage collection" would reclaim too.
//
// The caller passes the reference lists rather than this file querying for
// them, so the rule that matters is a pure function with tests rather than a
// SQL predicate nothing can exercise.

/**
 * @param stored     every sha-256 in `blobs`
 * @param diskRefs   every `disks.sha256`, across ALL organizations
 * @param entRefs    every `entitlements.sha256`, across ALL organizations
 * @returns the subset of `stored` that neither list mentions, deduplicated
 */
export function selectUnreferencedBlobs(
  stored: string[], diskRefs: string[], entRefs: string[],
): string[] {
  const referenced = new Set<string>([...diskRefs, ...entRefs]);
  const out = new Set<string>();
  for (const sha of stored) {
    if (!referenced.has(sha)) out.add(sha);
  }
  return [...out];
}
