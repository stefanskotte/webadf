// src/lib/files/job-view.ts
// The progress panel's words (spec 2026-11-01-progress-panel §3, §5, §6): one job as GET /api/files/jobs sends it, and
// the pure rules that turn it into a card -- title, bar, line, estimate, result, the pill -- plus the constants the
// server and the client share. CLIENT-SAFE: no database import.
import { jobStatus, runningWriteLine, RUNNING_WORDS, type JobProgressView } from './manager-rules';

/** A job finished this long ago is still listed, so a reload shows its result (spec §4). */
export const JOB_SHOWN_MS = 120_000;
/** The id prefix of a board's plain Queue sends, one synthetic job per board (spec §4): `queue:<deviceId>:<ms>`. */
export const QUEUE_JOB = 'queue:';
/** The remote_requests kind that records a Cancel the rest (never sent to a board). */
export const CANCEL_KIND = 'cancel';
/** The words (and error code) of a part withdrawn by Cancel the rest -- and of a queue row a Queue Delete cancelled. */
export const CANCELLED = 'cancelled';
/** A clean finish fades after this (spec §3). */
export const FADE_MS = 6_000;
/** The estimate shows only after this much progress (spec §3)... */
export const WARMUP_MS = 10_000;
/** ...and is the rate over this last stretch of bytes. */
export const WINDOW_MS = 30_000;
/** A kept card lists this many failed files, then "and N more" (spec §3). */
export const FAILED_SHOWN = 5;

export type JobKind = 'copy' | 'move' | 'send' | 'write';
/** One job (spec §4). `board`: the board the job is about (the destination between two boards); `from`: then the source's. */
export type JobView = JobProgressView & {
  id: string; kind: JobKind; board: string; from: string | null;
  /** The drawer the files go into ('to'), the STASH:/LIBRARY: place ('from'), where a job of quiet drawers alone makes them; else null for writes and plain sends. */
  place: string | null;
  /** A write job's one kind (delete, rename, …), null when it mixes kinds or is not a write job. */
  writeKind: string | null;
  offline: string | null; arrived: string[];
  /** Parts withdrawn (Cancel the rest, or a Queue Delete): counted apart from `failed`. */
  cancelled: number;
  /** Set once Cancel the rest ran: whether the job was a move, and where what did not go still is. */
  cancel: { move: boolean; source: string | null } | null;
  bytes: { total: number; done: number } | null;
  /** The file moving now (an Amiga path), while it runs. */
  current: string | null;
  running: boolean; startedAt: string; finishedAt: string | null;
};
export type Sample = { at: number; done: number };

const KB = 1024;
const MB = 1024 * 1024;
const pct = (a: number, b: number) => Math.min(100, Math.max(0, Math.floor((a * 100) / b)));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const loudOf = (j: JobView) => j.writes.filter((w) => !w.quiet);
/** What a write job counts: its loud writes; a job of quiet drawers alone (an empty disk's) counts those. */
const countedOf = (j: JobView) => { const loud = loudOf(j); return loud.length ? loud : j.writes; };
const notCancelled = (j: JobView) => j.writes.filter((w) => w.reason !== CANCELLED);

/**
 * The drawer every path is in (Amiga `Work:a/b` or Files `STASH:/a/b`, compared case-insensitively): a path's own name
 * is never part of it. Null for no paths or paths on different devices.
 */
export function commonDrawer(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let slash = false;
  const drawers: { dev: string; segs: string[] }[] = [];
  for (const p of paths) {
    const c = p.indexOf(':');
    if (c < 0) return null;
    if (p[c + 1] === '/') slash = true;
    drawers.push({ dev: p.slice(0, c + 1), segs: p.slice(c + 1).split('/').filter(Boolean).slice(0, -1) });
  }
  const [first, ...rest] = drawers;
  let common = first.segs;
  for (const d of rest) {
    if (d.dev.toLowerCase() !== first.dev.toLowerCase()) return null;
    let k = 0;
    while (k < common.length && k < d.segs.length && common[k].toLowerCase() === d.segs[k].toLowerCase()) k++;
    common = common.slice(0, k);
  }
  return first.dev + (slash && common.length ? '/' : '') + common.join('/');
}

