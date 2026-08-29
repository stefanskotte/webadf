// Deterministic synthetic disks. Used to generate committed golden fixtures
// without putting any real disk image, or anything derived from one, in the
// repository (parent spec §14).
export type SyntheticKind = 'zeros' | 'ones' | 'prng' | 'bootblock';

const ADF_BYTES = 901120;

// xorshift32. Chosen because it is four lines and reproduces identically in
// any language, which matters if this ever moves to C.
function fill(out: Uint8Array, from: number, seed: number): void {
  let x = seed >>> 0;
  for (let i = from; i < out.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    out[i] = x & 0xff;
  }
}

export function syntheticAdf(kind: SyntheticKind): Uint8Array {
  const out = new Uint8Array(ADF_BYTES);
  switch (kind) {
    case 'zeros':
      return out;
    case 'ones':
      out.fill(0xff);
      return out;
    case 'prng':
      fill(out, 0, 0x12345678);
      return out;
    case 'bootblock':
      out.set([0x44, 0x4f, 0x53, 0x00], 0); // 'DOS\0'
      out.set([0x00, 0x00, 0x03, 0x70], 8); // root block 880, big-endian
      fill(out, 12, 0xdeadbeef);
      return out;
  }
}
