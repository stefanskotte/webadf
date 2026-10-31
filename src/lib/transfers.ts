import { crc32 } from 'node:zlib';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { amigaNameProblem } from '@/lib/files/path';
import { WRITE_KINDS } from '@/lib/remote-limits';
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
/** `skipped`: a copy onto a volume whose name was there, answered Skip by Transfer (spec 2026-10-31 §2.2): not a failure. */
export type TransferStatus = 'queued' | 'sending' | 'delivered' | 'failed' | 'cancelled' | 'expired' | 'skipped';
/** The rows that finished: kept 7 days, cleared by Clear finished. */
const FINISHED: TransferStatus[] = ['delivered', 'failed', 'cancelled', 'expired', 'skipped'];
/** What the web app says when Transfer's writing switch is off (spec 2026-10-31 §4.1, §4.2). */
export const WRITING_OFF = 'Writing is off in Transfer';
const ACTIVE: TransferStatus[] = ['queued', 'sending'];

export const latin1Len = (s: string) => Buffer.byteLength(s, 'latin1');

/**
 * An Amiga-safe relative path (spec §2): Latin-1, parts of 1..30 bytes, no ':' '.' '..', at most 255 bytes. A ':' is
 * turned into '_' and must stay so: firmware 1.23 reads a NEXT path holding ':' as absolute (a copy onto a volume, NET:
 * volumes phase 2), so an ordinary Queue row must never carry one (coordinator ruling 2026-10-31).
 */
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

/**
 * An absolute Amiga path for a copy onto a volume (spec 2026-10-31 §2.2): a volume or device name, a colon, then one
 * or more parts, each a name AmigaDOS takes (amigaNameProblem: 1-30 characters, Latin-1, no ':' '/', not '.' '..').
 * Checked, never cleaned: the person picked the place. At most 255 characters. Null when it is not one.
 */
export function cleanAmigaDest(dest: string): string | null {
  const c = dest.indexOf(':');
  if (c < 1 || dest.length > 255) return null;
  const volume = dest.slice(0, c);
  const parts = dest.slice(c + 1).split('/');
  if (amigaNameProblem(volume) !== null || parts.some((x) => amigaNameProblem(x) !== null)) return null;
  return dest;
}

export type ClashMode = 'keep' | 'replace' | 'skip';
/**
 * `dest`/`onClash` (NET: volumes phase 2, spec 2026-10-31 §2.2, plan W1): a copy onto a volume. Its NEXT line is the
 * extended FILE the board relays ("FILE " + everything after "NEXT "): the absolute path, the comment, the clash mode.
 */
export type QueueRow = { id: string; sizeBytes: number; crc32: number; protection: number; path: string; comment: string;
  dest?: string | null; onClash?: ClashMode | null };

export function formatQueue(next: QueueRow | null, rows: QueueRow[]): string {
  const where = (r: QueueRow) => r.dest ?? r.path;
  const head = next
    ? `NEXT ${next.id} ${next.sizeBytes} ${next.crc32.toString(16)} ${next.protection.toString(16)} ` +
      `${latin1Len(where(next))}:${where(next)} ${latin1Len(next.comment)}:${next.comment}${next.dest ? ` ${next.onClash ?? 'keep'}` : ''}\n`
    : 'NEXT -\n';
  const lines = rows.map((r) => `${r.id} ${r.sizeBytes} ${latin1Len(where(r))}:${where(r)}\n`);
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

/**
 * `dest`, `onClash` (NET: volumes phase 2): a copy onto a volume -- the absolute Amiga path and the clash mode; the
 * row's `path` is then the file's name (what the Upload page shows). `moveSource`: the Files path a move removes once
 * every row of the job naming it is delivered (plan W7); `moveItem` the entry of it this row copies (`Pack/sub/x`, spec
 * 2026-10-31 §9), so the move removes exactly that.
 */
export type QueueFile = { path: string; sha256: string; sizeBytes: number; protection: number; comment: string; bytes?: Uint8Array;
  dest?: string; onClash?: ClashMode; moveSource?: string; moveItem?: string };
export type QueueManyResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: 'bad_name' | 'too_large' | 'queue_full' | 'no_device' | 'no_blob' | 'empty'; path?: string };

/**
 * A copy into NET:/<board> (Files increment 3, R3): every file or none. Each is checked first (a path that cleans,
 * bytes in the store, 1 byte to 4 MB each, sizes from the store, not the caller), then ONE transaction counts the
 * board's load as queueTransferFromBlob does, refuses `queue_full` past 32 files / 16 MB, inserts every row and bumps
 * the board's cursor once. Rows are a millisecond apart in the order given, which is the order the board takes them.
 */
export async function queueTransfers(db: Db, a: { orgId: string; deviceId: string; userId: string; files: QueueFile[]; now?: Date;
  /** The Files operation the rows belong to (plan W6): its progress reads them by it. */
  jobId?: string }):
  Promise<QueueManyResult> {
  const [dev] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, a.deviceId), eq(devices.orgId, a.orgId)));
  if (!dev) return { ok: false, reason: 'no_device' };
  if (a.files.length === 0) return { ok: true, ids: [] };
  // More files than any board's queue holds: refused before a single store call.
  if (a.files.length > SEND_QUEUE_MAX_FILES) return { ok: false, reason: 'queue_full' };
  const paths = a.files.map((f) => (f.dest === undefined ? cleanAmigaPath(f.path)
    : cleanAmigaDest(f.dest) && cleanAmigaPath(f.dest.slice(Math.max(f.dest.lastIndexOf('/'), f.dest.indexOf(':')) + 1))));
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
      blobSha256: c.f.sha256, createdAt: new Date(now.getTime() + k), expiresAt: new Date(now.getTime() + SEND_EXPIRE_MS),
      amigaDest: c.f.dest ?? null, onClash: c.f.dest !== undefined ? c.f.onClash ?? 'keep' : null, jobId: a.jobId ?? null,
      moveSource: c.f.moveSource ?? null, moveItem: c.f.moveItem ?? null }));
    await tx.insert(transfers).values(rows);
    await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, a.deviceId));
    return { ok: true as const, ids: rows.map((r) => r.id) };
  });
}

