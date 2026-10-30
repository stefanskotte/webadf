'use client';
import { useState } from 'react';
import { DiskIcon } from '@/components/ui/disk-icon';
import type { DiskColor } from '@/lib/disk-icon';
import { splitHint } from '@/lib/drop-hint';

/**
 * The shared look of Browse files and Choose files (C3 spec §2.1, §2.2): an ink pill around a hidden file input. The
 * colours are classes, not an inline style, so that below sm the same label can be the board's tile (C7 Ruling 19).
 */
export const INK_LABEL = 'inline-flex h-[38px] lg:h-8 shrink-0 cursor-pointer items-center rounded-[10px] bg-(--ink) px-3.5 text-[13px] font-semibold text-(--surface) has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-50';
export const INK_STYLE = { '--tw-ring-color': 'var(--ring)' } as React.CSSProperties;

/** Below sm a tile's grid cell: column 1 (Add) or 2 (Send) of the page's first row. */
export const TILE = {
  1: 'max-sm:col-start-1 max-sm:row-start-1',
  2: 'max-sm:col-start-2 max-sm:row-start-1',
  /** A zone alone in its row (Files, spec §5.4): the tile spans both columns of the zone's own two-column grid. */
  full: 'max-sm:col-span-2 max-sm:col-start-1 max-sm:row-start-1',
} as const;

/**
 * Below sm the board's 96 px tile (C7 spec §7): dashed, on the surface, its 13/600 word at the bottom. The word is CSS
 * content from data-tile, so the label's own text ("Browse files", which the 1440 tests read) is unchanged.
 */
export const TILE_LOOK = 'max-sm:h-24 max-sm:w-full max-sm:flex-col max-sm:justify-end max-sm:rounded-[14px] max-sm:border-[1.5px] max-sm:border-dashed max-sm:border-(--dash) max-sm:bg-(--surface) max-sm:px-2 max-sm:pb-3 max-sm:text-[13px] max-sm:text-(--ink) max-sm:before:content-[attr(data-tile)] max-sm:group-data-[over=true]:border-(--ink) max-sm:group-data-[over=true]:bg-(--surface-2)';

/**
 * The Files page's drop cards (C3 spec §2; the Upload page's until Files increment 3): the whole dashed card takes a
 * drop; its controls open the picker. Below sm
 * (C7 Plan ruling, Task 7) the section is display:contents, so its children are items of the page's two-column grid:
 * the file label is the tile, the 34 px disk sits on it, the hint and the controls go under both tiles.
 *
 * From lg (Files 2 §2, the approved mock-up) the card is a compact strip: no big disk, the title over the hint's first
 * sentence on the left (the rest is still read to a screen reader, and the "?" tells it all), the controls on one
 * line to the right, so the panes and the button bank get the height. A line the controls add (a status, a warning,
 * a board list) wraps under the strip only while it says something.
 */
export function DropCard({ testId, headingId, title, help, hint, keepHint = false, disk, tileCol, disabled, onFiles, onItems, children }: {
  testId: string; headingId: string; title: string; help?: React.ReactNode; hint: React.ReactNode;
  /** From lg the hint's rest stays on screen too, when no other line says it (the Send zone with no receiver line). */
  keepHint?: boolean;
  disk: { color: DiskColor; set: string; title: string }; tileCol: 1 | 2 | 'full'; disabled?: boolean;
  onFiles?: (files: FileList) => void;
  /** In place of onFiles, for a card that takes folders: the drop's items, to read before the handler returns. */
  onItems?: (items: DataTransferItemList) => void;
  children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const drop = (!!onFiles || !!onItems) && !disabled;
  // Only a drag that carries files is the card's business; a dragged link belongs to the URL field (final review M3).
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const h = typeof hint === 'string' ? splitHint(hint) : null;
  return (
    <section aria-labelledby={headingId} data-testid={testId} data-over={String(over)} data-drop={onFiles || onItems ? 'on' : 'off'}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); if (drop && !over) setOver(true); }}
      onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); if (drop && !over) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setOver(false); if (!drop) return; if (onItems) onItems(e.dataTransfer.items); else onFiles!(e.dataTransfer.files); }}
      className="group relative flex min-w-0 items-center gap-4 rounded-[20px] border-[1.5px] border-dashed border-[var(--dash)] bg-[var(--surface)] p-5 hover:border-[var(--ink)] data-[over=true]:border-[var(--ink)] data-[over=true]:bg-[var(--surface-2)] max-sm:contents sm:gap-5 sm:p-6 lg:gap-3 lg:rounded-[14px] lg:px-4 lg:py-2">
      <span aria-hidden="true" className={`pointer-events-none z-10 mt-[18px] self-start justify-self-center ${TILE[tileCol]} sm:hidden`}>
        <DiskIcon color={disk.color} size={34} />
      </span>
      <span className="hidden shrink-0 sm:block lg:hidden"><DiskIcon color={disk.color} size={84} set={disk.set} title={disk.title} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 max-sm:contents lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-3 lg:gap-y-1">
        <div className="flex min-w-0 flex-col gap-2 max-sm:contents lg:shrink lg:gap-0">
          <div className="flex items-center gap-1 max-sm:contents">
            <h2 id={headingId} className="text-[20px] font-bold max-sm:sr-only sm:text-[22px] lg:text-[16px] lg:leading-tight"
                style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>{title}</h2>
            {help}
          </div>
          <div data-testid={`${testId}-hint`} className="text-[13px] max-sm:order-1 max-sm:col-span-2 max-sm:text-[12px] lg:text-[12px] lg:leading-snug" style={{ color: 'var(--muted)' }}>
            {h ? <>{h.first}{h.rest && <span className={keepHint ? 'max-sm:hidden' : 'max-sm:hidden lg:sr-only'}>{` ${h.rest}`}</span>}</> : hint}
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}
