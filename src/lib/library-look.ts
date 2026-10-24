import type { DiskColor } from '@/lib/disk-icon';

/**
 * Pure look rules shared by the library grid, the table and the title page (spec
 * docs/superpowers/specs/2026-10-24-phase-c1-library-title-design.md §4). No stored colour exists for a title or a
 * collection, so each is derived from its id: the same id always draws the same colour.
 */

/** FNV-1a, unsigned: a small stable string hash (no randomness, no locale). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The kind tag's fill and text. One map for the grid, the table and the title page (ModernLibrary's wins). */
export function kindTag(kind: string | null | undefined): { bg: string; fg: string } {
  switch (kind) {
    case 'Game': return { bg: '#E1ECF8', fg: '#1D4A7A' };
    case 'App': return { bg: '#EEE5F5', fg: '#5A3380' };
    case 'Demo': return { bg: '#E2F0DF', fg: '#2E5B2A' };
    default: return { bg: 'var(--track)', fg: 'var(--muted)' };
  }
}

const TITLE_COLORS: DiskColor[] = ['black', 'red', 'blue', 'green'];

/**
 * The colour of a title's disk icon. An HD or HFE title is `grey`; a title with no kind that nobody authored is
 * `cream`; every other title is one of black / red / blue / green by a stable hash of its id.
 * `formats`: the image formats of the title's disks (case-insensitive; 'hfe' counts). `authored`: made here.
 */
export function titleDiskColor({ id, hasHd, kind, formats, authored }: {
  id: string; hasHd: boolean; kind: string | null | undefined; formats?: readonly string[]; authored?: boolean;
}): DiskColor {
  if (hasHd || (formats ?? []).some((f) => f.toLowerCase() === 'hfe')) return 'grey';
  if (!kind && !authored) return 'cream';
  return TITLE_COLORS[hash(id) % TITLE_COLORS.length];
}

const STAGES: Record<DiskColor, string> = {
  black: '#F1ECE2', blue: '#E9EEF4', grey: '#EEEDEA', red: '#F6E9E4', green: '#E8F0EA', cream: '#F4EFE5',
};

/** The tinted stage behind a disk icon on the title page (the board's map). */
export function stageFor(color: DiskColor): string {
  return STAGES[color];
}

/** The logo's four stripe colours, which a collection's dot is drawn from. */
export const COLLECTION_DOTS = ['#D9453A', '#EE8A2A', '#4F9D4A', '#2F6FB5'] as const;

/** A collection's dot colour: one of the four stripes, stable for its id. */
export function collectionDot(id: string): (typeof COLLECTION_DOTS)[number] {
  return COLLECTION_DOTS[hash(id) % COLLECTION_DOTS.length];
}
