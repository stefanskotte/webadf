import { crc32 } from 'node:zlib';
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { remoteRequests } from '@/db/schema/remote-requests';
import { cleanAmigaPath } from '@/lib/transfers';
import { listStash, lockOrg, touchStashDirs } from '@/lib/stash';
import { uniqueStashPath } from '@/lib/files/stash-paths';
import { parsePath } from '@/lib/files/path';
import { getForUpload, liveGet, settleGet, touchGet, type GetTarget } from '@/lib/remote-requests';
import { storeSendBytes } from '@/lib/send-http';
import { firmwareAtLeast } from '@/lib/firmware-version';
import {
  UPLOAD_AREA_MAX_BYTES, UPLOAD_AREA_MAX_FILES, UPLOAD_CHUNK, UPLOAD_FILE_MAX, UPLOAD_FW, UPLOAD_KEEP_MS, UPLOAD_RESUME_MS,
} from '@/lib/amiga-upload-limits';

// Uploads from the Amiga (spec 2026-10-18 §4): the board's open / chunk / close, and the person's area.

export type UploadRow = typeof amigaUploads.$inferSelect;
const LIVE = ['receiving', 'stored'];
/** What a board sent (R5), as the board card's count sees it: STASH: rows from the browser, copies and folders are not its. */
const FROM_AMIGA = [eq(amigaUploads.source, 'amiga'), eq(amigaUploads.kind, 'file')];

/** `request`: the get this upload answers (NET: volumes, spec 2026-10-30 §4.5): the file is stored at the copy's target. */
export type OpenInput = { size: number; date: string; protection: number; path: string; comment: string; request?: string };
export type OpenResult = { ok: true; id: string; offset: number } | { ok: false; code: 'size' | 'full' | 'name' };

/** Resumes the same file from the same board (path, size, date) within 24 h, or opens a new one within the org's limits. */
export async function openUpload(db: Db, dev: { deviceId: string; orgId: string }, a: OpenInput, now = new Date()): Promise<OpenResult> {
  if (!Number.isSafeInteger(a.size) || a.size < 0 || a.size > UPLOAD_FILE_MAX) return { ok: false, code: 'size' };
  // A fetched file (§4.5) goes where the copy said: the STASH: folder's segments, then its path below the copied entry.
  const get = a.request === undefined ? null : await getForUpload(db, dev.deviceId, a.request);
  if (a.request !== undefined && !get) return { ok: false, code: 'name' };
  const target = get?.target as GetTarget | undefined;
  const path = cleanAmigaPath(target ? [...(parsePath(target.dest)?.segments ?? []), ...target.rel].join('/') : a.path);
  if (!path) return { ok: false, code: 'name' };
  const comment = a.comment.replace(/[^\x20-\x7e\xa0-\xff]/g, '').slice(0, 79);
  const r = await openRow(db, dev, a, path, comment, get?.id ?? null, now);
  // The area is full: this file fails, the copy's other files go on (each is its own get).
  if (!r.ok && r.code === 'full' && get) await settleGet(db, get.id, { ok: false, code: 'full', text: 'STASH: is full' }, now);
  return r;
}

async function openRow(db: Db, dev: { deviceId: string; orgId: string }, a: OpenInput, path: string, comment: string, rid: string | null,
  now: Date): Promise<OpenResult> {
  return db.transaction(async (tx) => {
    // The count and the insert under one lock per org: READ COMMITTED alone lets two opens count the same rows (ruling P8).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`amiga_uploads:${dev.orgId}`}))`);
    const [same] = await tx.select({ id: amigaUploads.id, received: amigaUploads.receivedBytes }).from(amigaUploads)
      .where(and(eq(amigaUploads.orgId, dev.orgId), eq(amigaUploads.deviceId, dev.deviceId), eq(amigaUploads.status, 'receiving'), eq(amigaUploads.path, path),
        eq(amigaUploads.sizeBytes, a.size), eq(amigaUploads.amigaDate, a.date), gt(amigaUploads.expiresAt, now)))
      .orderBy(desc(amigaUploads.createdAt)).limit(1);
    if (same) {
      if (rid) await touchGet(tx, { id: rid }, now, same.id);
      return { ok: true as const, id: same.id, offset: same.received };
    }
    // Only rows that still count (3bv I1): receiving within its 24 h, stored within its 30 days.
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<string>`coalesce(sum(${amigaUploads.sizeBytes}),0)::bigint` })
      .from(amigaUploads)
      .where(and(eq(amigaUploads.orgId, dev.orgId), inArray(amigaUploads.status, LIVE), gt(amigaUploads.expiresAt, now)));
    if (load.n + 1 > UPLOAD_AREA_MAX_FILES || Number(load.b) + a.size > UPLOAD_AREA_MAX_BYTES) {
      return { ok: false as const, code: 'full' as const };
    }
    const [d] = await tx.select({ name: devices.name }).from(devices).where(eq(devices.id, dev.deviceId));
    const id = crypto.randomUUID();
    // A fetched file is a Files copy (P6): source copy, no board name, as every copy row.
    await tx.insert(amigaUploads).values({ id, orgId: dev.orgId, deviceId: dev.deviceId, deviceName: rid ? null : d?.name ?? 'Board',
      path, sizeBytes: a.size, protection: a.protection >>> 0, comment, amigaDate: a.date,
      expiresAt: new Date(now.getTime() + UPLOAD_RESUME_MS), ...(rid ? { source: 'copy' } : {}) });
    if (rid) await touchGet(tx, { id: rid }, now, id);
    return { ok: true as const, id, offset: 0 };
  });
}

