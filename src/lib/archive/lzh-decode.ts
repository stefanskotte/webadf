/**
 * The -lh5-/-lh6-/-lh7- decompressor: LZSS over a sliding window, with the
 * literal/length and position alphabets themselves Huffman-coded per block.
 *
 * This exists because Aminet is an LHA archive and nothing in the browser can
 * read one. Zip needs no code at all -- DecompressionStream('deflate-raw') is
 * native -- but LZH is ours to implement.
 *
 * WRITTEN AGAINST A REFERENCE, NOT FROM MEMORY. Every fixture in the tests was
 * produced by /opt/homebrew/bin/lha and the decoded bytes are compared to what
 * that tool extracts, which is the same standard this project applies to ADFs
 * with xdftool and to MFM with greaseweazle: a format is not "read correctly"
 * because our own writer agrees with our own reader.
 *
 * Huffman decoding here is CANONICAL AND BIT-AT-A-TIME, not LHA's own
 * table-driven make_table(). That is a deliberate trade: the table version is
 * faster and is where a from-memory implementation goes subtly wrong, and this
 * runs once on a <=25 MB archive in a browser, where correctness is worth far
 * more than the microseconds.
 */

const THRESHOLD = 3;
const MAXMATCH = 256;
/** 255 literals + match lengths THRESHOLD..MAXMATCH. */
const NC = 255 + MAXMATCH + 2 - THRESHOLD;
const CBIT = 9;
/** The tiny alphabet that encodes the literal/length code LENGTHS. */
const NT = 19;
const TBIT = 5;

export class BitReader {
  private pos = 0;
  private bit = 0;
  constructor(private readonly src: Uint8Array) {}

  /** Past the end reads as zero bits: a truncated archive should decode to
   *  garbage and be caught by the size/CRC check, not throw out of a loop. */
  private one(): number {
    if (this.pos >= this.src.length) return 0;
    const b = (this.src[this.pos] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) { this.bit = 0; this.pos++; }
    return b;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.one();
    return v >>> 0;
  }

  bit1(): number { return this.one(); }
}

/**
 * Canonical Huffman decoder built from code lengths, the same construction
 * deflate uses: symbols of equal length take consecutive codes, ordered by
 * symbol.
 */
class Huffman {
  private readonly counts: number[] = [];
  private readonly symbols: number[] = [];
  /** Set when the alphabet collapsed to ONE symbol, which LHA encodes as a
   *  table of length zero and which has no bits to read at all. */
  readonly single: number | null;

  constructor(lengths: number[], single: number | null = null) {
    this.single = single;
    if (single !== null) return;

    let max = 0;
    for (const l of lengths) if (l > max) max = l;
    for (let i = 0; i <= max; i++) this.counts[i] = 0;
    for (const l of lengths) if (l > 0) this.counts[l]++;

    const offsets: number[] = [0, 0];
    for (let l = 1; l < max; l++) offsets[l + 1] = offsets[l] + this.counts[l];
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s] > 0) this.symbols[offsets[lengths[s]]++] = s;
    }
  }

  decode(br: BitReader): number {
    if (this.single !== null) return this.single;
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < this.counts.length; len++) {
      code |= br.bit1();
      const count = this.counts[len];
      if (code - first < count) return this.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    // Ran out of lengths without matching: corrupt stream. Returning a literal
    // zero keeps the caller's loop bounded by outSize rather than hanging.
    return 0;
  }
}

/** The position/pre-tree length table, shared by the T and P alphabets. */
function readPtLen(br: BitReader, nn: number, nbit: number, iSpecial: number): Huffman {
  const n = br.bits(nbit);
  if (n === 0) return new Huffman([], br.bits(nbit));

  const lengths = new Array<number>(nn).fill(0);
  let i = 0;
  while (i < n && i < nn) {
    let c = br.bits(3);
    // 3 bits hold 0..6; 7 means "keep counting in unary", which is how a long
    // code length is expressed without widening the field.
    if (c === 7) while (br.bit1()) c++;
    lengths[i++] = c;
    // Only the T alphabet has this: after the third length, two bits say how
    // many zero lengths follow. It exists because positions 3..5 are almost
    // always unused and would otherwise cost three bits each.
    if (i === iSpecial) {
      let z = br.bits(2);
      while (z-- > 0 && i < nn) lengths[i++] = 0;
    }
  }
  return new Huffman(lengths);
}

/** The literal/length code lengths, themselves coded with the T alphabet. */
function readCLen(br: BitReader, t: Huffman): Huffman {
  const n = br.bits(CBIT);
  if (n === 0) return new Huffman([], br.bits(CBIT));

  const lengths = new Array<number>(NC).fill(0);
  let i = 0;
  while (i < n && i < NC) {
    const c = t.decode(br);
    if (c <= 2) {
      // Runs of "no code", at three scales, because most of a 510-symbol
      // alphabet is unused in any given block.
      const run = c === 0 ? 1 : c === 1 ? br.bits(4) + 3 : br.bits(CBIT) + 20;
      for (let k = 0; k < run && i < NC; k++) lengths[i++] = 0;
    } else {
      lengths[i++] = c - 2;
    }
  }
  return new Huffman(lengths);
}

/**
 * Decode `outSize` bytes of an -lh5-/-lh6-/-lh7- stream.
 *
 * `dicBits` is 13, 15 or 16 -- the sliding-window size, and the only thing
 * that differs between the three methods.
 */
export function decodeLzh(src: Uint8Array, outSize: number, dicBits: number): Uint8Array {
  const out = new Uint8Array(outSize);
  const br = new BitReader(src);
  const np = dicBits + 1;
  const pbit = dicBits <= 13 ? 4 : 5;

  let blockSize = 0;
  let c!: Huffman, p!: Huffman;
  let written = 0;

  while (written < outSize) {
    if (blockSize === 0) {
      blockSize = br.bits(16);
      // A zero-length block in a stream that still owes bytes means the data
      // ran out. Stop rather than spin: the caller checks the length it got.
      if (blockSize === 0) break;
      const t = readPtLen(br, NT, TBIT, 3);
      c = readCLen(br, t);
      p = readPtLen(br, np, pbit, -1);
    }
    blockSize--;

    const sym = c.decode(br);
    if (sym < 256) {
      out[written++] = sym;
      continue;
    }

    const len = sym - 256 + THRESHOLD;
    const pc = p.decode(br);
    // A position code of 0 means distance 0; anything else is an implicit
    // leading 1 followed by pc-1 explicit bits.
    const dist = pc === 0 ? 0 : ((1 << (pc - 1)) | br.bits(pc - 1));
    let from = written - dist - 1;
    if (from < 0) break; // corrupt: would read before the window
    for (let k = 0; k < len && written < outSize; k++) {
      out[written++] = out[from++];
    }
  }

  return written === outSize ? out : out.subarray(0, written);
}
