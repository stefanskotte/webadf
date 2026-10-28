import { Link } from '@/components/shell/link';

const STEP = 'grid h-[34px] min-w-[34px] place-items-center rounded-[9px] px-2 text-[13px] font-semibold';

/**
 * The owner pages titles by a cursor (spec §3.2 titles), so there are no page numbers: the first page, and the next.
 * The library pager's look (library-pager.tsx); hidden when everything fits on one page.
 */
export function RemotePager({ firstHref, nextHref }: { firstHref: string | null; nextHref: string | null }) {
  if (!firstHref && !nextHref) return null;
  return (
    <nav aria-label="Pages" data-testid="remote-pager" className="mx-4 mt-6 flex items-center gap-1 sm:mx-7">
      {firstHref
        ? <Link href={firstHref} data-testid="remote-pager-first" className={`${STEP} hover:bg-[var(--track)]`} style={{ color: 'var(--ink)' }}>‹ First page</Link>
        : <span className={STEP} style={{ color: 'var(--muted-2)' }} aria-hidden="true">‹ First page</span>}
      {nextHref
        ? <Link href={nextHref} data-testid="remote-pager-next" className={`${STEP} hover:bg-[var(--track)]`} style={{ color: 'var(--ink)' }}>Next ›</Link>
        : <span className={STEP} style={{ color: 'var(--muted-2)' }} aria-hidden="true">Next ›</span>}
    </nav>
  );
}
