import { Link } from '@/components/shell/link';
import { fromQuery } from '@/lib/trail';
import type { GameListItem } from '@/lib/queries';

// TYPE sits between title and year: it qualifies what the row IS, so it
// belongs next to the name rather than out among the numbers.
// 104px, not 82: "Educational" is the longest label and at 82 its pill ran
// into the YEAR column.
const COLS = 'grid-cols-[30px_1fr_104px_50px_128px_40px_74px_100px]';

function fmtSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_048_576).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function GameTable({ games, collectionId }: {
  games: GameListItem[];
  /**
   * The collection currently being viewed, carried into each title's link so
   * its breadcrumb can lead back here. Null in the unfiltered library.
   */
  collectionId?: string | null;
}) {
  return (
    <div className="glass-card mx-4 overflow-hidden sm:mx-7" data-testid="game-table">
      {/* COLS totals ~590px of FIXED tracks, and the card above clips
          (overflow-hidden, which is what rounds its corners). So on a phone
          the last columns were not merely cramped -- they were cut off with
          no way to reach them. This wrapper scrolls them into reach, and the
          min-width below is what gives it something to scroll: without it the
          grid would just compress the 1fr title column to nothing and never
          overflow. Both are inert at desktop, where the column is far wider
          than 600px. */}
      <div className="overflow-x-auto">
        <div className={`grid ${COLS} min-w-[600px] items-center border-b px-4 py-2 font-mono text-[9.5px] tracking-[0.06em]`}
             style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
          <span /><span>TITLE</span><span>TYPE</span><span>YEAR</span><span>PUBLISHER</span>
          <span className="text-right">DSK</span><span className="text-right">SIZE</span>
          <span className="text-right">SHA-256</span>
        </div>
        {games.map((g, i) => (
          <Link key={g.id} href={`/games/${g.id}${fromQuery(collectionId)}`} data-testid="game-row"
                className={`grid ${COLS} min-w-[600px] items-center border-b px-4 py-2 font-mono text-[11px] hover:bg-white/40`}
                style={{ borderColor: 'rgb(30 45 60 / 0.05)' }}>
            <span style={{ color: 'var(--faint)' }}>{String(i + 1).padStart(2, '0')}</span>
            <span className="truncate pr-3 font-medium" style={{ color: 'var(--ink)' }}>{g.title}</span>
            <span className="pr-3" data-testid="game-kind">
              {g.kind
                ? (
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.02em]"
                        style={{ background: 'var(--hairline-strong)', color: 'var(--ink)' }}>
                    {g.kind}
                  </span>
                  )
                /* An em dash, not a guess. TOSEC recognises 45.9% of a real
                   archive, so "unknown" is the common case and must read as
                   "not identified" rather than as a category of its own. */
                : <span style={{ color: 'var(--faint)' }}>—</span>}
            </span>
            <span style={{ color: 'var(--muted)' }}>{g.year ?? '—'}</span>
            <span className="truncate pr-3" style={{ color: 'var(--muted)' }}>{g.publisher ?? '—'}</span>
            <span className="text-right font-semibold"
                  style={{ color: g.diskCount > 1 ? 'var(--amber-text)' : 'var(--muted-2)' }}>
              {g.diskCount}
            </span>
            <span className="text-right" style={{ color: 'var(--muted-2)' }}>{fmtSize(g.sizeBytes)}</span>
            <span className="text-right text-[10px]" style={{ color: 'var(--faint)' }}>
              {g.sha256Prefix ? `${g.sha256Prefix.slice(0, 8)}…` : '—'}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
