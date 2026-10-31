// src/lib/files/net-moves.ts
// NET: volumes phase 2 (spec 2026-10-31 §4.1; plan W7): a move's second half, on the server. A move's source is
// removed only once every part of its copy has ended -- every get of it stored (or, between volumes, relayed), every
// queue row of it delivered -- and then exactly once, as the person's own Delete would remove it. Anything skipped,
// failed, cancelled or expired keeps the source, and so does a removal that is refused; the job then says why
// ("Copied, but the original could not be removed — …").
//
// The rows carry the source as a marker (gets: target.moveSource or target.relay.moveSource; queue rows: move_source).
// settleMove holds every marked row's lock while it decides and removes, and clears the markers only after: a second
// caller waits, then finds nothing. The job's progress counts a marked row as unfinished, and settles finished groups
// itself (final review C2), so whatever ended a row -- the board, a timeout, writing switched off, an expiry, a cancel --
// the job finishes. SERVER ONLY.
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { newRequestId } from '@/lib/remote-wire';
import { parsePath } from './path';
import { driverFor } from './drivers';
import { Refused, type OpCtx } from './driver';
import { isNetVolumePath, placeOf, removeOnVolume } from './net-write';
import { refusalWords } from './words';

const ACTIVE_ROWS = ['queued', 'sending'];

/** Remove one source as the person who moved it; null when it went, else the words why not. */
async function removeSource(orgId: string, userId: string | null, source: string, jobId: string): Promise<string | null> {
  const p = parsePath(source);
  const ctx: OpCtx = { orgId, userId, versions: [] };
  try {
    const r = p && isNetVolumePath(p) ? await removeOnVolume(ctx, [source], { jobId })
      : p && driverFor(p.device)?.remove ? await driverFor(p.device)!.remove!(ctx, [source]) : null;
    if (!r || r.kind !== 'done') return refusalWords('failed');
    const bad = r.items.find((i) => !i.ok);
    return bad && !bad.ok ? (bad.refusal.detail ?? refusalWords(bad.refusal.code)) : null;
  } catch (e) {
    if (e instanceof Refused) return e.refusal.detail ?? refusalWords(e.refusal.code);
    throw e;
  }
}

const getMarked = (jobId: string, source: string) => and(eq(remoteRequests.fetchId, jobId), eq(remoteRequests.kind, 'get'),
  or(sql`${remoteRequests.target}->>'moveSource' = ${source}`, sql`${remoteRequests.target}->'relay'->>'moveSource' = ${source}`));
const rowMarked = (jobId: string, source: string) => and(eq(transfers.jobId, jobId), eq(transfers.moveSource, source));

/**
 * The move of `source` in job `jobId`, once every part of it has ended: removed if all of it arrived, else kept; a
 * refused removal is recorded in the job as a failed delete. Returns whether the source was removed.
 */
export async function settleMove(db: Db, orgId: string, jobId: string, source: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gets = await tx.select({ id: remoteRequests.id, status: remoteRequests.status, target: remoteRequests.target, deviceId: remoteRequests.deviceId })
      .from(remoteRequests).where(getMarked(jobId, source)).for('update');
    const rows = await tx.select({ id: transfers.id, status: transfers.status, userId: transfers.createdByUserId, deviceId: transfers.deviceId })
      .from(transfers).where(rowMarked(jobId, source)).for('update');
    if (gets.length === 0 && rows.length === 0) return false;
    // Still on its way: a get not settled, or a queue row waiting or moving.
    if (gets.some((g) => g.status !== 'done' && g.status !== 'failed') || rows.some((r) => ACTIVE_ROWS.includes(r.status))) return false;
    // A relayed get hands its file to a queue row: the row must exist (it is made in the same request as the get's done).
    const relayed = gets.filter((g) => (g.target as { relay?: unknown }).relay);
    const arrived = gets.every((g) => g.status === 'done') && rows.every((r) => r.status === 'delivered') && rows.length >= relayed.length;
    let removed = false;
    if (arrived) {
      const userId = (gets[0]?.target as { userId?: string } | undefined)?.userId ?? rows[0]?.userId ?? null;
      const why = await removeSource(orgId, userId, source, jobId);
      removed = why === null;
      if (why !== null) {
        // Said in the job, as a delete that could not be done (final review I-2): the person sees the move became a copy.
        const at = placeOf(parsePath(source));
        await tx.insert(remoteRequests).values({ id: newRequestId(), orgId, deviceId: gets[0]?.deviceId ?? rows[0].deviceId, kind: 'delete',
          amigaPath: at?.amiga ?? source, fetchId: jobId, status: 'failed', errorCode: 'moved', answeredAt: new Date(),
          errorText: `Copied, but the original could not be removed — ${why}`, target: { label: at?.shown ?? source } });
      }
    }
    if (gets.length) {
      await tx.update(remoteRequests).set({ target: sql`(${remoteRequests.target} - 'moveSource') #- '{relay,moveSource}'` })
        .where(inArray(remoteRequests.id, gets.map((g) => g.id)));
    }
    if (rows.length) await tx.update(transfers).set({ moveSource: null }).where(inArray(transfers.id, rows.map((r) => r.id)));
    return removed;
  });
}

/** After a queue row finished (the done route): its move, if it was one. */
export async function settleMoveOfTransfer(db: Db, transferId: string): Promise<boolean> {
  const [row] = await db.select({ jobId: transfers.jobId, moveSource: transfers.moveSource, orgId: transfers.orgId })
    .from(transfers).where(eq(transfers.id, transferId));
  return row?.jobId && row.moveSource ? settleMove(db, row.orgId, row.jobId, row.moveSource) : false;
}

/** After a get settled: its move, if it was one. */
export async function settleMoveOfGet(db: Db, getId: string): Promise<boolean> {
  const [g] = await db.select({ fetchId: remoteRequests.fetchId, orgId: remoteRequests.orgId, target: remoteRequests.target })
    .from(remoteRequests).where(eq(remoteRequests.id, getId));
  const t = g?.target as { moveSource?: string; relay?: { moveSource?: string } } | null;
  const source = t?.moveSource ?? t?.relay?.moveSource;
  return g?.fetchId && source ? settleMove(db, g.orgId, g.fetchId, source) : false;
}

/** Every move of a job whose parts have all ended, settled (the progress calls this: final review C2). */
export async function settleMovesOfJob(db: Db, orgId: string, jobId: string): Promise<void> {
  const fromGets = await db.select({ s: sql<string>`coalesce(${remoteRequests.target}->>'moveSource', ${remoteRequests.target}->'relay'->>'moveSource')` })
    .from(remoteRequests).where(and(eq(remoteRequests.fetchId, jobId), eq(remoteRequests.orgId, orgId), eq(remoteRequests.kind, 'get'),
      sql`coalesce(${remoteRequests.target}->>'moveSource', ${remoteRequests.target}->'relay'->>'moveSource') is not null`));
  const fromRows = await db.select({ s: transfers.moveSource }).from(transfers)
    .where(and(eq(transfers.jobId, jobId), eq(transfers.orgId, orgId), sql`${transfers.moveSource} is not null`));
  for (const s of new Set([...fromGets, ...fromRows].map((x) => x.s!))) await settleMove(db, orgId, jobId, s);
}
