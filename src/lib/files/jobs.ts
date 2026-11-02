// src/lib/files/jobs.ts
// The progress panel's record (spec 2026-11-01-progress-panel §4): the org's jobs that run, or finished in the last
// 2 minutes -- every Files job (transfers.job_id, remote_requests.fetch_id) with fetchProgress's fields, its bytes and
// what its card's title names; and per board one job for the plain Queue sends, which have no job id. Plain Postgres
// queries over transfers, remote_requests and amiga_uploads: nothing hosted-only, no table of its own. SERVER ONLY.
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Db } from '@/db';
import { devices } from '@/db/schema/devices';
import { transfers } from '@/db/schema/transfers';
import { remoteRequests } from '@/db/schema/remote-requests';
import { amigaUploads } from '@/db/schema/amiga-uploads';
import { isOnline } from '@/lib/device-state';
import { failureText } from '@/lib/send-ui';
import { expireStale, type GetTarget, type RemoteRow } from '@/lib/remote-requests';
import { jobStatus } from './manager-rules';
import { fetchProgress, type FetchProgress } from './net-fetch';
import { CANCEL_KIND, CANCELLED, commonDrawer, JOB_SHOWN_MS, QUEUE_JOB, type JobKind, type JobView } from './job-view';

type TransferRow = typeof transfers.$inferSelect;
const ACTIVE = ['queued', 'sending'];
/** A request of a job not yet ended (a move's removal decided and not recorded is `settling`). */
const LIVE = ['waiting', 'sent', 'fetching', 'placing', 'settling'];
const iso = (d: Date) => d.toISOString();
const latest = (ds: Date[]) => (ds.length ? iso(new Date(Math.max(...ds.map((d) => d.getTime())))) : null);

/** The org's jobs, newest first. */
export async function listJobs(db: Db, orgId: string, now = new Date()): Promise<JobView[]> {
  const since = new Date(now.getTime() - JOB_SHOWN_MS);
  const a = await db.selectDistinct({ id: transfers.jobId }).from(transfers)
    .where(and(eq(transfers.orgId, orgId), isNotNull(transfers.jobId), or(inArray(transfers.status, ACTIVE), gte(transfers.finishedAt, since))));
  const b = await db.selectDistinct({ id: remoteRequests.fetchId }).from(remoteRequests)
    .where(and(eq(remoteRequests.orgId, orgId), isNotNull(remoteRequests.fetchId),
      or(inArray(remoteRequests.status, LIVE), gte(remoteRequests.answeredAt, since))));
  const ids = [...new Set([...a, ...b].map((r) => r.id!))];
  const out: JobView[] = [];
  // Requests sent and not answered in time fail once here for every job, not once per job (fetchProgress would).
  await expireStale(db, now);
  for (const id of ids) {
    // One job whose card cannot be worked out is left out (and logged), not the whole listing.
    let j: JobView | null;
    try { j = await jobView(db, orgId, id, now, undefined, { expire: false }); } catch (e) {
      console.error(`jobs: job ${id} could not be listed`, e);
      continue;
    }
    if (j && (j.running || (j.finishedAt !== null && j.finishedAt >= iso(since)))) out.push(j);
  }
  out.push(...(await queueJobs(db, orgId, now)));
  return out.sort((x, y) => y.startedAt.localeCompare(x.startedAt) || x.id.localeCompare(y.id));
}

async function boardNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: devices.id, name: devices.name }).from(devices).where(inArray(devices.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name] as const));
}

async function uploadsOf(db: Db, orgId: string, gets: RemoteRow[]): Promise<Map<string, { size: number; received: number }>> {
  const ids = gets.map((g) => g.uploadId).filter((x): x is string => !!x);
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: amigaUploads.id, size: amigaUploads.sizeBytes, received: amigaUploads.receivedBytes }).from(amigaUploads)
    .where(and(inArray(amigaUploads.id, ids), eq(amigaUploads.orgId, orgId)));
  return new Map(rows.map((r) => [r.id, { size: r.size, received: r.received }] as const));
}

/**
 * A job's bytes: a get's file by its size (from the copy's walk, else its upload's) and what of it arrived; a queue row by
 * its size and the board's last fetched chunk; any ended part whole, so the bar ends with the job. Between volumes each
 * file counts once -- its way up the first half, its queue row (once handed over) the second.
 */
