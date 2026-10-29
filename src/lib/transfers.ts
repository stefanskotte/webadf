import { crc32 } from 'node:zlib';
import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { diskStore } from '@/lib/storage';
import { mapLimit } from '@/lib/pool';
import type { Db } from '@/db';
import type { SendSummary } from '@/lib/send-ui';
import { XFER_FW, SEND_FILE_MAX, SEND_QUEUE_MAX_FILES, SEND_QUEUE_MAX_BYTES } from '@/lib/send-limits';

export { XFER_FW, SEND_FILE_MAX, SEND_QUEUE_MAX_FILES, SEND_QUEUE_MAX_BYTES };
export const SEND_QUEUE_BYTES = 6144;
export const SEND_CHUNK_MAX = 16_384;
export const SEND_EXPIRE_MS = 24 * 3600_000;
export const SEND_KEEP_FINISHED_MS = 7 * 24 * 3600_000;
export type TransferStatus = 'queued' | 'sending' | 'delivered' | 'failed' | 'cancelled' | 'expired';
const ACTIVE: TransferStatus[] = ['queued', 'sending'];

export const latin1Len = (s: string) => Buffer.byteLength(s, 'latin1');

/** An Amiga-safe relative path (spec §2): Latin-1, parts of 1..30 bytes, no ':' '.' '..', at most 255 bytes. */
export function cleanAmigaPath(input: string): string | null {
  const parts: string[] = [];
  for (const raw of input.split('/')) {
    let p = '';
    for (const ch of raw) {
      const c = ch.codePointAt(0)!;
      if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) continue;
      p += ch === ':' ? '_' : c > 0xff ? '_' : ch;
    }
    if (p === '' || p === '.' || p === '..') continue;
    if (p.length > 30) {
      const dot = p.lastIndexOf('.');
      const ext = dot > 0 && p.length - dot <= 9 ? p.slice(dot) : '';
      p = p.slice(0, 30 - ext.length) + ext;
    }
    parts.push(p);
  }
  const out = parts.join('/');
  return out.length >= 1 && out.length <= 255 ? out : null;
}

export type QueueRow = { id: string; sizeBytes: number; crc32: number; protection: number; path: string; comment: string };

export function formatQueue(next: QueueRow | null, rows: QueueRow[]): string {
  const head = next
    ? `NEXT ${next.id} ${next.sizeBytes} ${next.crc32.toString(16)} ${next.protection.toString(16)} ` +
      `${latin1Len(next.path)}:${next.path} ${latin1Len(next.comment)}:${next.comment}\n`
    : 'NEXT -\n';
  const lines = rows.map((r) => `${r.id} ${r.sizeBytes} ${latin1Len(r.path)}:${r.path}\n`);
  for (let n = lines.length; n >= 0; n--) {
    const t = head + `LIST ${n}\n` + lines.slice(0, n).join('');
    if (latin1Len(t) <= SEND_QUEUE_BYTES) return t;
  }
  return head + 'LIST 0\n';
}

export type QueueResult = { ok: true; id: string } | { ok: false; reason: 'bad_name' | 'too_large' | 'queue_full' | 'no_device' | 'no_blob' };

/** A comment as Transfer can show it: Latin-1 printable, at most 79 characters. */
const cleanComment = (c: string) => c.replace(/[^\x20-\x7e\xa0-\xff]/g, '').slice(0, 79);

