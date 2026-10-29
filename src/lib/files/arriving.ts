// src/lib/files/arriving.ts
// Files from the Amiga still arriving in STASH: (Files increment 3): a pane showing one re-reads its listing so the
// row moves without a reload, and a row whose bytes have not moved for STALL_MS says it stopped and what to do (the
// retired Upload page's words, from-amiga-ui at 8205ecc). CLIENT-SAFE: no server imports.
import { parsePath } from './path';
import type { FsEntry, Listing } from './types';

/** How long an arriving file may sit at the same byte count before its row calls it stopped. */
export const STALL_MS = 120_000;
/** A STASH: pane re-reads its listing this often while a row there is arriving and moving... */
export const STASH_POLL_MS = 3_000;
/** ...and this often while every arriving row has stopped (sent again from the Amiga, it moves on). */
export const STASH_STALLED_POLL_MS = 10_000;

/** Per arriving row (by path): the byte count last seen and since when it has been that. */
export type ArrivingSeen = Record<string, { bytes: number; since: number }>;

/** The seen-map after a read at `now`: a row whose bytes moved (or is new) restarts its clock; rows no longer arriving are forgotten. */
export function trackArriving(prev: ArrivingSeen, entries: readonly FsEntry[], now: number): ArrivingSeen {
  const next: ArrivingSeen = {};
  for (const e of entries) {
    if (e.received === undefined) continue;
    const p = prev[e.path];
    next[e.path] = p && p.bytes === e.received ? p : { bytes: e.received, since: now };
  }
  return next;
}

const isStalled = (e: FsEntry, seen: ArrivingSeen, now: number) =>
  e.received !== undefined && seen[e.path] !== undefined && now - seen[e.path].since >= STALL_MS;

export const stalledWords = (pct: number) => `Stopped at ${pct} % — send it again from the Amiga to continue`;

/** The entries as a pane draws them: a stopped row's `arriving N%` mark becomes the stopped words. */
export function withStalls(entries: FsEntry[], seen: ArrivingSeen, now: number): FsEntry[] {
  if (!entries.some((e) => isStalled(e, seen, now))) return entries;
  return entries.map((e) => (isStalled(e, seen, now)
    ? { ...e, marks: e.marks.map((m) => { const pct = /^arriving (\d+)%$/.exec(m); return pct ? stalledWords(Number(pct[1])) : m; }) }
    : e));
}

/** How often a pane showing `l` re-reads it for its arriving rows: STASH: only; null when nothing there is arriving. */
export function stashPollMs(l: Listing | null, seen: ArrivingSeen, now: number): number | null {
  if (!l || parsePath(l.path)?.device !== 'STASH') return null;
  const rows = l.entries.filter((e) => e.received !== undefined);
  if (!rows.length) return null;
  return rows.some((e) => !isStalled(e, seen, now)) ? STASH_POLL_MS : STASH_STALLED_POLL_MS;
}
