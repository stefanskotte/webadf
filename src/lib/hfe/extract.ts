// AmigaDOS sectors out of an HFE bitstream.
//
// decodeTrack (src/lib/adfmfm/track.ts) cannot be reused: it needs exactly
// 12,668 bytes with sync on a byte boundary -- our own encoder's layout. A
// capture puts sync wherever the drive's index happened to fall, at any bit
// offset, and a sector can straddle the end of the revolution. So this scans
// bit by bit, reads each candidate sector with wrap-around, and keeps only
// what both checksums vouch for.

import { joinOddEven, checksum } from '@/lib/adfmfm/mfm';
import { ADF_BYTES, SECTORS, SECTOR_DATA_BYTES, TRACK_DATA_BYTES, TRACKS } from '@/lib/adfmfm/constants';
import type { HfeDisk, HfeSide } from './parse';

/** Two 0x4489 sync words. */
const SYNC = 0x44894489;
/** What follows the sync: info 8, label 32, header sum 8, data sum 8, data 1024. */
const SECTOR_BODY_BYTES = 1080;

const u32be = (v: Uint8Array) => ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0;
const bitAt = (s: HfeSide, p: number) => (s.bytes[p >>> 3] >>> (7 - (p & 7))) & 1;

/** `n` bytes from an arbitrary bit offset, wrapping at the end of the revolution. */
function readBits(side: HfeSide, bitOffset: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let p = bitOffset % side.bits;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      v = (v << 1) | bitAt(side, p);
      if (++p === side.bits) p = 0;
    }
    out[i] = v;
  }
  return out;
}

export function decodeSectors(side: HfeSide, trackNo: number): Map<number, Uint8Array> {
  const found = new Map<number, Uint8Array>();
  let reg = 0;
  // One revolution plus 31 bits, so a sync split by the index is still seen.
  for (let i = 0; i < side.bits + 31; i++) {
    reg = ((reg << 1) | bitAt(side, i % side.bits)) >>> 0;
    if (reg !== SYNC) continue;

    const body = readBits(side, i + 1, SECTOR_BODY_BYTES);
    const info = joinOddEven(body.subarray(0, 8));
    const label = joinOddEven(body.subarray(8, 40));
    const hdrSum = u32be(joinOddEven(body.subarray(40, 48)));
    const datSum = u32be(joinOddEven(body.subarray(48, 56)));
    const data = joinOddEven(body.subarray(56, SECTOR_BODY_BYTES));

    const headerAndLabel = new Uint8Array(info.length + label.length);
    headerAndLabel.set(info, 0);
    headerAndLabel.set(label, info.length);
    // A false sync, a damaged sector, or one from another track: skip it,
    // never fail the whole track over it. Only the final count decides.
    if (checksum(headerAndLabel) !== hdrSum || checksum(data) !== datSum) continue;
    if (info[0] !== 0xff || info[1] !== trackNo || info[2] >= SECTORS) continue;
    if (!found.has(info[2])) found.set(info[2], data);
  }
  return found;
}

/** Spec D3: every Amiga disk has a standard track 0 -- Kickstart reads the bootblock through trackdisk. */
export function hasAmigaBootTrack(disk: HfeDisk): boolean {
  const s = decodeSectors(disk.tracks[0][0], 0);
  return s.has(0) && s.has(1);
}

export type Extraction = { ok: true; adf: Uint8Array } | { ok: false; reason: string };

export function extractAdf(disk: HfeDisk): Extraction {
  const adf = new Uint8Array(ADF_BYTES);
  for (let t = 0; t < TRACKS; t++) {
    const cyl = t >> 1;
    const side = t & 1;
    const sectors = decodeSectors(disk.tracks[cyl][side], t);
    if (sectors.size !== SECTORS) {
      return { ok: false, reason: `Track ${t} (cylinder ${cyl}, side ${side}): ${sectors.size} of 11 sectors readable` };
    }
    for (const [id, data] of sectors) adf.set(data, t * TRACK_DATA_BYTES + id * SECTOR_DATA_BYTES);
  }
  return { ok: true, adf };
}
