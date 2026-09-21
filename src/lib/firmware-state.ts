/**
 * Whether a device is running the current firmware.
 *
 * Pure, and deliberately NOT a version comparison (spec D2). The registry's
 * `sequence` is the ordering authority: a reported string is looked up, and a
 * string that is not in the registry is `unrecognised` -- never `current`.
 *
 * Comparing semver instead would report a dirty bench build of `1.0.0` as up
 * to date against released `1.0.0`, because the two share a semver and differ
 * only in the git suffix. That is precisely the dishonesty this increment
 * exists to remove, so the cheaper-looking design is the wrong one.
 */
export interface ReleaseRef {
  version: string;
  sequence: number;
  semver: string;
  security: boolean;
}

export type FirmwareState =
  | { kind: 'unknown' }
  | { kind: 'unrecognised'; version: string }
  | { kind: 'current'; version: string }
  | { kind: 'behind'; version: string; releasesBehind: number; latest: ReleaseRef };

export function firmwareState(
  reported: string | null,
  releases: readonly ReleaseRef[],
): FirmwareState {
  // An empty string is not a reading. It cannot reach here from the status
  // route (firmwareVersionSchema has .min(1)), but a column can hold one from
  // before that bound existed, and "" must not be looked up as a version.
  if (!reported) return { kind: 'unknown' };

  const match = releases.find((r) => r.version === reported);
  if (!match) return { kind: 'unrecognised', version: reported };

  // Highest sequence wins, computed rather than assumed, so an unsorted query
  // result cannot silently change the answer.
  const latest = releases.reduce((a, b) => (b.sequence > a.sequence ? b : a));
  if (match.sequence >= latest.sequence) return { kind: 'current', version: reported };

  return {
    kind: 'behind',
    version: reported,
    // Counted, not subtracted: sequences need not be contiguous, and a gap
    // would otherwise report a device as further behind than it is.
    releasesBehind: releases.filter((r) => r.sequence > match.sequence).length,
    latest,
  };
}

export function countBehind(states: readonly FirmwareState[]): number {
  return states.filter((s) => s.kind === 'behind').length;
}
