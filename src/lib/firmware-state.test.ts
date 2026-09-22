import { describe, it, expect } from 'vitest';
import {
  firmwareState, countBehind, buildRegistry, firmwareLabel, type ReleaseRef,
} from './firmware-state';

const rel = (version: string, sequence: number, semver: string, security = false): ReleaseRef =>
  ({ version, sequence, semver, security, notes: null });

const releases: ReleaseRef[] = [
  rel('1.0.0+ga111111', 1, '1.0.0'),
  rel('1.1.0+gb222222', 2, '1.1.0'),
  rel('1.2.0+gc333333', 3, '1.2.0', true),
];
const registry = buildRegistry(releases);
const empty = buildRegistry([]);

describe('firmwareState', () => {
  it('is unknown when the device has never reported a version', () => {
    expect(firmwareState(null, registry)).toEqual({ kind: 'unknown' });
    expect(firmwareState('', registry)).toEqual({ kind: 'unknown' });
  });

  /**
   * The state this increment ships in: no release has been published yet,
   * because the first one needs the operator at the Mac with the signing key.
   * Accusing every board in the fleet of running an unrecognised build in the
   * meantime is a verdict nothing supports.
   */
  it('says so when nothing has been published, rather than accusing the device', () => {
    expect(firmwareState('1.0.0+ga111111', empty))
      .toEqual({ kind: 'unavailable', version: '1.0.0+ga111111' });
    expect(firmwareState(null, empty)).toEqual({ kind: 'unknown' });
  });

  it('is current when the reported version is the newest release', () => {
    expect(firmwareState('1.2.0+gc333333', registry))
      .toEqual({ kind: 'current', version: '1.2.0+gc333333' });
  });

  it('counts how many releases a device is behind', () => {
    expect(firmwareState('1.0.0+ga111111', registry))
      .toMatchObject({ kind: 'behind', releasesBehind: 2, latest: { version: '1.2.0+gc333333' } });
    expect(firmwareState('1.1.0+gb222222', registry))
      .toMatchObject({ kind: 'behind', releasesBehind: 1 });
  });

  /**
   * The case the whole design turns on. A bench build's semver is EQUAL to a
   * release's, so any comparison-based scheme calls it up to date. It is not
   * up to date -- it is a build nobody can account for. The second string is
   * what the board on the bench actually reported before this increment.
   */
  it('calls an unregistered build unrecognised, never current', () => {
    for (const v of ['1.2.0+gdeadbee-dirty', 'verify-a286680', '4b.0-dev']) {
      expect(firmwareState(v, registry), v).toEqual({ kind: 'unrecognised', version: v });
    }
  });

  it('reads the ordering from sequence, not from array order', () => {
    const shuffled = buildRegistry([releases[2], releases[0], releases[1]]);
    expect(firmwareState('1.2.0+gc333333', shuffled)).toMatchObject({ kind: 'current' });
    expect(firmwareState('1.0.0+ga111111', shuffled)).toMatchObject({ releasesBehind: 2 });
  });

  // Sequences need not be contiguous -- a deleted release leaves a gap -- so
  // "behind" counts releases that exist rather than subtracting numbers.
  it('counts releases rather than subtracting sequence numbers', () => {
    const gapped = buildRegistry([rel('1.0.0+ga111111', 1, '1.0.0'), rel('9.0.0+gz999999', 97, '9.0.0')]);
    expect(firmwareState('1.0.0+ga111111', gapped))
      .toMatchObject({ kind: 'behind', releasesBehind: 1 });
  });
});

describe('securityPending', () => {
  it('is true when the newest release is a security release', () => {
    expect(firmwareState('1.1.0+gb222222', registry)).toMatchObject({ securityPending: true });
  });

  /**
   * The case the flag exists for, and the one reading only the newest release
   * got wrong: a security release followed by an ordinary one. The board is
   * still missing the security fix, and the signal must not go quiet just
   * because something duller shipped afterwards.
   */
  it('is true when a security release is skipped over by a later ordinary one', () => {
    const reg = buildRegistry([
      rel('1.0.0+ga111111', 1, '1.0.0'),
      rel('1.1.0+gb222222', 2, '1.1.0', true),   // security
      rel('1.1.1+gc333333', 3, '1.1.1'),          // ordinary, newest
    ]);
    expect(firmwareState('1.0.0+ga111111', reg)).toMatchObject({ securityPending: true });
  });

  it('is false when nothing newer is a security release', () => {
    const reg = buildRegistry([
      rel('1.0.0+ga111111', 1, '1.0.0'),
      rel('1.1.0+gb222222', 2, '1.1.0'),
    ]);
    expect(firmwareState('1.0.0+ga111111', reg)).toMatchObject({ securityPending: false });
  });

  it('ignores a security release the device already has', () => {
    const reg = buildRegistry([
      rel('1.0.0+ga111111', 1, '1.0.0', true),    // security, already running
      rel('1.1.0+gb222222', 2, '1.1.0'),
    ]);
    expect(firmwareState('1.0.0+ga111111', reg)).toMatchObject({ securityPending: false });
  });
});

describe('firmwareLabel', () => {
  it('words every state, and pluralises', () => {
    expect(firmwareLabel(firmwareState(null, registry))).toBe('fw unknown');
    expect(firmwareLabel(firmwareState('1.2.0+gc333333', registry)))
      .toBe('fw 1.2.0+gc333333 · up to date');
    expect(firmwareLabel(firmwareState('1.1.0+gb222222', registry)))
      .toBe('fw 1.1.0+gb222222 · 1 release behind');
    expect(firmwareLabel(firmwareState('1.0.0+ga111111', registry)))
      .toBe('fw 1.0.0+ga111111 · 2 releases behind');
    expect(firmwareLabel(firmwareState('nope', registry)))
      .toBe('fw nope · unrecognised build');
    expect(firmwareLabel(firmwareState('1.0.0+ga111111', empty)))
      .toBe('fw 1.0.0+ga111111 · no releases published');
  });
});

describe('countBehind', () => {
  it('counts only devices that are behind', () => {
    expect(countBehind([
      firmwareState('1.0.0+ga111111', registry),   // behind
      firmwareState('1.2.0+gc333333', registry),   // current
      firmwareState(null, registry),               // unknown
      firmwareState('verify-a286680', registry),   // unrecognised
      firmwareState('1.0.0+ga111111', empty),      // unavailable
    ])).toBe(1);
  });

  it('is zero for an empty fleet', () => {
    expect(countBehind([])).toBe(0);
  });
});
