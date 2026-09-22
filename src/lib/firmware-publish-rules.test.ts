import { describe, it, expect } from 'vitest';
import { decidePublish, PublishRefused, type ExistingRelease } from './firmware-publish-rules';

const input = (version: string) => ({ version });

describe('decidePublish', () => {
  it('gives the first release sequence 1', () => {
    expect(decidePublish([], input('1.0.0+ga111111'))).toBe(1);
  });

  it('gives each later release the next sequence', () => {
    const existing: ExistingRelease[] = [{ version: '1.0.0+ga111111', semver: '1.0.0', sequence: 1 }];
    expect(decidePublish(existing, input('1.1.0+gb222222'))).toBe(2);
  });

  // Sequences need not be contiguous, but they must only ever go up, because
  // the sequence IS the ordering and increment 2's anti-rollback reads it.
  it('continues above the highest existing sequence, not the count', () => {
    const existing: ExistingRelease[] = [
      { version: '1.0.0+ga111111', semver: '1.0.0', sequence: 1 },
      { version: '9.0.0+gz999999', semver: '9.0.0', sequence: 97 },
    ];
    expect(decidePublish(existing, input('9.0.1+gy888888'))).toBe(98);
  });

  /**
   * A build whose source cannot be identified must never become the thing a
   * fleet is compared against. Refused in the publish script too; refused
   * here as well because a check that lives only in a script is a check that
   * can be skipped by anyone who calls the route directly.
   */
  it('refuses a dirty version', () => {
    expect(() => decidePublish([], input('1.0.0+ga111111-dirty')))
      .toThrow(expect.objectContaining({ reason: 'unidentifiable_build' }));
  });

  /**
   * +nogit is WORSE than -dirty: a dirty build at least names its base
   * commit, while a nogit build names nothing, and two different images
   * produce the identical string. The original rule was a string match on
   * '-dirty' alone, so this published cleanly and could have become the
   * thing the whole fleet was compared against.
   */
  it('refuses a build made where git was unavailable', () => {
    expect(() => decidePublish([], input('1.0.0+nogit')))
      .toThrow(expect.objectContaining({ reason: 'unidentifiable_build' }));
  });

  it('refuses a duplicate version', () => {
    const existing: ExistingRelease[] = [{ version: '1.0.0+ga111111', semver: '1.0.0', sequence: 1 }];
    expect(() => decidePublish(existing, input('1.0.0+ga111111')))
      .toThrow(expect.objectContaining({ reason: 'duplicate_version' }));
  });

  // Publishing 0.9.0 after 1.0.0 is always a mistake, and the registry is the
  // ordering authority -- so it says no rather than recording an order that
  // contradicts the version every human reads.
  it('refuses a semver below the current maximum', () => {
    const existing: ExistingRelease[] = [{ version: '1.1.0+gb222222', semver: '1.1.0', sequence: 1 }];
    expect(() => decidePublish(existing, input('1.0.0+ga111111')))
      .toThrow(expect.objectContaining({ reason: 'semver_regression' }));
  });

  it('compares semver numerically, so 1.10.0 is above 1.9.0', () => {
    const existing: ExistingRelease[] = [{ version: '1.9.0+ga111111', semver: '1.9.0', sequence: 1 }];
    expect(decidePublish(existing, input('1.10.0+gb222222'))).toBe(2);
    const higher: ExistingRelease[] = [{ version: '1.10.0+gb222222', semver: '1.10.0', sequence: 1 }];
    expect(() => decidePublish(higher, input('1.9.0+ga111111')))
      .toThrow(expect.objectContaining({ reason: 'semver_regression' }));
  });

  // Re-releasing the same semver from a new commit is ordinary -- a rebuild
  // with a fix that did not warrant a bump. Only going DOWN is refused.
  it('allows the same semver with a new build', () => {
    const existing: ExistingRelease[] = [{ version: '1.1.0+gb222222', semver: '1.1.0', sequence: 1 }];
    expect(decidePublish(existing, input('1.1.0+gc333333'))).toBe(2);
  });

  it('refuses a version whose semver is not three numbers', () => {
    for (const bad of ['weird', '1.0', '1.0.0.0', 'v1.0.0', '1.0.0-rc1', '']) {
      expect(() => decidePublish([], input(`${bad}+ga111111`)), bad)
        .toThrow(expect.objectContaining({ reason: 'bad_semver' }));
    }
  });

  // The suffix is what makes a version unique; a bare semver identifies no
  // build and no board could ever report it.
  it('refuses a version with no build identity at all', () => {
    expect(() => decidePublish([], input('1.0.0')))
      .toThrow(expect.objectContaining({ reason: 'bad_semver' }));
  });

  /**
   * One malformed row already in the registry used to make EVERY later
   * publish die reporting bad_semver -- blaming a well-formed candidate for
   * a row it had nothing to do with, after the artifact was already uploaded.
   */
  it('ignores an existing row whose semver does not parse', () => {
    const existing: ExistingRelease[] = [
      { version: 'junk', semver: 'not-a-semver', sequence: 1 },
      { version: '1.0.0+ga111111', semver: '1.0.0', sequence: 2 },
    ];
    expect(decidePublish(existing, input('1.1.0+gb222222'))).toBe(3);
  });

  it('is a PublishRefused, so callers can map it to one status', () => {
    try {
      decidePublish([], input('1.0.0+ga111111-dirty'));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishRefused);
    }
  });
});
