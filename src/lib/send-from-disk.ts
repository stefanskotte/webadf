import type { AdfEntry } from '@/lib/adffs';

/** The inverse of adffs's protectionString ("hsparwed"; rwed SET means forbidden). R5: the low eight bits only. */
export function protectionBits(s: string): number {
  if (!/^[h-][s-][p-][a-][r-][w-][e-][d-]$/.test(s)) return 0;
  let b = 0;
  const high = [0x80, 0x40, 0x20, 0x10];
  const low = [0x08, 0x04, 0x02, 0x01];
  high.forEach((m, i) => { if (s[i] !== '-') b |= m; });
  low.forEach((m, i) => { if (s[4 + i] === '-') b |= m; });
  return b;
}

export type PickedFile = { block: number; path: string; protection: number; comment: string; sizeBytes: number };

/**
 * The files to send for the chosen entries (spec §4 "the disk Browse page"; R4): a file by its own name, a folder
 * under its own name with every file inside it, in tree order. Empty folders send nothing; a file chosen both on its
 * own and inside a chosen folder is sent once.
 */
export function pickFiles(root: AdfEntry[], blocks: readonly number[]): PickedFile[] {
  const want = new Set(blocks);
  const seen = new Set<number>();
  const out: PickedFile[] = [];
  const addAll = (e: AdfEntry, prefix: string) => {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.kind === 'file') {
      if (seen.has(e.block)) return;
      seen.add(e.block);
      out.push({ block: e.block, path, protection: protectionBits(e.protection), comment: e.comment ?? '', sizeBytes: e.sizeBytes });
      return;
    }
    for (const c of e.children) addAll(c, path);
  };
  const walk = (entries: AdfEntry[]) => {
    for (const e of entries) {
      if (want.has(e.block)) addAll(e, '');
      else if (e.kind === 'dir') walk(e.children);
    }
  };
  walk(root);
  return out;
}
