import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { diskStore } from '@/lib/storage';
import { contentHashes } from '@/lib/content-hashes';
import { matchBlob, type Candidate } from '@/lib/tosec-match';
import { applyMatch } from '@/lib/tosec-apply';
import { openretroEntries, openretroDiskSha1 } from '@/db/schema/openretro';
import { applyEnrichment } from '@/lib/openretro-apply';
import { ensureImage } from '@/lib/openretro-images';

/** Stop well inside the 300 s function limit rather than being killed mid-write. */
const DEFAULT_BUDGET_MS = 240_000;
/** Blobs read per pass. Each read pulls ~880 KB. */
const HASH_BATCH = 25;
/** Blobs matched per pass. No blob reads here, so this can be larger. */
const MATCH_BATCH = 200;
/** Blobs considered per enrichment pass. */
const ENRICH_BATCH = 50;
/**
 * Images fetched per sweep run, across all blobs. A first pass over a large
 * library therefore spreads over several nights instead of arriving at
 * openretro.org as a burst.
 */
const IMAGE_CAP_PER_RUN = 40;

export interface SweepResult {
  hashed: number; matched: number; none: number; ambiguous: number; merged: number;
  enriched: number; enrichNone: number; enrichAmbiguous: number;
  imagesStored: number; imageBytes: number;
  done: boolean;
}

/**
 * Best-effort image fetch for one entry: the cover, the title screen and every
 * screenshot, up to `budget` images.
 *
 * Every fetch is isolated. An image that 404s at openretro.org is PERMANENT,
 * not transient -- unlike anything phase 2 can fail on -- so letting it
 * propagate would abort its blob's enrichment, leave the blob unstamped, and
 * hand the same blob back to the very next pass. With no ORDER BY on the todo
 * query nothing can rotate ahead of it, so a single missing image would burn
 * the whole 240 s budget every night, forever. The facts are the enrichment;
 * the pictures are a bonus, and a missing one must not cost the facts.
 */
async function fetchEntryImages(
  entryUuid: string, out: SweepResult, budget: number,
): Promise<number> {
  if (budget <= 0) return 0;
  const db = getDb();
  const rows = await db.select({
    frontSha1: openretroEntries.frontSha1,
    titleSha1: openretroEntries.titleSha1,
    screenshotSha1s: openretroEntries.screenshotSha1s,
  }).from(openretroEntries).where(eq(openretroEntries.uuid, entryUuid)).limit(1);
  const e = rows[0];
  if (!e) return 0;

  const wanted: Array<{ sha1: string; kind: 'front' | 'title' | 'screenshot'; ordinal: number }> = [];
  if (e.frontSha1) wanted.push({ sha1: e.frontSha1, kind: 'front', ordinal: 0 });
  if (e.titleSha1) wanted.push({ sha1: e.titleSha1, kind: 'title', ordinal: 0 });
  // Persisted comma-joined by the importer, because the import and this fetch
  // are different requests -- an in-memory list would be long gone by now.
  (e.screenshotSha1s ?? '').split(',').filter(Boolean).forEach((sha1, i) => {
    wanted.push({ sha1, kind: 'screenshot', ordinal: i + 1 });
  });

  let fetched = 0;
  for (const w of wanted) {
    if (fetched >= budget) break;
    try {
      const r = await ensureImage(entryUuid, w.sha1, w.kind, w.ordinal);
      if (r.stored) {
        fetched++;
        out.imagesStored++;
        out.imageBytes += r.bytes;
      }
    } catch (err) {
      console.error(`openretro: image ${w.sha1} for entry ${entryUuid} failed`, err);
    }
  }
  return fetched;
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
  const out: SweepResult = {
    hashed: 0, matched: 0, none: 0, ambiguous: 0, merged: 0,
    enriched: 0, enrichNone: 0, enrichAmbiguous: 0, imagesStored: 0, imageBytes: 0,
    done: false,
  };
  // `done` means EVERY phase drained, so each phase that can leave work
  // behind records its own verdict. Phase 2 alone setting out.done would
  // report "Scan complete" to the admin page while enrichment was still
  // hundreds of blobs from finished.
  let matchDone = false;
  let enrichDone = false;
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
    if (todo.length === 0) { matchDone = true; break; }

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

  // Phase 3 -- enrich. Runs last: a blob's TOSEC identity is useful context
  // when a human reviews an enrichment miss, and all three phases share one
  // budget.
  let imageBudget = IMAGE_CAP_PER_RUN;
  while (spent() < budgetMs) {
    const todo = await db.select({ sha256: blobs.sha256, sha1: blobs.sha1 })
      .from(blobs)
      .where(and(isNull(blobs.enrichCheckedAt), sql`${blobs.sha1} is not null`))
      .limit(ENRICH_BATCH);
    if (todo.length === 0) { enrichDone = true; break; }

    for (const b of todo) {
      if (spent() >= budgetMs) break;
      try {
        const hit = await db.select({ entryUuid: openretroDiskSha1.entryUuid })
          .from(openretroDiskSha1).where(eq(openretroDiskSha1.sha1, b.sha1!));
        const uuids = [...new Set(hit.map((h) => h.entryUuid))];

        if (uuids.length === 0) {
          await db.update(blobs).set({ enrichState: 'none', enrichCheckedAt: new Date(), openretroEntryId: null })
            .where(eq(blobs.sha256, b.sha256));
          out.enrichNone++;
          continue;
        }
        if (uuids.length > 1) {
          // 13,610 of the 175,282 sha1s in a real sync map to more than one
          // parent -- worst case 85 -- so this branch is ordinary, not an
          // error. Two entries disagreeing about what these bytes are is not
          // something a sweep may pick between.
          await db.update(blobs).set({ enrichState: 'ambiguous', enrichCheckedAt: new Date(), openretroEntryId: null })
            .where(eq(blobs.sha256, b.sha256));
          out.enrichAmbiguous++;
          continue;
        }

        const uuid = uuids[0];
        await applyEnrichment(b.sha256, uuid);
        imageBudget -= await fetchEntryImages(uuid, out, imageBudget);
        // Stamped only after the work succeeded -- the same ordering phase 2
        // uses, and for the same reason: a stamp before a throw is
        // unrecoverable, since the cursor never revisits it.
        await db.update(blobs).set({ enrichState: 'enriched', enrichCheckedAt: new Date(), openretroEntryId: uuid })
          .where(eq(blobs.sha256, b.sha256));
        out.enriched++;
      } catch (err) {
        // Deliberately does NOT stamp: an image fetch failure is usually
        // transient, and stamping would record it as decided forever.
        console.error(`openretro: enrichment failed for blob ${b.sha256}`, err);
      }
    }
  }

  out.done = matchDone && enrichDone;
  return out;
}

