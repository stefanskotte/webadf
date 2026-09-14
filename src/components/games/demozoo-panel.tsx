/* eslint-disable @next/next/no-img-element */
import type { GameDetail } from '@/lib/queries';
import { DemozooSuggestions, UnlinkButton } from './demozoo-actions';

/**
 * The linked production, or the suggestion card. Rendered OUTSIDE GameFacts,
 * which renders nothing for a title OpenRetro never enriched -- exactly the
 * titles Demozoo exists for.
 */
export function DemozooPanel({ game }: { game: GameDetail }) {
  const { link, suggestions, isGame } = game.demozoo;

  if (!link) {
    // Demozoo never answers for a game (spec §5.3.1) -- not even a search box.
    if (isGame) return null;
    return (
      <DemozooSuggestions
        gameId={game.id}
        suggestions={suggestions.map((s) => s.production)}
        // R16: the game's title still reads metadataSource === 'demozoo' with
        // no active link -- a later import re-matched a blob away from it.
        // The suggestion card is the only place this game gets rendered, so
        // the explanation and its repair (unlink, relabelled) live here.
        restoreTitle={game.metadataSource === 'demozoo'}
      />
    );
  }

  const p = link.production;
  const facts: Array<[string, string]> = [];
  if (p.types.length) facts.push(['Type', p.types.join(', ')]);
  if (p.groups.length) facts.push(['By', p.groups.join(', ')]);
  if (p.releaseYear) facts.push(['Released', String(p.releaseYear)]);

  return (
    <div className="px-4 pb-3 sm:px-7" data-testid="demozoo-panel" data-link-source={link.source}>
      <div className="glass-card p-5">
        <div className="flex items-start justify-between gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="whitespace-nowrap font-semibold" style={{ color: 'var(--muted)' }}>{k}</dt>
                <dd className="min-w-0 break-words" data-testid={`demozoo-fact-${k.toLowerCase()}`}>{v}</dd>
              </div>
            ))}
          </dl>
          <UnlinkButton gameId={game.id} />
        </div>
        {p.screenshots.length > 0 && (
          <div className="mt-5 flex gap-3 overflow-x-auto pb-1" data-testid="demozoo-screenshots">
            {p.screenshots.map((s) => (
              <img key={s.sha1} src={s.url} alt={`${p.title} screenshot`} loading="lazy" decoding="async"
                   className="h-[132px] w-[168px] shrink-0 rounded-md object-contain" />
            ))}
          </div>
        )}
        <div className="mt-5 text-[12px]" style={{ color: 'var(--muted)' }} data-testid="demozoo-credit">
          Metadata and images from{' '}
          <a href={p.url} target="_blank" rel="noreferrer noopener" className="font-semibold" style={{ color: 'var(--amber-text)' }}>Demozoo</a>.
        </div>
      </div>
    </div>
  );
}
