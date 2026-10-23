import type { AdfEntry } from '@/lib/adffs';

/** A Workbench icon file: "Disk.info", "Copy.info". */
export const isInfoFile = (e: AdfEntry) => e.kind === 'file' && e.name.toLowerCase().endsWith('.info');

/**
 * The disk browser's name filter and "Hide .info files" (A5), applied to the
 * tree before it is flattened into rows. A match is a case-insensitive
 * substring of the entry's name; the folders on the way to a match stay, and
 * are returned in `open` so the browser can show what matched without the
 * person opening each one. A folder whose own name matches keeps everything in
 * it. With neither in force the input comes back as is.
 */
export function filterTree(
  entries: AdfEntry[], { query, hideInfo }: { query: string; hideInfo: boolean },
): { entries: AdfEntry[]; open: Set<number> } {
  const q = query.trim().toLowerCase();
  const open = new Set<number>();
  if (!q && !hideInfo) return { entries, open };

  const visible = (list: AdfEntry[]) => (hideInfo ? list.filter((e) => !isInfoFile(e)) : list);
  const all = (list: AdfEntry[]): AdfEntry[] =>
    visible(list).map((e) => (e.kind === 'dir' ? { ...e, children: all(e.children) } : e));

  const walk = (list: AdfEntry[]): AdfEntry[] => {
    const out: AdfEntry[] = [];
    for (const e of visible(list)) {
      if (!q || e.name.toLowerCase().includes(q)) {
        out.push(e.kind === 'dir' ? { ...e, children: q ? all(e.children) : walk(e.children) } : e);
        continue;
      }
      if (e.kind !== 'dir') continue;
      const children = walk(e.children);
      if (children.length) {
        open.add(e.block);
        out.push({ ...e, children });
      }
    }
    return out;
  };
  return { entries: walk(entries), open };
}
