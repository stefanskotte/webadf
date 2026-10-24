/* eslint-disable @next/next/no-img-element */
import type { ReactNode } from 'react';
import { DiskIcon } from '@/components/ui/disk-icon';
import { kindTag, stageFor, titleDiskColor } from '@/lib/library-look';

/**
 * The top of the title page (spec docs/superpowers/specs/2026-10-24-phase-c1-library-title-design.md §5.2; board:
 * ModernTitle): the art, the heading with its info pills and the edit trigger, and the identify box.
 *
 * Pure markup over plain props so it renders (and unit-tests) without a database. The three client pieces that live
 * in it -- the edit trigger, the cover buttons and the Demozoo / TOSEC identify content -- arrive as slots.
 */

const PILL = 'inline-flex w-fit max-w-full items-center rounded-full px-2.5 py-[3px] text-[13px] font-medium leading-tight';
const NEUTRAL = { background: 'var(--track)', color: 'var(--muted)' };

export interface TitleHeroProps {
  title: string;
  id: string;
  year: number | null;
  publisher: string | null;
  /** Game / App / Demo ..., or null when no TOSEC set says (then there is no kind pill). */
  kind: string | null;
  diskCount: number;
  /** The cover to show (override, else OpenRetro's front, else its title screen), or null. */
  cover: { url: string } | null;
  /** The image formats of the title's disks, for the disk icon's colour (an HFE title is grey). */
  formats: readonly string[];
  hasHd: boolean;
  authored: boolean;
  /** `DF0 · ADF` when a disk of this title is confirmed in a drive, else null. */
  mounted: string | null;
  /** The disk icon's set line: the collection carried by ?from=, else the kind, else `Unidentified`. */
  setLabel: string;
  editSlot: ReactNode;
  coverSlot: ReactNode;
  identifySlot: ReactNode;
}

export function TitleHero({
  title, id, year, publisher, kind, diskCount, cover, formats, hasHd, authored, mounted, setLabel,
  editSlot, coverSlot, identifySlot,
}: TitleHeroProps) {
  const color = titleDiskColor({ id, hasHd, kind, formats, authored });
  const tag = kindTag(kind);
  return (
    <section data-testid="title-hero"
             className="glass-card flex flex-col gap-6 rounded-[20px] p-5 sm:p-7 lg:flex-row lg:items-center lg:gap-9">
      <div className="flex w-full max-w-[260px] shrink-0 flex-col items-center gap-2 self-center lg:self-auto">
        {/* A FIXED box either way, so nothing shifts when an image decodes (the 4/5 box GameFacts used to own). */}
        {cover ? (
          <div data-testid="title-art" className="aspect-[4/5] w-full overflow-hidden rounded-2xl"
               style={{ background: 'var(--surface-2)' }}>
            <img src={cover.url} alt={`${title} cover`} data-testid="game-cover" decoding="async"
                 className="h-full w-full object-contain" />
          </div>
        ) : (
          <div data-testid="title-art" className="flex h-[240px] w-full items-center justify-center rounded-2xl"
               style={{ background: stageFor(color) }}>
            <DiskIcon color={color} size={180} hd={hasHd} stack={diskCount} mounted={mounted !== null}
                      set={setLabel} title={title} />
          </div>
        )}
        {coverSlot}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        <h1 className="break-words text-[34px] font-bold leading-none tracking-[-0.02em] sm:text-[48px]"
            style={{ color: 'var(--ink)' }}>
          {title}
        </h1>
        <div data-testid="title-pills" className="flex flex-wrap items-center gap-2">
          {kind && (
            <span data-testid="title-pill-kind" className={PILL} style={{ background: tag.bg, color: tag.fg }}>{kind}</span>
          )}
          <span data-testid="title-pill-disks" className={PILL} style={NEUTRAL}>
            {diskCount} disk{diskCount === 1 ? '' : 's'}
          </span>
          {/* Both values of a state: an unknown year or publisher is a dash, not an absent pill. */}
          <span data-testid="title-pill-year" className={PILL} style={NEUTRAL}>Year {year ?? '—'}</span>
          <span data-testid="title-pill-publisher" className={PILL} style={NEUTRAL}>Publisher {publisher ?? '—'}</span>
          {mounted && (
            <span data-testid="title-pill-drive"
                  className={`${PILL} gap-1.5 font-mono !text-[12px] !font-semibold`}
                  style={{ background: 'var(--drive-pill-bg)', color: 'var(--drive-pill-fg)' }}>
              <span aria-hidden className="size-1.5 rounded-full" style={{ background: '#3FBF55' }} />
              {mounted}
            </span>
          )}
        </div>
        <div className="flex gap-2">{editSlot}</div>
      </div>

      <div data-testid="title-identify"
           className="flex w-full shrink-0 flex-col gap-2.5 rounded-[14px] p-[18px] lg:w-[360px] lg:self-stretch"
           style={{ background: 'var(--surface-2)' }}>
        {identifySlot}
      </div>
    </section>
  );
}
