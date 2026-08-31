import { adminCounts } from '@/lib/admin-queries';
import { PageHeader } from '@/components/shell/page-header';

// Counts are read live on every render; nothing here is cached. cacheComponents
// stays off in this project (see next.config.ts), and an operator looking at a
// database overview wants the number as it is now, not as it was.
export const dynamic = 'force-dynamic';

const TILES = [
  { key: 'users', label: 'Users' },
  { key: 'orgs', label: 'Organizations' },
  { key: 'games', label: 'Games' },
  { key: 'disks', label: 'Disks' },
  { key: 'blobs', label: 'Blobs' },
  { key: 'liveInvites', label: 'Live invites' },
] as const;

export default async function AdminOverviewPage() {
  const counts = await adminCounts();
  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Overview"
        subtitle="Every organization, unscoped — these numbers cross the tenant boundary"
      />
      <div className="grid grid-cols-2 gap-3 px-7 pb-10 md:grid-cols-3">
        {TILES.map((tile) => (
          <div key={tile.key} className="glass-card p-5">
            <div className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>
              {tile.label}
            </div>
            <div
              className="mt-1 text-[30px] font-bold leading-none tracking-[-0.03em]"
              data-testid={`count-${tile.key}`}
            >
              {counts[tile.key]}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