function bytesOf(gets: RemoteRow[], uploads: Map<string, { size: number; received: number }>, sent: TransferRow[], relayed: boolean) {
  let total = 0;
  let done = 0;
  for (const g of gets) {
    const t = g.target as GetTarget;
    const u = g.uploadId ? uploads.get(g.uploadId) : undefined;
    const size = t.size ?? u?.size ?? 0;
    const up = g.status === 'done' || g.status === 'failed' || g.status === 'placing' ? size : u?.received ?? 0;
    total += size;
    if (!t.relay) done += up;
    else if (g.status === 'failed') done += size;
    else if (g.status !== 'done') done += Math.floor(up / 2);   // a relayed get once done is its queue row's
  }
  for (const x of sent) {
    const part = ACTIVE.includes(x.status) ? x.bytesSent : x.sizeBytes;
    if (relayed) done += Math.floor(x.sizeBytes / 2) + Math.floor(part / 2);
    else { total += x.sizeBytes; done += part; }
  }
  return { total, done: Math.min(done, total) };
}

/** One job as its card says it, however long ago it finished; `progress` when the caller already has it. */
export async function jobView(db: Db, orgId: string, id: string, now: Date, progress?: FetchProgress | null,
  opts: { expire?: boolean } = {}): Promise<JobView | null> {
  const p = progress === undefined ? await fetchProgress(db, orgId, id, now, opts) : progress;
  if (!p) return null;
  const reqs = await db.select().from(remoteRequests).where(and(eq(remoteRequests.fetchId, id), eq(remoteRequests.orgId, orgId)))
    .orderBy(asc(remoteRequests.createdAt), asc(remoteRequests.id));
  const sent = await db.select().from(transfers).where(and(eq(transfers.jobId, id), eq(transfers.orgId, orgId)))
    .orderBy(asc(transfers.createdAt), asc(transfers.id));
  const gets = reqs.filter((r) => r.kind === 'get');
  const relay = gets.map((g) => (g.target as GetTarget).relay).find((x) => !!x) ?? null;
  const marker = reqs.find((r) => r.kind === CANCEL_KIND) ?? null;
  const names = await boardNames(db, [...(relay ? [relay.deviceId] : []), ...gets.slice(0, 1).map((g) => g.deviceId)]);
  // A part withdrawn by Cancel the rest (or a Queue Delete) says `cancelled`: counted apart, never a failure.
  const failed = p.failed.filter((f) => f.reason !== CANCELLED);
  const cancelled = p.failed.length - failed.length + p.writes.filter((w) => w.reason === CANCELLED).length;
  const running = !jobStatus({ ...p, failed, writes: p.writes.filter((w) => w.reason !== CANCELLED) }, p.board).finished;
  const markerTarget = (marker?.target ?? {}) as { move?: boolean; source?: string | null };
  const moved = sent.some((x) => x.moveSource !== null || x.moveItem !== null)
    || gets.some((g) => (g.target as GetTarget).moveSeen !== undefined) || !!markerTarget.move;
  const kind: JobKind = sent.length || gets.length ? (moved ? 'move' : 'copy') : 'write';
  const loudKinds = [...new Set(p.writes.filter((w) => !w.quiet).map((w) => w.kind))];
  const dests = [...sent.map((x) => x.amigaDest), ...gets.map((g) => (g.target as GetTarget).relay?.dest ?? null)].filter((x): x is string => !!x);
  const first = gets[0]?.target as GetTarget | undefined;
  // Drawers alone (a copy of an empty disk: every write a quiet `ensure`) say where they go, as a copy's files do.
  const quietOnly = kind === 'write' && loudKinds.length === 0;
  const place = quietOnly ? commonDrawer(p.writes.map((w) => w.label)) : kind === 'write' ? null : p.direction === 'to' ? commonDrawer(dests) : first ? (first.library ? 'LIBRARY:' : first.dest) : null;
  const moving = sent.find((x) => x.status === 'sending');
  const fetching = gets.find((g) => g.status === 'fetching') ?? gets.find((g) => g.status === 'sent');
  const starts = [...reqs.map((r) => r.createdAt), ...sent.map((x) => x.createdAt)];
  const ends = [...reqs.map((r) => r.answeredAt), ...sent.map((x) => x.finishedAt)].filter((x): x is Date => !!x);
  return {
    id, kind, direction: p.direction,
    board: relay ? names.get(relay.deviceId) ?? p.board : p.board,
    from: relay && gets[0] ? names.get(gets[0].deviceId) ?? null : null,
    place, writeKind: kind === 'write' && loudKinds.length === 1 ? loudKinds[0] : null,
    total: p.total, done: p.done, failed, waiting: p.waiting, skipped: p.skipped, writes: p.writes, offline: p.offline, arrived: p.arrived,
    cancelled, cancel: marker ? { move: !!markerTarget.move, source: markerTarget.source ?? null } : null,
    bytes: p.total > 0 ? bytesOf(gets, await uploadsOf(db, orgId, gets), sent, !!relay) : null,
    current: !running ? null : moving ? moving.amigaDest ?? moving.path : fetching?.amigaPath ?? null,
    running,
    startedAt: iso(new Date(Math.min(...starts.map((d) => d.getTime())))),
    finishedAt: running ? null : latest(ends),
  };
}

