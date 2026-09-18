import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { diskStore } from '@/lib/storage';
import { contentHashes } from '@/lib/content-hashes';
import { matchBlob, type Candidate } from '@/lib/tosec-match';
import { applyMatch } from '@/lib/tosec-apply';
import { openretroEntries, openretroDiskSha1, openretroImages } from '@/db/schema/openretro';
import { matchIdentity, openretroSortTitle, type IdentityCandidate } from '@/lib/openretro-identity';
import { applyEnrichment } from '@/lib/openretro-apply';
import { ensureImage } from '@/lib/openretro-images';
import { demozooMatchPhase } from '@/lib/demozoo/sweep';
import { demozooImagePhase } from '@/lib/demozoo/images';

/** Stop well inside the 300 s function limit rather than being killed mid-write. */
const DEFAULT_BUDGET_MS = 240_000;
/** Blobs read per pass. Each read pulls ~880 KB. */
const HASH_BATCH = 25;
/** Blobs matched per pass. No blob reads here, so this can be larger. */
const MATCH_BATCH = 200;
/** Blobs considered per enrichment pass. */
const ENRICH_BATCH = 50;
/**
 * Images fetched per ROLLING HOUR, across every run -- not per run.
 *
 * This was 40-per-run, correct while the only caller was one cron a night, and
 * wrong the moment a sweep could also be triggered by an upload: 40 per run at
 * four runs an hour is 3,840 images a day arriving at a volunteer-run site
 * that previously saw 40 a night. A per-run cap cannot bound a rate when the
 * number of runs is not fixed.
 *
 * Counted from openretro_images.fetched_at, so the budget is shared by every
 * run automatically -- including concurrent ones, which each re-read it before
 * fetching -- needing no coordination and no new table. 60/hour is one a
 * minute sustained: enough that a new library fills in over an evening rather
 * than a week, and the one number to turn down if openretro's operators ever
 * ask us to.
 */
const IMAGES_PER_ROLLING_HOUR = 60;

/**
 * How many images may still be fetched this hour. Re-read before each entry so
 * that two runs overlapping (an upload trigger landing on top of the cron)
 * converge on the same budget instead of each spending it in full.
 */
async function imageBudgetRemaining(): Promise<number> {
  const since = new Date(Date.now() - 3_600_000);
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(openretroImages)
    .where(sql`${openretroImages.fetchedAt} > ${since}`);
  return Math.max(0, IMAGES_PER_ROLLING_HOUR - (rows[0]?.n ?? 0));
}

/**
 * Every OpenRetro entry keyed by normalised title, built once per run and only
 * if something actually needs it.
 *
 * Held in memory rather than queried per blob because the table is 3,697 rows
 * -- small enough that one read beats thousands of LIKEs, and because the
 * normalisation has to happen in TypeScript anyway: doing it in SQL would mean
 * a second implementation of makeSortTitle that could drift from the first.
 */
async function buildIdentityIndex(): Promise<Map<string, IdentityCandidate[]>> {
  const rows = await getDb()
    .select({ uuid: openretroEntries.uuid, gameName: openretroEntries.gameName,
              year: openretroEntries.year })
    .from(openretroEntries);
  const idx = new Map<string, IdentityCandidate[]>();
  for (const r of rows) {
    const key = openretroSortTitle(r.gameName);
    const bucket = idx.get(key);
    if (bucket) bucket.push(r); else idx.set(key, [r]);
  }
  return idx;
}

