/**
 * The -lh5-/-lh6-/-lh7- decompressor: LZSS over a sliding window, with the
 * literal/length and position alphabets themselves Huffman-coded per block.
 * And, at the end of this file, -lh1- (LHarc 1.x), which shares only the bit
 * reader and the canonical Huffman decoder.
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

/**
 * The longest code length LHA can express: its decoder builds 16-bit tables,
 * and its encoder limits every alphabet to 16. Anything longer is not an LHA
 * stream -- and is dangerous: the unary "7 means keep counting" field would
 * otherwise let 12.5 KB of 1-bits declare a length of 100,000, which Huffman
 * allocates as counts[] and decode() walks for EVERY symbol, without consuming
 * input once the stream has ended (review N1, 2026-10-13: ~150 s for one
 * 4 MiB member).
 */
export const MAX_CODE_LEN = 16;

/** Thrown for a stream that is not decodable LHA (a code length over 16). */
export class LzhCorruptError extends Error {}

export class BitReader {
  private pos = 0;
  private bit = 0;
  /** Set once any bit has been read past the end of the input. */
  overrun = false;
  constructor(private readonly src: Uint8Array) {}

  /** Past the end reads as zero bits: a truncated archive should decode to
   *  garbage and be caught by the size/CRC check, not throw out of a loop. */
  private one(): number {
    if (this.pos >= this.src.length) { this.overrun = true; return 0; }
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
    // Defence in depth: readPtLen refuses these as it reads them, but no
    // length from any source may size counts[] past MAX_CODE_LEN.
    for (const l of lengths) {
      if (l > MAX_CODE_LEN) throw new LzhCorruptError(`code length ${l} exceeds ${MAX_CODE_LEN}`);
    }

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
    // Bounded: past MAX_CODE_LEN the stream is refused, so neither this loop
    // nor the table it feeds can be made arbitrarily long.
    if (c === 7) {
      while (br.bit1()) {
        if (++c > MAX_CODE_LEN) throw new LzhCorruptError(`code length exceeds ${MAX_CODE_LEN}`);
      }
    }
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
 * Output bytes each block must pay for, on average, before the decoder gives up.
 *
 * THE WORK IS PER BLOCK, NOT PER BYTE. Every block rebuilds three Huffman
 * tables (up to 19 + 510 + 17 code lengths) before emitting anything, and a
 * block may be as short as one symbol. A stream of one-literal blocks costs
 * ~44 bits each, so 20 MB of input buys ~3.8M blocks and ~2 billion table
 * entries for 3.8 MB of output: 20 s of CPU in a server function, from a URL.
 * The output-size cap the caller applies does not see this at all.
 *
 * So the number of blocks is budgeted against the output: at most
 * ceil(outSize / 256) + 16. Real encoders never come near it -- a block's own
 * tables cost tens of bytes, so an encoder that made blocks this short would
 * be inflating its output; LHA flushes a block when its 16-bit symbol counter
 * or its buffer fills, i.e. after thousands of symbols. Measured 2026-10-13
 * over 1,328 real archives (Aminet, WHDLoad packs; 28,482 -lh5-/6-/7- members,
 * 1.33 GB): no member came near the budget, and the fewest output bytes per
 * block in any multi-block member was 7,340 -- 28x above 256. The +16 covers
 * the short final block of each member and tiny files. With the budget the worst case
 * above stops after ~15K blocks, a few milliseconds.
 */
export const LZH_BYTES_PER_BLOCK = 256;

/** Thrown when a stream spends more blocks than LZH_BYTES_PER_BLOCK allows. */
export class LzhWorkBudgetError extends Error {
  constructor() { super('too many blocks for the declared size'); }
}

/**
 * Decode `outSize` bytes of an -lh5-/-lh6-/-lh7- stream.
 *
 * `dicBits` is 13, 15 or 16 -- the sliding-window size, and the only thing
 * that differs between the three methods.
 *
 * Throws LzhWorkBudgetError for a stream that uses far more blocks than its
 * size justifies (see LZH_BYTES_PER_BLOCK), and LzhCorruptError for a code
 * length over MAX_CODE_LEN; otherwise never throws.
 */
export function decodeLzh(src: Uint8Array, outSize: number, dicBits: number): Uint8Array {
  const maxBlocks = Math.ceil(outSize / LZH_BYTES_PER_BLOCK) + 16;
  let blocks = 0;
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
      if (++blocks > maxBlocks) throw new LzhWorkBudgetError();
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

/* ------------------------------------------------------------------------ *
 * -lh1- (LHarc 1.x)
 *
 * PORTED FROM LHa for UNIX 1.14i-ac (github.com/jca02266/lha), not written
 * from memory: decode_start_fix / ready_made / decode_p_st0 (shuf.c),
 * start_c_dyn / reconst / swap_inc / update_c / decode_c_dyn (dhuf.c) and
 * decode() (slide.c). The fixtures were made and extracted by that tool.
 *
 * - LZSS over a 4 KB window, matches of THRESHOLD..60 bytes.
 * - Literals and lengths share one 314-symbol ADAPTIVE Huffman tree (the
 *   Vitter/FGK-style sibling-list tree of LZHUF.C): it starts with every
 *   symbol at frequency 1 and is updated after every symbol, so encoder and
 *   decoder stay in step without any table in the stream. When the root's
 *   frequency reaches 0x8000 every frequency is halved and the tree rebuilt.
 * - A position is (code << 6) | 6 raw bits, where `code` is 0..63 under a
 *   FIXED Huffman table (LHarc's "old compatible" lengths 3..8). That table is
 *   canonical -- lengths never decrease with the symbol -- so the canonical
 *   Huffman class above decodes it exactly as ready_made() assigns it.
 * - The window starts FULL OF SPACES (slide.c: memset(dtext, ' ', dicsiz)).
 *   LHarc's own encoder (from Okumura's LZHUF.C) inserts that prefill into its
 *   dictionary and can match against it, so a reference before the first
 *   byte is legitimate here and yields 0x20 -- not "corrupt".
 * ------------------------------------------------------------------------ */

const LH1_THRESHOLD = 3;
const LH1_MAXMATCH = 60;
const LH1_DICSIZ = 1 << 12;
/** 256 literals + lengths 3..60 (lha_macro.h: 256 + 60 - THRESHOLD + 1). */
const LH1_N_CHAR = 256 + LH1_MAXMATCH - LH1_THRESHOLD + 1;
const LH1_TREESIZE_C = LH1_N_CHAR * 2;
const LH1_ROOT_C = 0;

/** shuf.c fixed[0], "old compatible": start length, then the symbol at which
 *  each next-longer length begins. */
const LH1_FIXED = [3, 0x01, 0x04, 0x0c, 0x18, 0x30, 0];

function lh1PositionTable(): Huffman {
  // ready_made(0) with np = 1 << (12 - 6) = 64: the lengths it assigns.
  const np = LH1_DICSIZ >> 6;
  const lengths: number[] = [];
  let j = LH1_FIXED[0];
  let t = 1;
  for (let i = 0; i < np; i++) {
    while (LH1_FIXED[t] === i) { j++; t++; }
    lengths.push(j);
  }
  return new Huffman(lengths);
}

/** The adaptive literal/length tree of dhuf.c, for n_max = 314. */
class Lh1Tree {
  private readonly nMax = LH1_N_CHAR;
  // dhuf.c's arrays are sized TREESIZE; only the C half is used for -lh1-.
  private readonly child = new Int32Array(LH1_TREESIZE_C + 1);
  private readonly parent = new Int32Array(LH1_TREESIZE_C + 1);
  private readonly block = new Int32Array(LH1_TREESIZE_C + 1);
  private readonly edge = new Int32Array(LH1_TREESIZE_C + 1);
  private readonly stock = new Int32Array(LH1_TREESIZE_C + 1);
  private readonly sNode = new Int32Array(LH1_N_CHAR + 1);
  private readonly freq = new Uint16Array(LH1_TREESIZE_C + 1);
  private avail = 0;

  constructor() {
    // start_c_dyn()
    const { child, parent, block, edge, stock, sNode, freq, nMax } = this;
    let i: number, j: number;
    for (i = 0; i < LH1_TREESIZE_C; i++) { stock[i] = i; block[i] = 0; }
    for (i = 0, j = nMax * 2 - 2; i < nMax; i++, j--) {
      freq[j] = 1;
      child[j] = ~i;
      sNode[i] = j;
      block[j] = 1;
    }
    this.avail = 2;
    edge[1] = nMax - 1;
    i = nMax * 2 - 2;
    while (j >= 0) {
      const f = freq[j] = freq[i] + freq[i - 1];
      child[j] = i;
      parent[i] = parent[i - 1] = j;
      if (f === freq[j + 1]) {
        edge[block[j] = block[j + 1]] = j;
      } else {
        edge[block[j] = stock[this.avail++]] = j;
      }
      i -= 2;
      j--;
    }
  }

  /** dhuf.c reconst(start, end): halve every leaf frequency and rebuild. */
  private reconst(start: number, end: number): void {
    const { child, parent, block, edge, stock, sNode, freq } = this;
    let i: number, j: number, k: number, l: number, b = 0;
    let f: number, g: number;
    for (i = j = start; i < end; i++) {
      if ((k = child[i]) < 0) {
        freq[j] = (freq[i] + 1) >>> 1;
        child[j] = k;
        j++;
      }
      if (edge[b = block[i]] === i) stock[--this.avail] = b;
    }
    j--;
    i = end - 1;
    l = end - 2;
    while (i >= start) {
      while (i >= l) {
        freq[i] = freq[j];
        child[i] = child[j];
        i--; j--;
      }
      f = freq[l] + freq[l + 1];
      for (k = start; f < freq[k]; k++);
      while (j >= k) {
        freq[i] = freq[j];
        child[i] = child[j];
        i--; j--;
      }
      freq[i] = f;
      child[i] = l + 1;
      i--;
      l -= 2;
    }
    f = 0;
    for (i = start; i < end; i++) {
      if ((j = child[i]) < 0) sNode[~j] = i;
      else parent[j] = parent[j - 1] = i;
      if ((g = freq[i]) === f) {
        block[i] = b;
      } else {
        edge[b = block[i] = stock[this.avail++]] = i;
        f = g;
      }
    }
  }

  /** dhuf.c swap_inc(p) */
  private swapInc(p: number): number {
    const { child, parent, block, edge, stock, sNode, freq } = this;
    const b = block[p];
    const q = edge[b];
    let adjust = false;
    if (q !== p) {
      // swap for leader
      const r = child[p];
      const s = child[q];
      child[p] = s;
      child[q] = r;
      if (r >= 0) parent[r] = parent[r - 1] = q;
      else sNode[~r] = q;
      if (s >= 0) parent[s] = parent[s - 1] = p;
      else sNode[~s] = p;
      p = q;
      adjust = true;
    } else if (b === block[p + 1]) {
      adjust = true;
    }
    if (adjust) {
      edge[b]++;
      if (++freq[p] === freq[p - 1]) {
        block[p] = block[p - 1];
      } else {
        edge[block[p] = stock[this.avail++]] = p; // create block
      }
    } else if (++freq[p] === freq[p - 1]) {
      stock[--this.avail] = b; // delete block
      block[p] = block[p - 1];
    }
    return parent[p];
  }

  /** dhuf.c update_c(p) */
  private update(p: number): void {
    if (this.freq[LH1_ROOT_C] === 0x8000) this.reconst(0, this.nMax * 2 - 1);
    this.freq[LH1_ROOT_C]++;
    let q = this.sNode[p];
    // Bounded: each step moves to a parent, and no tree path is longer than
    // the node count. The guard is defence in depth against a bug, not input.
    let steps = 0;
    do {
      q = this.swapInc(q);
      if (++steps > LH1_TREESIZE_C) throw new LzhCorruptError('adaptive tree is not a tree');
    } while (q !== LH1_ROOT_C);
  }

  /** dhuf.c decode_c_dyn(), for n1 = 512 (never reached: no 8-bit tail). */
  decode(br: BitReader): number {
    const { child } = this;
    let c = child[LH1_ROOT_C];
    let steps = 0;
    do {
      // decode_c_dyn: c = child[c - (buf < 0)], i.e. a 1 bit takes c - 1.
      c = child[c - br.bit1()];
      if (++steps > LH1_TREESIZE_C) throw new LzhCorruptError('adaptive tree is not a tree');
    } while (c > 0);
    c = ~c;
    this.update(c);
    return c;
  }
}

/**
 * Decode `outSize` bytes of an -lh1- stream.
 *
 * Never writes past `outSize`. Returns SHORT -- which readLha reports as
 * truncated -- when the stream needs bits beyond the end of `src`: LHA's
 * encoder flushes its last code into the data (encode_end_dyn pads 7 zero
 * bits), so a whole stream never reads past its end, and stopping there is
 * what keeps a 64-byte member claiming 16 MB from decoding 16M symbols of
 * zeros.
 *
 * THE WORK BUDGET IS STRUCTURAL: every symbol consumes at least one input bit
 * and emits at least one output byte, so the loop runs at most
 * min(outSize, 8 * src.length) times; each symbol walks and updates a tree of
 * fixed size (both guarded), and the halving rebuild runs once per 0x8000
 * symbols. No block structure exists to be abused the way -lh5-'s is.
 *
 * Throws only LzhCorruptError, and only if the tree invariant were broken.
 */
export function decodeLh1(src: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  if (outSize === 0) return out;
  const br = new BitReader(src);
  const tree = new Lh1Tree();
  const pos = lh1PositionTable();
  // slide.c: adjust = 256 - THRESHOLD, so length = c - 253.
  const adjust = 256 - LH1_THRESHOLD;
  let written = 0;

  while (written < outSize) {
    const c = tree.decode(br);
    if (c < 256) {
      if (br.overrun) break;
      out[written++] = c;
      continue;
    }
    const len = c - adjust;
    const off = ((pos.decode(br) << 6) | br.bits(6)) + 1;
    if (br.overrun) break;
    // off is 1..LH1_DICSIZ (the window), so `written - off` is exactly the
    // ring position LHA reads; below zero it is the space-filled prefill.
    let from = written - off;
    for (let k = 0; k < len && written < outSize; k++, from++) {
      out[written++] = from < 0 ? 0x20 : out[from];
    }
  }

  return written === outSize ? out : out.subarray(0, written);
}
