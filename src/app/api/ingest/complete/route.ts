import { after } from 'next/server';
import { sweep } from '@/lib/tosec-sweep';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { BlobServiceRateLimited } from '@vercel/blob';
import { getDb } from '@/db';
import { blobs, entitlements, games, disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { completeBody, stableId } from '@/lib/ingest';
import { groupDisks } from '@/lib/grouping';
import { parseTosecName } from '@/lib/tosec';
import { contentHashes } from '@/lib/content-hashes';
import { mapLimit } from '@/lib/pool';
import { chunk } from '@/lib/chunk';
import { inspectHfe, type HfeInspection } from '@/lib/hfe/inspect';
import { isHfeFilename } from '@/lib/disk-format';
import { MAX_HFE_PER_BATCH } from '@/lib/blob-upload';

// A batch is up to MAX_BATCH (500) files. Verification reads back every
// genuinely-new blob (~880 KB each), so this is the one ingest route that can
// legitimately run for a while. 60s is the ceiling available on every Vercel
// plan; the clients batch at 500 and retry, so a batch that does run out of
// time is re-driven rather than lost.
export const maxDuration = 60;

/** head() calls in flight at once. Bounded so a 500-file batch cannot fan out 500 requests. */
const STAT_CONCURRENCY = 12;
/** Full read-backs in flight at once. Lower: each one pulls ~880 KB. */
const VERIFY_CONCURRENCY = 4;
/** Rows per INSERT. Keeps any single statement well inside Postgres' parameter limit. */
const INSERT_CHUNK = 250;

type Verdict =
  | { ok: true; sizeBytes: number; gzipSizeBytes: number | null;
      // Present only on the first-registration path, which is the only
      // branch that reads the bytes. A dedupe hit skips the read-back by
      // design and its blob already carries hashes from that first write.
      hashes: { crc32: string; md5: string; sha1: string } | null;
      // The bytes verify() read, kept only when the caller asked (an HFE,
      // which is inspected next): holding every read of a 500-file batch
      // would be ~440 MB.
      bytes?: Uint8Array }
  | { ok: false; reason: 'not-stored' | 'size-mismatch' | 'digest-mismatch' | 'hfe-refused' };

/**
 * Decides whether the store really holds the content this file claims, and at
 * what size. Nothing about the client's payload is taken on trust.
 *
 * `alreadyRegistered` blobs skip the read-back: their digest was verified when
 * the row was first written and the key is immutable (allowOverwrite: false),
 * so re-reading ~880 KB on every dedupe hit would buy nothing. That is the
 * common case by far, and it stays a single head().
 *
 * A blob being registered for the FIRST time is read in full and hashed. This
 * is the only moment content addressing can actually be enforced, and it is
 * the moment the `blobs` row is created — before this, a PUT of arbitrary
 * bytes under any claimed hash was accepted with a 200 and catalogued.
 *
 * The digest is checked BEFORE the size claim, and is what decides deletion.
 * The size claim only describes the client's own belief; the digest is proof
 * about the content. So authentic bytes are never deleted because a client
 * miscounted, and inauthentic bytes are always deleted however the client
 * described them — which matters, because leaving them would park unverified
 * content at a key nobody can ever overwrite.
 */
async function verify(
  sha256: string, claimedSize: number, alreadyRegistered: boolean, keepBytes = false,
): Promise<Verdict> {
  const stat = await diskStore.stat(sha256);
  if (!stat) return { ok: false, reason: 'not-stored' };

  if (alreadyRegistered) {
    if (stat.sizeBytes !== claimedSize) return { ok: false, reason: 'size-mismatch' };
    return { ok: true, sizeBytes: stat.sizeBytes, gzipSizeBytes: null, hashes: null };
  }

  const bytes = await diskStore.read(sha256);
  // One pass over bytes that are already in memory. This is the only moment
  // they ever are (see the comment on verify()), so it is the only free
  // opportunity to record the other three digests.
  const h = contentHashes(bytes);
  if (h.sha256 !== sha256) {
    await release(sha256);
    return { ok: false, reason: 'digest-mismatch' };
  }

  // Authentic content, wrongly described. Rejected (the caller has to send a
  // payload that matches reality) but deliberately NOT deleted: these bytes
  // are provably the content of this key, and the next /complete describing
  // them correctly will register them.
  if (bytes.byteLength !== claimedSize) return { ok: false, reason: 'size-mismatch' };

  // Recorded at ingest (Spec) so the "should we store these gzipped?" decision
  // can be revisited against real numbers instead of a guess. Free here: the
  // bytes are already in memory for the digest check, and this is the only
  // time they ever are.
  return {
    ok: true,
    sizeBytes: bytes.byteLength,
    gzipSizeBytes: gzipSync(bytes).byteLength,
    hashes: { crc32: h.crc32, md5: h.md5, sha1: h.sha1 },
    ...(keepBytes ? { bytes } : {}),
  };
}

/**
 * Deletes the bytes at a key that failed verification and has no `blobs` row.
 *
 * Without this, a rejected upload leaves unverified content parked at
 * adf/<sha> that nobody can ever overwrite (allowOverwrite: false) — so the
 * legitimate owner of those bytes could never store them. Only ever called
 * for an UNREGISTERED key: content that already has a row was verified when
 * that row was written and must never be touched.
 */
async function release(sha256: string): Promise<void> {
  try {
    await diskStore.remove(sha256);
  } catch {
    // Best effort. A key we could not free is a wedged key, but failing the
    // whole request over it would be worse — the rejection still stands.
  }
}

export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  const parsed = completeBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  const db = getDb();
  const files = parsed.data.files;

  // Each HFE costs ~100 ms of inspection (spec D3), and a ~2 MB read on a
  // dedupe hit, on top of verification, inside a 60 s budget. Both clients split their batches
  // with splitBatches(), so only a hand-rolled caller ever sees this.
  const hfeFiles = files.filter((f) => isHfeFilename(f.filename));
  if (hfeFiles.length > MAX_HFE_PER_BATCH) {
    return Response.json({ error: 'too_many_hfe', max: MAX_HFE_PER_BATCH }, { status: 400 });
  }
  const hfeNamed = new Set(hfeFiles.map((f) => f.sha256));
  const uniqueShas = [...new Set(files.map((f) => f.sha256))];

  // Which of these already have a blobs row? Drives whether verification has
  // to read the bytes back, and is a plain indexed PK lookup.
  const existingRows = await db
    .select({ sha256: blobs.sha256 })
    .from(blobs)
    .where(inArray(blobs.sha256, uniqueShas));
  const registered = new Set(existingRows.map((r) => r.sha256));

  // Claimed size per hash. If one request describes the same hash at two
  // different sizes, at most one can be right — take the first and let the
  // size check decide.
  const claimed = new Map<string, number>();
  for (const f of files) if (!claimed.has(f.sha256)) claimed.set(f.sha256, f.sizeBytes);

  const hfeInfo = new Map<string, Extract<HfeInspection, { ok: true }>>();
  const hfeRefusal = new Map<string, string>();

  const verdictFor = new Map<string, Verdict>();
  try {
    // Split by cost. Already-registered hashes are one head() each and run
    // wider; first-time registrations pull the whole blob and run narrower.
    // Both bounded -- neither may fan out 500 concurrent requests.
    const alreadyKnown = uniqueShas.filter((s) => registered.has(s));
    const needsRead = uniqueShas.filter((s) => !registered.has(s));

    const knownVerdicts = await mapLimit(alreadyKnown, STAT_CONCURRENCY, (s) =>
      verify(s, claimed.get(s)!, true));
    const newVerdicts = await mapLimit(needsRead, VERIFY_CONCURRENCY, (s) =>
      verify(s, claimed.get(s)!, false, hfeNamed.has(s)));

    alreadyKnown.forEach((s, i) => verdictFor.set(s, knownVerdicts[i]));
    needsRead.forEach((s, i) => verdictFor.set(s, newVerdicts[i]));

    // HFE (spec D3) is validated on EVERY registration, a dedupe hit
    // included: skipping the read-back above rests on the digest having been
    // proven once, which says nothing about whether these bytes are an HFE
    // the board can play -- another org may have uploaded them as anything.
    // A first registration reuses the bytes verify() already read; only a
    // dedupe hit pays for a read here.
    const hfeShas = uniqueShas.filter((s) => verdictFor.get(s)!.ok && hfeNamed.has(s));
    const inspections = await mapLimit(hfeShas, VERIFY_CONCURRENCY, async (s) => {
      const v = verdictFor.get(s) as Extract<Verdict, { ok: true }>;
      const bytes = v.bytes ?? await diskStore.read(s);
      delete v.bytes; // not needed past this point; let it go before the inserts
      return inspectHfe(bytes);
    });
    hfeShas.forEach((s, i) => {
      const r = inspections[i];
      if (r.ok) {
        hfeInfo.set(s, r);
      } else {
        // Authentic bytes, deliberately NOT released: same rule as a
        // size-mismatch -- they are provably this key's content.
        verdictFor.set(s, { ok: false, reason: 'hfe-refused' });
        hfeRefusal.set(s, r.reason);
      }
    });
  } catch (err) {
    // Unhandled before: the blob service rate-limiting one batch used to 500
    // the whole request with a stack trace. It is transient and retryable, so
    // say so.
    if (err instanceof BlobServiceRateLimited) {
      return Response.json(
        { error: 'blob store rate limited, retry this batch' },
        { status: 503, headers: { 'retry-after': String(err.retryAfter ?? 10) } },
      );
    }
    throw err;
  }

  const rejected: string[] = [];
  const rejectedReasons: Record<string, string> = {};
  for (const s of uniqueShas) {
    const v = verdictFor.get(s)!;
    if (!v.ok) {
      rejected.push(s);
      rejectedReasons[s] = v.reason === 'hfe-refused' ? hfeRefusal.get(s)! : v.reason;
    }
  }

  // Every landed file now carries the store's size, not the client's claim.
  const landed = files
    .filter((f) => verdictFor.get(f.sha256)!.ok)
    .map((f) => {
      const v = verdictFor.get(f.sha256) as Extract<Verdict, { ok: true }>;
      return { ...f, sizeBytes: v.sizeBytes };
    });

  if (landed.length === 0) {
    return Response.json({ created: 0, rejected, rejectedReasons }, { status: 409 });
  }

  const blobRows = [...new Map(landed.map((f) => {
    const v = verdictFor.get(f.sha256) as Extract<Verdict, { ok: true }>;
    return [f.sha256, {
      sha256: f.sha256,
      sizeBytes: v.sizeBytes,
      gzipSizeBytes: v.gzipSizeBytes,
      storageKey: diskStore.storageKey(f.sha256),
      crc32: v.hashes?.crc32 ?? null,
      md5: v.hashes?.md5 ?? null,
      sha1: v.hashes?.sha1 ?? null,
      hashedAt: v.hashes ? new Date() : null,
    }];
  })).values()];
  for (const part of chunk(blobRows, INSERT_CHUNK)) {
    await db.insert(blobs).values(part).onConflictDoNothing();
  }

  const entitlementRows = [...new Map(landed.map((f) =>
    [f.sha256, { orgId, sha256: f.sha256, sourceFilename: f.filename }])).values()];
  for (const part of chunk(entitlementRows, INSERT_CHUNK)) {
    await db.insert(entitlements).values(part).onConflictDoNothing();
  }

  // parseTosecName returns title: '' for a filename that is empty or is
  // nothing but an extension/bracket clause (e.g. ".adf", "[cr].adf"). The
  // bytes still landed and the entitlement above is still valid — a bad
  // filename doesn't mean the upload failed — but we must not write a
  // games row with an empty title, and grouping these under one blank-title
  // "game" key would incorrectly merge unrelated uploads. So: filter them
  // out of the grouping input entirely and report them separately.
  const groupable = landed.filter((f) => parseTosecName(f.filename).title.trim() !== '');
  const skippedTitle = landed
    .filter((f) => parseTosecName(f.filename).title.trim() === '')
    .map((f) => f.sha256);

  const grouped = groupDisks(groupable.map((f) => ({
    filename: f.filename, sha256: f.sha256, sizeBytes: f.sizeBytes,
  })));

  // Deterministic ids, always including orgId: calling /complete twice
  // with the same payload (a CLI retry) or with a payload that overlaps
  // an earlier one (a batch that re-sends already-ingested files) must
  // land on the SAME game/disk primary keys so onConflictDoNothing turns
  // the repeat write into a no-op instead of a duplicate row. orgId is
  // part of every derivation so two tenants uploading the identical disk
  // set still get their own separate game/disk rows — the dedupe lives
  // only on `blobs`, never on these per-tenant catalog rows.
  //
  // Accumulated and inserted in bulk rather than two round trips per game:
  // a 500-disk batch used to mean up to ~1,000 sequential Neon round trips
  // inside one function invocation, which is most of the time budget spent
  // on latency alone.
  const gameRows = new Map<string, typeof games.$inferInsert>();
  const diskRows = new Map<string, typeof disks.$inferInsert>();

  for (const g of grouped) {
    const gameId = stableId('game', orgId, g.sortTitle, g.year === null ? '' : String(g.year));
    if (!gameRows.has(gameId)) {
      gameRows.set(gameId, {
        id: gameId, orgId, title: g.title, sortTitle: g.sortTitle,
        year: g.year, publisher: g.publisher, metadataSource: 'filename',
      });
    }
    for (const d of g.disks) {
      const diskId = stableId('disk', gameId, d.sha256);
      if (!diskRows.has(diskId)) {
        // Decided by the bytes (did this sha256 pass HFE inspection in this
        // batch?), not by this row's filename: the same bytes can appear
        // under an .adf name elsewhere in the same batch (or in `disks.set`,
        // which keeps only the FIRST filename seen per diskId), and a
        // filename check would silently drop the HFE stamping in that case.
        const hfe = hfeInfo.get(d.sha256);
        diskRows.set(diskId, {
          id: diskId, gameId, orgId, diskNo: d.diskNo, sha256: d.sha256,
          tosecName: d.filename, isBoot: d.isBoot, sizeBytes: d.sizeBytes,
          ...(hfe ? {
            imageFormat: 'hfe' as const, writeProtected: true,
            extractable: hfe.extractable, extractReason: hfe.extractReason,
            maxTrackBits: hfe.maxTrackBits,
          } : {}),
        });
      }
    }
  }

  for (const part of chunk([...gameRows.values()], INSERT_CHUNK)) {
    await db.insert(games).values(part).onConflictDoNothing();
  }
  // Strictly after the games inserts: disks.game_id has an FK onto games.id.
  //
  // Split by format: the disk id is stableId('disk', gameId, sha256), so the
  // same bytes first uploaded under a .adf name already have a row. A later
  // .hfe upload of them must turn that row into an HFE, not leave it an
  // unmountable "ADF".
  const allDiskRows = [...diskRows.values()];
  const adfRows = allDiskRows.filter((r) => r.imageFormat !== 'hfe');
  const hfeRows = allDiskRows.filter((r) => r.imageFormat === 'hfe');
  for (const part of chunk(adfRows, INSERT_CHUNK)) {
    await db.insert(disks).values(part).onConflictDoNothing();
  }
  for (const part of chunk(hfeRows, INSERT_CHUNK)) {
    await db.insert(disks).values(part).onConflictDoUpdate({
      target: disks.id,
      // Write-back can move disks.sha256 while keeping disks.id, so an
      // existing row at this id may by now hold different (ADF) bytes.
      // Guarded so this upsert only flips a row that still holds these
      // exact HFE bytes -- never one that write-back has since replaced.
      setWhere: sql`${disks.sha256} = excluded.sha256`,
      set: {
        imageFormat: 'hfe', writeProtected: true,
        extractable: sql`excluded.extractable`, extractReason: sql`excluded.extract_reason`,
        maxTrackBits: sql`excluded.max_track_bits`,
      },
    });
  }

  // applyMatch rewrites the games/disks rows that exist when it runs, so a blob
  // matched before these disks existed would never reach them. Clearing the
  // verdict puts these hashes back in front of the sweeper, which re-applies the
  // identity to the rows just created. Only hashes that were already decided are
  // touched; a brand-new blob has a null cursor already.
  const decided = [...new Set(landed.map((f) => f.sha256))];
  if (decided.length > 0) {
    await db.update(blobs).set({
      matchCheckedAt: null, matchState: null, tosecEntryId: null,
    }).where(and(inArray(blobs.sha256, decided), isNotNull(blobs.matchCheckedAt)));
  }

  // Identify and enrich what just landed, WITHOUT making the uploader wait for
  // it. Until now the only thing that ever ran the sweeper was a cron at 03:00
  // UTC, so somebody who uploaded sixty disks at lunchtime looked at sixty
  // untitled files until the next morning. For a library other people are
  // meant to be able to use, that is the whole experience.
  //
  // after() rather than a bare un-awaited promise: on a serverless platform
  // the function can be frozen the moment the response is returned, which is
  // precisely when a fire-and-forget sweep would be killed. after() is the
  // documented way to keep work alive past the response.
  //
  // A SHORT budget, not the cron's 240 s. This is the "make the new disks
  // appear" pass, and the nightly run remains the one that finishes long jobs
  // -- every phase is stamped and resumable, so stopping early costs nothing
  // but the next run's time.
  //
  // Overlap with the cron, or with another upload, is left possible on
  // purpose. Every write here is idempotent and stamped, and the one thing
  // that genuinely must not double up -- requests to openretro.org -- is
  // bounded by a rolling-hour budget that every run re-reads before fetching,
  // so concurrency costs a little duplicated local work and nothing external.
  after(async () => {
    try {
      await sweep(45_000);
    } catch (err) {
      // Never let a sweep failure reach the uploader: their disks ARE stored,
      // and the nightly run will identify them. Logged, not surfaced.
      console.error('ingest: post-upload sweep failed', err);
    }
  });

  return Response.json({
    created: grouped.length,
    disks: groupable.length,
    rejected,
    rejectedReasons,
    skippedTitle,
    notices: Object.fromEntries([...hfeInfo].map(([s, r]) => [s, r.notices])),
  });
}
