import { describe, it, expect } from 'vitest';
import { buildRegistry, type ReleaseRef } from './firmware-state';
import {
  refuseTarget, overBatchCap, MAX_UPDATE_BATCH, type TargetCandidate,
} from './firmware-update-rules';

const rel = (version: string, sequence: number, semver: string): ReleaseRef =>
  ({ version, sequence, semver, security: false, notes: null, signatureFormat: 2 });

const releases = [
  rel('1.0.0+ga111111', 1, '1.0.0'),
  rel('1.1.0+gb222222', 2, '1.1.0'),
  rel('1.2.0+gc333333', 3, '1.2.0'),
];
const reg = buildRegistry(releases);
const latest = releases[2];

const dev = (over: Partial<TargetCandidate> = {}): TargetCandidate => ({
  id: 'd1', name: 'Bench', updateProtocol: 1, firmwareVersion: '1.0.0+ga111111', ...over,
});

describe('refuseTarget', () => {
  it('allows a board that is behind', () => {
    expect(refuseTarget(dev(), latest, reg)).toBeNull();
  });

  // Every board in the field today. The UI never offers the control, so
  // reaching this means the page was stale.
  it('refuses a board that cannot update', () => {
    expect(refuseTarget(dev({ updateProtocol: null }), latest, reg)).toBe('cannot_update');
    expect(refuseTarget(dev({ updateProtocol: 0 }), latest, reg)).toBe('cannot_update');
  });

  it('refuses a board already running the target', () => {
    expect(refuseTarget(dev({ firmwareVersion: '1.2.0+gc333333' }), latest, reg))
      .toBe('already_current');
  });

  it('refuses a target below what the board runs', () => {
    const older = releases[0];
    expect(refuseTarget(dev({ firmwareVersion: '1.2.0+gc333333' }), older, reg))
      .toBe('would_roll_back');
  });

  /**
   * A board running something hand-flashed has no sequence, so nothing rules
   * it out -- and offering it the update is the RECOVERY path. This is the one
   * case where "we do not recognise this" must not become "we refuse".
   */
  it('allows an unrecognised build, which is how a hand-flashed board recovers', () => {
    expect(refuseTarget(dev({ firmwareVersion: 'verify-a286680' }), latest, reg)).toBeNull();
    expect(refuseTarget(dev({ firmwareVersion: '1.0.0+gdeadbee-dirty' }), latest, reg)).toBeNull();
  });

  it('allows a board that has never reported a version', () => {
    expect(refuseTarget(dev({ firmwareVersion: null }), latest, reg)).toBeNull();
  });

  // Re-flashing the same sequence is not a rollback; only going DOWN is.
  it('treats an equal sequence as already current, not a rollback', () => {
    expect(refuseTarget(dev({ firmwareVersion: '1.1.0+gb222222' }), releases[1], reg))
      .toBe('already_current');
  });

  it('refuses a target release the board cannot verify (signature format 1)', () => {
    const unverifiable = buildRegistry([{ ...rel('1.1.0+ga', 2, '1.1.0'), signatureFormat: 1 }]);
    expect(refuseTarget(dev({ firmwareVersion: '1.0.0+gold' }), unverifiable.latest!, unverifiable))
      .toBe('unverifiable_release');
  });
});

/**
 * The batch cap is one number with two readers: the route's zod schema
 * refuses past it, and the update bar disables Update and says how many to
 * untick. A cap the UI did not know about surfaced as a generic
 * "Could not request the update." with nothing to act on.
 */
describe('overBatchCap', () => {
  it('is 50, the number the route has always enforced', () => {
    expect(MAX_UPDATE_BATCH).toBe(50);
  });

  it('is zero at and under the cap', () => {
    expect(overBatchCap(0)).toBe(0);
    expect(overBatchCap(1)).toBe(0);
    expect(overBatchCap(MAX_UPDATE_BATCH)).toBe(0);
  });

  it('is how many to untick past the cap', () => {
    expect(overBatchCap(MAX_UPDATE_BATCH + 1)).toBe(1);
    expect(overBatchCap(73)).toBe(23);
  });
});
