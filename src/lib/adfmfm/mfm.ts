// Amiga MFM primitives. See the spec §3 for why each of these is shaped the
// way it is; the reference is Greaseweazle's greaseweazle/codec/amiga/amigados.py.

import { AdfmfmError } from './errors';

export class MfmFormatError extends AdfmfmError {
  constructor(message: string) {
    super(message);
    this.name = 'MfmFormatError';
  }
}

/**
 * Amiga odd/even bit split: all the odd bits of the block, then all the even
 * bits. Each output byte carries four data bits in the 0x55 lanes and leaves
 * the 0xAA lanes empty for clock bits. Doubles the length.
 *
 * Applied PER FIELD, never across a whole sector.
 */
export function splitOddEven(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i] = (src[i] >> 1) & 0x55;
    out[n + i] = src[i] & 0x55;
  }
  return out;
}

/** Inverse of splitOddEven. */
export function joinOddEven(src: Uint8Array): Uint8Array {
  const n = src.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = ((src[i] << 1) & 0xaa) | (src[n + i] & 0x55);
  }
  return out;
}

/**
 * Amiga checksum: XOR of the big-endian u32 words of the RAW, pre-split field,
 * then folded to the 0x55555555 lanes.
 *
 * The Amiga's own definition is the XOR of the MFM longs as stored. That is the
 * same value: the odd half of a raw long v is (v >>> 1) & 0x55555555 and the
 * even half is v & 0x55555555, XOR distributes over the shift, and XOR does not
 * care how the longs are grouped — which is why doing the split per field
 * changes nothing here. Spec §3.
 */
export function checksum(src: Uint8Array): number {
  // Out-of-range reads on a Uint8Array yield undefined, which coerces to 0 in
  // the shifts below -- so a misaligned length would silently checksum phantom
  // zero bytes instead of failing. Every real call site is 4, 20 or 512 bytes.
  if (src.length % 4 !== 0) {
    throw new MfmFormatError(`checksum needs a multiple of 4 bytes, got ${src.length}`);
  }
  let c = 0;
  for (let i = 0; i < src.length; i += 4) {
    c ^= (src[i] << 24) | (src[i + 1] << 16) | (src[i + 2] << 8) | src[i + 3];
  }
  c >>>= 0;
  return ((c ^ (c >>> 1)) & 0x55555555) >>> 0;
}

/**
 * Fill clock bits into the 0xAA lanes, in place, over a whole assembled track.
 *
 * A clock bit goes wherever neither the preceding nor the following data bit is
 * set. The 16-bit window carries that rule correctly across byte boundaries.
 *
 * The 0x4489 sync needs no special case: 0x89 has 0xAA bits set so it is
 * skipped outright, and 0x44 is processed but its neighbours already supply
 * every transition, so the fill is a no-op. Verified against the reference at
 * byte offset 256 of a real track.
 */
export function fillClockBits(track: Uint8Array): void {
  let y = 0;
  for (let i = 0; i < track.length; i++) {
    const x = track[i];
    y = ((y << 8) | x) & 0xffff;
    if ((x & 0xaa) === 0) {
      y |= ~((y >> 1) | (y << 1)) & 0xaaaa;
    }
    y &= 0xff;
    track[i] = y;
  }
}