export async function queueTransferFromBlob(db: Db, a: { orgId: string; deviceId: string; userId: string; path: string;
  sha256: string; protection?: number; comment?: string; bytes?: Uint8Array; now?: Date }): Promise<QueueResult> {
  const path = cleanAmigaPath(a.path);
  if (!path) return { ok: false, reason: 'bad_name' };
  const [dev] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, a.deviceId), eq(devices.orgId, a.orgId)));
  if (!dev) return { ok: false, reason: 'no_device' };
  const st = await diskStore.stat(a.sha256);
  if (!st) return { ok: false, reason: 'no_blob' };
  if (st.sizeBytes > SEND_FILE_MAX) return { ok: false, reason: 'too_large' };
  // The upload route already holds the bytes; reading 4 MB back from the store would only cost time.
  const bytes = a.bytes && a.bytes.byteLength === st.sizeBytes ? a.bytes : await diskStore.read(a.sha256);
  const crc = crc32(bytes) >>> 0;
  const now = a.now ?? new Date();
  const comment = cleanComment(a.comment ?? '');
  return db.transaction(async (tx) => {
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<number>`coalesce(sum(${transfers.sizeBytes}),0)::bigint` })
      .from(transfers).where(and(eq(transfers.deviceId, a.deviceId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)));
    if (load.n + 1 > SEND_QUEUE_MAX_FILES || Number(load.b) + st.sizeBytes > SEND_QUEUE_MAX_BYTES)
      return { ok: false as const, reason: 'queue_full' as const };
    const id = crypto.randomUUID();
    await tx.insert(transfers).values({ id, orgId: a.orgId, deviceId: a.deviceId, createdByUserId: a.userId, path,
      sizeBytes: st.sizeBytes, crc32: crc, protection: (a.protection ?? 0) >>> 0, comment, blobSha256: a.sha256,
      expiresAt: new Date(now.getTime() + SEND_EXPIRE_MS) });
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, a.deviceId));
    return { ok: true as const, id };
  });
}

export type QueueFile = { path: string; sha256: string; sizeBytes: number; protection: number; comment: string; bytes?: Uint8Array };
export type QueueManyResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: 'bad_name' | 'too_large' | 'queue_full' | 'no_device' | 'no_blob' | 'empty'; path?: string };

/**
 * A copy into NET:/<board> (Files increment 3, R3): every file or none. Each is checked first (a path that cleans,
 * bytes in the store, 1 byte to 4 MB each, sizes from the store, not the caller), then ONE transaction counts the
 * board's load as queueTransferFromBlob does, refuses `queue_full` past 32 files / 16 MB, inserts every row and bumps
 * the board's cursor once. Rows are a millisecond apart in the order given, which is the order the board takes them.
 */
export async function queueTransfers(db: Db, a: { orgId: string; deviceId: string; userId: string; files: QueueFile[]; now?: Date }):
  Promise<QueueManyResult> {
  const [dev] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, a.deviceId), eq(devices.orgId, a.orgId)));
  if (!dev) return { ok: false, reason: 'no_device' };
  if (a.files.length === 0) return { ok: true, ids: [] };
  // More files than any board's queue holds: refused before a single store call.
  if (a.files.length > SEND_QUEUE_MAX_FILES) return { ok: false, reason: 'queue_full' };
  const paths = a.files.map((f) => cleanAmigaPath(f.path));
  const bad = paths.findIndex((p) => !p);
  if (bad >= 0) return { ok: false, reason: 'bad_name', path: a.files[bad].path };
  const stats = await mapLimit(a.files, 12, (f) => diskStore.stat(f.sha256));
  const checked: { path: string; size: number; f: QueueFile }[] = [];
  for (const [k, f] of a.files.entries()) {
    const st = stats[k];
    if (!st) return { ok: false, reason: 'no_blob', path: f.path };
    if (st.sizeBytes > SEND_FILE_MAX) return { ok: false, reason: 'too_large', path: f.path };
    if (st.sizeBytes === 0) return { ok: false, reason: 'empty', path: f.path };
    checked.push({ path: paths[k]!, size: st.sizeBytes, f });
  }
  // Read before the transaction: up to 16 MB of store reads must not hold it open.
  const crcs = await mapLimit(checked, 12, async (c) =>
    crc32(c.f.bytes && c.f.bytes.byteLength === c.size ? c.f.bytes : await diskStore.read(c.f.sha256)) >>> 0);
  const now = a.now ?? new Date();
  const bytes = checked.reduce((n, c) => n + c.size, 0);
  return db.transaction(async (tx) => {
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<number>`coalesce(sum(${transfers.sizeBytes}),0)::bigint` })
      .from(transfers).where(and(eq(transfers.deviceId, a.deviceId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)));
    if (load.n + checked.length > SEND_QUEUE_MAX_FILES || Number(load.b) + bytes > SEND_QUEUE_MAX_BYTES)
      return { ok: false as const, reason: 'queue_full' as const };
    const rows = checked.map((c, k) => ({ id: crypto.randomUUID(), orgId: a.orgId, deviceId: a.deviceId, createdByUserId: a.userId,
      path: c.path, sizeBytes: c.size, crc32: crcs[k], protection: c.f.protection >>> 0, comment: cleanComment(c.f.comment),
      blobSha256: c.f.sha256, createdAt: new Date(now.getTime() + k), expiresAt: new Date(now.getTime() + SEND_EXPIRE_MS) }));
    await tx.insert(transfers).values(rows);
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, a.deviceId));
    return { ok: true as const, ids: rows.map((r) => r.id) };
  });
}

