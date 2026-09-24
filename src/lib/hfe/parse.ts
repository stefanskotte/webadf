// HFE v1 (HxC Floppy Emulator) reader. Layout and sources:
// docs/superpowers/research/2026-09-24-hfe-and-hd-floppies.md, Part A.
//
// Written not to throw (the readDms convention, src/lib/archive/dms.ts): this
// runs in the browser drop path as well as the ingest route, and an exception
// escaping a drop target is a dead UI.

import { HFE_V3_REFUSAL } from './messages';

const BLOCK = 512;
const HALF = 256;
const V1_SIGNATURE = 'HXCPICFE';
const V3_SIGNATURE = 'HXCHFEV3';
/** ISOIBM_MFM, AMIGA_MFM, and 0xFF "unspecified" -- which Greaseweazle writes. */
const MFM_ENCODINGS = new Set([0x00, 0x01, 0xff]);
const MIN_BITRATE = 238;
const MAX_BITRATE = 262;
const MIN_CYLINDERS = 80;
const MAX_CYLINDERS = 84;

/** One side of one cylinder, as an MSB-first bitstream (this repo's MFM packing). */
export interface HfeSide { bits: number; bytes: Uint8Array }

export interface HfeDisk {
  cylinders: number;
  bitRate: number;
  encoding: number;
  /** tracks[cylinder][side] */
  tracks: [HfeSide, HfeSide][];
}

export type HfeParse = { ok: true; disk: HfeDisk } | { ok: false; reason: string };

// HFE packs bits LSB-first; everything else in this repo is MSB-first.
const REVERSE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let r = 0;
    for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 0x80 >> b;
    t[i] = r;
  }
  return t;
})();

export function reverseBits(b: number): number {
  return REVERSE[b & 0xff];
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const fail = (reason: string): HfeParse => ({ ok: false, reason });

export function parseHfe(bytes: Uint8Array): HfeParse {
  if (bytes.length < BLOCK) return fail('Not an HFE file: shorter than its 512-byte header.');
  const signature = String.fromCharCode(...bytes.subarray(0, 8));
  // v3 keeps formatrevision 0 (measured), so the signature is the only tell.
  if (signature === V3_SIGNATURE) return fail(HFE_V3_REFUSAL);
  if (signature !== V1_SIGNATURE) return fail('Not an HFE file: the header has no HXCPICFE signature.');
  // Revision 1 is "HFE v2": the same opcode stream v3 uses.
  if (bytes[8] !== 0) return fail(HFE_V3_REFUSAL);

  const cylinders = bytes[9];
  const sides = bytes[10];
  const encoding = bytes[11];
  const bitRate = u16(bytes, 12);
  const lutBlock = u16(bytes, 18);

  if (!MFM_ENCODINGS.has(encoding)) return fail(`Not an Amiga disk: track encoding ${encoding} is not MFM.`);
  if (bitRate < MIN_BITRATE || bitRate > MAX_BITRATE) {
    return fail(`Not a double-density disk: bit rate ${bitRate} kbit/s (expected 250).`);
  }
  if (sides !== 2) return fail(`Not a double-sided disk: ${sides} side(s).`);
  if (cylinders < MIN_CYLINDERS || cylinders > MAX_CYLINDERS) {
    return fail(`Unsupported geometry: ${cylinders} cylinders (80–84 accepted).`);
  }

  const lut = lutBlock * BLOCK;
  if (lutBlock === 0 || lut + cylinders * 4 > bytes.length) {
    return fail('Truncated HFE file: the track table is missing.');
  }

  const tracks: [HfeSide, HfeSide][] = [];
  for (let c = 0; c < cylinders; c++) {
    const offBlock = u16(bytes, lut + c * 4);
    const sideLen = u16(bytes, lut + c * 4 + 2) >>> 1;
    if (sideLen === 0) return fail(`Cylinder ${c} is empty.`);
    const base = offBlock * BLOCK;
    // The last byte read is side 1's final byte, in the final (possibly partial) block.
    const last = base + ((sideLen - 1) >>> 8) * BLOCK + HALF + ((sideLen - 1) & 0xff);
    if (offBlock === 0 || last >= bytes.length) {
      return fail(`Truncated HFE file: cylinder ${c} runs past the end.`);
    }
    const s0 = new Uint8Array(sideLen);
    const s1 = new Uint8Array(sideLen);
    for (let i = 0; i < sideLen; i++) {
      const at = base + (i >>> 8) * BLOCK + (i & 0xff);
      s0[i] = REVERSE[bytes[at]];
      s1[i] = REVERSE[bytes[at + HALF]];
    }
    tracks.push([{ bits: sideLen * 8, bytes: s0 }, { bits: sideLen * 8, bytes: s1 }]);
  }

  return { ok: true, disk: { cylinders, bitRate, encoding, tracks } };
}
