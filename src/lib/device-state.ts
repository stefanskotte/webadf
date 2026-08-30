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
