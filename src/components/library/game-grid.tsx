import Link from 'next/link';
import { Cover } from './cover';
import type { GameListItem } from '@/lib/queries';

export function GameGrid({ games }: { games: GameListItem[] }) {
  if (games.length === 0) {
    return (
      <div className="glass-card mx-7 flex flex-col items-center gap-3 p-12 text-center">
        <p className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>No disks yet</p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Drop some ADFs on the ingest page, or run <code className="font-mono">webadf push</code>.
        </p>
        <Link href="/ingest" className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
              style={{ background: 'var(--primary-action)' }}>Add disks</Link>
      </div>
    );
  }

  return (
    <div className="mx-7 grid grid-cols-5 gap-4" data-testid="game-grid">
      {games.map((g) => (
        <Link key={g.id} href={`/games/${g.id}`} className="glass-card flex flex-col p-2.5"
              data-testid="game-card">
          <Cover id={g.id} title={g.title} diskCount={g.diskCount} />
          <div className="flex flex-col gap-0.5 px-0.5 pb-1 pt-2.5">
            <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              {g.title}
            </span>
            <span className="truncate font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
              {[g.year, g.publisher].filter(Boolean).join(' · ') || 'unidentified'}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
