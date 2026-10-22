import { Link } from '@/components/shell/link';
import { viewModeHref, type LibraryView } from '@/lib/library-view';

/**
 * Grid or table, for the slice being viewed: switching keeps the collection
 * (or All titles) you are in, rather than dropping you back at the root, and the
 * page you are on (library paging): both views list the same titles.
 */
export function ViewToggle({ mode, view, page = 1 }: { mode: 'grid' | 'table'; view: LibraryView; page?: number }) {
  // Bigger on a phone and back to today's 36x32 from `sm`: this pair lives in
  // the page header's actions, where a thumb is the only pointer there is.
  const base = 'grid h-10 w-11 place-items-center text-[11px] font-semibold sm:h-8 sm:w-9';
  const on  = { background: 'var(--primary-action)', color: '#fff' };
  const off = { color: 'var(--muted)' };
  return (
    <div className="flex overflow-hidden rounded-lg border"
         style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)' }}>
      <Link href={viewModeHref(view, 'grid', undefined, page)}  aria-label="Grid view"  aria-pressed={mode === 'grid'}
            className={base} style={mode === 'grid' ? on : off}>▦</Link>
      <Link href={viewModeHref(view, 'table', undefined, page)} aria-label="Table view" aria-pressed={mode === 'table'}
            className={base} style={mode === 'table' ? on : off}>☰</Link>
    </div>
  );
}
