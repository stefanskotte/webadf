// Files from the computer dropped on a pane inside a disk (Files increment 1, R5). CLIENT-SAFE: no database import.
// The Browse page's drop pipeline without its review list: the same stageDrop (staging.ts) names, clash and depth
// checks and the same block estimate (blocksForPlan) as drop-staging.tsx, then one manifest for
// POST /api/disks/<id>/files/batch. Where the review list let a person rename or skip a clashing row, this refuses the
// whole drop instead and says why -- like a copy (ops.ts), it writes all of it or none of it.
import { blocksForPlan, type Filesystem } from '@/lib/adffs';
import { joinDestination, pathTooDeep, stageDrop, type ExistingEntry } from '@/lib/staging';
import type { DroppedItem } from '@/lib/drop-reader';
import { refusalWords } from './words';

export type DropManifestEntry = { op: 'mkdir' | 'add'; path: string; protection?: number };

export type DropPlan =
  | {
    ok: true; manifest: DropManifestEntry[];
    /** The file parts of the multipart body: [disk path, file], in manifest order. */
    parts: [string, File][];
    /** [as dropped, as written] for every name made writable or shortened. */
    renamed: [string, string][];
  }
  /** `message` null: nothing was dropped, so nothing to say. */
  | { ok: false; message: string | null };

const listOf = (names: string[]) => names.join(', ');

/**
 * Plan a drop into the folder `parentPath` ('' for the disk's root; its names joined by '/') of a disk whose `folder`
 * entries are already there. Paths in the manifest are from the disk's root, as the batch route reads them.
 */
export function planComputerDrop(
  dropped: readonly DroppedItem[], folder: readonly ExistingEntry[],
  disk: { filesystem: Filesystem; intl: boolean; freeBytes: number | null; parentPath: string },
): DropPlan {
  if (dropped.length === 0) return { ok: false, message: null };
  const staged = stageDrop(dropped, new Map([['', folder]]), disk.intl);

  const there = staged.filter((s) => s.collidesWith === 'existing').map((s) => s.name);
  if (there.length) return { ok: false, message: `${refusalWords('name_exists').slice(0, -1)}: ${listOf(there)}.` };
  const twice = staged.filter((s) => s.collidesWith === 'staged').map((s) => s.name);
  if (twice.length) return { ok: false, message: `Two of the dropped items would have the same name: ${listOf(twice)}.` };

  // A staged row's own name may be shortened, so its disk path is built from its ancestors' STAGED names.
  const nameOf = new Map(staged.map((s) => [s.path, s.name]));
  const relative = (path: string): string => {
    const slash = path.lastIndexOf('/');
    const leaf = nameOf.get(path) ?? path.slice(slash + 1);
    return slash === -1 ? leaf : `${relative(path.slice(0, slash))}/${leaf}`;
  };
  const diskPath = (path: string) => joinDestination(disk.parentPath, relative(path));

  const deep = dropped.filter((d) => pathTooDeep(diskPath(d.path))).map((d) => d.path);
  if (deep.length) return { ok: false, message: `Too deeply nested for the disk: ${listOf(deep)}.` };

  const need = blocksForPlan(dropped.map((d) => ({ kind: d.kind, sizeBytes: d.sizeBytes })), disk.filesystem);
  const free = disk.freeBytes === null ? 0 : Math.floor(disk.freeBytes / 512);
  if (need > free) return { ok: false, message: refusalWords('disk_full', `needs ${Math.ceil(need / 2)} KB, ${Math.floor(free / 2)} KB free`) };

  const manifest: DropManifestEntry[] = [];
  const parts: [string, File][] = [];
  for (const d of dropped) {
    const path = diskPath(d.path);
    if (d.kind === 'dir') { manifest.push({ op: 'mkdir', path }); continue; }
    manifest.push({ op: 'add', path, ...(typeof d.protection === 'number' ? { protection: d.protection } : {}) });
    if (d.file) parts.push([path, d.file]);
  }
  const renamed = staged.filter((s) => s.shortened).map((s): [string, string] => [s.path.slice(s.path.lastIndexOf('/') + 1), s.name]);
  return { ok: true, manifest, parts, renamed };
}
