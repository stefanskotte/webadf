// The AmigaDOS filesystem module's public surface.
//
// Shaped like src/lib/adfmfm/: pure functions over a Uint8Array, no I/O and
// no database, so the entire format is testable in vitest. Write operations
// (write.ts, re-exported below) never mutate their input -- they return a
// new Uint8Array -- and never throw, returning a WriteResult instead.

import { geometryOf } from './geometry';
import { readBoot } from './boot';
import { readRoot, type VolumeInfo } from './root';
import { walkDirectory, type AdfEntry } from './dir';
import { readFileBytes, type FileBytes } from './file';

export { MAX_ENTRIES } from './constants';
export type { VolumeInfo } from './root';
export type { AdfEntry } from './dir';
export type { FileBytes } from './file';
export type { Filesystem, BootInfo } from './boot';
export { readUsage, type VolumeUsage } from './usage';
export {
  addFile, deleteEntry, renameEntry, replaceFile, makeDirectory, moveEntry, setProtection, setComment,
  applyBatch, type WriteResult, type WriteError, type BatchOp, type EntryMeta,
} from './write';
export { blocksForFile, blocksForPlan, type CostItem } from './capacity';
export { geometryOf, geometryFor, DD_GEOMETRY, HD_GEOMETRY, type Geometry } from './geometry';

export type VolumeResult =
  | {
      ok: true; volume: VolumeInfo; root: AdfEntry[]; truncated: boolean; warnings: string[];
      /** The directory block `root` lists: 880 DD, 1,760 HD. Every caller that
       *  names "the root" by block number takes it from here (HD writes spec §6.1). */
      rootBlock: number;
    }
  | { ok: false; reason: 'not-adf' | 'no-dos-signature' | 'no-filesystem' };

/**
 * A DISCRIMINATED UNION, not a throw, because "this disk has no filesystem"
 * is an ordinary answer for 20% of a real archive (design decision D-3-3).
 * Every game and demo disk answers this way; a game disk is not a failure.
 *
 * The three failure reasons are distinguished because the page renders them
 * differently: an image that is neither 880 KB nor 1.76 MB is a catalog
 * problem, a missing signature and a missing filesystem are both ordinary
 * properties of a disk.
 */
export function readVolume(adf: Uint8Array): VolumeResult {
  const geometry = geometryOf(adf);
  if (!geometry) return { ok: false, reason: 'not-adf' };

  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-dos-signature' };

  const volume = readRoot(adf, boot);
  if (!volume) return { ok: false, reason: 'no-filesystem' };

  const { root, truncated, warnings } = walkDirectory(adf, geometry.rootBlock);
  return { ok: true, volume, root, truncated, warnings, rootBlock: geometry.rootBlock };
}

/** One file's bytes, addressed by its header block (design decision D-3-5). */
export function readFile(adf: Uint8Array, block: number): FileBytes | null {
  const boot = readBoot(adf);
  if (!boot) return null;
  return readFileBytes(adf, block, boot.filesystem);
}
