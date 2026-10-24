// Pure rules for the admin Firmware page (A7 spec §3). No I/O: the page and the promote route do that.

import { isTestBuild } from '@/lib/firmware-github-release';

/** Releases per page on /admin/firmware. */
export const FIRMWARE_PAGE_SIZE = 25;

/**
 * The GitHub repository firmware releases live in, when WEBADF_FIRMWARE_REPO is unset. One constant for the importer
 * (firmware-import.ts, which a self-hoster points at a fork) and the admin page's links, so the two cannot disagree.
 */
export const FIRMWARE_REPO_DEFAULT = 'stefanskotte/webadf';

/** WEBADF_FIRMWARE_REPO, else FIRMWARE_REPO_DEFAULT. Read per call so a test can set it. */
export function firmwareRepo(raw: string | undefined = process.env.WEBADF_FIRMWARE_REPO): string {
  return raw || FIRMWARE_REPO_DEFAULT;
}

/**
 * The notes a promoted TEST build starts from: the leading "TEST build" and the punctuation and spaces right after it
 * removed ("TEST build: DF1 fix" -> "DF1 fix"). Notes that do not start "TEST build" come back unchanged.
 */
export function stripTestPrefix(notes: string): string {
  if (!notes.startsWith('TEST build')) return notes;
  return notes.slice('TEST build'.length).replace(/^[\s\-–—:·,.]+/, '');
}

/**
 * The GitHub release page for a Release row: `fw-<semver>` (githubReleasePlan's tag). Null for a TEST build (never
 * published to GitHub) and for a semver that is not plain x.y.z (githubReleasePlan refuses those too).
 */
export function githubReleaseUrl(semver: string, notes: string | null, repo: string): string | null {
  if (isTestBuild(notes)) return null;
  if (!/^\d+\.\d+\.\d+$/.test(semver)) return null;
  return `https://github.com/${repo}/releases/tag/fw-${semver}`;
}

/**
 * `?page=` as a 1-based page within 1..pages (at least 1, so an empty registry still has page 1). Anything that is
 * not a plain positive integer reads as page 1; past the end reads as the last page. A hand-edited URL is not worth
 * an error page (the Users page's rule).
 */
export function clampPage(raw: string | string[] | undefined, pages: number): number {
  const last = Math.max(1, pages);
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (s === undefined || !/^\d+$/.test(s)) return 1;
  const n = Number.parseInt(s, 10);
  return Math.min(Math.max(n, 1), last);
}
