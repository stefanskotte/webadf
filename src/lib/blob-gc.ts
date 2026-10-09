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

/**
 * The weekly production sweep's decision (HANDOFF backlog "Blob garbage
 * collection", operator ruling 2026-10-08: run it weekly). Pure, so every
 * branch is tested; blob-gc-run.ts only gathers the inputs and acts.
 *
 * Two kinds of garbage, same rule as selectUnreferencedBlobs -- nothing
 * anywhere names the bytes:
 *   - a `blobs` ROW nothing references (its object goes too, bytes first);
 *   - a store OBJECT under adf/ with no row and no reference: a delta whose
 *     disk_versions rows went with a deleted disk, or the bytes of an upload
 *     that never completed. These are invisible to a sweep that walks rows.
 *
 * Both only once older than `graceMs`. An upload PUTs its bytes before
 * /api/ingest/complete writes the row, and a row can exist a moment before the
 * disk or entitlement naming it; the grace makes every such in-flight write
 * safe without having to know each flow's ordering.
 *
 * And brakes, which refuse the whole plan rather than trim it. The dangerous
 * failure is not a lot of garbage -- the e2e suite leaks 40-170 edited-disk
 * objects on a busy day (measured 2026-10-08: 1,229 of 1,385 objects had no
 * row) -- but an input that makes LIVE bytes look orphaned. So:
 *   - the listing must line up with the database: at least `minRowMatch` of
 *     the rows must have their object in the listing, or the key parsing (or
 *     the listing) is wrong and every object would look row-less;
 *   - a run may drop at most `maxRowFraction` of the rows (beyond `floor`):
 *     rows are reachable content, and a huge row plan means a reference list
 *     came back short.
 */
export interface BlobGcInput {
  rows: { sha256: string; createdAt: Date }[];
  objects: { sha256: string; uploadedAt: Date }[];
  /** Every sha anything in the database names: disks, entitlements, history, devices, write sessions. */
  referenced: Iterable<string>;
  now: Date;
  graceMs: number;
  minRowMatch?: number;
  maxRowFraction?: number;
  floor?: number;
}

export interface BlobGcPlan {
  /** Rows to delete (their objects are removed first). */
  rows: string[];
  /** Objects with no row to remove. */
  objects: string[];
  /** Set when the brake tripped: nothing may be deleted. */
  refused: string | null;
}

export function planBlobGc(input: BlobGcInput): BlobGcPlan {
  const { now, graceMs, minRowMatch = 0.9, maxRowFraction = 0.25, floor = 20 } = input;
  const cutoff = now.getTime() - graceMs;
  const referenced = new Set(input.referenced);
  const refuse = (why: string): BlobGcPlan => ({ rows: [], objects: [], refused: why });

  const listed = new Set(input.objects.map((o) => o.sha256));
  const matched = input.rows.filter((r) => listed.has(r.sha256)).length;
  if (input.rows.length > 0 && matched < input.rows.length * minRowMatch) {
    return refuse(`only ${matched} of ${input.rows.length} rows have their object in the store listing -- the listing does not line up with the database`);
  }

  const unrefRows = new Set(selectUnreferencedBlobs(input.rows.map((r) => r.sha256), [...referenced], []));
  const rows = input.rows
    .filter((r) => unrefRows.has(r.sha256) && r.createdAt.getTime() < cutoff)
    .map((r) => r.sha256);
  const rowLimit = Math.max(floor, Math.floor(input.rows.length * maxRowFraction));
  if (rows.length > rowLimit) {
    return refuse(`would delete ${rows.length} of ${input.rows.length} blob rows (limit ${rowLimit}) -- check the reference lists`);
  }

  const rowed = new Set(input.rows.map((r) => r.sha256));
  const objects = input.objects
    .filter((o) => !rowed.has(o.sha256) && !referenced.has(o.sha256) && o.uploadedAt.getTime() < cutoff)
    .map((o) => o.sha256);
  return { rows, objects, refused: null };
}

/**
 * The cover pass: which cover/<sha256> objects (a title's own image,
 * games.cover_override_sha256) may go. Same rule as the adf/ objects --
 * nothing names them, and older than the grace period -- with no rows to
 * reconcile: a cover has no table of its own, only the games rows naming it.
 *
 * A Revert or a replaced image leaves its object behind on purpose (another
 * title, possibly in another org, may name the same bytes); this is what
 * reclaims it. The grace covers the upload's own ordering: bytes are stored
 * before the games row names them.
 *
 * Brakes, refusing the whole pass rather than trimming it:
 *   - at least `minRefMatch` of the referenced digests must be in the listing,
 *     or the listing (or its key parsing) is wrong and every object would
 *     look unreferenced;
 *   - at most `maxFraction` of the listed objects (beyond `floor`) may go in
 *     one run: a reference list that came back short must not empty the store.
 */
export interface CoverGcInput {
  objects: { sha256: string; uploadedAt: Date }[];
  /** Every non-null games.cover_override_sha256, across ALL organizations. */
  referenced: Iterable<string>;
  now: Date;
  graceMs: number;
  minRefMatch?: number;
  maxFraction?: number;
  floor?: number;
}

export function planCoverGc(input: CoverGcInput): { objects: string[]; refused: string | null } {
  const { now, graceMs, minRefMatch = 0.9, maxFraction = 0.25, floor = 20 } = input;
  const cutoff = now.getTime() - graceMs;
  const referenced = new Set(input.referenced);
  const listed = new Set(input.objects.map((o) => o.sha256));

  const matched = [...referenced].filter((s) => listed.has(s)).length;
  if (referenced.size > 0 && matched < referenced.size * minRefMatch) {
    return { objects: [], refused: `only ${matched} of ${referenced.size} referenced covers are in the store listing -- the listing does not line up with the database` };
  }

  const objects = [...new Set(input.objects
    .filter((o) => !referenced.has(o.sha256) && o.uploadedAt.getTime() < cutoff)
    .map((o) => o.sha256))];
  if (referenced.size === 0 && objects.length > 0) {
    return { objects: [], refused: `no title names a cover image, yet ${objects.length} would be deleted -- check the reference list` };
  }
  const limit = Math.max(floor, Math.floor(input.objects.length * maxFraction));
  if (objects.length > limit) {
    return { objects: [], refused: `would delete ${objects.length} of ${input.objects.length} cover images (limit ${limit}) -- check the reference list` };
  }
  return { objects, refused: null };
}

/**
 * The last look before deleting covers: `planned` minus every digest a title
 * names now. Closes the window between the reference read and the delete, in
 * which a person may have re-chosen exactly these bytes.
 */
export function withoutReferenced(planned: readonly string[], referencedNow: Iterable<string>): string[] {
  const named = new Set(referencedNow);
  return planned.filter((s) => !named.has(s));
}
