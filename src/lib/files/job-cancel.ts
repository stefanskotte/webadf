// src/lib/files/job-cancel.ts
// Cancel the rest (spec 2026-11-01-progress-panel §6), each part as its single-row action already does it: queue rows
// to the Amiga cancelled (the board stops the one it sends; Transfer keeps nothing of it); gets withdrawn -- waiting ones
// never sent, taken ones refused at their open -- and a file arriving stopped as Delete stops an arriving STASH: row;
// waiting writes withdrawn (a drawer delete Transfer already runs finishes its drawer: Transfer has no stop for it). A
// move keeps every source not yet removed: its markers go, so no settle removes one from here. A `cancel` row records
// it for the card (kind 'cancel', never sent to a board). SERVER ONLY.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { amigaUploads, amigaUploadChunks } from '@/db/schema/amiga-uploads';
import { cancelQueueSends } from '@/lib/transfers';
import { isWriteKind, type GetTarget } from '@/lib/remote-requests';
import { newRequestId } from '@/lib/remote-wire';
import { CANCEL_KIND, CANCELLED, commonDrawer, QUEUE_JOB } from './job-view';

const ACTIVE = ['queued', 'sending'];
export type CancelResult = { ok: true; cancelled: number } | { ok: false };

/** A Files path's parent (`STASH:/Games/Pack` → `STASH:/Games`, `STASH:/Pack` → `STASH:`). */
const filesParent = (p: string) => { const c = p.indexOf(':'); const s = p.lastIndexOf('/'); return s > c + 1 ? p.slice(0, s) : p.slice(0, c + 1); };
/** The path of the entry a queue row copies: the moved entry's parent and the row's `move_item` (which starts at its name). */
const fullSource = (source: string, item: string | null) => (item ? `${filesParent(source)}/${item}` : source);

export async function cancelJob(db: Db, orgId: string, id: string, now = new Date()): Promise<CancelResult> {
  if (id.startsWith(QUEUE_JOB)) {
    const end = id.lastIndexOf(':');
    if (end <= QUEUE_JOB.length) return { ok: false };
    const deviceId = id.slice(QUEUE_JOB.length, end);
    const [d] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));
    if (!d) return { ok: false };
    return { ok: true, cancelled: await cancelQueueSends(db, orgId, deviceId, now) };
  }
  return db.transaction(async (tx) => {
    // The parts in settleMove's order (requests, then queue rows): a settle running meanwhile waits, then finds no markers.
    const reqs = await tx.select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, id), eq(remoteRequests.orgId, orgId)))
      .orderBy(remoteRequests.createdAt, remoteRequests.id).for('update');
    const rows = await tx.select().from(transfers).where(and(eq(transfers.jobId, id), eq(transfers.orgId, orgId)))
      .orderBy(transfers.createdAt, transfers.id).for('update');
    if (reqs.length === 0 && rows.length === 0) return { ok: false as const };
    const gets = reqs.filter((r) => r.kind === 'get');
    const markedSource = (r: (typeof reqs)[number]) => { const t = r.target as GetTarget | null; return t?.moveSource ?? t?.relay?.moveSource; };
    const marked = reqs.filter((r) => (r.kind === 'get' || r.kind === 'mkdir') && !!markedSource(r));
    const markedRows = rows.filter((x) => x.moveSource !== null);
    // What the card says once cancelled: whether it was a move, and where what did not go still is.
    const move = rows.some((x) => x.moveSource !== null || x.moveItem !== null) || gets.some((g) => (g.target as GetTarget).moveSeen !== undefined);
    const source = commonDrawer(markedRows.length ? markedRows.map((x) => fullSource(x.moveSource!, x.moveItem))
      : gets.filter((g) => (g.target as GetTarget).moveSeen !== undefined).map((g) => g.amigaPath));

    const withdraw = reqs.filter((r) => (r.kind === 'get' && ['waiting', 'sent', 'fetching'].includes(r.status))
      || (isWriteKind(r.kind) && r.status === 'waiting'));
    if (withdraw.length) {
      await tx.update(remoteRequests).set({ status: 'failed', errorCode: CANCELLED, errorText: CANCELLED, answeredAt: now })
        .where(inArray(remoteRequests.id, withdraw.map((r) => r.id)));
    }
    const arriving = withdraw.filter((r) => r.kind === 'get' && r.status === 'fetching' && r.uploadId).map((r) => r.uploadId!);
    if (arriving.length) {
      // The board's next chunk or close hears that it is gone (as deleteStash and releaseStaging do it).
      const hit = await tx.update(amigaUploads).set({ status: 'deleted' })
        .where(and(inArray(amigaUploads.id, arriving), eq(amigaUploads.orgId, orgId), eq(amigaUploads.status, 'receiving')))
        .returning({ id: amigaUploads.id });
      if (hit.length) await tx.delete(amigaUploadChunks).where(inArray(amigaUploadChunks.uploadId, hit.map((h) => h.id)));
    }
    const sending = rows.filter((x) => ACTIVE.includes(x.status));
    if (sending.length) {
      await tx.update(transfers).set({ status: 'cancelled', finishedAt: now })
        .where(and(inArray(transfers.id, sending.map((x) => x.id)), inArray(transfers.status, ACTIVE)));
      await tx.update(devices).set({ sendVersion: sql`${devices.sendVersion} + 1` })
        .where(inArray(devices.id, [...new Set(sending.map((x) => x.deviceId))]));
    }
    if (marked.length) {
      await tx.update(remoteRequests).set({ target: sql`(${remoteRequests.target} - 'moveSource') #- '{relay,moveSource}'` })
        .where(inArray(remoteRequests.id, marked.map((r) => r.id)));
    }
    if (markedRows.length) await tx.update(transfers).set({ moveSource: null }).where(inArray(transfers.id, markedRows.map((x) => x.id)));

    const cancelled = withdraw.length + sending.length;
    const stillRunning = reqs.some((r) => isWriteKind(r.kind) && (r.status === 'sent' || r.status === 'settling'));
    if ((cancelled > 0 || marked.length > 0 || markedRows.length > 0 || stillRunning) && !reqs.some((r) => r.kind === CANCEL_KIND)) {
      // The board the job is about, by fetchProgress's own rule (the marker itself is never picked there).
      const board = rows[0]?.deviceId ?? reqs.find((r) => r.kind !== 'get')?.deviceId ?? reqs[0].deviceId;
      await tx.insert(remoteRequests).values({ id: newRequestId(), orgId, deviceId: board, kind: CANCEL_KIND, status: 'done', fetchId: id,
        target: { move, source: move ? source : null }, createdAt: now, answeredAt: now });
    }
    return { ok: true as const, cancelled };
  });
}
