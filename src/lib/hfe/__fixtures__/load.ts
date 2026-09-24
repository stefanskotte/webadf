import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export type FixtureName = 'clean' | 'v3' | 'pc';

export function fixture(name: FixtureName): Uint8Array {
  const path = fileURLToPath(new URL(`./${name}.hfe.gz`, import.meta.url));
  return new Uint8Array(gunzipSync(readFileSync(path)));
}

/** A copy with one byte changed. */
export function setByte(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const out = bytes.slice();
  out[offset] = value;
  return out;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

/** Where one side of one cylinder lives in the interleaved file. */
export function sideRange(bytes: Uint8Array, cylinder: number, side: 0 | 1) {
  const lut = u16(bytes, 18) * 512 + cylinder * 4;
  const base = u16(bytes, lut) * 512;
  const sideLen = u16(bytes, lut + 2) >>> 1;
  return { base, sideLen, at: (i: number) => base + (i >>> 8) * 512 + side * 256 + (i & 0xff) };
}

/** A copy with bytes [from, to) of one side's track data set to zero (no flux: sectors there are lost). */
export function zeroSide(bytes: Uint8Array, cylinder: number, side: 0 | 1, from: number, to: number): Uint8Array {
  const out = bytes.slice();
  const r = sideRange(out, cylinder, side);
  for (let i = from; i < to; i++) out[r.at(i)] = 0;
  return out;
}

/** A copy with one cylinder's track-table length (both sides, bytes) rewritten. */
export function setTrackLength(bytes: Uint8Array, cylinder: number, len: number): Uint8Array {
  const out = bytes.slice();
  const lut = u16(out, 18) * 512 + cylinder * 4;
  out[lut + 2] = len & 0xff;
  out[lut + 3] = (len >>> 8) & 0xff;
  return out;
}
