import { crc32 } from 'node:zlib';
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks } from '@/db/schema/catalog';
import { transfers } from '@/db/schema/transfers';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { cleanAmigaPath } from '@/lib/transfers';
import { storeSendBytes } from '@/lib/send-http';
import { firmwareAtLeast } from '@/lib/firmware-version';
import {
  UPLOAD_AREA_MAX_BYTES, UPLOAD_AREA_MAX_FILES, UPLOAD_CHUNK, UPLOAD_FILE_MAX, UPLOAD_FW, UPLOAD_KEEP_MS, UPLOAD_RESUME_MS,
} from '@/lib/amiga-upload-limits';

// Uploads from the Amiga (spec 2026-10-18 §4): the board's open / chunk / close, and the person's area.

export type UploadRow = typeof amigaUploads.$inferSelect;
const LIVE = ['receiving', 'stored'];

export type OpenInput = { size: number; date: string; protection: number; path: string; comment: string };
export type OpenResult = { ok: true; id: string; offset: number } | { ok: false; code: 'size' | 'full' | 'name' };

/** Resumes the same file from the same board (path, size, date) within 24 h, or opens a new one within the org's limits. */
export async function openUpload(db: Db, dev: { deviceId: string; orgId: string }, a: OpenInput, now = new Date()): Promise<OpenResult> {
  if (!Number.isSafeInteger(a.size) || a.size < 0 || a.size > UPLOAD_FILE_MAX) return { ok: false, code: 'size' };
  const path = cleanAmigaPath(a.path);
  if (!path) return { ok: false, code: 'name' };
  const comment = a.comment.replace(/[^\x20-\x7e\xa0-\xff]/g, '').slice(0, 79);
  return db.transaction(async (tx) => {
    // The count and the insert under one lock per org: READ COMMITTED alone lets two opens count the same rows (ruling P8).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`amiga_uploads:${dev.orgId}`}))`);
    const [same] = await tx.select({ id: amigaUploads.id, received: amigaUploads.receivedBytes }).from(amigaUploads)
      .where(and(eq(amigaUploads.orgId, dev.orgId), eq(amigaUploads.deviceId, dev.deviceId), eq(amigaUploads.status, 'receiving'), eq(amigaUploads.path, path),
        eq(amigaUploads.sizeBytes, a.size), eq(amigaUploads.amigaDate, a.date), gt(amigaUploads.expiresAt, now)))
      .orderBy(desc(amigaUploads.createdAt)).limit(1);
    if (same) return { ok: true as const, id: same.id, offset: same.received };
    // Only rows that still count (3bv I1): receiving within its 24 h, stored within its 30 days.
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<string>`coalesce(sum(${amigaUploads.sizeBytes}),0)::bigint` })
      .from(amigaUploads)
      .where(and(eq(amigaUploads.orgId, dev.orgId), inArray(amigaUploads.status, LIVE), gt(amigaUploads.expiresAt, now)));
    if (load.n + 1 > UPLOAD_AREA_MAX_FILES || Number(load.b) + a.size > UPLOAD_AREA_MAX_BYTES) {
      return { ok: false as const, code: 'full' as const };
    }
    const [d] = await tx.select({ name: devices.name }).from(devices).where(eq(devices.id, dev.deviceId));
    const id = crypto.randomUUID();
    await tx.insert(amigaUploads).values({ id, orgId: dev.orgId, deviceId: dev.deviceId, deviceName: d?.name ?? 'Board',
      path, sizeBytes: a.size, protection: a.protection >>> 0, comment, amigaDate: a.date,
      expiresAt: new Date(now.getTime() + UPLOAD_RESUME_MS) });
    return { ok: true as const, id, offset: 0 };
  });
}

export type ChunkResult = { ok: true; received: number } | { ok: false; status: 400 | 404 | 409; received?: number };

/** One chunk at `offset`: stored when it is the next one; a retry of a stored one changes nothing; a gap is 409. */
export async function storeChunk(db: Db, deviceId: string, id: string, offset: number, data: Uint8Array): Promise<ChunkResult> {
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
    if (r.status === 'stored') return { ok: true, name: r.path };
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
    // Deleted or expired meanwhile: it stays so, and the board hears gone.
    return failed ? { ok: false, status: 409, code: 'crc' } : lost({ ok: false, status: 404, code: 'gone' });
  }
  const sha = await storeSendBytes(bytes);   // adf/<sha256> through diskStore: local folder or Vercel Blob (ruling P5)
  const done = await db.transaction(async (tx) => {
    const hit = await tx.update(amigaUploads).set({ status: 'stored', crc32: crc >>> 0, blobSha256: sha, storedAt: now, receivedBytes: r.sizeBytes,
      expiresAt: new Date(now.getTime() + UPLOAD_KEEP_MS) })
      .where(and(eq(amigaUploads.id, id), eq(amigaUploads.status, 'receiving'))).returning({ id: amigaUploads.id });
    if (hit.length) await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id));
    return hit.length > 0;
  });
  // Lost the update: another close stored it (ok, the same name) -- or a delete took it (gone, not ok).
  return done ? { ok: true, name: r.path } : lost({ ok: false, status: 404, code: 'gone' });
}

