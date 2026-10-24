/**
 * The admin Overview's board health rules (A7 spec §1), pure so every threshold is unit-tested at its edge.
 * The queries that feed these live in admin-queries.ts; the page only renders what comes out.
 */
import { relative } from '@/lib/device-state';
import { semverOf } from '@/lib/firmware-version';

/** An error counts while `last_error_at` is at most this old. */
export const ERROR_WINDOW_MS = 24 * 3_600_000;
/** "Seen in 7 days": the window for the distribution, Behind and Offline. */
export const SEEN_WINDOW_MS = 7 * 24 * 3_600_000;
/** Offline = seen in the window but not within this. */
export const OFFLINE_AFTER_MS = 24 * 3_600_000;
/** Needs attention shows at most this many boards. */
export const ATTENTION_LIMIT = 20;

export type AttentionKind = 'error' | 'behind' | 'offline';
export interface AttentionReason { kind: AttentionKind; text: string }

/** One board as the attention query reads it. `sequence` is its version's release row's; null = unrecognised. */
export interface BoardHealthRow {
  deviceId: string;
  name: string;
  ownerEmail: string | null;
  firmwareVersion: string | null;
  sequence: number | null;
  lastSeenAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** The current release (spec §1): the highest-sequence release that is not a TEST build and not an e2e version. */
export interface CurrentRelease { version: string; sequence: number }

function within(at: Date | null, windowMs: number, now: number): boolean {
  return at !== null && now - at.getTime() <= windowMs;
}

/** Why a board needs attention, most severe first; [] = it does not. */
export function attentionReasons(row: BoardHealthRow, current: CurrentRelease | null, now: number): AttentionReason[] {
  const out: AttentionReason[] = [];
  if (row.lastError && within(row.lastErrorAt, ERROR_WINDOW_MS, now)) {
    out.push({ kind: 'error', text: `Error ${relative(row.lastErrorAt, now)}: ${row.lastError}` });
  }
  const seen7d = within(row.lastSeenAt, SEEN_WINDOW_MS, now);
  // An unrecognised version (no release row, or none reported) counts as behind: nothing says it is not.
  if (seen7d && current && (row.sequence === null || row.sequence < current.sequence)) {
    out.push({ kind: 'behind', text: `Behind: runs ${row.firmwareVersion ?? 'unknown'}, current is ${current.version}` });
  }
  if (seen7d && !within(row.lastSeenAt, OFFLINE_AFTER_MS, now)) {
    out.push({ kind: 'offline', text: `Offline ${relative(row.lastSeenAt, now)}` });
  }
  return out;
}

const RANK: Record<AttentionKind, number> = { error: 0, behind: 1, offline: 2 };

/** Errors first, then behind, then offline (by each row's most severe reason); then most recently seen. */
export function sortAttention<T extends { reasons: AttentionReason[]; lastSeenAt: Date | null }>(rows: readonly T[]): T[] {
  const rank = (r: T) => (r.reasons.length ? Math.min(...r.reasons.map((x) => RANK[x.kind])) : 3);
  return [...rows].sort((a, b) =>
    rank(a) - rank(b) || (b.lastSeenAt?.getTime() ?? -Infinity) - (a.lastSeenAt?.getTime() ?? -Infinity));
}

export type AttentionRow = BoardHealthRow & { reasons: AttentionReason[] };

/** The Needs attention list: boards with a reason, sorted, at most ATTENTION_LIMIT. */
export function needsAttention(rows: readonly BoardHealthRow[], current: CurrentRelease | null, now: number): AttentionRow[] {
  const flagged = rows
    .map((r) => ({ ...r, reasons: attentionReasons(r, current, now) }))
    .filter((r) => r.reasons.length > 0);
  return sortAttention(flagged).slice(0, ATTENTION_LIMIT);
}

export interface DistributionInput { version: string | null; count: number; sequence: number | null }
export interface DistributionRow extends DistributionInput {
  /** count / the largest count, for the bar's width (0..1). */
  share: number;
  /** A release row exists for this version. */
  recognised: boolean;
  /** This version is the current release. */
  current: boolean;
}

/**
 * Newest release first by its sequence; versions with no release row last (by count, then name), a NULL version
 * after those. `currentSequence` tags the current release's row.
 */
export function orderDistribution(rows: readonly DistributionInput[], currentSequence: number | null): DistributionRow[] {
  const max = Math.max(0, ...rows.map((r) => r.count));
  const sorted = [...rows].sort((a, b) => {
    if (a.sequence !== null && b.sequence !== null) return b.sequence - a.sequence;
    if (a.sequence !== null) return -1;
    if (b.sequence !== null) return 1;
    if ((a.version === null) !== (b.version === null)) return a.version === null ? 1 : -1;
    return b.count - a.count || (a.version ?? '').localeCompare(b.version ?? '');
  });
  return sorted.map((r) => ({
    ...r,
    share: max > 0 ? r.count / max : 0,
    recognised: r.sequence !== null,
    current: r.sequence !== null && r.sequence === currentSequence,
  }));
}

/** The semver part of a version for display (the full string goes in `title`); "Unknown" for none reported. */
export function versionLabel(version: string | null): string {
  if (version === null) return 'Unknown';
  return semverOf(version) ?? version.split('+')[0];
}