/**
 * The plain Queue sends (spec §4): per board, its job-less rows that wait or move, with those that finished since the
 * oldest of them was queued -- or, once none waits, those that finished in the last 2 minutes. Its id carries the newest
 * row's time, so a later batch is a new card.
 */
async function queueJobs(db: Db, orgId: string, now: Date): Promise<JobView[]> {
  const since = now.getTime() - JOB_SHOWN_MS;
  const active = await db.select().from(transfers)
    .where(and(eq(transfers.orgId, orgId), isNull(transfers.jobId), inArray(transfers.status, ACTIVE), gt(transfers.expiresAt, now)));
  const start = new Map<string, number>();
  for (const r of active) start.set(r.deviceId, Math.min(start.get(r.deviceId) ?? Infinity, r.createdAt.getTime()));
  const ended = await db.select().from(transfers)
    .where(and(eq(transfers.orgId, orgId), isNull(transfers.jobId), gte(transfers.finishedAt, new Date(Math.min(since, ...start.values())))));
  const byBoard = new Map<string, TransferRow[]>();
  for (const r of [...active, ...ended.filter((x) => x.finishedAt!.getTime() >= (start.get(x.deviceId) ?? since))]) {
    byBoard.set(r.deviceId, [...(byBoard.get(r.deviceId) ?? []), r]);
  }
  if (byBoard.size === 0) return [];
  const boards = await db.select({ id: devices.id, name: devices.name, lastSeenAt: devices.lastSeenAt }).from(devices)
    .where(inArray(devices.id, [...byBoard.keys()]));
  return boards.map((d): JobView => {
    const rows = byBoard.get(d.id)!.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id));
    const waiting = rows.filter((x) => ACTIVE.includes(x.status));
    const running = waiting.length > 0;
    return {
      id: `${QUEUE_JOB}${d.id}:${rows[rows.length - 1].createdAt.getTime()}`, kind: 'send', direction: 'to', board: d.name, from: null,
      place: null, writeKind: null, total: rows.length, done: rows.filter((x) => x.status === 'delivered').length,
      failed: rows.filter((x) => x.status === 'failed' || x.status === 'expired').map((x) => ({ name: x.path,
        reason: x.status === 'expired' ? `${d.name} did not take it within 24 h` : failureText(x.errorCode, x.errorText) })),
      waiting: waiting.length, skipped: rows.filter((x) => x.status === 'skipped').length, writes: [],
      offline: running && !isOnline(d.lastSeenAt, now.getTime()) ? d.name : null, arrived: [],
      cancelled: rows.filter((x) => x.status === 'cancelled').length, cancel: null,
      bytes: { total: rows.reduce((n, x) => n + x.sizeBytes, 0), done: rows.reduce((n, x) => n + (ACTIVE.includes(x.status) ? x.bytesSent : x.sizeBytes), 0) },
      current: rows.find((x) => x.status === 'sending')?.path ?? null, running,
      startedAt: iso(rows[0].createdAt),
      finishedAt: running ? null : latest(rows.map((x) => x.finishedAt).filter((x): x is Date => !!x)),
    };
  });
}
