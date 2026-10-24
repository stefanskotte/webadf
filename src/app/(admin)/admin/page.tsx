import {
  adminCounts, adminBoardCounts, adminFirmwareDistribution, adminAttentionCandidates,
} from '@/lib/admin-queries';
import { readCurrentRelease } from '@/lib/firmware-releases';
import { needsAttention, orderDistribution, versionLabel } from '@/lib/admin-board-health';
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

const BOARD_TILES = [
  { key: 'paired', id: 'boardsPaired', label: 'Paired' },
  { key: 'online', id: 'boardsOnline', label: 'Online now' },
  { key: 'seen7d', id: 'boardsSeen7d', label: 'Seen in 7 days' },
] as const;

function Tile({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="glass-card p-5">
      <div className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      <div className="mt-1 text-[30px] font-bold leading-none tracking-[-0.03em]" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-4 pb-2 pt-2 text-[15px] font-semibold sm:px-7" style={{ color: 'var(--ink)' }}>
      {children}
    </h2>
  );
}

export default async function AdminOverviewPage() {
  // One `now` for every rule on the page, so the tiles, the distribution and the attention list agree.
  const now = Date.now();
  const [counts, boards, dist, candidates, current] = await Promise.all([
    adminCounts(), adminBoardCounts(now), adminFirmwareDistribution(now), adminAttentionCandidates(now),
    readCurrentRelease(),
  ]);
  const attention = needsAttention(candidates, current, now);
  const distribution = orderDistribution(dist, current?.sequence ?? null);
  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Overview"
        subtitle="Every organization, unscoped — these numbers cross the tenant boundary"
      />
      <div className="grid grid-cols-2 gap-3 px-4 pb-6 sm:px-7 md:grid-cols-3">
        {TILES.map((tile) => (
          <Tile key={tile.key} label={tile.label} value={counts[tile.key]} testId={`count-${tile.key}`} />
        ))}
      </div>

      <SectionTitle>Boards</SectionTitle>
      <div className="grid grid-cols-2 gap-3 px-4 pb-6 sm:px-7 md:grid-cols-3">
        {BOARD_TILES.map((tile) => (
          <Tile key={tile.key} label={tile.label} value={boards[tile.key]} testId={`count-${tile.id}`} />
        ))}
      </div>

      <SectionTitle>Boards by firmware (seen in the last 7 days)</SectionTitle>
      <div className="px-4 pb-6 sm:px-7">
        <div className="glass-card flex flex-col gap-2 p-5" data-testid="fw-dist">
          {distribution.length === 0 ? (
            <div className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid="fw-dist-empty">
              No board has been seen in the last 7 days.
            </div>
          ) : distribution.map((row) => (
            <div
              key={row.version ?? '\u0000null'}
              className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-[13px]"
              data-testid="fw-dist-row"
              data-version={row.version ?? ''}
              data-count={row.count}
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-mono" style={{ color: 'var(--ink)' }} title={row.version ?? undefined}>
                  {versionLabel(row.version)}
                </span>
                {row.current && (
                  <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent-blue)' }}>
                    Current
                  </span>
                )}
                {!row.recognised && row.version !== null && (
                  <span className="text-[11px]" style={{ color: 'var(--muted)' }}>unrecognised</span>
                )}
              </span>
              <span className="h-2 rounded-full" style={{ background: 'var(--hairline)' }}>
                <span
                  className="block h-2 rounded-full"
                  style={{ width: `${Math.max(2, row.share * 100)}%`, background: 'var(--accent-blue)' }}
                />
              </span>
              <span className="tabular-nums" style={{ color: 'var(--ink)' }}>{row.count}</span>
            </div>
          ))}
        </div>
      </div>

      <SectionTitle>Needs attention</SectionTitle>
      <div className="px-4 pb-10 sm:px-7">
        <div className="glass-card flex flex-col divide-y p-0" style={{ borderColor: 'var(--hairline)' }} data-testid="attention">
          {attention.length === 0 ? (
            <div className="p-5 text-[13px]" style={{ color: 'var(--muted)' }} data-testid="attention-empty">
              Nothing needs attention.
            </div>
          ) : attention.map((row) => (
            <div
              key={row.deviceId}
              className="flex flex-col gap-1 px-5 py-3 text-[13px]"
              style={{ borderColor: 'var(--hairline)' }}
              data-testid="attention-row"
              data-device-id={row.deviceId}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-semibold" style={{ color: 'var(--ink)' }}>{row.name}</span>
                <span className="break-all" style={{ color: 'var(--muted)' }}>{row.ownerEmail ?? '—'}</span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {row.reasons.map((reason) => (
                  <li
                    key={reason.kind}
                    className="break-words"
                    data-kind={reason.kind}
                    style={{ color: reason.kind === 'error' ? 'var(--danger-fg)' : reason.kind === 'behind' ? 'var(--amber-text)' : 'var(--muted)' }}
                  >
                    {reason.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
