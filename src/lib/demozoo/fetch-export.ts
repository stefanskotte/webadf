// The ONLY file in this project that makes a request to data.demozoo.org.
//
// Demozoo is a non-profit. Operator ruling 2026-09-14: at most once a week.
// That is enforced by the caller's last_attempt_at gate (import.ts); this file
// guarantees ONE request per call, conditional, identifying us.

import { demozooExportStore, type DemozooExportStore } from '@/lib/storage';

export const EXPORT_URL = 'https://data.demozoo.org/demozoo-export.sql.gz';
export const DEMOZOO_USER_AGENT = 'webadf/1.0 (Amiga disk library; +https://webadf.vercel.app)';

export type FetchOutcome =
  | { status: 'unchanged' }
  | { status: 'stored'; etag: string | null; lastModified: string | null };

export async function fetchExport(
  prev: { etag: string | null; lastModified: string | null } | null,
  deps: { fetch: typeof fetch; store: DemozooExportStore } = { fetch: globalThis.fetch, store: demozooExportStore },
): Promise<FetchOutcome> {
  const headers: Record<string, string> = { 'user-agent': DEMOZOO_USER_AGENT };
  if (prev?.etag) headers['if-none-match'] = prev.etag;
  if (prev?.lastModified) headers['if-modified-since'] = prev.lastModified;

  const res = await deps.fetch(EXPORT_URL, { headers });
  if (res.status === 304) return { status: 'unchanged' };
  if (!res.ok || !res.body) throw new Error(`demozoo export: HTTP ${res.status}`);

  await deps.store.putStream('export.sql.gz', res.body);
  return { status: 'stored', etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}
