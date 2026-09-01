// The root block: where "does this disk have a filesystem?" is answered.

import { ROOT_BLOCK, CHECKSUM_WORD, T_HEADER, ST_ROOT } from './constants';
import { blockAt, be32, i32, checksumOk, bcplString, amigaDate } from './blocks';
import type { BootInfo, Filesystem } from './boot';

export interface VolumeInfo {
  filesystem: Filesystem;
  intl: boolean;
  dirc: boolean;
  name: string;
  createdAt: Date | null;
  modifiedAt: Date | null;
}

/**
 * Null when block 880 is not a valid root block.
 *
 * THE CHECKSUM IS NOT OPTIONAL (design decision D-3-1). Type and secondary
 * type alone are two 32-bit comparisons that ordinary game data passes by
 * chance: all four Project-X disks in the operator's archive have T_HEADER at
 * offset 0 and ST_ROOT at 508 on a disk with no filesystem at all, because
 * block 880 is the middle of the game's data. They store 0x31313131 -- ASCII
 * "1111" -- where the checksum belongs. The checksum is the only thing that
 * distinguishes a filesystem from a coincidence.
 */
export function readRoot(adf: Uint8Array, boot: BootInfo): VolumeInfo | null {
  const root = blockAt(adf, ROOT_BLOCK);
  if (!root) return null;
  if (be32(root, 0) !== T_HEADER) return null;
  if (i32(root, 508) !== ST_ROOT) return null;
  if (!checksumOk(root, CHECKSUM_WORD)) return null;

  return {
    filesystem: boot.filesystem,
    intl: boot.intl,
    dirc: boot.dirc,
    name: bcplString(root, 432, 30),
    // Offsets per the format reference: volume modification at 420, creation
    // at 484. Both are three-word dates.
    modifiedAt: amigaDate(root, 420),
    createdAt: amigaDate(root, 484),
  };
}
