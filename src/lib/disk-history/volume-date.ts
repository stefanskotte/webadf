// A restored disk must not look like a volume the Amiga already knows.
//
// AmigaDOS identifies a volume by its name AND its creation date. When a disk
// is inserted, the ROM filesystem walks the DOS list and, for each volume node,
// compares dl_VolumeDate with the root block's creation date as three longs
// (days, minutes, ticks), all of which must be equal, and only then compares the name.
// Read from the operator's own ROMs: fs 40.1 (Kickstart 3.1, $FAAE46),
// fs 46.13 (3.1.4, $FAA2FC) and fs 47.4 (3.2, $FAA1F0) -- HANDOFF 3ar.
//
// So a restore that puts back the same name and date is taken for the volume
// the Amiga remembers, which then writes its stale root and bitmap over the restored
// image (the Locale block-591 corruption, 2026-09-29). Moving the creation
// date by a single tick makes it a different volume. The date shown on the disk
// page is day-only, so one tick does not show.

import { be32, blockAt, checksumOk } from '@/lib/adffs/blocks';
import { CHECKSUM_WORD, ST_ROOT, T_HEADER } from '@/lib/adffs/constants';
import { geometryOf } from '@/lib/adffs/geometry';
import { putBe32, recheck } from '@/lib/adffs/write-blocks';

/** Root-block offset of the volume creation date (days, minutes, ticks). */
const CREATED = 484;
const TICKS_PER_MINUTE = 3000;
const MINUTES_PER_DAY = 1440;

type Stamp = [days: number, mins: number, ticks: number];

/** True when `adf` holds a readable AmigaDOS volume, i.e. one the Amiga can remember. */
export function hasVolume(adf: Uint8Array): boolean {
  return rootOf(adf) !== null;
}

/** The root block number of a readable AmigaDOS volume, or null. */
function rootOf(adf: Uint8Array): number | null {
  const g = geometryOf(adf);
  if (!g) return null;
  // 'DOS' + a flags byte. DOS\0..DOS\5 are what Kickstart 3.1 checks for; 3.2
  // also mounts the long-filename DOS\6 and DOS\7, whose root keeps the same
  // creation date at 484. Re-dating a type an older ROM won't mount is harmless.
  if (adf[0] !== 0x44 || adf[1] !== 0x4f || adf[2] !== 0x53 || adf[3] > 7) return null;
  const root = blockAt(adf, g.rootBlock);
  if (!root) return null;
  if (be32(root, 0) !== T_HEADER || be32(root, 508) !== ST_ROOT) return null;
  if (!checksumOk(root, CHECKSUM_WORD)) return null;
  return g.rootBlock;
}

function stampOf(adf: Uint8Array, rootBlock: number): Stamp {
  const root = blockAt(adf, rootBlock)!;
  return [be32(root, CREATED), be32(root, CREATED + 4), be32(root, CREATED + 8)];
}

function later(a: Stamp, b: Stamp): Stamp {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? a : b;
  return a;
}

/** One tick on, carrying into minutes and days. Out-of-range fields still move forward. */
function nextTick([d, m, t]: Stamp): Stamp {
  if (t + 1 < TICKS_PER_MINUTE) return [d, m, t + 1];
  if (m + 1 < MINUTES_PER_DAY) return [d, m + 1, 0];
  return [(d + 1) >>> 0, 0, 0];
}

/**
 * `target` with its volume creation date moved one tick past the latest of its
 * own and every image in `seen`, and the root checksum fixed; `target` itself
 * is untouched.
 *
 * `seen` is every image the Amiga may still remember under this name: the
 * current head, and the disk's latest earlier restore that has a volume. Each
 * re-dating restore issues a date later than the one before it, so that one
 * holds the highest date ever issued for the disk. Going past all of them means restoring the same
 * version twice, or restoring after the head lost its root, never hands the
 * Amiga a date it has already seen. Images without a readable root are ignored.
 *
 * Null when `target` has no readable AmigaDOS root (NDOS, a trackloader disk,
 * a damaged root): such a disk has no volume for the Amiga to remember, and its
 * bytes are restored exactly.
 */
export function bumpVolumeDate(target: Uint8Array, seen: readonly Uint8Array[]): Uint8Array | null {
  const rootBlock = rootOf(target);
  if (rootBlock === null) return null;
  let base = stampOf(target, rootBlock);
  for (const image of seen) {
    const r = rootOf(image);
    if (r !== null) base = later(base, stampOf(image, r));
  }

  const [d, m, t] = nextTick(base);
  const out = target.slice();
  const o = rootBlock * 512 + CREATED;
  putBe32(out, o, d);
  putBe32(out, o + 4, m);
  putBe32(out, o + 8, t);
  recheck(out, rootBlock);
  return out;
}

/**
 * True when `a` and `b` differ at most in the volume creation date and the
 * root checksum. A head that is a re-dated copy of the version being restored
 * already holds that version, so restoring it again changes nothing.
 */
export function sameExceptVolumeDate(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const rootBlock = rootOf(a);
  if (rootBlock === null || rootOf(b) !== rootBlock) return false;
  const date = rootBlock * 512 + CREATED;
  const sum = rootBlock * 512 + CHECKSUM_WORD * 4;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if ((i >= date && i < date + 12) || (i >= sum && i < sum + 4)) continue;
    return false;
  }
  return true;
}