export interface SweepResult {
  hashed: number; matched: number; none: number; ambiguous: number; merged: number;
  enriched: number; enrichNone: number; enrichAmbiguous: number;
  /** Of `enriched`, how many came from TOSEC identity rather than a content
   *  hash. Reported separately because it is the only way to tell whether
   *  identity matching is earning its keep -- see openretro-identity.ts, which
   *  records that on THIS archive it is worth exactly one disk. */
  enrichedByIdentity: number;
  imagesStored: number; imageBytes: number;
  demozooApplied: number; demozooSuggested: number; demozooNone: number; demozooSkippedGame: number;
  demozooImagesStored: number;
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
    enriched: 0, enrichNone: 0, enrichAmbiguous: 0, enrichedByIdentity: 0,
    imagesStored: 0, imageBytes: 0,
    demozooApplied: 0, demozooSuggested: 0, demozooNone: 0, demozooSkippedGame: 0,
    demozooImagesStored: 0,
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
  let imageBudget = 0;
  let identityIndex: Map<string, IdentityCandidate[]> | null = null;
  while (spent() < budgetMs) {
    const todo = await db.select({
        sha256: blobs.sha256, sha1: blobs.sha1,
        // Carried so a hash miss can fall back to TOSEC identity without a
        // second round trip per blob. LEFT join: most blobs have no TOSEC
        // identity, and those simply skip the fallback.
        tosecSortTitle: tosecEntries.sortTitle, tosecYear: tosecEntries.year,
      })
      .from(blobs)
      .leftJoin(tosecEntries, eq(tosecEntries.id, blobs.tosecEntryId))
      .where(and(isNull(blobs.enrichCheckedAt), sql`${blobs.sha1} is not null`))
      .limit(ENRICH_BATCH);
    if (todo.length === 0) { enrichDone = true; break; }

    // A blob that THROWS is deliberately never stamped, so the same todo query
    // hands it straight back -- which is how one permanently-failing blob used
    // to burn the entire 240 s budget every night while nothing else advanced.
    // Skipping it for the rest of THIS run lets the queue behind it move; the
    // next run still retries it, which is what a transient fault needs.
    const failedThisRun = new Set<string>();
    if (todo.every((t) => failedThisRun.has(t.sha256))) { enrichDone = true; break; }

    for (const b of todo) {
      if (spent() >= budgetMs) break;
      if (failedThisRun.has(b.sha256)) continue;
      try {
        const hit = await db.select({ entryUuid: openretroDiskSha1.entryUuid })
          .from(openretroDiskSha1).where(eq(openretroDiskSha1.sha1, b.sha1!));
        const uuids = [...new Set(hit.map((h) => h.entryUuid))];

        if (uuids.length === 0) {
          // No content-hash hit. Before recording a miss, try the blob's TOSEC
          // identity: openretro is thin in whole-disk ADF dumps but holds
          // 3,697 NAMED games, so a disk TOSEC can name is sometimes a game
          // openretro knows under a different set of bytes.
          const viaIdentity = b.tosecSortTitle
            ? matchIdentity(b.tosecSortTitle, b.tosecYear,
                            (identityIndex ??= await buildIdentityIndex()).get(b.tosecSortTitle) ?? [])
            : { state: 'none' as const };

          if (viaIdentity.state === 'matched') {
            await applyEnrichment(b.sha256, viaIdentity.uuid);
            imageBudget = await imageBudgetRemaining();
            imageBudget -= await fetchEntryImages(viaIdentity.uuid, out, imageBudget);
            await db.update(blobs).set({
              enrichState: 'enriched', enrichCheckedAt: new Date(),
              openretroEntryId: viaIdentity.uuid,
            }).where(eq(blobs.sha256, b.sha256));
            out.enriched++;
            out.enrichedByIdentity++;
            continue;
          }

          await db.update(blobs).set({
            enrichState: viaIdentity.state === 'ambiguous' ? 'ambiguous' : 'none',
            enrichCheckedAt: new Date(), openretroEntryId: null,
          }).where(eq(blobs.sha256, b.sha256));
          if (viaIdentity.state === 'ambiguous') out.enrichAmbiguous++; else out.enrichNone++;
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
        imageBudget = await imageBudgetRemaining();
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
        failedThisRun.add(b.sha256);
      }
    }
  }

  // Demozoo (spec §5): after TOSEC and OpenRetro, inside the same budget.
  const demozooDone = spent() < budgetMs ? await demozooMatchPhase(spent, budgetMs, out) : false;
  if (spent() < budgetMs) await demozooImagePhase(spent, budgetMs, out);
  out.done = matchDone && enrichDone && demozooDone;
  return out;
}

export interface ScanStatus {
  blobs: number; hashed: number; matched: number; none: number;
  ambiguous: number; unchecked: number; unreadable: number; tosecEntries: number;
  /**
   * Blobs in match_state 'none' that are decided rather than a real miss --
   * either because every disk that currently points at the blob belongs to an
   * AUTHORED game, or because the blob is the image_sha256 of ANY
   * disk_versions row with seq > 0 (a version written by a device or the
   * browser), whether or not a disk still points at those exact bytes right
   * now. The second clause is what keeps a SUPERSEDED written image (the
   * disk has since moved on to a later write) counted: its disks-row branch
   * stops applying the moment the disk repoints, but the write itself never
   * stops being one. Neither case is a miss: a disk somebody made, or wrote
   * to, is in no preservation set and never will be, so counting either would
   * make the coverage rate fall every time the operator creates one or writes
   * to their own hardware.
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
      --
      -- The write-back branch below is a SEPARATE, unconditional OR, not
      -- nested inside "some disk points at it": a write's image is decided
      -- the moment it is recorded (disk_versions.seq > 0), and stays decided
      -- after a LATER write moves the disk on to its next head. The disk row
      -- always points at the current head only, so a superseded written image
      -- would otherwise fall out of every disks-based branch entirely and sit
      -- in match_state 'none' forever with nothing able to lower it.
      (select count(*)::int from blobs b
        where b.match_state = 'none'
          and (
            (
              exists (select 1 from disks d where d.sha256 = b.sha256)
              and not exists (
                select 1 from disks d
                join games g on g.id = d.game_id
                where d.sha256 = b.sha256 and g.authored = false
              )
            )
            -- A disk image that exists because someone WROTE to a disk
            -- (write-back): in no preservation set, and not a gap in the
            -- archive -- whether or not a disk still points at these exact
            -- bytes right now.
            or exists (
              select 1 from disk_versions v where v.image_sha256 = b.sha256 and v.seq > 0
            )
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
