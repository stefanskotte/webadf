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
