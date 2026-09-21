import { describe, it, expect } from 'vitest';
import { firmwareState, countBehind, type ReleaseRef } from './firmware-state';

const rel = (version: string, sequence: number, semver: string, security = false): ReleaseRef =>
  ({ version, sequence, semver, security });

const registry: ReleaseRef[] = [
  rel('1.0.0+ga111111', 1, '1.0.0'),
  rel('1.1.0+gb222222', 2, '1.1.0'),
  rel('1.2.0+gc333333', 3, '1.2.0', true),
];

describe('firmwareState', () => {
  it('is unknown when the device has never reported a version', () => {
    expect(firmwareState(null, registry)).toEqual({ kind: 'unknown' });
  });

  it('is current when the reported version is the newest release', () => {
    expect(firmwareState('1.2.0+gc333333', registry))
      .toEqual({ kind: 'current', version: '1.2.0+gc333333' });
  });

  it('counts how many releases a device is behind', () => {
    const s = firmwareState('1.0.0+ga111111', registry);
    expect(s).toMatchObject({ kind: 'behind', releasesBehind: 2 });
    expect(s).toMatchObject({ latest: { version: '1.2.0+gc333333', security: true } });
  });

  it('counts one behind for the release just before the newest', () => {
    expect(firmwareState('1.1.0+gb222222', registry))
      .toMatchObject({ kind: 'behind', releasesBehind: 1 });
  });

  /**
   * The case the whole design turns on. A bench build's semver is EQUAL to a
   * release's, so any comparison-based scheme calls it up to date. It is not
   * up to date -- it is a build nobody can account for, and saying so is the
   * only honest answer. The second string is what the board on the bench was
   * actually reporting before this increment.
   */
  it('calls an unregistered build unrecognised, never current', () => {
    expect(firmwareState('1.2.0+gdeadbee-dirty', registry))
      .toEqual({ kind: 'unrecognised', version: '1.2.0+gdeadbee-dirty' });
    expect(firmwareState('verify-a286680', registry))
      .toEqual({ kind: 'unrecognised', version: 'verify-a286680' });
    expect(firmwareState('4b.0-dev', registry))
      .toEqual({ kind: 'unrecognised', version: '4b.0-dev' });
  });

  it('is unrecognised when the registry is empty, not current', () => {
    expect(firmwareState('1.0.0+ga111111', []))
      .toEqual({ kind: 'unrecognised', version: '1.0.0+ga111111' });
  });

  it('is still unknown when the registry is empty and nothing was reported', () => {
    expect(firmwareState(null, [])).toEqual({ kind: 'unknown' });
  });

  // Ordering comes from `sequence`, never from array order and never from the
  // version string, so an unsorted query result cannot change the answer.
  it('reads the newest release from sequence, not from array order', () => {
    const shuffled = [registry[2], registry[0], registry[1]];
    expect(firmwareState('1.2.0+gc333333', shuffled)).toMatchObject({ kind: 'current' });
    expect(firmwareState('1.0.0+ga111111', shuffled)).toMatchObject({ releasesBehind: 2 });
  });

  // Sequences need not be contiguous -- a deleted release would leave a gap --
  // so "behind" counts releases that exist, not the arithmetic difference.
  it('counts releases rather than subtracting sequence numbers', () => {
    const gapped = [rel('1.0.0+ga111111', 1, '1.0.0'), rel('9.0.0+gz999999', 97, '9.0.0')];
    expect(firmwareState('1.0.0+ga111111', gapped))
      .toMatchObject({ kind: 'behind', releasesBehind: 1 });
  });

  it('treats an empty reported string as unknown, not as a version', () => {
    expect(firmwareState('', registry)).toEqual({ kind: 'unknown' });
  });
});

describe('countBehind', () => {
  it('counts only devices that are behind', () => {
    expect(countBehind([
      firmwareState('1.0.0+ga111111', registry),   // behind
      firmwareState('1.2.0+gc333333', registry),   // current
      firmwareState(null, registry),               // unknown
      firmwareState('verify-a286680', registry),   // unrecognised
    ])).toBe(1);
  });

  it('is zero for an empty fleet', () => {
    expect(countBehind([])).toBe(0);
  });
});
