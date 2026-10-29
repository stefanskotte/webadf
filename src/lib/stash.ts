import { and, asc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { UPLOAD_AREA_MAX_BYTES, UPLOAD_AREA_MAX_FILES, UPLOAD_KEEP_MS } from '@/lib/amiga-upload-limits';
import { amigaDateText, dateOfAmigaText } from '@/lib/files/stash-paths';

// STASH: (Files spec 2026-10-29 §4.2): the org's loose-file store, built on amiga_uploads. Rows are files (kind 'file') and
// the folders that need a row of their own (kind 'dir': empty, made with Makedir, or given protection or a comment).

export type StashSource = 'amiga' | 'browser' | 'copy';
export type StashRow = {
  id: string; path: string; kind: 'file' | 'dir'; status: 'stored' | 'receiving' | 'failed';
  sizeBytes: number; receivedBytes: number; blobSha256: string | null; protection: number; comment: string;
  date: Date | null; source: StashSource; deviceName: string | null; errorCode: string | null;
  libraryDiskId: string | null; createdAt: Date;
};
export type NewStashEntry = { path: string; kind: 'file' | 'dir'; sha256: string | null; sizeBytes: number; date: Date | null; protection: number; comment: string };
export const STASH_FULL = 'STASH: holds 500 files / 256 MB; delete some first';

/** Thrown by moveStash for a subtree with a file still arriving from the Amiga (controller ruling 6). */
export class StashBusy extends Error {
  constructor() { super('still arriving from the Amiga'); }
}

type Reader = Pick<Db, 'select'>;

/** Live rows, oldest first (R5): stored and not past 30 days, receiving within 24 h, failed. */
export async function listStash(db: Reader, orgId: string, now = new Date()): Promise<StashRow[]> {
  const rows = await db.select().from(amigaUploads)
    .where(and(eq(amigaUploads.orgId, orgId), ne(amigaUploads.status, 'deleted'),
      or(and(inArray(amigaUploads.status, ['stored', 'receiving']), gt(amigaUploads.expiresAt, now)), eq(amigaUploads.status, 'failed'))))
    .orderBy(asc(amigaUploads.createdAt), asc(amigaUploads.id));
  return rows.map((r) => ({
    id: r.id, path: r.path, kind: r.kind === 'dir' ? 'dir' : 'file', status: r.status as StashRow['status'],
    sizeBytes: r.sizeBytes, receivedBytes: r.receivedBytes, blobSha256: r.blobSha256, protection: r.protection, comment: r.comment,
    date: dateOfAmigaText(r.amigaDate), source: (r.source === 'browser' || r.source === 'copy' ? r.source : 'amiga') as StashSource,
    deviceName: r.deviceName, errorCode: r.errorCode, libraryDiskId: r.libraryDiskId, createdAt: r.createdAt,
  }));
}

/** The org lock openUpload, closeUpload and insertStash take, so counts and name checks do not race. */
export function lockOrg(tx: Pick<Db, 'execute'>, orgId: string) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`amiga_uploads:${orgId}`}))`);
}

/** A file added under folders keeps their rows alive: each ancestor dir row is kept 30 days from now (ruling 16). */
export async function touchStashDirs(tx: Pick<Db, 'update'>, orgId: string, path: string, now: Date): Promise<void> {
  const segs = path.split('/').filter(Boolean);
  const parents: string[] = [];
  for (let k = 1; k < segs.length; k++) parents.push(segs.slice(0, k).join('/').toLowerCase());
  if (parents.length === 0) return;
  await tx.update(amigaUploads).set({ expiresAt: new Date(now.getTime() + UPLOAD_KEEP_MS) })
    .where(and(eq(amigaUploads.orgId, orgId), eq(amigaUploads.kind, 'dir'), eq(amigaUploads.status, 'stored'),
      inArray(sql`lower(${amigaUploads.path})`, parents)));
}

/** All or nothing under the org lock: `replaceIds` are deleted in the same transaction and not counted. */
export async function insertStash(db: Db, orgId: string, source: 'browser' | 'copy', entries: NewStashEntry[],
  opts: { replaceIds?: string[]; now?: Date } = {}): Promise<{ ok: true; ids: string[] } | { ok: false; code: 'stash_full' }> {
  const now = opts.now ?? new Date();
  const replace = opts.replaceIds ?? [];
  return db.transaction(async (tx) => {
    await lockOrg(tx, orgId);
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<string>`coalesce(sum(${amigaUploads.sizeBytes}),0)::bigint` })
      .from(amigaUploads)
      .where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.status, ['receiving', 'stored']), gt(amigaUploads.expiresAt, now),
        replace.length ? sql`${amigaUploads.id} not in (${sql.join(replace.map((i) => sql`${i}`), sql`, `)})` : undefined));
    const bytes = entries.reduce((a, e) => a + e.sizeBytes, 0);
    if (load.n + entries.length > UPLOAD_AREA_MAX_FILES || Number(load.b) + bytes > UPLOAD_AREA_MAX_BYTES) return { ok: false as const, code: 'stash_full' as const };
    if (replace.length) {
      await tx.update(amigaUploads).set({ status: 'deleted' }).where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.id, replace)));
      await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, replace));
    }
    const ids: string[] = [];
    for (const e of entries) {
      const id = crypto.randomUUID();
      ids.push(id);
      await tx.insert(amigaUploads).values({
        id, orgId, deviceId: null, deviceName: null, source, kind: e.kind, path: e.path, sizeBytes: e.sizeBytes, receivedBytes: e.sizeBytes,
        protection: e.protection >>> 0, comment: e.comment, amigaDate: amigaDateText(e.date ?? now), status: 'stored',
        blobSha256: e.sha256, storedAt: now,
        createdAt: sql`clock_timestamp()`,   // now() is the transaction's start: a batch must keep its order (oldest first)
        expiresAt: new Date(now.getTime() + UPLOAD_KEEP_MS),
      });
      if (e.kind === 'file') await touchStashDirs(tx, orgId, e.path, now);
    }
    return { ok: true as const, ids };
  });
}

/** Status deleted, chunks gone; receiving rows too (the board's next chunk or close hears gone). Returns how many rows went. */
export async function deleteStash(db: Db, orgId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return db.transaction(async (tx) => {
    const done = await tx.update(amigaUploads).set({ status: 'deleted' })
      .where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.id, ids), ne(amigaUploads.status, 'deleted')))
      .returning({ id: amigaUploads.id });
    if (done.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, done.map((d) => d.id)));
    return done.length;
  });
}

/** Renames or moves rows; refused whole (StashBusy) when any of them is still arriving from the Amiga (ruling 6). */
export async function moveStash(db: Db, orgId: string, moves: { id: string; path: string }[], now = new Date()): Promise<void> {
  if (moves.length === 0) return;
  await db.transaction(async (tx) => {
    await lockOrg(tx, orgId);
    const busy = await tx.select({ id: amigaUploads.id }).from(amigaUploads)
      .where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.id, moves.map((m) => m.id)), eq(amigaUploads.status, 'receiving'), gt(amigaUploads.expiresAt, now)));
    if (busy.length) throw new StashBusy();
    for (const m of moves) await tx.update(amigaUploads).set({ path: m.path, sentName: null }).where(and(eq(amigaUploads.id, m.id), eq(amigaUploads.orgId, orgId)));
  });
}

export async function setStashMeta(db: Db, orgId: string, ids: string[], meta: { protection?: number; comment?: string }): Promise<void> {
  const set: Partial<typeof amigaUploads.$inferInsert> = {};
  if (meta.protection !== undefined) set.protection = meta.protection >>> 0;
  if (meta.comment !== undefined) set.comment = meta.comment;
  if (ids.length === 0 || Object.keys(set).length === 0) return;
  await db.update(amigaUploads).set(set).where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.id, ids)));
}