export async function sendQueueText(db: Db, deviceId: string, now = new Date()): Promise<string> {
  const rows = await db.select({ id: transfers.id, sizeBytes: transfers.sizeBytes, crc32: transfers.crc32,
    protection: transfers.protection, path: transfers.path, comment: transfers.comment })
    .from(transfers)
    .where(and(eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)))
    .orderBy(asc(transfers.createdAt), asc(transfers.id));
  return formatQueue(rows[0] ?? null, rows);
}

export async function recordChunk(db: Db, deviceId: string, id: string, offset: number):
  Promise<{ ok: true; sha256: string; sizeBytes: number } | { ok: false; status: 400 | 404 | 409 }> {
  // One conditional update, never a read then a write: a cancel that lands between the two must not be turned back
  // into 'sending' (review finding). The offset is checked in the same statement, before the row is marked.
  const [u] = await db.update(transfers).set({ status: 'sending', bytesSent: offset })
    .where(and(eq(transfers.id, id), eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE),
      gt(transfers.sizeBytes, offset)))
    .returning({ sha: transfers.blobSha256, size: transfers.sizeBytes });
  if (u) {
    // A board fetching a chunk is provably talking to Receive, and while a file moves it skips its server polls (one HTTPS
    // connection, used for chunks), so the poll's rx report goes stale mid-file and the page reads "Receive is not running".
    // Refresh it here, throttled like the poll (recordSendRx writes on a change or after 30 s, not once per chunk).
    await recordSendRx(db, deviceId, 'c');
    return { ok: true, sha256: u.sha, sizeBytes: u.size };
  }
  const [r] = await db.select({ status: transfers.status }).from(transfers)
    .where(and(eq(transfers.id, id), eq(transfers.deviceId, deviceId)));
  if (!r) return { ok: false, status: 404 };
  return { ok: false, status: ACTIVE.includes(r.status as TransferStatus) ? 400 : 409 };
}

export type SendOutcome = { ok: true; savedAs: string } | { ok: false; code: string; text: string };

export async function finishTransfer(db: Db, deviceId: string, id: string, o: SendOutcome, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(transfers).set(o.ok
      ? { status: 'delivered', savedAs: o.savedAs.slice(0, 255), finishedAt: now }
      : { status: 'failed', errorCode: o.code.slice(0, 16), errorText: o.text.slice(0, 120), finishedAt: now })
      .where(and(eq(transfers.id, id), eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE)))
      .returning({ id: transfers.id });
    if (done.length === 0) return false;
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, deviceId));
    return true;
  });
}

export async function cancelTransfer(db: Db, orgId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx.update(transfers).set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(transfers.id, id), eq(transfers.orgId, orgId), inArray(transfers.status, ACTIVE)))
      .returning({ deviceId: transfers.deviceId });
    if (done.length === 0) return false;
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, done[0].deviceId));
    return true;
  });
}

export async function expireTransfers(db: Db, now = new Date()): Promise<{ expired: number; deleted: number }> {
  return db.transaction(async (tx) => {
    // queued AND sending: a row whose board vanished mid-file would otherwise stay 'sending' for ever, hidden from the
    // queue yet counted against the board's limits and keeping its blob (review finding).
    const ex = await tx.update(transfers).set({ status: 'expired', finishedAt: now })
      .where(and(inArray(transfers.status, ACTIVE), lt(transfers.expiresAt, now)))
      .returning({ deviceId: transfers.deviceId });
    const devs = [...new Set(ex.map((e) => e.deviceId))];
    if (devs.length) await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(inArray(devices.id, devs));
    const del = await tx.delete(transfers)
      .where(lt(transfers.finishedAt, new Date(now.getTime() - SEND_KEEP_FINISHED_MS))).returning({ id: transfers.id });
    return { expired: ex.length, deleted: del.length };
  });
}

export async function recordSendRx(db: Db, deviceId: string, rx: 'c' | 'r' | 'u' | '-', now = new Date()): Promise<void> {
  await db.update(devices).set({ sendRx: rx, sendRxAt: now }).where(and(eq(devices.id, deviceId),
    sql`(${devices.sendRx} is distinct from ${rx} or ${devices.sendRxAt} is null or ${devices.sendRxAt} < ${new Date(now.getTime() - 30_000)})`));
}

