/**
 * The rules that decide whether a firmware release may be published, and what
 * sequence it gets.
 *
 * Pure, and separate from the database write, because these rules are the
 * whole safety of the registry and this repo's vitest has no DATABASE_URL --
 * so anything that needs a connection is only ever exercised by e2e. The
 * rules deserve better coverage than that.
 */

export type PublishRefusalReason =
  | 'dirty'
  | 'duplicate_version'
  | 'semver_regression'
  | 'bad_semver'
  | 'version_semver_mismatch';

export class PublishRefused extends Error {
  constructor(public readonly reason: PublishRefusalReason) {
    super(`firmware publish refused: ${reason}`);
    this.name = 'PublishRefused';
  }
}

export interface ExistingRelease {
  version: string;
  semver: string;
  sequence: number;
}

export interface PublishCandidate {
  version: string;
  semver: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function semverParts(s: string): [number, number, number] {
  const m = SEMVER_RE.exec(s);
  if (!m) throw new PublishRefused('bad_semver');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1, 0 or 1. Numeric per component, so "1.10.0" is above "1.9.0". */
function compareSemver(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Returns the sequence the release should get, or throws PublishRefused.
 *
 * `existing` is every release already in the registry. It is passed whole
 * rather than pre-aggregated so that every rule reads the same snapshot --
 * a max(sequence) and a separate duplicate check could otherwise disagree.
 */
export function decidePublish(
  existing: readonly ExistingRelease[],
  candidate: PublishCandidate,
): number {
  // Validate the semver first, so a malformed one is reported as bad_semver
  // rather than as whatever the later comparisons happen to do with it.
  semverParts(candidate.semver);

  // The version must actually carry the semver it claims. Without this a
  // release could be filed under an ordering its own string contradicts,
  // and the Devices tab would show a version that no board could report.
  if (!candidate.version.startsWith(`${candidate.semver}+`)) {
    throw new PublishRefused('version_semver_mismatch');
  }

  if (candidate.version.endsWith('-dirty')) throw new PublishRefused('dirty');

  if (existing.some((r) => r.version === candidate.version)) {
    throw new PublishRefused('duplicate_version');
  }

  for (const r of existing) {
    if (compareSemver(candidate.semver, r.semver) < 0) {
      throw new PublishRefused('semver_regression');
    }
  }

  return existing.reduce((m, r) => (r.sequence > m ? r.sequence : m), 0) + 1;
}