export interface ScanStatus {
  blobs: number; hashed: number; matched: number; none: number;
  ambiguous: number; unchecked: number; unreadable: number; tosecEntries: number;
  /**
   * Blobs in match_state 'none' whose every referencing disk belongs to an
   * AUTHORED game. Not misses: a disk somebody made is in no preservation set
   * and never will be, so counting it would make the coverage rate fall every
   * time the operator creates one.
   */
  authoredNone: number;
  enriched: number; enrichNone: number; enrichAmbiguous: number; enrichUnchecked: number;
  openretroEntries: number; imagesStored: number; imageBytes: number;
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
      -- Disks somebody MADE here rather than uploaded. They will hash to
      -- something no DAT contains, so they land in match_state 'none' --
      -- correct, and not a miss: a disk the operator authored is in no
      -- preservation set and never will be. Counting them would make the
      -- reported coverage fall every time they make one, reporting their own
      -- work as a gap in the archive.
      --
      -- EVERY disk on the blob must be authored, not just one. A blob is
      -- global and content-addressed: if the same bytes also back a real
      -- uploaded disk in any organization, then it IS an archive disk that
      -- TOSEC failed to recognise, and that is exactly what this rate is for.
      (select count(*)::int from blobs b
        where b.match_state = 'none'
          and exists (select 1 from disks d where d.sha256 = b.sha256)
          and not exists (
            select 1 from disks d
            join games g on g.id = d.game_id
            where d.sha256 = b.sha256 and g.authored = false
          ))                                                                     as authored_none,
      (select count(*)::int from tosec_entries)                                  as tosec_entries,
      (select count(*)::int from blobs where enrich_state = 'enriched')          as enriched,
      (select count(*)::int from blobs where enrich_state = 'none')              as enrich_none,
      (select count(*)::int from blobs where enrich_state = 'ambiguous')         as enrich_ambiguous,
      -- Counts only HASHED blobs: phase 3's cursor requires a sha1, so a blob
      -- with no hash is not pending enrichment, it is permanently outside it.
      -- Counting those here would leave enrich-unchecked stuck above zero
      -- with no run able to lower it.
      (select count(*)::int from blobs where enrich_checked_at is null
        and sha1 is not null)                                                    as enrich_unchecked,
      (select count(*)::int from openretro_entries)                              as openretro_entries,
      (select count(*)::int from openretro_images)                               as images_stored,
      (select coalesce(sum(size_bytes), 0)::bigint from openretro_images)        as image_bytes
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
    authoredNone: Number(r.authored_none),
    tosecEntries: Number(r.tosec_entries),
    enriched: Number(r.enriched), enrichNone: Number(r.enrich_none),
    enrichAmbiguous: Number(r.enrich_ambiguous), enrichUnchecked: Number(r.enrich_unchecked),
    openretroEntries: Number(r.openretro_entries),
    imagesStored: Number(r.images_stored), imageBytes: Number(r.image_bytes),
    sets: sets.map((s) => ({ ...s, entries: Number(s.entries) })),
  };
}
