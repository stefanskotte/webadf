// src/lib/files/net-moves.ts
// NET: volumes phase 2 (spec 2026-10-31 §4.1; plan W7): a move's second half, on the server. A move's source is
// removed only once every part of its copy has ended -- every get of it stored (or, between volumes, relayed), every
// queue row of it delivered, every Makedir of its empty drawers made -- and then exactly once. Anything skipped,
// failed, cancelled or expired keeps the source, and so does a removal that is refused; the job then says why
// ("Copied, but the original could not be removed — …"). Since §9 (2026-11-01) only what was copied is removed: off a
// volume one DELETE … one per copied file, then each copied drawer deepest first (a drawer something new is in stays).
//
// The parts carry the source as a marker (gets and Makedirs: target.moveSource or target.relay.moveSource; queue rows:
// move_source).
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
import { Refused, REMOVE_FAILED, type IncomingItem, type OpCtx } from './driver';
import { isKeptWords } from '@/lib/remote-browse';
import { isNetVolumePath, placeOf, removeCopiedOnVolume } from './net-write';
import { refusalWords } from './words';

const ACTIVE_ROWS = ['queued', 'sending'];

type Part = { id: string; kind: string; status: string; amigaPath: string; target: unknown; deviceId: string };
type Row = { blobSha256: string; sizeBytes: number; protection: number; comment: string; moveItem: string | null };
type Removal = { kind: 'removed' } | { kind: 'kept'; label: string } | { kind: 'refused'; why: string };

/**
 * What a move of a STASH:/LIBRARY: entry copied (spec §9), as its driver's `unchanged`: each delivered row's file by
 * its path below the entry (`move_item`) with the bytes, bits and comment it went with, each Makedir's drawer, and the
 * drawers between. Null when a row does not say which entry it copied (queued before §9): then nothing is removed.
 */
function copiedOf(rows: Row[], mkdirs: Part[]): IncomingItem[] | null {
  if (rows.some((r) => !r.moveItem)) return null;
  const out = new Map<string, IncomingItem>();
  const dir = (rel: string[]) => {
    for (let k = 1; k <= rel.length; k++) {
      const at = rel.slice(0, k);
      out.set(`d:${at.join('/').toLowerCase()}`, out.get(`d:${at.join('/').toLowerCase()}`) ?? { rel: at, kind: 'dir', date: null, protection: 0, comment: null });
    }
  };
  for (const r of rows) {
    const rel = r.moveItem!.split('/');
    dir(rel.slice(0, -1));
    out.set(`f:${rel.join('/').toLowerCase()}`, { rel, kind: 'file', sha256: r.blobSha256, size: r.sizeBytes, date: null, protection: r.protection, comment: r.comment });
  }
  for (const m of mkdirs) {
    const item = (m.target as { moveItem?: string }).moveItem;
    if (item) dir(item.split('/'));
  }
  return [...out.values()];
}

/** Remove what a move of one source copied, as the person who moved it: removed (or sent), kept in part, or refused. */
async function removeSource(orgId: string, userId: string | null, source: string, jobId: string, parts: Part[], rows: Row[]): Promise<Removal> {
  const p = parsePath(source);
  const ctx: OpCtx = { orgId, userId, versions: [] };
  try {
    if (p && isNetVolumePath(p)) {
      // Off a volume: the copied files are the gets' paths, the drawers the walk's (spec §9).
      const gets = parts.filter((g) => g.kind === 'get');
      const drawers = gets.flatMap((g) => (g.target as { moveDrawers?: string[] }).moveDrawers ?? []);
      const files = gets.map((g) => g.amigaPath).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      await removeCopiedOnVolume(ctx, source, files, drawers, jobId);
      return { kind: 'removed' };
    }
    const d = p ? driverFor(p.device) : null;
    const copied = copiedOf(rows, parts.filter((x) => x.kind === 'mkdir'));
    if (!d?.remove || !copied) return { kind: 'refused', why: refusalWords('failed') };
    const r = await d.remove(ctx, [source], new Map([[source, copied]]));
    if (r.kind !== 'done') return { kind: 'refused', why: refusalWords('failed') };
    const bad = r.items.find((i) => !i.ok);
    if (!bad || bad.ok) return { kind: 'removed' };
    if (bad.refusal.detail && isKeptWords(bad.refusal.detail)) return { kind: 'kept', label: source };
    return { kind: 'refused', why: bad.refusal.detail === REMOVE_FAILED ? refusalWords(bad.refusal.code) : bad.refusal.detail ?? refusalWords(bad.refusal.code) };
  } catch (e) {
    if (e instanceof Refused) return { kind: 'refused', why: e.refusal.detail ?? refusalWords(e.refusal.code) };
    throw e;
  }
}

