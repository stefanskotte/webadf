// The matching decision, isolated from the database so every branch is
// unit-testable. The caller narrows candidates in SQL and passes them here.

export interface BlobHashes { crc32: string | null; md5: string | null; sha1: string | null; sizeBytes: number }
export interface Candidate { id: string; crc32: string | null; md5: string | null; sha1: string | null; sizeBytes: number }

export type MatchVerdict =
  | { state: 'matched'; entryId: string }
  | { state: 'none' }
  | { state: 'ambiguous'; entryIds: string[] };

/**
 * Strongest hash first. A tier is only consulted when the blob actually has
 * that hash, and a null NEVER equals a null -- two entries missing a sha1
 * must not both "match" a blob missing one.
 *
 * crc32 is a 32-bit checksum and collides, so it is only ever used together
 * with the exact size, and never preferred over a stronger hash that is
 * present on both sides.
 */
export function matchBlob(blob: BlobHashes, candidates: Candidate[]): MatchVerdict {
  const tiers: Array<(c: Candidate) => boolean> = [];
  if (blob.sha1) tiers.push((c) => c.sha1 !== null && c.sha1 === blob.sha1);
  if (blob.md5) tiers.push((c) => c.md5 !== null && c.md5 === blob.md5);
  if (blob.crc32) {
    tiers.push((c) => c.crc32 !== null && c.crc32 === blob.crc32 && c.sizeBytes === blob.sizeBytes);
  }

  for (const tier of tiers) {
    const hits = candidates.filter(tier);
    if (hits.length === 1) return { state: 'matched', entryId: hits[0].id };
    // Ambiguity stops the cascade rather than falling through to a weaker
    // hash: a weaker tier cannot resolve what a stronger one could not.
    if (hits.length > 1) return { state: 'ambiguous', entryIds: hits.map((h) => h.id) };
  }
  return { state: 'none' };
}
