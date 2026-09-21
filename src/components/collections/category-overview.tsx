/* eslint-disable @next/next/no-img-element */
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
 * The totals stay because a number you would otherwise count by hand is worth
 * the line. The "Everything is filed." that used to sit beside them does not:
 * it was explaining why this page was not the grid, back when the cards were
 * bare rectangles with a name on them.
 *
 * Only rendered when there ARE collections. An account with no collections and
 * no titles is an EMPTY library, and the grid already says so properly; a
 * second empty state here would be a worse copy that appears only on brand-new
 * accounts. See the caller.
 */

/** The same deterministic hue the game covers use, so an imageless card here looks like an imageless card there. */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function gradientFor(id: string): string {
  const hue = hueFor(id);
  return `linear-gradient(150deg, oklch(0.44 0.16 ${hue}), oklch(0.24 0.10 ${(hue + 45) % 360}))`;
}

/**
 * One tile of the mosaic.
 *
 * `object-cover` rather than the contain-over-blur treatment a game card uses:
 * a tile is a quarter of a small card, and at that size the mosaic is read as
 * texture and colour -- "this is the demos one" -- not as individual box art.
 * Cropping is what makes four different images read as one surface; contain
 * would leave four letterboxed slivers with gaps between them.
 */
function Tile({ url }: { url?: string }) {
  // An empty cell draws NOTHING, so the one gradient behind the whole mosaic
  // shows through it. Giving each empty cell its own gradient was tried first
  // and measured by eye: two unrelated hues beside two real covers read as
  // noise, where one continuous surface reads as "there are two covers here".
  if (!url) return null;
  return (
    <img
      src={url} alt="" aria-hidden="true" loading="lazy" decoding="async"
      data-testid="mosaic-tile"
      className="h-full w-full object-cover"
    />
  );
}

/**
 * The mosaic behind a collection card: a 2x2 of its first covers.
 *
 * A single cover fills the whole square instead of sitting in one corner with
 * three empty cells -- one picture is a picture, not a broken grid. Every
 * missing cell falls back to the deterministic gradient, which is the app's
 * own "no image" look (see Cover), so a half-identified collection looks
 * intentional rather than half-loaded. That is the common case here:
 * OpenRetro recognises a small minority of a real archive.
 */
function Mosaic({ id, covers }: { id: string; covers: string[] }) {
  if (covers.length === 0) {
    return <div className="absolute inset-0" style={{ background: gradientFor(id) }} />;
  }
  if (covers.length === 1) {
    return (
      <div className="absolute inset-0" style={{ background: gradientFor(id) }}>
        <Tile url={covers[0]} />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px" style={{ background: gradientFor(id) }}>
      {[0, 1, 2, 3].map((i) => (
        <Tile key={i} url={covers[i]} />
      ))}
    </div>
  );
}

export function CategoryOverview({
  collections, totalTitles, totalDisks, mosaics,
}: {
  collections: CollectionListItem[];
  totalTitles: number;
  totalDisks: number;
  /** Collection id -> up to four cover URLs. Absent means "nothing to show": the card draws its gradient. */
  mosaics?: Map<string, string[]>;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="category-overview">
      {/* Just the totals. "Everything is filed." went with the bare cards
          (operator, 2026-09-21): it was there to explain why the page was not
          the grid you expected, and a wall of collection art explains itself.

          `--on-dark-muted`, NOT `--muted-2`. The grey ramp (globals.css) is
          for text on a LIGHT surface -- inside a glass card -- and #5f6874 on
          the shell's dark band is very nearly invisible, which is exactly what
          this line was (operator, 2026-09-21). This text sits directly on the
          page background, in the same dark band as the PageHeader subtitle
          immediately above it, so it takes the same colour that subtitle does.
          Anything rendered outside a card on this shell has the same
          question to answer. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1">
        <span className="font-mono text-[11.5px]" style={{ color: 'var(--on-dark-muted)' }}>
          {totalTitles.toLocaleString()} titles · {totalDisks.toLocaleString()} disks ·{' '}
          {collections.length.toLocaleString()} {collections.length === 1 ? 'collection' : 'collections'}
        </span>
      </div>

      {/* The same breakpoints the game grid uses, so the two views of the same
          library line up column for column instead of each having its own
          idea of how wide a card is. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
        {collections.map((c) => (
          <Link
            key={c.id}
            href={viewHref({ kind: 'collection', id: c.id })}
            data-testid={`overview-card-${c.id}`}
            className="glass-card relative aspect-square overflow-hidden p-0"
          >
            <Mosaic id={c.id} covers={mosaics?.get(c.id) ?? []} />
            {/* The name sits ON the mosaic rather than under it, which is what
                keeps the card square whatever the name's length.

                A SOFT SCRIM WAS NOT ENOUGH (operator, 2026-09-21: "the text is
                not easy to read"). Box art is bright, saturated and
                unpredictable -- amber and pale covers put white text on a
                near-white ground, and a gradient that fades to transparent
                offers no floor. So the label block is its own surface: a band
                that is essentially opaque where the text actually sits, only
                fading out ABOVE it, with the app's ink colour rather than flat
                black so it belongs to the card. The hairline along its top
                edge is what keeps it from reading as a smudge over the art,
                and the blur softens whatever detail still shows through. */}
            <div
              className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 px-3 pb-2.5 pt-6 backdrop-blur-[3px]"
              style={{
                background: 'linear-gradient(to top, rgb(9 15 24 / 0.94) 0%, rgb(9 15 24 / 0.90) 62%, rgb(9 15 24 / 0) 100%)',
                boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.14)',
              }}
            >
              <span
                className="truncate text-[14px] font-semibold"
                style={{ color: '#fff', textShadow: '0 1px 2px rgb(0 0 0 / 0.55)' }}
              >
                {c.name}
              </span>
              <span className="font-mono text-[11px]" style={{ color: 'rgb(255 255 255 / 0.78)' }}>
                {c.gameCount.toLocaleString()} {c.gameCount === 1 ? 'title' : 'titles'}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
