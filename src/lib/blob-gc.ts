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
 * @param historyRefs every `disk_versions.blob_sha256` and `image_sha256`: an
 *                   earlier version a disk's history still needs to rebuild
 * @returns the subset of `stored` that no list mentions, deduplicated
 */
export function selectUnreferencedBlobs(
  stored: string[], diskRefs: string[], entRefs: string[], historyRefs: string[] = [],
): string[] {
  const referenced = new Set<string>([...diskRefs, ...entRefs, ...historyRefs]);
  const out = new Set<string>();
  for (const sha of stored) {
    if (!referenced.has(sha)) out.add(sha);
  }
  return [...out];
}

/**
 * Which refused uploads' stored bytes may be deleted.
 *
 * The SAME rule as selectUnreferencedBlobs, applied to bytes that have no
 * blobs row yet: an upload PUTs to the store before /api/ingest/complete
 * runs, so a refusal there leaves an object the teardown's GC (which walks
 * `blobs`) can never find. It may go only if no blobs row names it either --
 * one that does is somebody's registered content, however the refused
 * request described it.
 *
 * @param candidates the refused uploads' sha-256s
 * @param registered every `blobs.sha256` among them, read at the refusal
 */
export function selectReleasableUploads(
  candidates: string[], registered: string[],
  diskRefs: string[], entRefs: string[], historyRefs: string[] = [],
): string[] {
  const rowed = new Set(registered);
  return selectUnreferencedBlobs(candidates.filter((s) => !rowed.has(s)), diskRefs, entRefs, historyRefs);
}