/** What and where (spec §3). */
export function jobTitle(j: JobView): string {
  if (j.kind === 'send') return `Sending ${plural(j.total, 'file', 'files')} to ${j.board}`;
  if (j.kind === 'write') {
    const loud = loudOf(j);
    if (loud.length === 0) return `Changing the disks of ${j.board}${j.place ? ` · ${j.place}` : ''}`;
    if (loud.length === 1) return `${RUNNING_WORDS[loud[0].kind] ?? 'Changing'} ${loud[0].label} on ${j.board}`;
    return `${j.writeKind ? RUNNING_WORDS[j.writeKind] ?? 'Changing' : 'Changing'} ${loud.length} items on ${j.board}`;
  }
  const verb = j.kind === 'move' ? 'Moving' : 'Copying';
  if (j.direction === 'from') return `${verb} from ${j.board}${j.place ? ` to ${j.place}` : ''}`;
  const at = j.place ? ` · ${j.place}` : '';
  return j.from ? `${verb} from ${j.from} to ${j.board}${at}` : `${verb} to ${j.board}${at}`;
}

/** "2.4 of 9.8 MB"; under a megabyte "12 of 820 KB". */
export function sizeWords(done: number, total: number): string {
  if (total < MB) return `${Math.round(done / KB)} of ${Math.max(1, Math.round(total / KB))} KB`;
  return `${(done / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`;
}

export function leftWords(sec: number): string {
  if (sec < 45) return 'less than a minute left';
  return `about ${Math.round(sec / 60)} min left`;
}

/** Files ended of all (a job with files), else its loud writes ended of all. */
export function itemsOf(j: JobView): { ended: number; total: number; noun: 'files' | 'items' } {
  if (j.total > 0) return { ended: Math.max(0, j.total - j.waiting), total: j.total, noun: 'files' };
  const counted = countedOf(j);
  return { ended: counted.filter((w) => w.status === 'done' || w.status === 'failed').length, total: counted.length, noun: 'items' };
}

/** The bar (0-100): by bytes where they are known and not all empty, by items otherwise (spec §3). */
export function barOf(j: JobView): { value: number; byBytes: boolean } {
  if (j.bytes && j.bytes.total > 0) return { value: pct(j.bytes.done, j.bytes.total), byBytes: true };
  const it = itemsOf(j);
  return { value: it.total ? pct(it.ended, it.total) : 0, byBytes: false };
}

/**
 * Seconds left, or null: only while it runs with known bytes and its board online, only once bytes have moved for
 * WARMUP_MS, and at the rate of the samples in the last WINDOW_MS.
 */
export function timeLeft(samples: Sample[], j: Pick<JobView, 'bytes' | 'offline' | 'running'>, now: number): number | null {
  if (!j.running || j.offline || !j.bytes || j.bytes.total <= 0 || samples.length === 0) return null;
  const moved = samples.find((s) => s.done > samples[0].done);
  if (!moved || now - moved.at < WARMUP_MS) return null;
  const recent = samples.filter((s) => s.at >= now - WINDOW_MS);
  if (recent.length < 2) return null;
  const a = recent[0];
  const b = recent[recent.length - 1];
  const rate = (b.done - a.done) / ((b.at - a.at) / 1000);
  if (!(rate > 0)) return null;
  return Math.max(0, (j.bytes.total - j.bytes.done) / rate);
}

/** "3 of 12 files · 2.4 of 9.8 MB · about 1 min left"; an offline board waits instead of an estimate (spec §3). */
export function jobLine(j: JobView, left: number | null): string {
  const it = itemsOf(j);
  const parts = [it.noun === 'files' ? `${it.ended} of ${plural(it.total, 'file', 'files')}` : `${it.ended} of ${plural(it.total, 'item', 'items')}`];
  if (j.bytes && j.bytes.total > 0) parts.push(sizeWords(j.bytes.done, j.bytes.total));
  if (j.offline) parts.push(`Waiting for ${j.offline} (offline)`);
  else if (left !== null) parts.push(leftWords(left));
  return parts.join(' · ');
}

/** The card's second line while it runs: the file moving now, else the write running (with a delete's count). */
export function jobNow(j: JobView): string | null {
  if (!j.running) return null;
  return j.current ?? runningWriteLine(j, j.board);
}

