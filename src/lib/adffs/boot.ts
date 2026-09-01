// The boot block: the DOS signature and the filesystem flag nibble.
//
// Reference: http://lclevy.free.fr/adflib/adf_info.html

import { blockAt } from './blocks';

export type Filesystem = 'OFS' | 'FFS';

export interface BootInfo {
  filesystem: Filesystem;
  /** International mode: changes the directory hash function. */
  intl: boolean;
  /** Directory cache. A cache OVER the hash chains, never a replacement. */
  dirc: boolean;
}

const FLAG_FFS = 0x01;
const FLAG_INTL = 0x02;
const FLAG_DIRC = 0x04;

/**
 * Null when there is no DOS signature at all -- one archive disk in 61.
 *
 * THE BOOT BLOCK'S OWN CHECKSUM IS DELIBERATELY NOT VERIFIED (design decision
 * D-3-2). It looks like the obvious validity test and is the opposite of one:
 * measured against the operator's archive, only 19 of the 49 disks with a
 * sound filesystem have a valid boot checksum. Non-bootable data disks and
 * disks with custom boot code routinely fail it while reading perfectly.
 * Enforcing it here would discard 61% of what this module exists to read.
 */
export function readBoot(adf: Uint8Array): BootInfo | null {
  const boot = blockAt(adf, 0);
  if (!boot) return null;
  if (boot[0] !== 0x44 || boot[1] !== 0x4f || boot[2] !== 0x53) return null; // 'DOS'
  const flags = boot[3];
  return {
    filesystem: (flags & FLAG_FFS) ? 'FFS' : 'OFS',
    intl: (flags & FLAG_INTL) !== 0,
    dirc: (flags & FLAG_DIRC) !== 0,
  };
}
