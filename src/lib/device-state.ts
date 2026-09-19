/**
 * How a device should be described, given what a human asked for and what the
 * device last reported.
 *
 * The parent spec's §7 rule is that the UI must never present desired state as
 * fact. That is why there are four states and not two: a divergence means
 * something different depending on whether the device is still talking to us.
 * "Mounting disk 2..." and "requested disk 2, last seen 4 minutes ago" carry
 * the same columns and mean opposite things to the person reading them.
 */
export type DeviceState = 'empty' | 'converged' | 'pending' | 'stale';

/**
 * Derived from the protocol, not chosen by feel. The poll holds 25 s and
 * touchLastSeen fires once per poll request, so a healthy device refreshes
 * last_seen_at at least every 25 s. Two missed polls plus slack. If the hold
 * duration changes, revisit this.
 */
export const STALE_AFTER_MS = 60_000;

export interface DeviceStateRow {
  desiredSha256: string | null;
  mountedSha256: string | null;
  lastSeenAt: Date | null;
}

export function deviceState(row: DeviceStateRow, now: number): DeviceState {
  if (row.desiredSha256 === row.mountedSha256) {
    // Includes both null: nothing wanted, nothing held.
    return row.desiredSha256 === null ? 'empty' : 'converged';
  }

  // They differ, so something is outstanding. Whether that reads as progress
  // or as a problem depends entirely on whether the device is still there.
  const seen = row.lastSeenAt?.getTime();
  if (seen === undefined || now - seen > STALE_AFTER_MS) return 'stale';
  return 'pending';
}

/**
 * Same threshold as `deviceState`'s stale check, but asked as its own
 * question: is this device online right now, independent of whether
 * anything is desired of it. devices/page.tsx's header count and the live
 * fingerprint both need exactly this predicate, so it lives here once
 * rather than twice.
 */
export function isOnline(lastSeenAt: Date | null, now: number): boolean {
  return lastSeenAt !== null && now - lastSeenAt.getTime() <= STALE_AFTER_MS;
}

/**
 * "5m ago", "never" -- the human-readable age of a timestamp. Shared by
 * DeviceCard (what a person reads) and the live fingerprint (what proves
 * that text stale), so the two can never drift apart.
 */
export function relative(from: Date | null, now: number): string {
  if (!from) return 'never';
  const s = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
