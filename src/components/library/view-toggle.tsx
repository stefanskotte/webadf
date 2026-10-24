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
  // The segmented control (.seg / .seg-item, globals.css) centres the glyph and
  // draws the pressed item from aria-pressed.
  const base = 'h-10 w-11 text-[11px] sm:h-8 sm:w-9';
  return (
    <div className="seg" role="group" aria-label="View">
      <Link href={viewModeHref(view, 'grid', undefined, page)}  aria-label="Grid view"  aria-pressed={mode === 'grid'}
            className={`seg-item seg-item--icon ${base}`}>▦</Link>
      <Link href={viewModeHref(view, 'table', undefined, page)} aria-label="Table view" aria-pressed={mode === 'table'}
            className={`seg-item seg-item--icon ${base}`}>☰</Link>
    </div>
  );
}