/** A finished card's words: Cancel's, a send's, else today's finished line (jobStatus) and what was cancelled elsewhere. */
export function resultWords(j: JobView): string {
  if (j.cancel) {
    // A cancelled move says copied: a file counted done may still have its original (the rest stays in the source).
    const verb = j.kind === 'send' ? 'sent' : j.kind === 'write' ? 'done' : 'copied';
    const counted = countedOf(j);
    const [done, total] = j.total > 0 ? [j.done, j.total] : [counted.filter((w) => w.status === 'done').length, counted.length];
    const fails = j.failed.length ? `, ${j.failed.length} failed` : '';
    const rest = j.kind === 'move' && j.cancel.source ? `; the rest is still in ${j.cancel.source}` : '';
    return `Cancelled: ${done} of ${total} ${verb}${fails}${rest}`;
  }
  if (j.kind === 'send') {
    const [first, ...more] = j.failed;
    return `Sent ${plural(j.done, 'file', 'files')} to ${j.board}${j.cancelled ? `, ${j.cancelled} cancelled` : ''}`
      + (first ? `, ${j.failed.length} failed: ${first.name}: ${first.reason}${more.length ? '; …' : ''}` : '');
  }
  const line = jobStatus({ ...j, writes: notCancelled(j) }, j.board).line;
  return j.cancelled ? `${line} · ${j.cancelled} cancelled` : line;
}

/** The failed files of a kept card: the first five, then "and N more" (spec §3). */
export function failureList(j: JobView): string[] {
  const all = j.failed.map((f) => `${f.name}: ${f.reason}`);
  return all.length > FAILED_SHOWN ? [...all.slice(0, FAILED_SHOWN), `and ${all.length - FAILED_SHOWN} more`] : all;
}

/** Nothing failed, nothing cancelled, no drawer kept: a clean finish, which fades. */
export function isClean(j: JobView): boolean {
  return !j.cancel && j.cancelled === 0 && j.failed.length === 0
    && !j.writes.some((w) => (w.status === 'failed' && w.reason !== CANCELLED) || w.kept);
}

/** Whether a card shows: running always; finished clean for FADE_MS after it was first seen finished; else until closed. */
export function cardShown(j: JobView, s: { finishedSeenAt: number | null; dismissed: boolean; now: number }): boolean {
  if (j.running) return true;
  if (s.dismissed) return false;
  if (!isClean(j)) return true;
  return s.finishedSeenAt === null || s.now - s.finishedSeenAt < FADE_MS;
}

/** The collapsed pill: running jobs and their bytes together (by items when none has bytes), else what is finished. */
export function pillWords(jobs: JobView[]): string {
  const running = jobs.filter((j) => j.running);
  if (running.length === 0) return jobs.length === 1 ? '1 finished' : `${jobs.length} finished`;
  const withBytes = running.filter((j) => j.bytes && j.bytes.total > 0);
  const value = withBytes.length
    ? pct(withBytes.reduce((n, j) => n + j.bytes!.done, 0), withBytes.reduce((n, j) => n + j.bytes!.total, 0))
    : Math.floor(running.reduce((n, j) => n + barOf(j).value, 0) / running.length);
  return `${plural(running.length, 'job', 'jobs')} · ${value} %`;
}

export function canCancel(j: JobView): boolean {
  return j.running && !j.cancel;
}

/** Cancel asks first (spec §5). */
export function confirmWords(j: JobView): string {
  if (j.kind === 'write') {
    // A drawer delete Transfer already runs has no stop (spec §6): it finishes its drawer.
    return j.writes.some((w) => w.kind === 'delete' && w.status === 'running')
      ? 'Cancel the rest of these changes? A drawer being deleted now finishes first; what is done stays.'
      : 'Cancel the rest of these changes? What is done stays.';
  }
  // A plain Queue send has no job of its own: its rows share one card, and Cancel takes all of that board's waiting files.
  if (j.id.startsWith(QUEUE_JOB)) {
    return `Cancels ${j.waiting === 1 ? 'the 1 file' : `all ${j.waiting} files`} waiting for ${j.board}. What has arrived stays.`;
  }
  return `Cancel the rest of this ${j.kind}? What has arrived stays.`;
}

/** The job a Cancel dialog asks about, as the latest answer has it, while it still runs; null closes the dialog. */
export function askingAbout(id: string, jobs: JobView[]): JobView | null {
  return jobs.find((j) => j.id === id && j.running) ?? null;
}

/** How far above the viewport's bottom the panel sits to clear the lowest anchor on screen (the Files bar), else 0. */
export function panelLift(anchorTops: number[], viewport: number): number {
  const on = anchorTops.filter((t) => t > 0 && t < viewport);
  return on.length ? Math.ceil(viewport - Math.min(...on) + 8) : 0;
}
