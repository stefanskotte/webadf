// src/lib/files/net-moves.ts
// NET: volumes phase 2 (spec 2026-10-31 §4.1; plan W7): a move's second half, on the server. A move onto a volume
// leaves its sources until the board has delivered every file of them; a move out of a volume until every file of it is
// stored. Then the source is removed as the person's own Delete would remove it -- once, whoever finishes last. A file
// skipped, failed, cancelled or expired keeps its source: nothing is taken away that did not arrive.
//
// The claim holds the rows' locks while the source is removed and clears the move marker only after: so a second caller
// waits and then finds nothing to do, and the job's progress (which counts a row still marked as not finished) never
// says "done" before the source is gone. A volume source's DELETE joins the move's own job. SERVER ONLY.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { parsePath } from './path';
import { driverFor } from './drivers';
import { Refused, type OpCtx } from './driver';
import { isNetVolumePath, removeOnVolume } from './net-write';

/** Remove one source as the person who moved it (its device's own remove); a refusal leaves it where it is. */
async function removeSource(orgId: string, userId: string | null, source: string, jobId: string | null): Promise<boolean> {
  const p = parsePath(source);
  const ctx: OpCtx = { orgId, userId, versions: [] };
  try {
    if (p && isNetVolumePath(p)) {
      const r = await removeOnVolume(ctx, [source], jobId ? { jobId } : {});
      return r.kind === 'done' && r.items.every((i) => i.ok);
    }
    const d = p ? driverFor(p.device) : null;
    if (!d?.remove) return false;
    const r = await d.remove(ctx, [source]);
    return r.kind === 'done' && r.items.every((i) => i.ok);
  } catch (e) {
    if (e instanceof Refused) return false;
    throw e;
  }
}

/**
 * After a queue row of a move onto a volume finished: when every row of its job naming the same source has finished,
 * the source is removed if they were all delivered, then the marker cleared. Returns whether it removed the source.
 */
export async function settleMoveOfTransfer(db: Db, transferId: string): Promise<boolean> {
  const [row] = await db.select({ jobId: transfers.jobId, moveSource: transfers.moveSource, orgId: transfers.orgId, userId: transfers.createdByUserId })
    .from(transfers).where(eq(transfers.id, transferId));
  if (!row?.jobId || !row.moveSource) return false;
  const named = and(eq(transfers.jobId, row.jobId), eq(transfers.moveSource, row.moveSource));
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: transfers.id, status: transfers.status }).from(transfers).where(named).for('update');
    if (rows.length === 0 || rows.some((r) => r.status === 'queued' || r.status === 'sending')) return false;
    const removed = rows.every((r) => r.status === 'delivered') && await removeSource(row.orgId, row.userId, row.moveSource!, row.jobId);
    await tx.update(transfers).set({ moveSource: null }).where(named);
    return removed;
  });
}

/**
 * After a get of a move out of a volume settled: when every get of its job naming the same source has settled, the
 * source is deleted on the Amiga if every one is done (its DELETE in the same job), then the marker dropped.
 */
export async function settleMoveOfGet(db: Db, getId: string): Promise<boolean> {
  const [g] = await db.select({ fetchId: remoteRequests.fetchId, orgId: remoteRequests.orgId, target: remoteRequests.target })
    .from(remoteRequests).where(eq(remoteRequests.id, getId));
  const t = g?.target as { moveSource?: string; userId?: string } | null;
  const source = t?.moveSource;
  if (!g?.fetchId || !source) return false;
  const named = and(eq(remoteRequests.fetchId, g.fetchId), eq(remoteRequests.kind, 'get'), sql`${remoteRequests.target}->>'moveSource' = ${source}`);
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: remoteRequests.id, status: remoteRequests.status }).from(remoteRequests).where(named).for('update');
    if (rows.length === 0 || rows.some((r) => r.status !== 'done' && r.status !== 'failed')) return false;
    const removed = rows.every((r) => r.status === 'done') && await removeSource(g.orgId, t?.userId ?? null, source, g.fetchId);
    await tx.update(remoteRequests).set({ target: sql`${remoteRequests.target} - 'moveSource'` }).where(named);
    return removed;
  });
}
