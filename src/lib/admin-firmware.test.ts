import { describe, it, expect } from 'vitest';
import {
  stripTestPrefix, githubReleaseUrl, clampPage, firmwareRepo,
  FIRMWARE_PAGE_SIZE, FIRMWARE_REPO_DEFAULT,
} from './admin-firmware';

describe('stripTestPrefix', () => {
  it('removes "TEST build" and the punctuation and spaces after it', () => {
    expect(stripTestPrefix('TEST build: DF1 fix')).toBe('DF1 fix');
    expect(stripTestPrefix('TEST build -- DF1 fix')).toBe('DF1 fix');
    expect(stripTestPrefix('TEST build – DF1 fix')).toBe('DF1 fix');
    expect(stripTestPrefix('TEST build — DF1 fix')).toBe('DF1 fix');
    expect(stripTestPrefix('TEST build · DF1 fix')).toBe('DF1 fix');
    expect(stripTestPrefix('TEST build, DF1 fix')).toBe('DF1 fix');
    expect(stripTestPrefix('TEST build. DF1 fix')).toBe('DF1 fix');
    expect(stripTestPrefix('TEST build e2e promote')).toBe('e2e promote');
  });

  it('leaves the rest of the notes alone, punctuation included', () => {
    expect(stripTestPrefix('TEST build: a - b: c.')).toBe('a - b: c.');
  });

  it('a bare "TEST build" becomes empty', () => {
    expect(stripTestPrefix('TEST build')).toBe('');
    expect(stripTestPrefix('TEST build -: ')).toBe('');
  });

  it('notes that do not start "TEST build" are unchanged', () => {
    expect(stripTestPrefix('Fixes DF1. TEST build later')).toBe('Fixes DF1. TEST build later');
    expect(stripTestPrefix('test build: lower case')).toBe('test build: lower case');
    expect(stripTestPrefix('')).toBe('');
  });
});

describe('githubReleaseUrl', () => {
  const repo = 'stefanskotte/webadf';
  it('a release with a plain x.y.z semver links to its fw-<semver> tag', () => {
    expect(githubReleaseUrl('1.21.1', 'Uploads survive outages.', repo))
      .toBe('https://github.com/stefanskotte/webadf/releases/tag/fw-1.21.1');
    expect(githubReleaseUrl('1.0.0', null, 'me/fork')).toBe('https://github.com/me/fork/releases/tag/fw-1.0.0');
  });

  it('a TEST build has no link', () => {
    expect(githubReleaseUrl('1.21.1', 'TEST build: bench', repo)).toBeNull();
  });

  it('a semver that is not plain x.y.z has no link', () => {
    expect(githubReleaseUrl('1.0.0-rc1', null, repo)).toBeNull();
    expect(githubReleaseUrl('1.0', null, repo)).toBeNull();
    expect(githubReleaseUrl('v1.0.0', null, repo)).toBeNull();
  });
});

describe('clampPage', () => {
  it('passes a page inside the range through', () => {
    expect(clampPage('1', 3)).toBe(1);
    expect(clampPage('2', 3)).toBe(2);
    expect(clampPage('3', 3)).toBe(3);
  });

  it('clamps garbage, zero, negatives and past-the-end (Review Focus 5)', () => {
    expect(clampPage(undefined, 3)).toBe(1);
    expect(clampPage('', 3)).toBe(1);
    expect(clampPage('abc', 3)).toBe(1);
    expect(clampPage('0', 3)).toBe(1);
    expect(clampPage('-1', 3)).toBe(1);
    expect(clampPage('9999', 3)).toBe(3);
    expect(clampPage('1.5', 3)).toBe(1);
    expect(clampPage(['2', '3'], 3)).toBe(2);
  });

  it('there is always a page 1, even with no rows', () => {
    expect(clampPage('5', 0)).toBe(1);
    expect(clampPage(undefined, 0)).toBe(1);
  });
});

describe('repo and page size', () => {
  it('25 per page', () => {
    expect(FIRMWARE_PAGE_SIZE).toBe(25);
  });

  it('WEBADF_FIRMWARE_REPO wins, else the default the importer uses', () => {
    expect(FIRMWARE_REPO_DEFAULT).toBe('stefanskotte/webadf');
    expect(firmwareRepo(undefined)).toBe('stefanskotte/webadf');
    expect(firmwareRepo('me/fork')).toBe('me/fork');
  });
});
