// The AmigaDOS filesystem reader's public surface.
//
// Shaped like src/lib/adfmfm/: pure functions over a Uint8Array, no I/O and
// no database, so the entire format is testable in vitest. Read-only by
// design -- writing needs bitmap and hash-chain maintenance this module
// deliberately does not do.

import { ADF_BYTES } from '@/lib/adfmfm';
import { ROOT_BLOCK } from './constants';
import { readBoot } from './boot';
import { readRoot, type VolumeInfo } from './root';
import { walkDirectory, type AdfEntry } from './dir';
import { readFileBytes, type FileBytes } from './file';

export { MAX_ENTRIES } from './constants';
export type { VolumeInfo } from './root';
export type { AdfEntry } from './dir';
export type { FileBytes } from './file';
export type { Filesystem, BootInfo } from './boot';

export type VolumeResult =
  | { ok: true; volume: VolumeInfo; root: AdfEntry[]; truncated: boolean; warnings: string[] }
  | { ok: false; reason: 'not-adf' | 'no-dos-signature' | 'no-filesystem' };

/**
 * A DISCRIMINATED UNION, not a throw, because "this disk has no filesystem"
 * is an ordinary answer for 20% of a real archive (design decision D-3-3).
 * Every game and demo disk answers this way; a game disk is not a failure.
 *
 * The three failure reasons are distinguished because the page renders them
 * differently: a non-880K image is a catalog problem, a missing signature and
 * a missing filesystem are both ordinary properties of a disk.
 */
export function readVolume(adf: Uint8Array): VolumeResult {
  if (adf.length !== ADF_BYTES) return { ok: false, reason: 'not-adf' };

  const boot = readBoot(adf);
  if (!boot) return { ok: false, reason: 'no-dos-signature' };

  const volume = readRoot(adf, boot);
  if (!volume) return { ok: false, reason: 'no-filesystem' };

  const { root, truncated, warnings } = walkDirectory(adf, ROOT_BLOCK);
  return { ok: true, volume, root, truncated, warnings };
}

/** One file's bytes, addressed by its header block (design decision D-3-5). */
export function readFile(adf: Uint8Array, block: number): FileBytes | null {
  const boot = readBoot(adf);
  if (!boot) return null;
  return readFileBytes(adf, block, boot.filesystem);
}
