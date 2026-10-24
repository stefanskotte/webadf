/* eslint-disable @next/next/no-img-element */
import type { GameDetail } from '@/lib/queries';
import { DemozooSuggestions, UnlinkButton } from './demozoo-actions';
import { IdentifySearch } from './identify-search';

/**
 * The identify box's content (title-hero.tsx slot `title-identify`, spec §5.2): whichever branch applies, without a
 * card of its own -- the box is the card. Rendered OUTSIDE GameFacts, which renders nothing for a title OpenRetro
 * never enriched -- exactly the titles Demozoo exists for.
 */
export function DemozooIdentify({ game }: { game: GameDetail }) {
  const { link, suggestions, isGame } = game.demozoo;

  if (!link) {
    // Demozoo never answers for a game (spec §5.3.1), so a game gets the
    // search box over TOSEC only. The one exception is the repair path: a
    // game whose title Demozoo still owns (written before TOSEC identified a
    // disk as a game) needs a way back, and TOSEC itself will not retitle a
    // 'demozoo' title (R5).
    if (isGame) {
      if (game.metadataSource !== 'demozoo') {
        return (
          <div className="flex flex-col gap-2.5" data-testid="identify-search-panel">
            <span className="text-[13px] font-semibold">Identify with TOSEC</span>
            <IdentifySearch gameId={game.id} sources="tosec" />
            <div className="text-[12px] leading-normal" style={{ color: 'var(--muted-2)' }}>
              Releases from TOSEC. Nothing changes until you choose.
            </div>
          </div>
        );
      }
      return (
        <div className="flex flex-col gap-2.5" data-testid="demozoo-restore">
          <span className="text-[13px] font-semibold">Identify with TOSEC</span>
          <span className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
            This title&apos;s name came from Demozoo.
          </span>
          <UnlinkButton gameId={game.id} label="Restore original title" />
        </div>
      );
    }
    return (
      <DemozooSuggestions
        gameId={game.id}
        suggestions={suggestions.map((s) => s.production)}
        // R16: the game's title still reads metadataSource === 'demozoo' with
        // no active link -- a later import re-matched a blob away from it.
        // The suggestion card is the only place this game gets rendered, so
        // the explanation and its repair (unlink, relabelled) live here.
        restoreTitle={game.metadataSource === 'demozoo'}
        search={<IdentifySearch gameId={game.id} sources="all" />}
      />
    );
  }

  // Linked: the box names the production and holds the way out; the facts, screenshots and credit stay in the
  // full-width DemozooPanel below.
  return (
    <div className="flex flex-col gap-2.5" data-testid="demozoo-linked">
      <span className="text-[13px] font-semibold">Identify with Demozoo</span>
      <a href={link.production.url} target="_blank" rel="noreferrer noopener"
         className="break-words text-[14px] font-semibold" style={{ color: 'var(--amber-text)' }}>
        {link.production.title}
      </a>
      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>Linked to Demozoo</span>
      <UnlinkButton gameId={game.id} />
    </div>
  );
}

/** The linked production's facts, screenshots and credit, full width under the hero. Nothing when not linked. */
export function DemozooPanel({ game }: { game: GameDetail }) {
  const { link } = game.demozoo;
  if (!link) return null;

  const p = link.production;
  const facts: Array<[string, string]> = [];
  if (p.types.length) facts.push(['Type', p.types.join(', ')]);
  if (p.groups.length) facts.push(['By', p.groups.join(', ')]);
  if (p.releaseYear) facts.push(['Released', String(p.releaseYear)]);

  return (
    <div data-testid="demozoo-panel" data-link-source={link.source}>
      <div className="glass-card rounded-2xl p-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="whitespace-nowrap font-semibold" style={{ color: 'var(--muted)' }}>{k}</dt>
              <dd className="min-w-0 break-words" data-testid={`demozoo-fact-${k.toLowerCase()}`}>{v}</dd>
            </div>
          ))}
        </dl>
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
