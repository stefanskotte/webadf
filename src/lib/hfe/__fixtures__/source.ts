// The ADF every committed Amiga HFE fixture was made from. Rebuilt here
// rather than committed: the repository holds no disk image (adfmfm spec
// §14), and a test that needs the expected bytes regenerates them.
//
// Every sector is distinct (its own track and sector number in text, plus 16
// seeded bytes), so a decoder that puts a sector in the wrong place cannot
// pass. Tracks 0, 1, 158 and 159 are fully random, which exercises every
// bit pattern through the bit reversal and the odd/even join. Everything
// else is low-entropy on purpose: it keeps the gzipped fixture ~100 KB.
import { ADF_BYTES, SECTORS, SECTOR_DATA_BYTES, TRACK_DATA_BYTES } from '@/lib/adfmfm';

// xorshift32, the same generator src/lib/adfmfm/synthetic.ts uses.
function fill(out: Uint8Array, from: number, to: number, seed: number): void {
  let x = seed >>> 0;
  for (let i = from; i < to; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    out[i] = x & 0xff;
  }
}

export function sparseAdf(): Uint8Array {
  const out = new Uint8Array(ADF_BYTES);
  const enc = new TextEncoder();
  for (let t = 0; t < 160; t++) {
    for (let s = 0; s < SECTORS; s++) {
      const at = t * TRACK_DATA_BYTES + s * SECTOR_DATA_BYTES;
      out.set(enc.encode(`webadf-hfe-fixture t${t} s${s}`), at);
      // Math.imul by an odd constant of a value >= 1: never a zero seed.
      fill(out, at + 480, at + 496, Math.imul(t * SECTORS + s + 1, 0x9e3779b1));
    }
  }
  for (const t of [0, 1, 158, 159]) {
    fill(out, t * TRACK_DATA_BYTES, (t + 1) * TRACK_DATA_BYTES, 0x01234567 + t);
  }
  return out;
}