export type UploadView = {
  id: string; path: string; sizeBytes: number; status: 'receiving' | 'stored' | 'failed'; receivedBytes: number;
  errorCode: string | null; deviceId: string | null; deviceName: string; createdAt: number; storedAt: number | null;
  expiresAt: number; libraryDiskId: string | null; libraryGameId: string | null;
  /** created_at as Postgres prints it, with microseconds: a Date is milliseconds and would round (ruling PF4). */
  cursor: string;
};
/** An exact position in the area (a created_at with microseconds) that Clear all compares without truncation. */
export type UploadCursor = string;
const CURSOR_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
/** Exactly `YYYY-MM-DDTHH:MM:SS.uuuuuuZ` (UTC) and a real instant: the only shape the SQL ever sees. */
export function isUploadCursor(s: unknown): s is UploadCursor {
  if (typeof s !== 'string' || !CURSOR_RE.test(s)) return false;
  const d = new Date(s.slice(0, 19) + 'Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === s.slice(0, 19);
}
export function toUploadView(r: UploadRow & { libraryGameId?: string | null; cursor: string }, now: number): UploadView {
  // A partial past its 24 h never moves again: it reads failed at once, as the daily cron will mark it.
  const lapsed = r.status === 'receiving' && r.expiresAt.getTime() <= now;
  return {
    id: r.id, path: r.path, sizeBytes: r.sizeBytes, status: lapsed ? 'failed' : (r.status as UploadView['status']),
    receivedBytes: r.receivedBytes, errorCode: lapsed ? 'expired' : r.errorCode, deviceId: r.deviceId, deviceName: r.deviceName,
    createdAt: r.createdAt.getTime(), storedAt: r.storedAt?.getTime() ?? null, expiresAt: r.expiresAt.getTime(),
    libraryDiskId: r.libraryDiskId, libraryGameId: r.libraryGameId ?? null, cursor: r.cursor,
  };
}

/** The org's area, newest first (the first row's `cursor` is what Clear all sends back); `board` filters it. A stored row past its 30 days is gone already for the person. */
export async function listUploads(db: Db, orgId: string, board: string | null, now = new Date()): Promise<UploadView[]> {
  const rows = await db.select({ u: amigaUploads, gameId: disks.gameId, cursor: sql<string>`to_char(${amigaUploads.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(amigaUploads)
    .leftJoin(disks, and(eq(disks.id, amigaUploads.libraryDiskId), eq(disks.orgId, orgId)))
    .where(and(eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted'),
      or(ne(amigaUploads.status, 'stored'), gt(amigaUploads.expiresAt, now)),
      board ? eq(amigaUploads.deviceId, board) : undefined))
    .orderBy(desc(amigaUploads.createdAt), desc(amigaUploads.id)).limit(UPLOAD_AREA_MAX_FILES);
  return rows.map((r) => toUploadView({ ...r.u, libraryGameId: r.gameId, cursor: r.cursor }, now.getTime()));
}

export async function getUpload(db: Db, orgId: string, id: string): Promise<UploadRow | null> {
  const [r] = await db.select().from(amigaUploads)
    .where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')));
  return r ?? null;
}

/** The blob of a row the person can still use: stored and not past its 30 days (the list hides those too); else null. */
export function usableBlob(r: UploadRow, now = Date.now()): string | null {
  return r.status === 'stored' && r.blobSha256 && !(r.expiresAt && r.expiresAt.getTime() <= now) ? r.blobSha256 : null;
}

/** Delete one file: the row reads deleted and its chunks go now; the blob goes at the next weekly GC if nothing else holds it. */
export async function deleteUpload(db: Db, orgId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(amigaUploads).set({ status: 'deleted' })
      .where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted')))
      .returning({ id: amigaUploads.id });
    if (done.length === 0) return false;
    await tx.delete(amigaUploadChunks).where(eq(amigaUploadChunks.uploadId, id));
    return true;
  });
}

/**
 * Clear all (spec §4, ruling PF4): every stored or failed row created at or before `cursor` (the newest row's
 * UploadView.cursor the person saw); a receiving row stays. The comparison is on the exact Postgres timestamp, so a
 * file that arrived in the same millisecond, after the person looked, survives. With `board`, only that board's rows
 * go (the cursor is then the newest row of the filtered list).
 */
export async function clearUploads(db: Db, orgId: string, cursor: UploadCursor, board: string | null = null): Promise<number> {
  if (!isUploadCursor(cursor)) throw new RangeError('clearUploads: not an upload cursor');
  return db.transaction(async (tx) => {
    const done = await tx.update(amigaUploads).set({ status: 'deleted' })
      .where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.status, ['stored', 'failed']), sql`${amigaUploads.createdAt} <= ${cursor}::timestamptz`,
        board ? eq(amigaUploads.deviceId, board) : undefined))
      .returning({ id: amigaUploads.id });
    if (done.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, done.map((d) => d.id)));
    return done.length;
  });
}

export async function setLibraryDisk(db: Db, orgId: string, id: string, diskId: string): Promise<void> {
  await db.update(amigaUploads).set({ libraryDiskId: diskId }).where(and(eq(amigaUploads.id, id), eq(amigaUploads.orgId, orgId)));
}

/** Per board, for the card's line (spec §4): files stored within the last 24 h. */
export async function uploadSummaries(db: Db, orgId: string, now = new Date()): Promise<Record<string, number>> {
  const rows = await db.select({ deviceId: amigaUploads.deviceId, n: sql<number>`count(*)::int` }).from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), eq(amigaUploads.status, 'stored'), gt(amigaUploads.storedAt, new Date(now.getTime() - 24 * 3600_000))))
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
