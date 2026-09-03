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

  // "Has anyone authored anything here", not "did OpenRetro run".
  //
  // This gate read `=== 'openretro'` until the edit UI shipped, which meant a
  // description someone typed by hand was saved, stamped, protected from
  // scans -- and then never rendered, because the only author this block
  // recognised was the enrichment. Any non-null source is an author now;
  // those columns are only ever written BY an author.
  const authored = game.factsSource !== null || game.proseSource !== null;
  const enriched = authored || game.front !== null || game.screenshots.length > 0;
  // Distinct from `authored`: WHO wrote it, not whether anyone did.
  const fromOpenRetro = game.factsSource === 'openretro' || game.proseSource === 'openretro'
    || game.front !== null || game.title_ !== null || game.screenshots.length > 0;
  const hasBody = facts.length > 0 || game.description || game.front
    || game.screenshots.length > 0 || links.length > 0;
  if (!enriched || !hasBody) return null;

  const cover = game.front ?? game.title_;

  return (
    <div className="px-4 pb-3 sm:px-7" data-testid="game-facts">
      <div className="glass-card p-5">
        <div className="flex flex-col gap-5 md:flex-row">
          {cover && (
            // A FIXED box, with the image contained inside it.
            //
            // `h-auto` reserved no height at all until the bytes arrived, so
            // the whole card below the cover was painted at the top of the
            // page and then shoved down by ~280px when it decoded -- the jump
            // you see on opening a title. Nothing in the schema records an
            // image's dimensions (openretro_images stores sha1, kind, size
            // and source, no width/height), so the browser cannot be told the
            // real aspect ratio and has to be given a reserved one instead.
            //
            // 4/5 is the shape of Amiga box art (a measured cover is
            // 400x509 = 0.786 against this box's 0.8). object-contain means
            // a cover that disagrees letterboxes by a few pixels rather than
            // being cropped or resizing the layout. The grid's Cover has
            // done exactly this since it shipped, which is why the library
            // never had this bug.
            <div className="aspect-[4/5] w-full max-w-[220px] shrink-0 self-start overflow-hidden rounded-lg">
              <img
                src={cover.url}
                alt={`${game.title} cover`}
                data-testid="game-cover"
                decoding="async"
                className="h-full w-full object-contain"
              />
            </div>
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
              // w-[168px], not w-auto. With an auto width each thumbnail
              // occupied nothing until it decoded and then shoved every
              // thumbnail after it sideways -- measured on production as
              // three separate shifts, x 250->410, 410->565, 581->737.
              // Measured natural sizes are 472-500 x 400 (ratios 1.18-1.25),
              // so a 168x132 box at 1.27 contains the widest of them without
              // cropping, and object-contain letterboxes anything squarer by
              // a few pixels rather than moving its neighbours.
              <img key={s.sha1} src={s.url} alt={`${game.title} screenshot`}
                   loading="lazy" decoding="async"
                   className="h-[132px] w-[168px] shrink-0 rounded-md object-contain" />
            ))}
          </div>
        )}

        {/* Attribution. These images and facts are volunteer-contributed and
            copied into this project's own storage; crediting the source and
            linking back is the cheapest part of behaving well about that.
            
            CONDITIONAL, since the edit UI shipped. This block renders for
            hand-written content too now, and crediting OpenRetro for a
            sentence a person typed is the exact inverse of behaving well
            about attribution. Only claim it when something here really did
            come from them. */}
        {fromOpenRetro && (
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
        )}
      </div>
    </div>
  );
}
