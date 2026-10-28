import { and, asc, desc, eq, inArray, lte, or } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { disks, games } from '@/db/schema/catalog';
import { transfers } from '@/db/schema/transfers';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { toView } from '@/lib/send-http';
import { failureText } from '@/lib/send-ui';
import { listUploads } from '@/lib/amiga-uploads';
import { isLocal } from '@/lib/remote-hidden';
import { libraryEligible, uploadFailureText } from '@/lib/from-amiga-ui';
import type { ServerRow } from '@/lib/upload-staging';

// The server half of the Upload staging list (spec 2026-10-23 §3.1-3.2): sends and Amiga files of every board, and clear by row key.

const pctOf = (done: number, size: number) => (size > 0 ? Math.min(99, Math.floor((done * 100) / size)) : 0);

/** The org's newest 200 sends and its Amiga files, merged, newest first. */
export async function listStaging(db: Db, orgId: string, now = new Date()): Promise<ServerRow[]> {
  const t = now.getTime();
  const [sends, uploads] = await Promise.all([
    db.select({ t: transfers, boardName: devices.name }).from(transfers)
      .innerJoin(devices, eq(devices.id, transfers.deviceId))
      .where(eq(transfers.orgId, orgId))
      .orderBy(desc(transfers.createdAt), desc(transfers.id)).limit(200),
    listUploads(db, orgId, null, now),
  ]);

  const diskIds = [...new Set(uploads.flatMap((u) => (u.status === 'stored' && u.libraryDiskId ? [u.libraryDiskId] : [])))];
  const shas = [...new Set(uploads.flatMap((u) => (u.status === 'stored' && u.blobSha256 ? [u.blobSha256] : [])))];
  const found = diskIds.length || shas.length
    ? await db.select({ id: disks.id, sha256: disks.sha256, gameId: disks.gameId, title: games.title }).from(disks)
      .innerJoin(games, eq(games.id, disks.gameId))
      // "In library" names a local disk only, never a hidden remote stand-in with the same bytes (spec §4.1).
      .where(and(eq(disks.orgId, orgId), isLocal(disks), or(
        diskIds.length ? inArray(disks.id, diskIds) : undefined,
        shas.length ? inArray(disks.sha256, shas) : undefined)))
      .orderBy(asc(disks.id))
    : [];
  const byId = new Map(found.map((d) => [d.id, d]));
  const bySha = new Map<string, (typeof found)[number]>();
  for (const d of found) if (!bySha.has(d.sha256)) bySha.set(d.sha256, d);   // lowest id wins: disks has no created_at

  const out: ServerRow[] = [];
  for (const r of sends) {
    const v = toView(r.t, t);
    out.push({
      source: 'server', key: `send:${v.id}`, kind: 'out', id: v.id, name: v.path, sizeBytes: v.sizeBytes,
      board: { id: r.t.deviceId, name: r.boardName }, status: v.status, doneBytes: v.bytesSent,
      pct: v.status === 'sending' ? pctOf(v.bytesSent, v.sizeBytes) : null,
      savedAs: v.status === 'delivered' ? v.savedAs : null,
      error: v.status === 'failed' ? failureText(v.errorCode, v.errorText) : null,
      isDiskImage: false, title: null, at: v.createdAt,
    });
  }
  for (const u of uploads) {
    let title: ServerRow['title'] = null;
    if (u.status === 'stored') {
      const d = (u.libraryDiskId ? byId.get(u.libraryDiskId) : undefined) ?? (u.blobSha256 ? bySha.get(u.blobSha256) : undefined);
      if (d) title = { gameId: d.gameId, title: d.title };
    }
    out.push({
      source: 'server', key: `amiga:${u.id}`, kind: 'in', id: u.id, name: u.path, sizeBytes: u.sizeBytes,
      board: { id: u.deviceId, name: u.deviceName }, status: u.status, doneBytes: u.receivedBytes,
      pct: u.status === 'receiving' ? pctOf(u.receivedBytes, u.sizeBytes) : null,
      savedAs: null, error: u.status === 'failed' ? uploadFailureText(u.errorCode) : null,
      isDiskImage: libraryEligible(u.path, u.sizeBytes), title, at: u.createdAt,
    });
  }
  return out.sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

const idsWith = (keys: string[], prefix: string) => [...new Set(keys.flatMap((k) => (k.startsWith(prefix) && k.length > prefix.length ? [k.slice(prefix.length)] : [])))];

/** Removes the finished rows among `keys` (a row that moved on since the person looked stays); returns how many went. */
export async function clearStaging(db: Db, orgId: string, keys: string[], now = new Date()): Promise<number> {
  const sendIds = idsWith(keys, 'send:');
  const upIds = idsWith(keys, 'amiga:');
  if (!sendIds.length && !upIds.length) return 0;
  return db.transaction(async (tx) => {
    let n = 0;
    if (sendIds.length) {
      const gone = await tx.delete(transfers).where(and(eq(transfers.orgId, orgId), inArray(transfers.id, sendIds), or(
        inArray(transfers.status, ['delivered', 'failed', 'cancelled', 'expired']),
        and(inArray(transfers.status, ['queued', 'sending']), lte(transfers.expiresAt, now)))))
        .returning({ id: transfers.id });
      n += gone.length;
    }
    if (upIds.length) {
      const done = await tx.update(amigaUploads).set({ status: 'deleted' }).where(and(eq(amigaUploads.orgId, orgId), inArray(amigaUploads.id, upIds), or(
        eq(amigaUploads.status, 'failed'),
        and(eq(amigaUploads.status, 'receiving'), lte(amigaUploads.expiresAt, now)))))
        .returning({ id: amigaUploads.id });
      if (done.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, done.map((d) => d.id)));
      n += done.length;
    }
    return n;
  });
}
