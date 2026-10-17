import { crc32 } from 'node:zlib';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { diskStore } from '@/lib/storage';
import type { Db } from '@/db';
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

export async function queueTransferFromBlob(db: Db, a: { orgId: string; deviceId: string; userId: string; path: string;
  sha256: string; protection?: number; comment?: string; now?: Date }): Promise<QueueResult> {
  const path = cleanAmigaPath(a.path);
  if (!path) return { ok: false, reason: 'bad_name' };
  const [dev] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, a.deviceId), eq(devices.orgId, a.orgId)));
  if (!dev) return { ok: false, reason: 'no_device' };
  const st = await diskStore.stat(a.sha256);
  if (!st) return { ok: false, reason: 'no_blob' };
  if (st.sizeBytes > SEND_FILE_MAX) return { ok: false, reason: 'too_large' };
  const bytes = await diskStore.read(a.sha256);
  const crc = crc32(bytes) >>> 0;
  const now = a.now ?? new Date();
  const comment = (a.comment ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '').slice(0, 79);
  return db.transaction(async (tx) => {
    const [load] = await tx.select({ n: sql<number>`count(*)::int`, b: sql<number>`coalesce(sum(${transfers.sizeBytes}),0)::bigint` })
      .from(transfers).where(and(eq(transfers.deviceId, a.deviceId), inArray(transfers.status, ACTIVE)));
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
  if (u) return { ok: true, sha256: u.sha, sizeBytes: u.size };
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
