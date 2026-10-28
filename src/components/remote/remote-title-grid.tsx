import { Link } from '@/components/shell/link';
import { Cover, titleByline } from '@/components/library/cover';
import { kindTag } from '@/lib/library-look';
import { remoteListItem, remoteTitleHref } from '@/lib/remote/view';
import type { ShareTitle } from '@/lib/share/types';

const CARD = 'glass-card group relative flex flex-col p-0 transition-[box-shadow,border-color] duration-200 '
  + 'hover:border-[var(--line-strong)] hover:shadow-[0_18px_36px_-16px_rgb(36_33_27/0.35)]';

/**
 * An owner's titles as the library's cards (game-grid.tsx's look), read-only: the cover, the name, the byline, the
 * kind and the disk count. No mount ring, menu or drag: those are the local library's.
 */
export function RemoteTitleGrid({ libraryId, titles }: { libraryId: string; titles: ShareTitle[] }) {
  return (
    <div className="mx-4 grid grid-cols-2 gap-4 sm:mx-7 sm:grid-cols-3 md:grid-cols-5 md:gap-5" data-testid="remote-title-grid">
      {titles.map((t) => {
        const g = remoteListItem(t, libraryId);
        const tag = g.kind ? kindTag(g.kind) : null;
        return (
          <Link key={t.id} href={remoteTitleHref(libraryId, t.id)} data-testid="remote-title-card" data-title-id={t.id}
                className={CARD}>
            <Cover game={g} holds={undefined} />
            <div className="flex min-w-0 flex-col gap-0.5 px-3.5 pb-1 pt-3">
              <span className="truncate text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{g.title}</span>
              <span className="min-h-[1lh] truncate text-[13px]" style={{ color: 'var(--muted-2)' }}>{titleByline(g)}</span>
            </div>
            <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3.5 pb-3 pt-1.5">
              {tag && (
                <span className="max-w-full truncate rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ background: tag.bg, color: tag.fg }}>
                  {g.kind}
                </span>
              )}
              <span className="whitespace-nowrap font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>
                {g.diskCount === 1 ? '1 disk' : `${g.diskCount} disks`}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