/** What still counts against the board's limits: active rows not past their expiry (a lapsed row never moves again). */
export async function queueLoad(db: Db, deviceId: string, now = new Date()): Promise<{ files: number; bytes: number }> {
  const [l] = await db.select({ n: sql<number>`count(*)::int`, b: sql<string>`coalesce(sum(${transfers.sizeBytes}),0)::bigint` })
    .from(transfers).where(and(eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)));
  return { files: l.n, bytes: Number(l.b) };
}

export type TransferRow = typeof transfers.$inferSelect;

/** The board's rows for NET:/<board> (and GET /api/transfers): this org's only, newest first (finished rows live 7 days). */
export async function listTransfers(db: Db, orgId: string, deviceId: string, limit = 100): Promise<TransferRow[]> {
  return db.select().from(transfers)
    .where(and(eq(transfers.orgId, orgId), eq(transfers.deviceId, deviceId)))
    .orderBy(desc(transfers.createdAt), desc(transfers.id)).limit(limit);
}

/**
 * "Clear finished" on the Upload page: deletes this org's finished rows for the board (delivered, failed, cancelled,
 * expired) and the queued or sending rows past their expiry, which the page already shows as expired (toView's
 * "lapsed"). A live waiting or sending row is never touched. No cursor bump: sendQueueText lists only active rows not
 * past their expiry, so the board's queue text is the same before and after.
 */
export async function clearFinishedTransfers(db: Db, orgId: string, deviceId: string, now = new Date()): Promise<number> {
  const del = await db.delete(transfers)
    .where(and(eq(transfers.orgId, orgId), eq(transfers.deviceId, deviceId),
      or(inArray(transfers.status, ['delivered', 'failed', 'cancelled', 'expired']),
        and(inArray(transfers.status, ACTIVE), lte(transfers.expiresAt, now)))))
    .returning({ id: transfers.id });
  return del.length;
}

/**
 * Delete in NET: (Files increment 3, R4) on one finished row: the WHERE of clearFinishedTransfers for one row of the
 * org. False when it is waiting or sending (not past its expiry), missing, or another org's. No cursor bump, as there.
 */
export async function clearTransfer(db: Db, orgId: string, id: string, now = new Date()): Promise<boolean> {
  const del = await db.delete(transfers)
    .where(and(eq(transfers.id, id), eq(transfers.orgId, orgId),
      or(inArray(transfers.status, ['delivered', 'failed', 'cancelled', 'expired']),
        and(inArray(transfers.status, ACTIVE), lte(transfers.expiresAt, now)))))
    .returning({ id: transfers.id });
  return del.length > 0;
}

/** Per board, for the card's line (spec §4; R11): what waits or moves, and what finished in the last 24 h. */
export async function sendSummaries(db: Db, orgId: string, now = new Date()): Promise<Record<string, SendSummary>> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  // A queued or sending row past expires_at is "expired" on the queue page before the daily cron marks it; count it
  // as failed here too (only within the last 24 h, like the finished rows) so the card agrees with the page.
  const lapsed = and(inArray(transfers.status, ACTIVE), lte(transfers.expiresAt, now), gt(transfers.expiresAt, since));
  const rows = await db.select({ deviceId: transfers.deviceId, status: transfers.status, lapsed: sql<boolean>`${lapsed}`, n: sql<number>`count(*)::int` })
    .from(transfers)
    .where(and(eq(transfers.orgId, orgId),
      or(and(inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)), lapsed, gt(transfers.finishedAt, since))))
    .groupBy(sql`1, 2, 3`);   // by position: the lapsed flag's bind parameters differ between select and group by
  const out: Record<string, SendSummary> = {};
  for (const r of rows) {
    const s = (out[r.deviceId] ??= { waiting: 0, sending: 0, delivered: 0, failed: 0 });
    if (r.lapsed) s.failed += r.n;
    else if (r.status === 'queued') s.waiting += r.n;
    else if (r.status === 'sending') s.sending += r.n;
    else if (r.status === 'delivered') s.delivered += r.n;
    else if (r.status === 'failed' || r.status === 'expired') s.failed += r.n;
  }
  return out;
}
