import { Link } from '@/components/shell/link';
import { viewHref } from '@/lib/library-view';
import type { CollectionListItem } from '@/lib/collections';

/**
 * What /library shows when the inbox is empty.
 *
 * The landing view is "Uncategorized", which is the right default -- it is
 * where new titles arrive and where filing happens. But it empties, and a
 * well-organised library would then be greeted by a blank page, which reads
 * as "something is broken" rather than "you are done". So an empty inbox
 * falls through to the collections themselves, as cards that go exactly where
 * the rail rows go.
 *
 * The totals are here for the same reason the cards are: the page had nothing
 * on it, and a number you would otherwise have to count by hand is worth more
 * than whitespace.
 *
 * Only rendered when there ARE collections. An account with no collections and
 * no titles is an EMPTY library, and the grid already says so properly; a
 * second empty state here would be a worse copy that appears only on brand-new
 * accounts. See the caller.
 */
export function CategoryOverview({
  collections, totalTitles, totalDisks,
}: {
  collections: CollectionListItem[];
  totalTitles: number;
  totalDisks: number;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="category-overview">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1">
        <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
          Everything is filed.
        </span>
        <span className="font-mono text-[11.5px]" style={{ color: 'var(--muted-2)' }}>
          {totalTitles.toLocaleString()} titles · {totalDisks.toLocaleString()} disks ·{' '}
          {collections.length.toLocaleString()} {collections.length === 1 ? 'collection' : 'collections'}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {collections.map((c) => (
          <Link
            key={c.id}
            href={viewHref({ kind: 'collection', id: c.id })}
            data-testid={`overview-card-${c.id}`}
            className="glass-card flex flex-col gap-1 px-4 py-4"
          >
            <span className="truncate text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
              {c.name}
            </span>
            <span className="font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
              {c.gameCount.toLocaleString()} {c.gameCount === 1 ? 'title' : 'titles'}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
