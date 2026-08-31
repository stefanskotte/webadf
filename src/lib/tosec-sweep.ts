import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { diskStore } from '@/lib/storage';
import { contentHashes } from '@/lib/content-hashes';
import { matchBlob, type Candidate } from '@/lib/tosec-match';
import { applyMatch } from '@/lib/tosec-apply';

/** Stop well inside the 300 s function limit rather than being killed mid-write. */
const DEFAULT_BUDGET_MS = 240_000;
/** Blobs read per pass. Each read pulls ~880 KB. */
const HASH_BATCH = 25;
/** Blobs matched per pass. No blob reads here, so this can be larger. */
const MATCH_BATCH = 200;

export interface SweepResult { hashed: number; matched: number; none: number; ambiguous: number; done: boolean }

/**
 * One bounded, resumable pass. Safe to kill and re-run: the cursors are
 * `hashed_at is null` and `match_checked_at is null`, so nothing is processed
 * twice and nothing is skipped.
 *
 * Hashing runs first -- matching a blob with no hashes would only record a
 * spurious 'none'.
 */
export async function sweep(budgetMs: number = DEFAULT_BUDGET_MS): Promise<SweepResult> {
  const db = getDb();
  const started = Date.now();
  const out: SweepResult = { hashed: 0, matched: 0, none: 0, ambiguous: 0, done: false };
  const spent = () => Date.now() - started;

  // Phase 1 -- hash.
  while (spent() < budgetMs) {
    const todo = await db.select({ sha256: blobs.sha256 }).from(blobs)
      .where(isNull(blobs.hashedAt)).limit(HASH_BATCH);
    if (todo.length === 0) break;

    for (const b of todo) {
      if (spent() >= budgetMs) break;
      try {
        const bytes = await diskStore.read(b.sha256);
        const h = contentHashes(bytes);
        await db.update(blobs)
          .set({ crc32: h.crc32, md5: h.md5, sha1: h.sha1, hashedAt: new Date() })
          .where(eq(blobs.sha256, b.sha256));
        out.hashed++;
      } catch {
        // Bytes missing from the store, or unreadable. Stamp hashedAt so the
        // sweeper does not spin on it forever; the hashes stay null, so it
        // will simply never match. A blob row without bytes is a separate
        // problem and not this job's to fix.
        await db.update(blobs).set({ hashedAt: new Date() }).where(eq(blobs.sha256, b.sha256));
      }
    }
  }

  // Phase 2 -- match.
  while (spent() < budgetMs) {
    const todo = await db.select({
      sha256: blobs.sha256, crc32: blobs.crc32, md5: blobs.md5,
      sha1: blobs.sha1, sizeBytes: blobs.sizeBytes,
    }).from(blobs)
      .where(and(isNull(blobs.matchCheckedAt), sql`${blobs.hashedAt} is not null`))
      .limit(MATCH_BATCH);
    if (todo.length === 0) { out.done = true; break; }

    for (const b of todo) {
      if (spent() >= budgetMs) break;

      // A blob with NO hashes (its bytes were unreadable, so phase 1 stamped
      // hashedAt and left the hashes null) must short-circuit. Otherwise every
      // branch of the or() below is undefined, drizzle emits .where(undefined),
      // and the query loads the ENTIRE tosec_entries table into memory to
      // reach the same 'none' the matcher would return anyway.
      if (!b.sha1 && !b.md5 && !b.crc32) {
        await db.update(blobs)
          .set({ matchState: 'none', matchCheckedAt: new Date(), tosecEntryId: null })
          .where(eq(blobs.sha256, b.sha256));
        out.none++;
        continue;
      }

      // Narrow in SQL, decide in the pure matcher.
      const candidates: Candidate[] = await db.select({
        id: tosecEntries.id, crc32: tosecEntries.crc32, md5: tosecEntries.md5,
        sha1: tosecEntries.sha1, sizeBytes: tosecEntries.sizeBytes,
      }).from(tosecEntries).where(or(
        b.sha1 ? eq(tosecEntries.sha1, b.sha1) : undefined,
        b.md5 ? eq(tosecEntries.md5, b.md5) : undefined,
        b.crc32 ? and(eq(tosecEntries.crc32, b.crc32), eq(tosecEntries.sizeBytes, b.sizeBytes)) : undefined,
      ));

      const verdict = matchBlob(
        { crc32: b.crc32, md5: b.md5, sha1: b.sha1, sizeBytes: b.sizeBytes },
        candidates,
      );

      await db.update(blobs).set({
        matchState: verdict.state,
        matchCheckedAt: new Date(),
        tosecEntryId: verdict.state === 'matched' ? verdict.entryId : null,
      }).where(eq(blobs.sha256, b.sha256));

      if (verdict.state === 'matched') {
        await applyMatch(b.sha256, verdict.entryId);
        out.matched++;
      } else if (verdict.state === 'ambiguous') out.ambiguous++;
      else out.none++;
    }
  }

  return out;
}

export interface ScanStatus {
  blobs: number; hashed: number; matched: number; none: number;
  ambiguous: number; unchecked: number; tosecEntries: number;
  sets: Array<{ setName: string; setVersion: string | null; entries: number }>;
}

/** Counts for the admin page, including the miss rate design section 2 exists to produce. */
export async function scanStatus(): Promise<ScanStatus> {
  const db = getDb();
  const { rows } = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from blobs)                                          as blobs,
      (select count(*)::int from blobs where hashed_at is not null)              as hashed,
      (select count(*)::int from blobs where match_state = 'matched')            as matched,
      (select count(*)::int from blobs where match_state = 'none')               as none,
      (select count(*)::int from blobs where match_state = 'ambiguous')          as ambiguous,
      (select count(*)::int from blobs where match_checked_at is null)           as unchecked,
      (select count(*)::int from tosec_entries)                                  as tosec_entries
  `);
  const r = rows[0];

  const sets = await db.select({
    setName: tosecEntries.setName,
    setVersion: tosecEntries.setVersion,
    entries: sql<number>`count(*)::int`,
  }).from(tosecEntries).groupBy(tosecEntries.setName, tosecEntries.setVersion);

  return {
    blobs: Number(r.blobs), hashed: Number(r.hashed), matched: Number(r.matched),
    none: Number(r.none), ambiguous: Number(r.ambiguous), unchecked: Number(r.unchecked),
    tosecEntries: Number(r.tosec_entries),
    sets: sets.map((s) => ({ ...s, entries: Number(s.entries) })),
  };
}
