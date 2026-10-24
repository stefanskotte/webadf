/* eslint-disable @next/next/no-img-element */
import { DiskIcon } from '@/components/ui/disk-icon';
import { holdLabel, type Hold } from '@/lib/drive-holds';
import { stageFor, titleDiskColor } from '@/lib/library-look';
import type { GameListItem } from '@/lib/queries';

/** A card's byline: what is known, and nothing when nothing is (operator 2026-10-22: no "unidentified"). */
export function titleByline(g: Pick<GameListItem, 'year' | 'publisher' | 'authored'>): string {
  return [g.year, g.publisher].filter(Boolean).join(' · ') || (g.authored ? 'made here' : '');
}

/** The no-cover disk's set line: the card's byline, or the density for an HD title. */
function diskSetLine(g: GameListItem): string {
  return g.hasHd ? 'HD · 1.76 MB' : titleByline(g);
}

/**
 * The card's DF0 pill (board: ModernLibrary): green dot once the board confirms, amber and `DF0…` while it is only
 * asked for. Drawn with or without a cover, beside the ring round the card (Ruling 7). `title` names the holds.
 */
export function DriveBadge({ holds, diskCount, inline = false }: {
  holds: Hold[] | undefined; diskCount: number;
  /** In flow after a table row's title, instead of floated over a card's art (spec §3.2). */
  inline?: boolean;
}) {
  if (!holds || holds.length === 0) return null;
  const mounted = holds.some((h) => h.state === 'mounted');
  return (
    <span data-testid="drive-badge" title={holds.map((h) => holdLabel(h, diskCount)).join('; ')}
          className={`flex items-center gap-[5px] rounded-full font-mono text-[11px] font-semibold leading-4 ${
            inline ? 'shrink-0 py-px pl-[7px] pr-[7px]' : 'absolute right-2 top-2 z-[1] py-0.5 pl-[7px] pr-2'}`}
          style={{ background: 'var(--drive-pill-bg)', color: 'var(--drive-pill-fg)', ...(inline ? {} : { boxShadow: '0 2px 6px rgb(0 0 0 / 0.3)' }) }}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full"
            style={mounted
              ? { background: 'var(--online-dot)', boxShadow: '0 0 5px var(--online-dot)' }
              : { background: 'var(--fetch-dot)' }} />
      {mounted ? 'DF0' : 'DF0…'}
    </span>
  );
}

/**
 * A title's art box on its library card (spec §1.3; board: ModernLibrary `.m-card`): a 4 / 5 box, so a card is the
 * same size whether its image has decoded, failed or never existed.
 *
 * With an image: the image twice, blurred and overscanned to fill the box, then the real one contained on top
 * (Ruling 9). Covers are portrait box art and screenshots are landscape, so neither `cover` (which would crop a
 * cover's logo away) nor `contain` alone (which would leave bare stage down the sides) suits both. The browser
 * fetches one URL once, so the second <img> costs no request.
 *
 * Without one -- the ordinary case, since OpenRetro and TOSEC recognise well under half a real library -- the
 * title's disk on its stage colour, which has to look intentional rather than missing.
 *
 * Hover moves only what is inside the clipped box (the cover scales, the disk lifts), never the card's own box: the
 * drag specs compare card boxes with the pointer over them. Reduced motion turns both off.
 */
export function Cover({ game: g, holds }: { game: GameListItem; holds: Hold[] | undefined }) {
  const color = titleDiskColor(g);
  // mounted={false} always: the card's one DF0 mark is the pill (DriveBadge), which also carries the amber `DF0…`
  // state and the hold tooltip. The icon's own badge would add a second mark that appears only on confirmation.
  const disk = { color, set: diskSetLine(g), title: g.title, hd: g.hasHd, stack: g.diskCount, mounted: false };
  return (
    <div className="relative m-2 mb-0 overflow-hidden rounded-[10px]"
         style={{ aspectRatio: '4 / 5', background: stageFor(color) }}>
      {g.coverUrl ? (
        <div className="absolute inset-0 transition-transform duration-[350ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-safe:group-hover:scale-[1.035]">
          <img
            src={g.coverUrl} alt="" aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
            style={{ filter: 'blur(18px) saturate(1.3)', transform: 'scale(1.35)', opacity: 0.55 }}
          />
          <img
            src={g.coverUrl} alt={`${g.title} cover`} data-testid="cover-image"
            loading="lazy" decoding="async"
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5">
          <div data-testid="cover-disk"
               className="transition-transform duration-[250ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-safe:group-hover:-translate-y-1.5 motion-safe:group-hover:-rotate-3">
            <DiskIcon {...disk} size={96} className="md:hidden" />
            <DiskIcon {...disk} size={124} className="hidden md:block" />
          </div>
          <span className="text-[11px] font-medium" style={{ color: 'var(--muted-2)' }}>No cover art yet</span>
        </div>
      )}
      <DriveBadge holds={holds} diskCount={g.diskCount} />
      {/* The board's inset hairline, over the art so it frames an image as well as the stage. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[10px]"
            style={{ boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.08)' }} />
    </div>
  );
}
