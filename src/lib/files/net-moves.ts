// src/lib/files/net-moves.ts
// NET: volumes phase 2 (spec 2026-10-31 §4.1; plan W7): a move's second half, on the server. A move onto a volume
// leaves its sources until the board has delivered every file of them; a move out of a volume until every file of it is
// stored. Then the source is removed as the person's own Delete would remove it -- once, whoever finishes last. A file
// skipped, failed, cancelled or expired keeps its source: nothing is taken away that did not arrive. SERVER ONLY.
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { parsePath } from './path';
import { driverFor } from './drivers';
import { Refused, type OpCtx } from './driver';

/** Remove one source as the person who moved it (its device's own remove); a refusal leaves it where it is. */
async function removeSource(orgId: string, userId: string | null, source: string): Promise<boolean> {
  const p = parsePath(source);
  const d = p ? driverFor(p.device) : null;
  if (!d?.remove) return false;
  const ctx: OpCtx = { orgId, userId, versions: [] };
  try {
    const r = await d.remove(ctx, [source]);
    return r.kind === 'done' && r.items.every((i) => i.ok);
  } catch (e) {
    if (e instanceof Refused) return false;
    throw e;
  }
}

/**
 * After a queue row of a move onto a volume finished: when every row of its job naming the same source has finished,
 * the source is claimed (move_source cleared, under the rows' locks, so only one caller acts) and, if they were all
 * delivered, removed. Returns whether it removed the source.
 */
export async function settleMoveOfTransfer(db: Db, transferId: string): Promise<boolean> {
  const [row] = await db.select({ jobId: transfers.jobId, moveSource: transfers.moveSource, orgId: transfers.orgId, userId: transfers.createdByUserId })
    .from(transfers).where(eq(transfers.id, transferId));
  if (!row?.jobId || !row.moveSource) return false;
  const claim = await db.transaction(async (tx) => {
    const rows = await tx.select({ id: transfers.id, status: transfers.status }).from(transfers)
      .where(and(eq(transfers.jobId, row.jobId!), eq(transfers.moveSource, row.moveSource!))).for('update');
    if (rows.length === 0 || rows.some((r) => r.status === 'queued' || r.status === 'sending')) return null;
    await tx.update(transfers).set({ moveSource: null }).where(and(eq(transfers.jobId, row.jobId!), eq(transfers.moveSource, row.moveSource!)));
    return rows.every((r) => r.status === 'delivered');
  });
  return claim ? removeSource(row.orgId, row.userId, row.moveSource) : false;
}

/**
 * After a get of a move out of a volume settled: when every get of its job naming the same source has settled, the
 * source is claimed (its gets' moveSource dropped, under their locks) and, if every one is done, deleted on the Amiga.
 */
export async function settleMoveOfGet(db: Db, getId: string): Promise<boolean> {
  const [g] = await db.select({ fetchId: remoteRequests.fetchId, orgId: remoteRequests.orgId, target: remoteRequests.target })
    .from(remoteRequests).where(eq(remoteRequests.id, getId));
  const t = g?.target as { moveSource?: string; userId?: string } | null;
  const source = t?.moveSource;
  if (!g?.fetchId || !source) return false;
  const named = and(eq(remoteRequests.fetchId, g.fetchId), eq(remoteRequests.kind, 'get'), sql`${remoteRequests.target}->>'moveSource' = ${source}`);
  const claim = await db.transaction(async (tx) => {
    const rows = await tx.select({ id: remoteRequests.id, status: remoteRequests.status }).from(remoteRequests).where(named).for('update');
    if (rows.length === 0 || rows.some((r) => r.status !== 'done' && r.status !== 'failed')) return null;
    await tx.update(remoteRequests).set({ target: sql`${remoteRequests.target} - 'moveSource'` }).where(named);
    return rows.every((r) => r.status === 'done');
  });
  return claim ? removeSource(g.orgId, t?.userId ?? null, source) : false;
}
