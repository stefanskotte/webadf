import { describe, it, expect } from 'vitest';
import { githubReleasePlan, isTestBuild, assertSameBytes } from './firmware-github-release';

const base = {
  version: '1.8.1+g1f343d5', semver: '1.8.1', sequence: 50, sha256: 'a'.repeat(64),
  signature: 'c2ln', signingKeyId: 'wf-123', notes: 'TLS heap relief',
};

describe('the GitHub release for a published firmware version', () => {
  it('is tagged fw-<semver> and carries the signed manifest', () => {
    const p = githubReleasePlan(base);
    expect(p.publish).toBe(true);
    if (!p.publish) return;
    expect(p.tag).toBe('fw-1.8.1');
    expect(p.title).toBe('Firmware 1.8.1');
    expect(p.body).toContain('1.8.1+g1f343d5');
    expect(p.body).toContain('TLS heap relief');
    expect(p.manifest).toMatchObject({ sha256: base.sha256, signature: 'c2ln', sequence: 50, signingKeyId: 'wf-123' });
  });

  it('never publishes a TEST build', () => {
    expect(isTestBuild('TEST build: DF1 on by default')).toBe(true);
    expect(isTestBuild('a release')).toBe(false);
    expect(isTestBuild(null)).toBe(false);
    expect(githubReleasePlan({ ...base, notes: 'TEST build: bench only' }).publish).toBe(false);
  });

  it('refuses a semver that is not three numbers', () => {
    expect(githubReleasePlan({ ...base, semver: '1.8' }).publish).toBe(false);
  });

  it('works without notes', () => {
    const p = githubReleasePlan({ ...base, notes: null });
    expect(p.publish).toBe(true);
  });

  it('refuses to attach bytes that are not the published ones', () => {
    expect(() => assertSameBytes('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
    expect(() => assertSameBytes('a'.repeat(64), 'b'.repeat(64))).toThrow(/not the published one/);
  });
});
