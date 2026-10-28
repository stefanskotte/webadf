import { Link } from '@/components/shell/link';
import { collectionDot } from '@/lib/library-look';
import { remoteHref, type RemoteView } from '@/lib/remote/view';
import type { ShareLibrary } from '@/lib/share/types';

// The library rail's look (collection-rail.tsx), read-only: a rail from md, a chip row below it.
const ROW = 'group flex min-w-0 shrink-0 items-center justify-between gap-2.5 text-[14px] md:h-[38px] md:rounded-[10px] md:px-3 max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:border max-md:px-3 max-md:text-[13px]';
const CHIP = 'max-md:border-(--line) max-md:bg-(--surface) md:hover:bg-(--track)';
const CURRENT = 'md:bg-(--surface) md:shadow-[0_1px_2px_rgb(36_33_27/.1),0_0_0_1px_var(--line)] max-md:border-(--ink) max-md:bg-(--ink)';
const NAME = 'min-w-0 truncate text-(--ink) max-md:group-data-[current=true]:text-(--surface)';
const COUNT = 'shrink-0 font-mono text-[12px] text-(--muted-2) max-md:group-data-[current=true]:text-(--on-ink-muted)';

/**
 * The collections the owner shares (spec §4.5), and All titles. A search is kept when the collection changes; the
 * page (cursor) is not: it belongs to the old list.
 */
export function RemoteCollections({ libraryId, library, view }: { libraryId: string; library: ShareLibrary; view: RemoteView }) {
  const item = (cid: string | null, name: string, count: number, dot: string) => {
    const current = view.collection === cid;
    return (
      <Link key={cid ?? 'all'} href={remoteHref(libraryId, { collection: cid, q: view.q, view: view.view })}
            data-testid={cid ? 'remote-collection' : 'remote-collection-all'} data-collection-id={cid ?? undefined}
            data-current={current} aria-current={current ? 'page' : undefined}
            className={`${ROW} ${current ? CURRENT : CHIP}`}>
        <span className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: dot }} />
          <span className={NAME} style={{ fontWeight: current ? 600 : 500 }}>{name}</span>
        </span>
        <span className={COUNT}>{count.toLocaleString('en-US')}</span>
      </Link>
    );
  };
  return (
    <aside className="flex shrink-0 flex-col md:ml-7 md:w-60 md:gap-0.5" data-testid="remote-collections">
      <div className="px-3 py-2 text-[12px] font-medium max-md:hidden" style={{ color: 'var(--muted-2)' }}>Shared collections</div>
      <nav aria-label="Shared collections" className="flex gap-2 overflow-x-auto px-4 pb-1 sm:px-7 md:contents">
        {item(null, 'All titles', library.titles, '#C4B9A2')}
        {library.collections.length > 0 && <div className="my-1 h-px max-md:hidden" style={{ background: 'var(--line)' }} />}
        {library.collections.map((c) => item(c.id, c.name, c.titles, collectionDot(c.id)))}
      </nav>
    </aside>
  );
}
