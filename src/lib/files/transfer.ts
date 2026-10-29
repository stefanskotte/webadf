// The Files manager's pure helpers for clash answers and downloads. Client-safe: no imports with values.
import type { FsEntry } from './types';

export type ClashChoice = 'replace' | 'skip' | 'keep-both';
export type TransferGroup = { onClash: 'ask' | ClashChoice; sources: string[] };

/**
 * The requests that carry out a set of clash answers. One answer for all is one request (one new version per
 * disk). `onClash` is per request, so mixed answers become one request per answer -- skipped sources are not sent,
 * and the clash-free sources go with the first request.
 */
export function clashGroups(sources: string[], clashed: string[], choices: Record<string, ClashChoice>): TransferGroup[] {
  const answers = [...new Set(clashed.map((s) => choices[s]))];
  if (answers.length === 1) return [{ onClash: answers[0], sources }];
  return answers.filter((a) => a !== 'skip').map((a, i) => ({
    onClash: a, sources: sources.filter((s) => (Object.hasOwn(choices, s) ? choices[s] : i === 0 ? a : null) === a),
  })).filter((g) => g.sources.length > 0);
}

/**
 * The multi-file download's byte cap (spec 2026-10-29 §3.3; final review): a zip is answered in one response, and the
 * hosting platform refuses a response body over ~4.5 MB. The same cap for self-hosters (no feature is smaller there).
 * One file is never zipped and is at most an HD disk's 1.76 MB, so it is never refused by this.
 */
export const ZIP_MAX_BYTES = 4 * 1024 * 1024;

/** Longer download URLs than this risk a server's header limit; the person zips a folder instead. */
export const DOWNLOAD_URL_MAX = 8000;

/** One file by path; anything else (several entries, or a folder) as one .zip named after the pane's folder. */
export function downloadHref(entries: FsEntry[], folderName: string): string {
  if (entries.length === 1 && entries[0].kind === 'file') return `/api/files/download?path=${encodeURIComponent(entries[0].path)}`;
  const q = new URLSearchParams();
  for (const e of entries) q.append('paths', e.path);
  q.set('name', folderName);
  return `/api/files/download?${q}`;
}
