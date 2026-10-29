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
  return keepBothFrom(name, taken, 1).name;
}

/** keepBothName counting from `first`: a caller that knows every number below it is taken skips them. */
function keepBothFrom(name: string, taken: (n: string) => boolean, first: number): { name: string; n: number } {
  const dot = name.lastIndexOf('.');
  const [stem, ext0] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = first; ; n++) {
    const suffix = `_${n}`;
    const ext = ext0.length + suffix.length < AMIGA_NAME_MAX ? ext0 : '';
    const candidate = stem.slice(0, AMIGA_NAME_MAX - suffix.length - ext.length) + suffix + ext;
    if (!taken(candidate)) return { name: candidate, n };
  }
}

export type StashNode = { name: string; kind: 'dir' | 'file'; row: number | null; children: StashNode[] };

const takenIn = (n: StashNode) => (name: string) => n.children.some((c) => sameStashName(c.name, name));

/**
 * Rows (oldest first) as a tree; implicit folders have row null; a later twin of a name gets the keep-both name (R4).
 * Linear in the rows: each folder's children are looked up by lower-cased name, and each name's twins number on from
 * the last one given (an archive of 4,096 members, all one name, must not cost n² or n³).
 */
export function stashTree(rows: readonly { path: string; kind: 'file' | 'dir' }[]): StashNode {
  const root: StashNode = { name: '', kind: 'dir', row: null, children: [] };
  // Per folder: its children by lower-cased name (the first of a name wins, as a find would), and the next twin number.
  const index = new Map<StashNode, { byName: Map<string, StashNode>; next: Map<string, number> }>();
  const indexOf = (n: StashNode) => {
    let ix = index.get(n);
    if (!ix) index.set(n, ix = { byName: new Map(), next: new Map() });
    return ix;
  };
  const add = (parent: StashNode, child: StashNode) => {
    parent.children.push(child);
    const { byName } = indexOf(parent);
    const k = child.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, child);
  };
  const twinName = (parent: StashNode, seg: string) => {
    const { byName, next } = indexOf(parent);
    const k = seg.toLowerCase();
    const got = keepBothFrom(seg, (n) => byName.has(n.toLowerCase()), next.get(k) ?? 1);
    next.set(k, got.n + 1);
    return got.name;
  };
  // A file that a folder of the same name was needed under: the folder shown beside it.
  const twinDir = new Map<StashNode, StashNode>();
  rows.forEach((row, i) => {
    const segs = row.path.split('/').filter(Boolean);
    let cur = root;
    segs.forEach((seg, k) => {
      const hit = indexOf(cur).byName.get(seg.toLowerCase());
      if (k < segs.length - 1) {
        if (hit?.kind === 'dir') { cur = hit; return; }
        if (hit) {
          let twin = twinDir.get(hit);
          if (!twin) {
            twin = { name: twinName(cur, seg), kind: 'dir', row: null, children: [] };
            add(cur, twin);
            twinDir.set(hit, twin);
          }
          cur = twin;
          return;
        }
        const dir: StashNode = { name: seg, kind: 'dir', row: null, children: [] };
        add(cur, dir);
        cur = dir;
        return;
      }
      if (hit && hit.kind === 'dir' && hit.row === null && row.kind === 'dir') { hit.row = i; return; }
      add(cur, { name: hit ? twinName(cur, seg) : seg, kind: row.kind, row: i, children: [] });
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

/** One entry of a browser drop, as the planner needs it: `path` relative to the folder dropped into. */
export type DropFile = { path: string; kind: 'file' | 'dir'; sizeBytes: number };
export type StashDropRefusal = 'too_large' | 'folder_too_large' | 'folder_too_many';

/**
 * A drop split into commits (R6, ruling 12): a file over 20 MB is refused alone (`too_large`); the rest is grouped by
 * its first segment, so a dropped folder always travels in one commit; a folder over 64 MB (`folder_too_large`) or over
 * 200 entries, itself included (`folder_too_many`), is refused whole; the tops are packed in order into commits of at
 * most 64 MB and 200 entries, a commit closing when the next top would not fit.
 */
export function planStashBatches<T extends DropFile>(items: readonly T[]): { batches: T[][]; refused: { path: string; why: StashDropRefusal }[] } {
  const refused: { path: string; why: StashDropRefusal }[] = [];
  const tops = new Map<string, T[]>();
  for (const it of items) {
    if (it.kind === 'file' && it.sizeBytes > STASH_FILE_MAX) { refused.push({ path: it.path, why: 'too_large' }); continue; }
    const top = it.path.split('/').filter(Boolean)[0] ?? it.path;
    const key = top.toLowerCase();
    if (!tops.has(key)) tops.set(key, []);
    tops.get(key)!.push(it);
  }
  const bytesOf = (xs: readonly T[]) => xs.reduce((a, x) => a + (x.kind === 'file' ? x.sizeBytes : 0), 0);
  const batches: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const group of tops.values()) {
    const top = group[0].path.split('/').filter(Boolean)[0] ?? group[0].path;
    const bytes = bytesOf(group);
    if (group.length > STASH_COMMIT_MAX_ENTRIES) { refused.push({ path: top, why: 'folder_too_many' }); continue; }
    if (bytes > STASH_COMMIT_MAX_BYTES) { refused.push({ path: top, why: 'folder_too_large' }); continue; }
    if (cur.length && (cur.length + group.length > STASH_COMMIT_MAX_ENTRIES || curBytes + bytes > STASH_COMMIT_MAX_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(...group);
    curBytes += bytes;
  }
  if (cur.length) batches.push(cur);
  return { batches, refused };
}