export type ChunkResult = { ok: true; received: number } | { ok: false; status: 400 | 404 | 409; received?: number };

/** One chunk at `offset`: stored when it is the next one; a retry of a stored one changes nothing; a gap is 409. */
export async function storeChunk(db: Db, deviceId: string, id: string, offset: number, data: Uint8Array, now = new Date()): Promise<ChunkResult> {
  if (data.byteLength < 1 || data.byteLength > UPLOAD_CHUNK) return { ok: false, status: 400 };
  return db.transaction(async (tx) => {
    const [r] = await tx.select({ size: amigaUploads.sizeBytes, received: amigaUploads.receivedBytes, status: amigaUploads.status })
      .from(amigaUploads).where(and(eq(amigaUploads.id, id), eq(amigaUploads.deviceId, deviceId))).for('update');
    if (!r || r.status !== 'receiving') return { ok: false as const, status: 404 as const };
    if (offset < r.received) return { ok: true as const, received: r.received };   // a retry after a lost answer
    if (offset > r.received) return { ok: false as const, status: 409 as const, received: r.received };
    const end = offset + data.byteLength;
    // Every chunk is 16 KB but the last, so a resume offset is always a chunk boundary.
    if (end > r.size || (data.byteLength !== UPLOAD_CHUNK && end !== r.size)) return { ok: false as const, status: 400 as const };
    await tx.insert(amigaUploadChunks).values({ uploadId: id, offset, data });
    await tx.update(amigaUploads).set({ receivedBytes: end }).where(eq(amigaUploads.id, id));
    // A fetched file's chunk is its get's sign of life: the 10-minute timeout restarts (fix round 1 ruling).
    await touchGet(tx, { uploadId: id }, now);
    return { ok: true as const, received: end };
  });
}

export type CloseResult = { ok: true; name: string } | { ok: false; status: 404 | 409; code: 'crc' | 'size' | 'gone' };

/**
 * What a close of a settled row answers. The board repeats a close whose answer it lost, or retries one after its 30 s
 * read timeout while the first still runs: the same CRC hears what the first close decided -- the name once stored,
 * crc once that CRC failed. Anything else (deleted, expired, another CRC) is gone.
 */
function settledAnswer(r: UploadRow, crc: number): CloseResult | null {
  if (r.status === 'receiving') return null;
  if (r.crc32 === crc >>> 0) {
    if (r.status === 'stored') return { ok: true, name: r.sentName ?? r.path };   // the name the board sent, not a keep-both one (R4)
    if (r.status === 'failed' && r.errorCode === 'crc') return { ok: false, status: 409, code: 'crc' };
  }
  return { ok: false, status: 409, code: 'gone' };
}

