'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { latestSaver } from '@/lib/user-prefs-client';
import { LIBRARY_PAGE_SIZES, type LibraryPageSize } from '@/lib/user-prefs-schema';
import { pageHref, pageWindow } from '@/lib/library-paging';

export const pageSizeLabel = (s: LibraryPageSize) => (s === 'all' ? 'All' : String(s));

/**
 * The library's pager (operator 2026-10-22), under the grid and the table alike: Prev, the page numbers, Next, and
 * how many titles a page holds -- the same per-user setting as Settings > Preferences (library.pageSize). Changing the
 * size saves it first and then goes to page 1 of the new paging: a page number counted at 48 a page means nothing at
 * 96. Hidden entirely in an empty view; the numbers are hidden when everything fits on one page.
 */
export function LibraryPager({ page, pages, pageSize, total }: {
  page: number; pages: number; pageSize: LibraryPageSize; total: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [saver] = useState(latestSaver);
  const [value, setValue] = useState(pageSize);
  const [serverSize, setServerSize] = useState(pageSize);
  const [, startTransition] = useTransition();
  const id = useId();
  if (pageSize !== serverSize) {
    setServerSize(pageSize);
    setValue(pageSize);
  }
  if (total === 0) return null;

  const params = new URLSearchParams(searchParams.toString());
  const href = (p: number) => pageHref(params, p);

  async function change(next: LibraryPageSize) {
    setValue(next);
    try {
      if (await saver.save({ library: { pageSize: next } }) === 'saved') {
        startTransition(() => {
          if (params.has('page')) router.push(pageHref(params, 1));
          else router.refresh();
        });
      }
    } catch {
      setValue(serverSize);
      toast.error("Couldn't save titles per page. Try again.");
    }
  }

  // Spec 1.4: 34px steps, mono numbers, ink-filled current page; Prev/Next stay sans.
  const step = 'grid h-[34px] min-w-[34px] place-items-center rounded-[9px] px-2 text-[13px] font-semibold';
  const hov = 'hover:bg-[var(--track)]';
  const num = `${step} font-mono`;
  const idle = { color: 'var(--ink)' };
  const muted = { color: 'var(--muted-2)' };
  const current = { background: 'var(--ink)', color: 'var(--surface)' };

  return (
    <nav aria-label="Pages" data-testid="library-pager"
         className="mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 sm:mx-7">
      {pages > 1 ? (
        <div className="flex flex-wrap items-center gap-1">
          {page > 1
            ? <Link href={href(page - 1)} className={`${step} ${hov}`} style={idle} data-testid="pager-prev" aria-label="Previous page">‹ Prev</Link>
            : <span className={step} style={muted} aria-hidden="true">‹ Prev</span>}
          {pageWindow(page, pages).map((p, i) => p === 'gap'
            ? <span key={`gap-${i}`} className={num} style={muted} aria-hidden="true">…</span>
            : p === page
              ? <span key={p} className={num} style={current} aria-current="page" data-testid={`pager-page-${p}`}>{p}</span>
              : <Link key={p} href={href(p)} className={`${num} ${hov}`} style={idle} data-testid={`pager-page-${p}`}
                      aria-label={`Page ${p}`}>{p}</Link>)}
          {page < pages
            ? <Link href={href(page + 1)} className={`${step} ${hov}`} style={idle} data-testid="pager-next" aria-label="Next page">Next ›</Link>
            : <span className={step} style={muted} aria-hidden="true">Next ›</span>}
        </div>
      ) : <span />}
      <span className="inline-flex items-center gap-2 text-[13px]">
        <label htmlFor={id} className="font-medium" style={{ color: 'var(--muted)' }}>Per page</label>
        <select
          id={id}
          data-testid="pager-size"
          value={String(value)}
          onChange={(e) => {
            const next = LIBRARY_PAGE_SIZES.find((s) => String(s) === e.target.value);
            if (next !== undefined) void change(next);
          }}
          className="h-[34px] max-sm:min-h-11 rounded-[9px] border px-2 text-[13px]"
          style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--ink)' }}
        >
          {LIBRARY_PAGE_SIZES.map((s) => <option key={s} value={String(s)}>{pageSizeLabel(s)}</option>)}
        </select>
      </span>
    </nav>
  );
}
