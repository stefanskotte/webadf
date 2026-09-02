/* eslint-disable @next/next/no-img-element */
import type { GameDetail } from '@/lib/queries';

/**
 * Everything OpenRetro contributed about a game: the cover, a screenshot
 * strip, the facts block, the prose and the outbound links.
 *
 * Renders NOTHING at all when nothing has been enriched -- an un-enriched
 * library should look exactly as it did before this increment, not sprout a
 * row of empty boxes. Every individual block is likewise conditional, because
 * the fields arrive independently: 2,930 of 3,697 entries have a cover but
 * only 1,706 have prose and 299 a chipset.
 *
 * Images are <img>, not next/image: they are already resized server-side by
 * openretro.org (?size=400) and served from our own Blob store, so the
 * optimizer would add a second transformation and a per-image function
 * invocation for no gain.
 */
export function GameFacts({ game }: { game: GameDetail }) {
  const facts: Array<[string, string | number]> = [];
  if (game.publisher) facts.push(['Publisher', game.publisher]);
  if (game.developer) facts.push(['Developer', game.developer]);
  if (game.year) facts.push(['Year', game.year]);
  if (game.players) facts.push(['Players', game.players]);
  if (game.languages) facts.push(['Languages', game.languages]);
  if (game.genre) facts.push(['Genre', game.genre]);
  if (game.chipset) facts.push(['Chipset', game.chipset]);

  const links: Array<[string, string]> = [];
  if (game.links?.holUrl) links.push(['Hall of Light', game.links.holUrl]);
  if (game.links?.mobygamesUrl) links.push(['MobyGames', game.links.mobygamesUrl]);
  if (game.links?.lemonUrl) links.push(['Lemon Amiga', game.links.lemonUrl]);
  if (game.links?.wikipediaUrl) links.push(['Wikipedia', game.links.wikipediaUrl]);
  if (game.links?.longplayUrl) links.push(['Longplay', game.links.longplayUrl]);

  const enriched = game.factsSource === 'openretro' || game.proseSource === 'openretro'
    || game.front !== null || game.screenshots.length > 0;
  const hasBody = facts.length > 0 || game.description || game.front
    || game.screenshots.length > 0 || links.length > 0;
  if (!enriched || !hasBody) return null;

  const cover = game.front ?? game.title_;

  return (
    <div className="px-4 pb-3 sm:px-7" data-testid="game-facts">
      <div className="glass-card p-5">
        <div className="flex flex-col gap-5 md:flex-row">
          {cover && (
            <img
              src={cover.url}
              alt={`${game.title} cover`}
              data-testid="game-cover"
              className="h-auto w-full max-w-[220px] self-start rounded-lg"
            />
          )}

          <div className="min-w-0 flex-1">
            {facts.length > 0 && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                {facts.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="whitespace-nowrap font-semibold" style={{ color: 'var(--muted)' }}>{k}</dt>
                    {/* A grid item's automatic minimum size is its content, so
                        a long Languages or Genre list would widen the 1fr
                        track past the card rather than wrap inside it. */}
                    <dd className="min-w-0 break-words" data-testid={`fact-${k.toLowerCase()}`}>{v}</dd>
                  </div>
                ))}
              </dl>
            )}

            {game.description && (
              <p className="mt-4 text-[13px] leading-relaxed" data-testid="game-description">
                {game.description}
              </p>
            )}

            {game.history && (
              <p className="mt-3 text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
                {game.history}
              </p>
            )}

            {links.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
                {links.map(([label, href]) => (
                  <a key={label} href={href} target="_blank" rel="noreferrer noopener"
                     className="font-semibold" style={{ color: 'var(--amber-text)' }}>
                    {label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {game.screenshots.length > 0 && (
          <div className="mt-5 flex gap-3 overflow-x-auto pb-1" data-testid="game-screenshots">
            {game.screenshots.map((s) => (
              <img key={s.sha1} src={s.url} alt={`${game.title} screenshot`}
                   className="h-[132px] w-auto shrink-0 rounded-md" />
            ))}
          </div>
        )}

        {/* Attribution. These images and facts are volunteer-contributed and
            copied into this project's own storage; crediting the source and
            linking back is the cheapest part of behaving well about that. */}
        <div className="mt-5 text-[12px]" style={{ color: 'var(--muted)' }} data-testid="openretro-credit">
          Metadata and images from{' '}
          <a
            href={game.links?.slug ? `https://openretro.org/amiga/${game.links.slug}` : 'https://openretro.org'}
            target="_blank" rel="noreferrer noopener"
            className="font-semibold" style={{ color: 'var(--amber-text)' }}
          >
            OpenRetro
          </a>
          .
        </div>
      </div>
    </div>
  );
}
