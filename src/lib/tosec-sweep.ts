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

export interface SweepResult {
  hashed: number; matched: number; none: number; ambiguous: number; merged: number; done: boolean;
}

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
  const out: SweepResult = { hashed: 0, matched: 0, none: 0, ambiguous: 0, merged: 0, done: false };
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
      } catch (err) {
        // Bytes missing from the store, or unreadable. Stamp hashedAt so the
        // sweeper does not spin on it forever; the hashes stay null, so it
        // will simply never match. A blob row without bytes is a separate
        // problem and not this job's to fix -- but log it: phase 2's
        // short-circuit will otherwise fold this silently into 'none', and
        // scanStatus's `unreadable` count (see below) is what keeps a
        // storage outage from being misread as a worse TOSEC hit rate.
        console.error(`tosec-sweep: could not read blob ${b.sha256}`, err);
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

      // Isolated per blob, unlike phase 1's unreadable case: on failure here
      // the blob is deliberately NOT stamped matchCheckedAt. Phase 1 stamps
      // on failure because an unreadable blob's bytes are gone -- retrying
      // costs a full object-store read and will keep failing the same way,
      // so stamping converts it into a permanent (if degraded) 'none'. A
      // phase-2 failure is different: the bytes are already known-good (we
      // are past phase 1), so the failure is in the candidate query,
      // applyMatch's batch, or the stamp itself -- almost certainly
      // transient (a Neon hiccup, the budget boundary hit mid-write). Not
      // stamping means the blob's match_checked_at IS NULL cursor keeps
      // selecting it on the next sweep instead of wedging it as a permanent
      // false 'none'. Without the try/catch, an unordered, unlimited-retry
      // `todo` query re-selects this exact blob every pass (no ORDER BY +
      // LIMIT means nothing else can rotate ahead of it), so one
      // deterministically-failing blob would wedge every blob behind it and
      // abort the whole sweep.
      try {
        // A blob with NO hashes (its bytes were unreadable, so phase 1
        // stamped hashedAt and left the hashes null) must short-circuit.
        // Otherwise every branch of the or() below is undefined, drizzle
        // emits .where(undefined), and the query loads the ENTIRE
        // tosec_entries table into memory to reach the same 'none' the
        // matcher would return anyway.
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

        if (verdict.state === 'matched') {
          // applyMatch MUST run before the blob is stamped 'matched'. If the
          // stamp ran first and applyMatch then threw -- a transient Neon
          // error, or the process killed exactly at the budget boundary this
          // file exists to guard -- the blob would already read
          // matchCheckedAt IS NOT NULL, phase 2's cursor would skip it
          // forever, and the catalog would never actually be rewritten. No
          // re-run of sweep() could heal that.
          //
          // Doing it in this order is safe because applyMatch is idempotent
          // for a repeated (sha256, entryId): the disk fields are overwritten
          // with identical values, the games UPDATE is gated on
          // metadataSource in MACHINE_SOURCES which is already false after a
          // first success only if a human has since edited the row, and
          // mergeDuplicates finds fewer than two duplicates on a second
          // pass. So a crash between applyMatch and the stamp just means the
          // next sweep redoes an idempotent operation -- the crash-and-retry
          // story this module is supposed to have.
          const applied = await applyMatch(b.sha256, verdict.entryId);
          out.merged += applied.gamesMerged;
          await db.update(blobs).set({
            matchState: 'matched',
            matchCheckedAt: new Date(),
            tosecEntryId: verdict.entryId,
          }).where(eq(blobs.sha256, b.sha256));
          out.matched++;
        } else {
          await db.update(blobs).set({
            matchState: verdict.state,
            matchCheckedAt: new Date(),
            tosecEntryId: null,
          }).where(eq(blobs.sha256, b.sha256));
          if (verdict.state === 'ambiguous') out.ambiguous++;
          else out.none++;
        }
      } catch (err) {
        console.error(`tosec-sweep: match failed for blob ${b.sha256}`, err);
      }
    }
  }

  return out;
}

export interface ScanStatus {
  blobs: number; hashed: number; matched: number; none: number;
  ambiguous: number; unchecked: number; unreadable: number; tosecEntries: number;
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
      -- Distinguishes "the object store could not produce these bytes"
      -- (hashed_at set, but no hash landed) from a genuine TOSEC miss (a
      -- real hash was computed and just isn't in tosec_entries). Both would
      -- otherwise read as match_state = 'none' and silently worsen the
      -- reported TOSEC hit rate during, say, a storage outage.
      (select count(*)::int from blobs where hashed_at is not null
        and sha1 is null)                                                        as unreadable,
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
    unreadable: Number(r.unreadable),
    tosecEntries: Number(r.tosec_entries),
    sets: sets.map((s) => ({ ...s, entries: Number(s.entries) })),
  };
}
