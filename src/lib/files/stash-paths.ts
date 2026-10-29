// src/lib/files/stash-paths.ts
// STASH: paths, dates and the tree its rows make (Files spec 2026-10-29 §4.2, increment 2). Client-safe: no server imports.
import { AMIGA_NAME_MAX } from './path';

export const STASH_FILE_MAX = 20 * 1024 * 1024;         // browser drops and URLs (spec §4.2)
export const STASH_COMMIT_MAX_BYTES = 64 * 1024 * 1024; // one browser commit (R6)
export const STASH_COMMIT_MAX_ENTRIES = 200;

const AMIGA_EPOCH = Date.UTC(1978, 0, 1);

/** "days.mins.ticks" since 1978-01-01 UTC (a tick is 1/50 s), as the board sends it. */
export function amigaDateText(d: Date): string {
  const ms = Math.max(0, d.getTime() - AMIGA_EPOCH);
  const days = Math.floor(ms / 86_400_000);
  const rest = ms - days * 86_400_000;
  const mins = Math.floor(rest / 60_000);
  const ticks = Math.min(2999, Math.round((rest - mins * 60_000) / 20));
  return `${days}.${mins}.${ticks}`;
}

export function dateOfAmigaText(s: string): Date | null {
  const m = /^(\d{1,6})\.(\d{1,5})\.(\d{1,5})$/.exec(s);
  if (!m) return null;
  const [days, mins, ticks] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mins >= 1440 || ticks >= 3000) return null;
  return new Date(AMIGA_EPOCH + days * 86_400_000 + mins * 60_000 + ticks * 20);
}

export const sameStashName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** 'ReadMe' → 'ReadMe_1', 'a.txt' → 'a_1.txt': the first free number, the stem trimmed to keep the name ≤ 30. */
export function keepBothName(name: string, taken: (n: string) => boolean): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext0] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const suffix = `_${n}`;
    const ext = ext0.length + suffix.length < AMIGA_NAME_MAX ? ext0 : '';
    const candidate = stem.slice(0, AMIGA_NAME_MAX - suffix.length - ext.length) + suffix + ext;
    if (!taken(candidate)) return candidate;
  }
}

export type StashNode = { name: string; kind: 'dir' | 'file'; row: number | null; children: StashNode[] };

const takenIn = (n: StashNode) => (name: string) => n.children.some((c) => sameStashName(c.name, name));

/** Rows (oldest first) as a tree; implicit folders have row null; a later twin of a name gets the keep-both name (R4). */
export function stashTree(rows: readonly { path: string; kind: 'file' | 'dir' }[]): StashNode {
  const root: StashNode = { name: '', kind: 'dir', row: null, children: [] };
  // A file that a folder of the same name was needed under: the folder shown beside it.
  const twinDir = new Map<StashNode, StashNode>();
  rows.forEach((row, i) => {
    const segs = row.path.split('/').filter(Boolean);
    let cur = root;
    segs.forEach((seg, k) => {
      const hit = cur.children.find((c) => sameStashName(c.name, seg));
      if (k < segs.length - 1) {
        if (hit?.kind === 'dir') { cur = hit; return; }
        if (hit) {
          let twin = twinDir.get(hit);
          if (!twin) {
            twin = { name: keepBothName(seg, takenIn(cur)), kind: 'dir', row: null, children: [] };
            cur.children.push(twin);
            twinDir.set(hit, twin);
          }
          cur = twin;
          return;
        }
        const dir: StashNode = { name: seg, kind: 'dir', row: null, children: [] };
        cur.children.push(dir);
        cur = dir;
        return;
      }
      if (hit && hit.kind === 'dir' && hit.row === null && row.kind === 'dir') { hit.row = i; return; }
      cur.children.push({ name: hit ? keepBothName(seg, takenIn(cur)) : seg, kind: row.kind, row: i, children: [] });
    });
  });
  return root;
}

export function stashFind(root: StashNode, names: readonly string[]): StashNode | null {
  let cur = root;
  for (let k = 0; k < names.length; k++) {
    if (cur.kind !== 'dir') return null;
    const hit = cur.children.find((c) => sameStashName(c.name, names[k]));
    if (!hit) return null;
    cur = hit;
  }
  return cur;
}

/** Row indexes of a node and everything under it. */
export function rowsUnder(n: StashNode): number[] {
  return [...(n.row === null ? [] : [n.row]), ...n.children.flatMap(rowsUnder)];
}

/** `path` placed among `rows` without a clash: an existing folder is joined (its spelling kept), a clash renamed keep-both. */
export function uniqueStashPath(rows: readonly { path: string; kind: 'file' | 'dir' }[], path: string): string {
  const segs = path.split('/').filter(Boolean);
  let cur: StashNode | null = stashTree(rows);
  const out: string[] = [];
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const hit: StashNode | undefined = cur?.children.find((c) => sameStashName(c.name, seg));
    if (k === segs.length - 1) { out.push(hit && cur ? keepBothName(seg, takenIn(cur)) : seg); break; }
    if (hit?.kind === 'dir') { out.push(hit.name); cur = hit; continue; }
    if (hit && cur) { out.push(keepBothName(seg, takenIn(cur))); cur = null; continue; }
    out.push(seg);
    cur = null;
  }
  return out.join('/');
}
