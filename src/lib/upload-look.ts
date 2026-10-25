// The Upload page's look rules (Phase C3 spec §3): pure and client-safe.
import type { DiskColor } from '@/lib/disk-icon';
import { driveDiskColor } from '@/lib/library-look';
import type { StagingFilter, Tone, ViewRow } from '@/lib/upload-staging';

export const FILTERS: { id: StagingFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'in', label: 'From the Amiga' },
  { id: 'out', label: 'To the Amiga' },
  { id: 'lib', label: 'To the library' },
];
export const EMPTY_UNDER: Record<Exclude<StagingFilter, 'all'>, string> = {
  lib: 'Nothing to the library right now.',
  out: 'Nothing to the Amiga right now.',
  in: 'Nothing from the Amiga right now.',
};

const PILLS = {
  lib: { label: 'To library', arrow: '↓', bg: 'var(--track)', fg: 'var(--muted)' },
  out: { label: 'To Amiga', arrow: '→', bg: 'var(--to-amiga-bg)', fg: 'var(--accent-blue)' },
  in: { label: 'From Amiga', arrow: '←', bg: 'var(--from-amiga-bg)', fg: 'var(--from-amiga-fg)' },
} as const;
export const directionPill = (kind: ViewRow['kind']) => ({ ...PILLS[kind] });

const TONES: Record<Tone, { fg: string; dot: string }> = {
  done: { fg: 'var(--success-fg)', dot: 'var(--online-dot)' },
  busy: { fg: 'var(--warning-fg)', dot: 'var(--fetch-dot)' },
  wait: { fg: 'var(--muted)', dot: 'var(--dash)' },
  fail: { fg: 'var(--danger-fg)', dot: 'var(--danger-fg)' },
};
export const toneLook = (tone: Tone) => ({ ...TONES[tone] });

/** Ruling 17: failed cream; a known title its library colour; else by direction. */
export function rowDiskColor(v: ViewRow): DiskColor {
  if (v.tone === 'fail') return 'cream';
  if (v.gameId) return driveDiskColor(v.gameId);
  if (v.kind === 'out') return 'blue';
  if (v.kind === 'in') return v.row.source === 'server' && v.row.isDiskImage ? 'black' : 'grey';
  return 'black';
}

/** The filter a key moves to (a roving radiogroup), or null for any other key. */
export function filterAfterKey(current: StagingFilter, key: string): StagingFilter | null {
  const ids = FILTERS.map((f) => f.id);
  const at = ids.indexOf(current);
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  const dir = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  return dir ? ids[(at + dir + ids.length) % ids.length] : null;
}