const getMarked = (jobId: string, source: string) => and(eq(remoteRequests.fetchId, jobId), inArray(remoteRequests.kind, ['get', 'mkdir']),
  or(sql`${remoteRequests.target}->>'moveSource' = ${source}`, sql`${remoteRequests.target}->'relay'->>'moveSource' = ${source}`));
const rowMarked = (jobId: string, source: string) => and(eq(transfers.jobId, jobId), eq(transfers.moveSource, source));

/**
 * The move of `source` in job `jobId`, once every part of it has ended: removed if all of it arrived, else kept; a
 * refused removal is recorded in the job as a failed delete. Returns whether the source was removed.
 */
export async function settleMove(db: Db, orgId: string, jobId: string, source: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const parts = await tx.select({ id: remoteRequests.id, kind: remoteRequests.kind, status: remoteRequests.status, amigaPath: remoteRequests.amigaPath,
      target: remoteRequests.target, deviceId: remoteRequests.deviceId, createdAt: remoteRequests.createdAt })
      .from(remoteRequests).where(getMarked(jobId, source)).orderBy(remoteRequests.createdAt, remoteRequests.id).for('update');
    const gets = parts.filter((g) => g.kind === 'get');
    const mkdirs = parts.filter((g) => g.kind === 'mkdir');
    const rows = await tx.select({ id: transfers.id, status: transfers.status, userId: transfers.createdByUserId, deviceId: transfers.deviceId,
      blobSha256: transfers.blobSha256, sizeBytes: transfers.sizeBytes, protection: transfers.protection, comment: transfers.comment, moveItem: transfers.moveItem })
      .from(transfers).where(rowMarked(jobId, source)).for('update');
    if (parts.length === 0 && rows.length === 0) return false;
    // Still on its way: a get not settled, a Makedir not answered, or a queue row waiting or moving.
    if (gets.some((g) => g.status !== 'done' && g.status !== 'failed') || mkdirs.some((m) => m.status !== 'done' && m.status !== 'failed')
      || rows.some((r) => ACTIVE_ROWS.includes(r.status))) return false;
    // A relayed get hands its file to a queue row: the row must exist (it is made in the same request as the get's done).
    const relayed = gets.filter((g) => (g.target as { relay?: unknown }).relay);
    const arrived = parts.every((g) => g.status === 'done') && rows.every((r) => r.status === 'delivered') && rows.length >= relayed.length;
    let removed = false;
    if (arrived) {
      const userId = (gets[0]?.target as { userId?: string } | undefined)?.userId ?? rows[0]?.userId ?? null;
      const out = await removeSource(orgId, userId, source, jobId, parts, rows);
      removed = out.kind === 'removed';
      const at = placeOf(parsePath(source));
      const said = { id: newRequestId(), orgId, deviceId: gets[0]?.deviceId ?? rows[0]?.deviceId ?? parts[0].deviceId, kind: 'delete',
        amigaPath: at?.amiga ?? source, fetchId: jobId, answeredAt: new Date() };
      if (out.kind === 'refused') {
        // Said in the job, as a delete that could not be done (final review I-2): the person sees the move became a copy.
        await tx.insert(remoteRequests).values({ ...said, status: 'failed', errorCode: 'moved',
          errorText: `Copied, but the original could not be removed — ${out.why}`, target: { label: at?.shown ?? source } });
      } else if (out.kind === 'kept') {
        // What the move left because something new is in it (spec §9): said in the job, not a failure.
        await tx.insert(remoteRequests).values({ ...said, status: 'done', answer: { removed: 0, kept: true }, target: { label: out.label, kept: true } });
      }
    }
    if (parts.length) {
      await tx.update(remoteRequests).set({ target: sql`(${remoteRequests.target} - 'moveSource') #- '{relay,moveSource}'` })
        .where(inArray(remoteRequests.id, parts.map((g) => g.id)));
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
    .from(remoteRequests).where(and(eq(remoteRequests.fetchId, jobId), eq(remoteRequests.orgId, orgId), inArray(remoteRequests.kind, ['get', 'mkdir']),
      sql`coalesce(${remoteRequests.target}->>'moveSource', ${remoteRequests.target}->'relay'->>'moveSource') is not null`));
  const fromRows = await db.select({ s: transfers.moveSource }).from(transfers)
    .where(and(eq(transfers.jobId, jobId), eq(transfers.orgId, orgId), sql`${transfers.moveSource} is not null`));
  for (const s of new Set([...fromGets, ...fromRows].map((x) => x.s!))) await settleMove(db, orgId, jobId, s);
}
