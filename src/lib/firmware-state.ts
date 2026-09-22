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
  notes: string | null;
}

export type FirmwareState =
  /** The device has never reported a version. */
  | { kind: 'unknown' }
  /**
   * Nothing has been published, so there is nothing to compare against. Its
   * own state rather than `unrecognised`, because calling every board in the
   * fleet an unrecognised build on the day this ships -- before the operator
   * has published anything -- is a verdict the system has no basis for.
   */
  | { kind: 'unavailable'; version: string }
  /** A build the registry has never seen, alongside releases it has. */
  | { kind: 'unrecognised'; version: string }
  | { kind: 'current'; version: string }
  | {
      kind: 'behind';
      version: string;
      releasesBehind: number;
      latest: ReleaseRef;
      /** True when ANY release newer than this device's is a security release. */
      securityPending: boolean;
    };

/**
 * The registry, indexed once per render rather than re-walked per device.
 *
 * Built once and shared: `latest` is a property of the release list, not of
 * any device, and recomputing it inside every card meant two independent
 * "which release is newest" calculations that could disagree.
 */
export interface Registry {
  /** Newest first. */
  ordered: readonly ReleaseRef[];
  latest: ReleaseRef | null;
  byVersion: ReadonlyMap<string, { sequence: number; rank: number }>;
}

export function buildRegistry(releases: readonly ReleaseRef[]): Registry {
  // Sorted here rather than trusted from the caller, so an unsorted query
  // result cannot silently change every answer on the page.
  const ordered = [...releases].sort((a, b) => b.sequence - a.sequence);
  const byVersion = new Map(
    ordered.map((r, rank) => [r.version, { sequence: r.sequence, rank }]),
  );
  return { ordered, latest: ordered[0] ?? null, byVersion };
}

export function firmwareState(reported: string | null, reg: Registry): FirmwareState {
  // An empty string is not a reading. It cannot reach here from the status
  // route (firmwareVersionSchema has .min(1)), but a column can hold one from
  // before that bound existed, and "" must not be looked up as a version.
  if (!reported) return { kind: 'unknown' };
  if (!reg.latest) return { kind: 'unavailable', version: reported };

  const match = reg.byVersion.get(reported);
  if (!match) return { kind: 'unrecognised', version: reported };

  // `rank` is the index in the newest-first order, so it IS the number of
  // releases ahead of this one -- counted rather than subtracted, because
  // sequences need not be contiguous.
  if (match.rank === 0) return { kind: 'current', version: reported };

  return {
    kind: 'behind',
    version: reported,
    releasesBehind: match.rank,
    latest: reg.latest,
    // Across EVERY release newer than this device's, not just the newest.
    // Reading only the newest meant a security release followed by an
    // ordinary one went quiet for exactly the boards still missing the fix.
    securityPending: reg.ordered.slice(0, match.rank).some((r) => r.security),
  };
}

export function countBehind(states: readonly FirmwareState[]): number {
  return states.filter((s) => s.kind === 'behind').length;
}

/**
 * How a firmware state is worded, in ONE place.
 *
 * Here rather than in the card, following src/lib/mount-wording.ts: the
 * wording is then covered by vitest rather than only by a full Playwright run,
 * and the card and the notice band cannot drift on what "behind" is called.
 */
export function firmwareLabel(state: FirmwareState): string {
  if (state.kind === 'unknown') return 'fw unknown';
  const suffix =
    state.kind === 'unavailable' ? 'no releases published'
    : state.kind === 'unrecognised' ? 'unrecognised build'
    : state.kind === 'current' ? 'up to date'
    : `${state.releasesBehind} ${state.releasesBehind === 1 ? 'release' : 'releases'} behind`;
  return `fw ${state.version} · ${suffix}`;
}