/** The close (spec §4): every byte in order, the size and the CRC-32, then the bytes into the disk store. */
export async function closeUpload(db: Db, deviceId: string, id: string, crc: number, now = new Date()): Promise<CloseResult> {
  const reread = async () => (await db.select().from(amigaUploads).where(and(eq(amigaUploads.id, id), eq(amigaUploads.deviceId, deviceId))))[0];
  // A guarded update or a chunk read lost a race: the row as it is now decides (another close settled it, or a delete).
  const lost = async (otherwise: CloseResult): Promise<CloseResult> => {
    const cur = await reread();
    if (!cur) return { ok: false, status: 404, code: 'gone' };
    const a = settledAnswer(cur, crc);
    return a && !(a.ok === false && a.code === 'gone') ? a : otherwise;
  };
  const r = await reread();
  if (!r) return { ok: false, status: 404, code: 'gone' };
  const settled = settledAnswer(r, crc);
  if (settled) return settled;
  const parts = await db.select({ offset: amigaUploadChunks.offset, data: amigaUploadChunks.data }).from(amigaUploadChunks)
    .where(eq(amigaUploadChunks.uploadId, id)).orderBy(asc(amigaUploadChunks.offset));
  const bytes = new Uint8Array(r.sizeBytes);
  let at = 0;
  for (const p of parts) {
    if (p.offset !== at || at + p.data.byteLength > r.sizeBytes) return lost({ ok: false, status: 409, code: 'size' });
    bytes.set(p.data, at);
    at += p.data.byteLength;
  }
  // Not every chunk is in: the board resumes. (Or a close running alongside settled the row and took the chunks.)
  if (at !== r.sizeBytes) return lost({ ok: false, status: 409, code: 'size' });
  if ((crc32(bytes) >>> 0) !== crc >>> 0) {
    // Final (spec §4): the chunks go, so the next send of this file starts at 0. The CRC sent is kept, so a repeat of
    // this close (its answer lost) hears crc again.
    const failed = await db.transaction(async (tx) => {
      const hit = await tx.update(amigaUploads).set({ status: 'failed', errorCode: 'crc', crc32: crc >>> 0 })
        .where(and(eq(amigaUploads.id, id), eq(amigaUploads.status, 'receiving'))).returning({ id: amigaUploads.id });
      if (hit.length) await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id));
      return hit.length > 0;
    });
    if (failed) await settleGetOf(db, id, { ok: false, code: 'crc', text: 'the copy arrived damaged' }, now);
    // Deleted or expired meanwhile: it stays so, and the board hears gone.
    return failed ? { ok: false, status: 409, code: 'crc' } : lost({ ok: false, status: 404, code: 'gone' });
  }
  const sha = await storeSendBytes(bytes);   // adf/<sha256> through diskStore: local folder or Vercel Blob (ruling P5)
  const done = await db.transaction(async (tx) => {
    // One name, one entry (R4): under the org lock, a path STASH: already holds is stored as its keep-both name.
    await lockOrg(tx, r.orgId);
    // A fetch answered Replace (P4): the FILE at exactly this path goes, so the arriving one takes its name.
    const [get] = await tx.select({ target: remoteRequests.target }).from(remoteRequests)
      .where(and(eq(remoteRequests.uploadId, id), eq(remoteRequests.kind, 'get')));
    if ((get?.target as GetTarget | undefined)?.replace) {
      await tx.update(amigaUploads).set({ status: 'deleted' }).where(and(eq(amigaUploads.orgId, r.orgId), ne(amigaUploads.id, id),
        eq(amigaUploads.kind, 'file'), eq(amigaUploads.status, 'stored'), sql`lower(${amigaUploads.path}) = lower(${r.path})`));
    }
    const others = (await listStash(tx, r.orgId, now)).filter((x) => x.id !== id && x.status !== 'failed');   // a failed stub holds no name: a retry of its path is stored as that path
    const path = uniqueStashPath(others, r.path);
    const hit = await tx.update(amigaUploads).set({ status: 'stored', crc32: crc >>> 0, blobSha256: sha, storedAt: sql`now()`, receivedBytes: r.sizeBytes,
      expiresAt: new Date(now.getTime() + UPLOAD_KEEP_MS), path, sentName: path === r.path ? null : r.path })
      .where(and(eq(amigaUploads.id, id), eq(amigaUploads.status, 'receiving'))).returning({ id: amigaUploads.id });
    if (hit.length) {
      await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id));
      await touchStashDirs(tx, r.orgId, path, now);
    }
    return hit.length > 0;
  });
  // Lost the update: another close stored it (ok, the same name) -- or a delete took it (gone, not ok).
  return done ? { ok: true, name: r.path } : lost({ ok: false, status: 404, code: 'gone' });
}

