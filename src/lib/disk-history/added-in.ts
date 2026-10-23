import type { HistoryVersion } from './history';

/**
 * "New in vN" (A5): for each entry path still on the disk, the version that
 * added it -- replayed oldest first from the file-level changes the History
 * panel already computed, so a later remove clears the mark and a re-add
 * takes the newer version; a restore brings back the mark an entry had. Only the detailed (newest) versions carry
 * changes; an entry added further back simply has no mark.
 */
export function addedIn(history: readonly HistoryVersion[]): Map<string, number> {
  const out = new Map<string, number>();
  // Every mark ever given, kept through removals: a restore (an Undo is one)
  // puts an entry back with the mark it had, not a new one, and an entry it
  // puts back that was never added (it was on the original) gets none.
  const given = new Map<string, number>();
  for (const version of [...history].sort((a, b) => a.seq - b.seq)) {
    if (version.seq === 0) continue;
    for (const c of version.changes) {
      if (c.kind === 'added' && version.source === 'rewind') {
        const earlier = given.get(c.path);
        if (earlier !== undefined) out.set(c.path, earlier);
      } else if (c.kind === 'added') {
        out.set(c.path, version.seq);
        given.set(c.path, version.seq);
      } else if (c.kind === 'removed') {
        out.delete(c.path);
        // A removed folder takes everything under it.
        for (const p of out.keys()) if (p.startsWith(`${c.path}/`)) out.delete(p);
      }
    }
  }
  return out;
}