/** Whether a board's last report lets it write to its Amiga's disks (plan W2): Transfer 2.5's READY 4 with both switches on. */
export const boardWrites = (d: { rxProto: number | null; browseOn: boolean; writeOn: boolean }) => (d.rxProto ?? 0) >= 4 && d.browseOn && d.writeOn;

/**
 * The board's queue text. A copy onto a volume (`amiga_dest`) is in it only while the board can write (spec 2026-10-31
 * §3: a 1.22 board, an old Transfer or the switch off never sees one); it waits meanwhile, and the queue goes on.
 */
export async function sendQueueText(db: Db, deviceId: string, now = new Date()): Promise<string> {
  const [d] = await db.select({ rxProto: devices.rxProto, browseOn: devices.browseOn, writeOn: devices.writeOn }).from(devices).where(eq(devices.id, deviceId));
  const rows = await db.select({ id: transfers.id, sizeBytes: transfers.sizeBytes, crc32: transfers.crc32,
    protection: transfers.protection, path: transfers.path, comment: transfers.comment, dest: transfers.amigaDest, onClash: transfers.onClash })
    .from(transfers)
    .where(and(eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now),
      ...(d && boardWrites(d) ? [] : [isNull(transfers.amigaDest)])))
    .orderBy(asc(transfers.createdAt), asc(transfers.id));
  const queue = rows.map((r) => ({ ...r, onClash: r.onClash as ClashMode | null }));
  return formatQueue(queue[0] ?? null, queue);
}

/**
 * Transfer is connected but cannot write (spec 2026-10-31 §5.7; plan W3): what waits to be written fails `readonly`
 * -- the copies onto a volume still queued or sending, and the write requests not yet taken -- so nothing hangs.
 */
export async function failWritesWhenOff(db: Db, deviceId: string, now = new Date()): Promise<{ rows: number; requests: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx.update(transfers).set({ status: 'failed', errorCode: 'readonly', errorText: WRITING_OFF, finishedAt: now })
      .where(and(eq(transfers.deviceId, deviceId), inArray(transfers.status, ACTIVE), isNotNull(transfers.amigaDest)))
      .returning({ id: transfers.id });
    if (rows.length) await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` }).where(eq(devices.id, deviceId));
    const reqs = await tx.update(remoteRequests).set({ status: 'failed', errorCode: 'readonly', errorText: WRITING_OFF, answeredAt: now })
      .where(and(eq(remoteRequests.deviceId, deviceId), eq(remoteRequests.status, 'waiting'), inArray(remoteRequests.kind, [...WRITE_KINDS])))
      .returning({ id: remoteRequests.id });
    return { rows: rows.length, requests: reqs.length };
  });
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
    // Transfer's SKIP (a copy onto a volume whose name was there, mode skip) is reported as code `skipped`: not a failure.
    const done = await tx.update(transfers).set(o.ok
      ? { status: 'delivered', savedAs: o.savedAs.slice(0, 255), finishedAt: now }
      : o.code === 'skipped' ? { status: 'skipped', finishedAt: now }
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

/**
 * `cap` (NET: volumes): Transfer's protocol, browse and write flags from the poll's rxv/browse/write; a change counts
 * like a new rx. Writing is on only for protocol 4 with both switches (plan W2). A receiver state other than connected
 * clears browse and write (Transfer is gone; spec 2026-10-31 §4.3).
 */
export async function recordSendRx(
  db: Db, deviceId: string, rx: 'c' | 'r' | 'u' | '-', now = new Date(), cap?: { proto: number; browse: boolean; write?: boolean },
): Promise<void> {
  const flags: { rxProto?: number; browseOn: boolean; writeOn: boolean } | null = cap
    ? { rxProto: cap.proto, browseOn: cap.browse, writeOn: cap.proto >= 4 && cap.browse && cap.write === true }
    : rx !== 'c' ? { browseOn: false, writeOn: false } : null;
  const capChanged = flags
    ? sql` or ${devices.browseOn} is distinct from ${flags.browseOn} or ${devices.writeOn} is distinct from ${flags.writeOn}${
      flags.rxProto !== undefined ? sql` or ${devices.rxProto} is distinct from ${flags.rxProto}` : sql``}`
    : sql``;
  await db.update(devices).set({ sendRx: rx, sendRxAt: now, ...(flags ?? {}) })
    .where(and(eq(devices.id, deviceId),
      sql`(${devices.sendRx} is distinct from ${rx} or ${devices.sendRxAt} is null or ${devices.sendRxAt} < ${new Date(now.getTime() - 30_000)}${capChanged})`));
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
      or(inArray(transfers.status, FINISHED),
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
      or(inArray(transfers.status, FINISHED),
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
