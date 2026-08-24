import Link from 'next/link';
import type { GameListItem } from '@/lib/queries';

const COLS = 'grid-cols-[30px_1fr_50px_156px_40px_74px_100px]';

function fmtSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_048_576).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function GameTable({ games }: { games: GameListItem[] }) {
  return (
    <div className="glass-card mx-7 overflow-hidden" data-testid="game-table">
      <div className={`grid ${COLS} items-center border-b px-4 py-2 font-mono text-[9.5px] tracking-[0.06em]`}
           style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
        <span /><span>TITLE</span><span>YEAR</span><span>PUBLISHER</span>
        <span className="text-right">DSK</span><span className="text-right">SIZE</span>
        <span className="text-right">SHA-256</span>
      </div>
      {games.map((g, i) => (
        <Link key={g.id} href={`/games/${g.id}`} data-testid="game-row"
              className={`grid ${COLS} items-center border-b px-4 py-2 font-mono text-[11px] hover:bg-white/40`}
              style={{ borderColor: 'rgb(30 45 60 / 0.05)' }}>
          <span style={{ color: 'var(--faint)' }}>{String(i + 1).padStart(2, '0')}</span>
          <span className="truncate pr-3 font-medium" style={{ color: 'var(--ink)' }}>{g.title}</span>
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
  );
}
