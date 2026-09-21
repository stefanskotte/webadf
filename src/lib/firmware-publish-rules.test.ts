import { describe, it, expect } from 'vitest';
import { decidePublish, PublishRefused, type ExistingRelease } from './firmware-publish-rules';

const input = (version: string, semver: string) => ({ version, semver });

describe('decidePublish', () => {
  it('gives the first release sequence 1', () => {
    expect(decidePublish([], input('1.0.0+ga111111', '1.0.0'))).toBe(1);
  });

  it('gives each later release the next sequence', () => {
    const existing: ExistingRelease[] = [{ version: '1.0.0+ga111111', semver: '1.0.0', sequence: 1 }];
    expect(decidePublish(existing, input('1.1.0+gb222222', '1.1.0'))).toBe(2);
  });

  // Sequences need not be contiguous, but they must only ever go up, because
  // the sequence IS the ordering and increment 2's anti-rollback reads it.
  it('continues above the highest existing sequence, not the count', () => {
    const existing: ExistingRelease[] = [
      { version: '1.0.0+ga111111', semver: '1.0.0', sequence: 1 },
      { version: '9.0.0+gz999999', semver: '9.0.0', sequence: 97 },
    ];
    expect(decidePublish(existing, input('9.0.1+gy888888', '9.0.1'))).toBe(98);
  });

  /**
   * A build whose source cannot be identified must never become the thing a
   * fleet is compared against. Refused in the publish script too; refused
   * here as well because a check that lives only in a script is a check that
   * can be skipped by anyone who calls the route directly.
   */
  it('refuses a dirty version', () => {
    expect(() => decidePublish([], input('1.0.0+ga111111-dirty', '1.0.0')))
      .toThrow(expect.objectContaining({ reason: 'dirty' }));
  });

  it('refuses a duplicate version', () => {
    const existing: ExistingRelease[] = [{ version: '1.0.0+ga111111', semver: '1.0.0', sequence: 1 }];
    expect(() => decidePublish(existing, input('1.0.0+ga111111', '1.0.0')))
      .toThrow(expect.objectContaining({ reason: 'duplicate_version' }));
  });

  // Publishing 0.9.0 after 1.0.0 is always a mistake, and the registry is the
  // ordering authority -- so it says no rather than recording an order that
  // contradicts the version every human reads.
  it('refuses a semver below the current maximum', () => {
    const existing: ExistingRelease[] = [{ version: '1.1.0+gb222222', semver: '1.1.0', sequence: 1 }];
    expect(() => decidePublish(existing, input('1.0.0+ga111111', '1.0.0')))
      .toThrow(expect.objectContaining({ reason: 'semver_regression' }));
  });

  it('compares semver numerically, so 1.10.0 is above 1.9.0', () => {
    const existing: ExistingRelease[] = [{ version: '1.9.0+ga111111', semver: '1.9.0', sequence: 1 }];
    expect(decidePublish(existing, input('1.10.0+gb222222', '1.10.0'))).toBe(2);
    const higher: ExistingRelease[] = [{ version: '1.10.0+gb222222', semver: '1.10.0', sequence: 1 }];
    expect(() => decidePublish(higher, input('1.9.0+ga111111', '1.9.0')))
      .toThrow(expect.objectContaining({ reason: 'semver_regression' }));
  });

  // Re-releasing the same semver from a new commit is ordinary -- a rebuild
  // with a fix that did not warrant a bump. Only going DOWN is refused.
  it('allows the same semver with a new build', () => {
    const existing: ExistingRelease[] = [{ version: '1.1.0+gb222222', semver: '1.1.0', sequence: 1 }];
    expect(decidePublish(existing, input('1.1.0+gc333333', '1.1.0'))).toBe(2);
  });

  it('refuses a semver that is not three numbers', () => {
    for (const bad of ['weird', '1.0', '1.0.0.0', 'v1.0.0', '1.0.0-rc1', '']) {
      expect(() => decidePublish([], input(`${bad}+ga111111`, bad)), bad)
        .toThrow(expect.objectContaining({ reason: 'bad_semver' }));
    }
  });

  // The suffix is what makes a version unique; a semver alone cannot identify
  // a build, and accepting one would put a string in the registry that no
  // board can ever report.
  it('refuses a version that does not carry the semver it claims', () => {
    expect(() => decidePublish([], input('2.0.0+ga111111', '1.0.0')))
      .toThrow(expect.objectContaining({ reason: 'version_semver_mismatch' }));
  });

  it('is a PublishRefused, so callers can map it to one status', () => {
    try {
      decidePublish([], input('1.0.0+ga111111-dirty', '1.0.0'));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishRefused);
    }
  });
});
