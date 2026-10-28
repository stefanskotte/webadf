import { Link } from '@/components/shell/link';
import { REMOTE_Q_MAX, remoteHref, type RemoteView } from '@/lib/remote/view';

/**
 * Search this remote library (spec §4.5 "titles ... with search"): the owner matches titles in scope. A plain GET
 * form, so it works before the page hydrates; the collection and the view are kept, the page is not.
 */
export function RemoteSearch({ libraryId, view }: { libraryId: string; view: RemoteView }) {
  return (
    <form role="search" action={`/remote/${encodeURIComponent(libraryId)}`} method="get" data-testid="remote-search"
          className="flex items-center gap-2">
      {view.collection && <input type="hidden" name="collection" value={view.collection} />}
      {view.view === 'table' && <input type="hidden" name="view" value="table" />}
      <input type="search" name="q" defaultValue={view.q} maxLength={REMOTE_Q_MAX} aria-label="Search this library"
             placeholder="Search this library" data-testid="remote-search-input"
             className="h-10 w-[min(240px,60vw)] rounded-[10px] border px-3 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) sm:h-8 sm:text-[13px] max-sm:min-h-11"
             style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }} />
    </form>
  );
}

/** Cards or table (the library's ViewToggle look), keeping the collection, the search and the page. */
export function RemoteViewToggle({ libraryId, view }: { libraryId: string; view: RemoteView }) {
  const base = 'h-10 w-11 sm:h-8 sm:w-9';
  return (
    <div className="seg" role="group" aria-label="View">
      <Link href={remoteHref(libraryId, { ...view, view: 'grid' })} aria-label="Grid view" aria-pressed={view.view === 'grid'}
            data-testid="remote-view-grid" className={`seg-item seg-item--icon ${base}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
        </svg>
      </Link>
      <Link href={remoteHref(libraryId, { ...view, view: 'table' })} aria-label="Table view" aria-pressed={view.view === 'table'}
            data-testid="remote-view-table" className={`seg-item seg-item--icon ${base}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </Link>
    </div>
  );
}
