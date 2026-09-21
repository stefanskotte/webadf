import type { AdfEntry } from '@/lib/adffs';

/**
 * File-level changes between two filesystem trees.
 *
 * THE REQUIREMENT THIS SERVES is timeline browsing: the operator wants to step
 * through a disk version's history and understand what each version changed at
 * the file level. A history UI lists the changes per version to let the user
 * select what to explore next.
 *
 * Why paths and not entries. The index holds entries, not paths; reconstructing
 * a tree from entries requires walking again. Paths are stable across versions
 * and sufficient to report what the user cares about: "this file was removed",
 * "that directory was added", "this file changed".
 *
 * Why report directories only when added/removed, not their contents separately.
 * A directory is a container; removing it removes its contents implicitly. If a
 * file moves into a new directory, the directory addition and the file addition
 * are both reported -- the user's tree view will show the hierarchy correctly.
 */

export interface TreeChange {
  path: string;
  kind: 'added' | 'changed' | 'removed';
  isDir: boolean;
}

/**
 * Compares two filesystem trees and returns changes: removed entries (first),
 * changed entries (second), added entries (third), each sorted alphabetically.
 * Paths are root-relative, using '/' as separator.
 *
 * Newest-first callers pass (before, after).
 */
export function diffTrees(before: readonly AdfEntry[], after: readonly AdfEntry[]): TreeChange[] {
  const beforeMap = treeToMap(before);
  const afterMap = treeToMap(after);

  const removed: TreeChange[] = [];
  const changed: TreeChange[] = [];
  const added: TreeChange[] = [];

  // Check all paths that were in before.
  for (const [path, beforeEntry] of beforeMap) {
    const afterEntry = afterMap.get(path);
    if (!afterEntry) {
      // Path existed before but not after: removed.
      removed.push({ path, kind: 'removed', isDir: beforeEntry.kind === 'dir' });
    } else if (beforeEntry.kind !== afterEntry.kind) {
      // Kind changed (file↔dir): treat as removal and addition.
      removed.push({ path, kind: 'removed', isDir: beforeEntry.kind === 'dir' });
      added.push({ path, kind: 'added', isDir: afterEntry.kind === 'dir' });
    } else if (beforeEntry.kind === 'file' && entriesChanged(beforeEntry, afterEntry)) {
      // Same kind, but file properties differ.
      changed.push({ path, kind: 'changed', isDir: false });
    }
  }

  // Check all paths that are in after but not in before: added.
  for (const [path, afterEntry] of afterMap) {
    if (!beforeMap.has(path)) {
      added.push({ path, kind: 'added', isDir: afterEntry.kind === 'dir' });
    }
  }

  // Sort each group alphabetically and return in order: removed, changed, added.
  return [
    ...removed.sort((a, b) => a.path.localeCompare(b.path)),
    ...changed.sort((a, b) => a.path.localeCompare(b.path)),
    ...added.sort((a, b) => a.path.localeCompare(b.path)),
  ];
}

/**
 * Check if a file entry has changed (size, modification time, or block).
 */
function entriesChanged(before: AdfEntry, after: AdfEntry): boolean {
  // Size changed.
  if (before.sizeBytes !== after.sizeBytes) return true;

  // Block changed.
  if (before.block !== after.block) return true;

  // Modification time changed. Handle null cases: if one is null and the other
  // is not, they differ. If both are null or both are dates, compare them.
  const beforeTime = before.modifiedAt?.getTime() ?? null;
  const afterTime = after.modifiedAt?.getTime() ?? null;
  if (beforeTime !== afterTime) return true;

  return false;
}

/**
 * Walk a tree into a flat map of path → AdfEntry, including directories and their children.
 * Paths use '/' as separator and are root-relative.
 */
function treeToMap(entries: readonly AdfEntry[]): Map<string, AdfEntry> {
  const map = new Map<string, AdfEntry>();

  function walk(items: readonly AdfEntry[], parentPath: string) {
    for (const item of items) {
      const path = parentPath ? `${parentPath}/${item.name}` : item.name;
      map.set(path, item);

      // For directories, walk their children.
      if (item.kind === 'dir' && item.children.length > 0) {
        walk(item.children, path);
      }
    }
  }

  walk(entries, '');
  return map;
}

/**
 * Returns a one-line summary for a disk whose filesystem is unreadable.
 * Pluralises on 1 sector.
 */
export function sectorSummary(sectorCount: number): string {
  const plural = sectorCount === 1 ? 'sector' : 'sectors';
  return `${sectorCount} ${plural} changed`;
}
