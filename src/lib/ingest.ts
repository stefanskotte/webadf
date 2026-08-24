import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_BATCH = 500;

export const checkBody = z.object({
  hashes: z.array(z.string().regex(SHA256_RE)).min(1).max(MAX_BATCH),
});

export const presignBody = z.object({
  files: z.array(z.object({
    sha256: z.string().regex(SHA256_RE),
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
  })).min(1).max(MAX_BATCH),
});

export const completeBody = z.object({
  files: z.array(z.object({
    sha256: z.string().regex(SHA256_RE),
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
    filename: z.string().min(1).max(255),
  })).min(1).max(MAX_BATCH),
});

export function splitKnownMissing(requested: string[], known: Set<string>) {
  const seen = new Set<string>();
  const out = { known: [] as string[], missing: [] as string[] };
  for (const h of requested) {
    if (seen.has(h)) continue;
    seen.add(h);
    (known.has(h) ? out.known : out.missing).push(h);
  }
  return out;
}

/**
 * Deterministic primary key derived from the given parts, shaped like a
 * UUID (not a cryptographic UUID — just a stable, collision-resistant
 * SHA-256 digest formatted with dashes). Same inputs always produce the
 * same id, so inserting the "same" catalog row twice — a CLI retry, or a
 * batch that re-sends some already-ingested files alongside new ones —
 * lands on the same primary key and `onConflictDoNothing` turns the repeat
 * write into a no-op instead of a duplicate row.
 *
 * Callers MUST include `orgId` as one of the parts for any catalog row
 * (games, disks). Leaving it out would let two different tenants who
 * upload the same disk collide onto the same row and merge their
 * libraries — the one dedupe that must never happen.
 */
export function stableId(...parts: string[]): string {
  // A NUL separator can't be forged by any input part (org ids, sha-256
  // hex, titles, years never contain one), so parts can't be split
  // ambiguously across a boundary. Built via fromCharCode rather than a
  // literal escape so this source file stays plain ASCII text.
  const sep = String.fromCharCode(0);
  const hash = createHash('sha256').update(parts.join(sep)).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}
