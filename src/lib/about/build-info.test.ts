import { describe, it, expect } from 'vitest';
import { resolveCommit, shortCommit, commitUrl } from './build-info';

const SHA = 'c6e4639aabbccddeeff00112233445566778899a';

describe('resolveCommit', () => {
  it('prefers Vercel', () => {
    expect(resolveCommit({ VERCEL_GIT_COMMIT_SHA: SHA, GIT_SHA: 'other' }, () => 'git')).toBe(SHA);
  });
  it('falls back to GIT_SHA (a Docker build argument)', () => {
    expect(resolveCommit({ GIT_SHA: ` ${SHA}\n` }, () => 'git')).toBe(SHA);
  });
  it('falls back to git', () => {
    expect(resolveCommit({}, () => `${SHA}\n`)).toBe(SHA);
  });
  it('says unknown when git is missing or throws', () => {
    expect(resolveCommit({}, () => null)).toBe('unknown');
    expect(resolveCommit({ GIT_SHA: '' }, () => { throw new Error('no .git'); })).toBe('unknown');
  });
});

describe('shortCommit / commitUrl', () => {
  it('shortens a full sha and links it', () => {
    expect(shortCommit(SHA)).toBe('c6e4639');
    expect(commitUrl(SHA)).toBe(`https://github.com/stefanskotte/webadf/commit/${SHA}`);
  });
  it('never links something that is not a full sha', () => {
    expect(shortCommit('unknown')).toBe('unknown');
    expect(commitUrl('unknown')).toBeNull();
    expect(commitUrl('c6e4639')).toBeNull();
  });
});
