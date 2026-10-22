import type { LibraryPageSize } from '@/lib/user-prefs-schema';

/**
 * Paging for /library, the grid and the table alike (operator 2026-10-22). The page lives in the address
 * (`?page=`), the size in the person's prefs (library.pageSize). Client-safe: no database import.
 */

export type ResolvedPage = { page: number; pages: number; offset: number; limit: number | null };

/**
 * Which page to show of `total` titles. `?page=` that is absent, junk or repeated is page 1; one past the end is the
 * last page, so a stale link (titles deleted, a bigger page size chosen) still shows titles. 'all' is one page.
 */
export function resolvePage(raw: string | string[] | undefined, total: number, size: LibraryPageSize): ResolvedPage {
  if (size === 'all') return { page: 1, pages: 1, offset: 0, limit: null };
  const pages = Math.max(1, Math.ceil(total / size));
  const asked = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : 1;
  const page = Math.min(asked, pages);
  return { page, pages, offset: (page - 1) * size, limit: size };
}

/**
 * The page numbers the pager shows: the first, the last, and the current page with its neighbours; 'gap' where pages
 * are left out. A gap would hide only one page, so that page is shown instead. One page needs no pager: [].
 */
export function pageWindow(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 1) return [];
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  for (const p of sorted) {
    const prev = out.length ? (out[out.length - 1] as number) : 0;
    if (p - prev === 2) out.push(p - 1);
    else if (p - prev > 2) out.push('gap');
    out.push(p);
  }
  return out;
}

/** The address of `page`, keeping every other parameter; page 1 drops `?page=`. */
export function pageHref(params: URLSearchParams, page: number): string {
  const next = new URLSearchParams(params.toString());
  if (page <= 1) next.delete('page');
  else next.set('page', String(page));
  const qs = next.toString();
  return qs ? `/library?${qs}` : '/library';
}

/**
 * The library header's count, for the whole view (never one page). At the root it is the inbox -- titles in no
 * collection -- and says so, so it never reads as the size of the library beside the folders (final review M3).
 */
export function librarySubtitle(t: { titles: number; disks: number }, kind: 'uncategorized' | 'all' | 'collection'): string {
  const n = (x: number, one: string, many: string) => `${x.toLocaleString('en-US')} ${x === 1 ? one : many}`;
  const titles = kind === 'uncategorized' ? n(t.titles, 'uncategorized title', 'uncategorized titles') : n(t.titles, 'title', 'titles');
  return `${titles} · ${n(t.disks, 'disk', 'disks')}`;
}
