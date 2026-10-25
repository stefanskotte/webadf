// The disk page's look rules (Phase C4 spec §5.5): pure and client-safe.
import type { AdfEntry } from '@/lib/adffs';
import type { TreeChange } from '@/lib/disk-history/diff';
import type { HistoryVersion } from '@/lib/disk-history/history';
import type { MountChoice } from '@/lib/mount-choice';
import { PROTECTION_FLAGS } from '@/lib/protection-bits';

export const formatKb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** `1 file`, `2 files`, `1 .info file` -- the counts on the Disk card and in the footer. */
export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const TEXT_EXT = new Set(['txt', 'doc', 'guide', 'readme', 'prefs', 'asc', 'me']);

/** Ruling 14: by name only -- no file bytes are read for the listing. */
export function entryGlyph(e: Pick<AdfEntry, 'kind' | 'name'>): { label: string; bg: string; fg: string } {
  if (e.kind === 'dir') return { label: 'DIR', bg: 'var(--dir-bg)', fg: 'var(--accent-blue)' };
  const lower = e.name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  if (ext === 'info') return { label: 'ICN', bg: 'var(--track)', fg: 'var(--muted-2)' };
  if (TEXT_EXT.has(ext) || /^read_?me/.test(lower)) return { label: 'TXT', bg: 'var(--track)', fg: 'var(--muted)' };
  if (!ext) return { label: 'EXE', bg: 'var(--exe-bg)', fg: 'var(--exe-fg)' };
  return { label: ext.slice(0, 3).toUpperCase(), bg: 'var(--track)', fg: 'var(--muted)' };
}

/** Ruling 13: all eight bits, in PROTECTION_FLAGS order; `on` = the letter shows in the string. */
export function protectionChips(p: string): { letter: string; on: boolean; label: string }[] {
  return PROTECTION_FLAGS.map((flag, i) => ({ letter: flag.letter, on: p[i] === flag.letter, label: flag.label }));
}

/** Ruling 15: blocks of entries whose `<name>.info` sits beside them, per directory, case-insensitive. */
export function infoCompanions(entries: AdfEntry[], into = new Set<number>()): Set<number> {
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (!lower.endsWith('.info') && names.has(`${lower}.info`)) into.add(e.block);
    if (e.kind === 'dir') infoCompanions(e.children, into);
  }
  return into;
}

export function countInfo(entries: AdfEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (e.kind === 'file' && e.name.toLowerCase().endsWith('.info')) n++;
    if (e.kind === 'dir') n += countInfo(e.children);
  }
  return n;
}

export function countTree(entries: AdfEntry[]): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  for (const e of entries) {
    if (e.kind === 'dir') {
      dirs++;
      const n = countTree(e.children);
      files += n.files;
      dirs += n.dirs;
    } else files++;
  }
  return { files, dirs };
}

export function changeCounts(changes: TreeChange[]): { added: number; changed: number; removed: number } {
  const out = { added: 0, changed: 0, removed: 0 };
  for (const c of changes) out[c.kind]++;
  return out;
}

/** The drive light (spec §2): holderText's ranking, as a state the dot and data-state carry. */
export function driveLight(choices: MountChoice[]): 'in' | 'moving' | 'stale' | 'none' {
  const held = choices.filter((c) => c.isThisDisk);
  const inDf1 = choices.filter((c) => c.df1?.isThisDisk === true);
  if (held.some((c) => c.state === 'converged') || inDf1.some((c) => c.df1Held)) return 'in';
  if (held.some((c) => c.state === 'pending') || inDf1.some((c) => !c.df1Held && !c.df1Stale)) return 'moving';
  if (held.length > 0 || inDf1.length > 0) return 'stale';
  return 'none';
}

/** The disk row's badge rule (disk-row.tsx): DF0 converged on this disk, else DF1 holding its digest. */
export function driveBadge(choices: MountChoice[]): 'DF0' | 'DF1' | null {
  if (choices.some((c) => c.state === 'converged' && c.isThisDisk)) return 'DF0';
  if (choices.some((c) => c.df1Held)) return 'DF1';
  return null;
}

export function densityPill(rootBlock: number, sizeBytes: number): string {
  return rootBlock === 1760 || sizeBytes >= 1_802_240 ? 'HD · 1.76 MB' : 'DD · 880 KB';
}

/** Ruling 24: the head, and the version on screen. */
export function openByDefault(versions: HistoryVersion[], viewingSeq: number | null): Set<number> {
  const open = new Set<number>();
  const head = versions.find((v) => v.isHead);
  if (head) open.add(head.seq);
  if (viewingSeq !== null) open.add(viewingSeq);
  return open;
}