/** The get (if any) whose file upload `id` is, settled. */
async function settleGetOf(db: Db, id: string, outcome: Parameters<typeof settleGet>[2], now: Date): Promise<void> {
  const [g] = await db.select({ id: remoteRequests.id }).from(remoteRequests)
    .where(and(eq(remoteRequests.uploadId, id), eq(remoteRequests.kind, 'get'), liveGet()));
  if (g) await settleGet(db, g.id, outcome, now);
}

export async function getUpload(db: Db, orgId: string, id: string): Promise<UploadRow | null> {
  const [r] = await db.select().from(amigaUploads)
    .where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')));
  return r ?? null;
}

/** The blob of a row the person can still use: stored and not past its 30 days; else null. */
export function usableBlob(r: UploadRow, now = Date.now()): string | null {
  return r.status === 'stored' && r.blobSha256 && !(r.expiresAt && r.expiresAt.getTime() <= now) ? r.blobSha256 : null;
}

export async function setLibraryDisk(db: Db, orgId: string, id: string, diskId: string): Promise<void> {
  await db.update(amigaUploads).set({ libraryDiskId: diskId }).where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId)));
}

/** Per board, for the card's line (spec §4): files stored within the last 24 h. */
export async function uploadSummaries(db: Db, orgId: string, now = new Date()): Promise<Record<string, number>> {
  const rows = await db.select({ deviceId: amigaUploads.deviceId, n: sql<number>`count(*)::int` }).from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), eq(amigaUploads.status, 'stored'), ...FROM_AMIGA, gt(amigaUploads.storedAt, new Date(now.getTime() - 24 * 3600_000))))
    .groupBy(amigaUploads.deviceId);
  const out: Record<string, number> = {};
  for (const r of rows) if (r.deviceId) out[r.deviceId] = r.n;
  return out;
}

export type UploadBoard = { id: string; name: string; key: string | null; canUpload: boolean };
/** The org's boards for the filter, with the key digits Receive shows ("Trusted board AB12", spec §6). */
export async function uploadBoards(db: Db, orgId: string): Promise<UploadBoard[]> {
  const rows = await db.select({ id: devices.id, name: devices.name, upKey: devices.upKey, fw: devices.firmwareVersion })
    .from(devices).where(eq(devices.orgId, orgId)).orderBy(asc(devices.name), asc(devices.id));
  return rows.map((r) => ({ id: r.id, name: r.name, key: r.upKey ? r.upKey.toUpperCase() : null, canUpload: firmwareAtLeast(r.fw, UPLOAD_FW) }));
}

/**
 * The daily /api/cron/transfers pass (spec §4 housekeeping): a partial past its 24 h fails (expired) and drops its
 * chunks; a stored row past its 30 days goes, as do failed and deleted rows older than 30 days (plan addition: the
 * table does not grow for ever). The blobs go at the next weekly GC once nothing names them.
 */
export async function expireUploads(db: Db, now = new Date()): Promise<{ failed: number; deleted: number }> {
  return db.transaction(async (tx) => {
    const failed = await tx.update(amigaUploads).set({ status: 'failed', errorCode: 'expired' })
      .where(and(eq(amigaUploads.status, 'receiving'), lte(amigaUploads.expiresAt, now)))
      .returning({ id: amigaUploads.id });
    if (failed.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, failed.map((f) => f.id)));
    const old = new Date(now.getTime() - UPLOAD_KEEP_MS);
    const deleted = await tx.delete(amigaUploads)
      .where(or(and(eq(amigaUploads.status, 'stored'), lte(amigaUploads.expiresAt, now)),
        and(inArray(amigaUploads.status, ['failed', 'deleted']), lt(amigaUploads.createdAt, old))))
      .returning({ id: amigaUploads.id });
    return { failed: failed.length, deleted: deleted.length };
  });
}

/** Of `shas`, those a live upload or any transfer still names: never released by ingest (plan ruling P6). */
export async function blobRefsElsewhere(db: Db, shas: string[]): Promise<string[]> {
  if (shas.length === 0) return [];
  const [u, t] = await Promise.all([
    db.selectDistinct({ s: amigaUploads.blobSha256 }).from(amigaUploads)
      .where(and(inArray(amigaUploads.blobSha256, shas), ne(amigaUploads.status, 'deleted'))),
    db.selectDistinct({ s: transfers.blobSha256 }).from(transfers).where(inArray(transfers.blobSha256, shas)),
  ]);
  return [...new Set([...u, ...t].flatMap((r) => (r.s ? [r.s] : [])))];
}
