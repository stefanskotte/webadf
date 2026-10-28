import { Link } from '@/components/shell/link';
import { DiskIcon } from '@/components/ui/disk-icon';
import { kindTag, titleDiskColor } from '@/lib/library-look';
import { remoteListItem, remoteTitleHref } from '@/lib/remote/view';
import type { ShareTitle } from '@/lib/share/types';

// The library table's tracks (game-table.tsx) without the size and controls columns: the owner does not list sizes
// per title, and a remote row has no menu.
const COLS = 'grid-cols-[40px_minmax(0,1fr)] sm:grid-cols-[36px_minmax(0,1fr)_104px_56px_150px_52px]';
const ROW = `grid ${COLS} sm:min-w-[620px] items-center gap-x-3 border-b px-4 font-sans text-[13px] sm:gap-x-[14px] sm:px-[18px]`;
const WIDE = 'max-sm:hidden';

/** An owner's titles as the library's table rows, read-only; below sm the facts fold under the name. */
export function RemoteTitleTable({ libraryId, titles }: { libraryId: string; titles: ShareTitle[] }) {
  return (
    <div className="glass-card mx-4 overflow-hidden sm:mx-7" data-testid="remote-title-table">
      <div className="overflow-x-auto">
        <div className={`${ROW} h-11 text-[12px] font-medium max-sm:hidden`} style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
          <span /><span>Name</span><span>Type</span><span>Year</span><span>Publisher</span><span className="text-right">Disks</span>
        </div>
        {titles.map((t) => {
          const g = remoteListItem(t, libraryId);
          const meta = [g.kind, g.year, g.publisher, g.diskCount === 1 ? '1 disk' : `${g.diskCount} disks`].filter(Boolean).join(' · ');
          return (
            <Link key={t.id} href={remoteTitleHref(libraryId, t.id)} data-testid="remote-title-row" data-title-id={t.id}
                  className={`${ROW} min-h-[56px] py-2 hover:bg-[color:var(--surface-2)] sm:h-[46px] sm:min-h-0 sm:py-0`}
                  style={{ borderColor: 'var(--hairline)' }}>
              <DiskIcon color={titleDiskColor(g)} size={26} stack={g.diskCount} mounted={false} />
              <span className="flex min-w-0 flex-col">
                <span className="text-[14px] font-semibold [overflow-wrap:anywhere] sm:truncate sm:text-[13px] sm:font-medium" style={{ color: 'var(--ink)' }}>
                  {g.title}
                </span>
                <span className="text-[12px] sm:hidden" style={{ color: 'var(--muted-2)' }}>{meta}</span>
              </span>
              <span className={WIDE}>
                {g.kind
                  ? <span className="rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ background: kindTag(g.kind).bg, color: kindTag(g.kind).fg }}>{g.kind}</span>
                  : <span style={{ color: 'var(--muted-2)' }}>—</span>}
              </span>
              <span className={WIDE} style={{ color: g.year ? 'var(--ink)' : 'var(--muted-2)' }}>{g.year ?? '—'}</span>
              <span className={`truncate ${WIDE}`} style={{ color: g.publisher ? 'var(--muted)' : 'var(--muted-2)' }}>{g.publisher ?? '—'}</span>
              <span className={`text-right font-mono ${WIDE}`} style={{ color: g.diskCount > 1 ? 'var(--amber-text)' : 'var(--ink)' }}>{g.diskCount}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
