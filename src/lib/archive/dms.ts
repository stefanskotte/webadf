/**
 * DiskMasher (.dms) -> ADF.
 *
 * A port of xDMS 1.3 by Andre Rodrigues de la Rocha, which is public domain
 * and is the de-facto specification: there is no published DMS format
 * document, and every field offset, every decoder and -- most importantly --
 * every piece of state that PERSISTS BETWEEN TRACKS is taken from that source
 * rather than inferred. Getting the last of those wrong is the characteristic
 * DMS bug: track 0 decodes perfectly and everything after it is noise, because
 * the LZ history buffer is shared across tracks unless a per-track flag says
 * to reset it.
 *
 * The reference binary is built from the same source during verification (see
 * scripts/dms-verify.ts), so this is checked against the thing it was ported
 * from, byte for byte, and not only against itself.
 */

// ---------------------------------------------------------------- constants
/** xDMS's `text`: one history buffer shared by every decoder, sized as its
 *  TEMP_BUFFER_LEN. The masks below index into it (QUICK 8 bits, HEAVY1 12,
 *  HEAVY2 13, MEDIUM/DEEP 14), so it must be at least 16 KB. */
const TEXT_LEN = 32000;
/** xDMS's TRACK_BUFFER_LEN. Also the ceiling it enforces on every length
 *  field in a track header, which is what stops a malformed file asking for
 *  an unbounded allocation. */
const TRACK_BUFFER_LEN = 32000;
const HEADLEN = 56;
const THLEN = 20;
/** A standard AmigaDOS DD disk: 80 cylinders of 2 sides x 11 x 512. DMS calls
 *  a cylinder a "track", so a track's unpacked length is 11264, not 5632. */
const ADF_BYTES = 901120;

const CRC_TABLE = (() => {
  // Generated, not transcribed. This is CRC-16/ARC (reflected poly 0xA001);
  // 256 hand-copied constants is 256 chances to introduce a silent one-bit
  // error that only shows up on some files.
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc16(b: Uint8Array, from = 0, len = b.length - from): number {
  let crc = 0;
  for (let i = from; i < from + len; i++) {
    crc = (CRC_TABLE[(crc ^ b[i]) & 0xff] ^ ((crc >>> 8) & 0xff)) & 0xffff;
  }
  return crc;
}

/** DMS's own per-track checksum: a plain 16-bit sum of the UNPACKED bytes.
 *  Weak as a hash and strong as a canary -- it is computed over the decoder's
 *  output, so it catches exactly the failure this port is most exposed to. */
function checksum(b: Uint8Array, len: number): number {
  let u = 0;
  for (let i = 0; i < len; i++) u = (u + b[i]) & 0xffff;
  return u;
}

/** Position-decode tables shared by MEDIUM and DEEP. Both are pure runs of
 *  repeated values, so they are written as [value, count] pairs: the shape is
 *  then visible, where 256 loose digits would hide a transcription slip. */
function expandRuns(into: Uint8Array, pairs: ReadonlyArray<readonly [number, number]>): void {
  let at = 0;
  for (const [v, n] of pairs) { into.fill(v, at, at + n); at += n; }
  if (at !== into.length) throw new Error(`table runs cover ${at}, not ${into.length}`);
}

const D_CODE = new Uint8Array(256);
const D_LEN = new Uint8Array(256);
// D_CODE, as [value, runLength] pairs -- both tables are pure runs,
// which is visible here and is not visible in 256 loose digits.
expandRuns(D_CODE, [[0,32], [1,16], [2,16], [3,16], [4,8], [5,8], [6,8], [7,8], [8,8], [9,8], [10,8], [11,8], [12,4], [13,4], [14,4], [15,4], [16,4], [17,4], [18,4], [19,4], [20,4], [21,4], [22,4], [23,4], [24,2], [25,2], [26,2], [27,2], [28,2], [29,2], [30,2], [31,2], [32,2], [33,2], [34,2], [35,2], [36,2], [37,2], [38,2], [39,2], [40,2], [41,2], [42,2], [43,2], [44,2], [45,2], [46,2], [47,2], [48,1], [49,1], [50,1], [51,1], [52,1], [53,1], [54,1], [55,1], [56,1], [57,1], [58,1], [59,1], [60,1], [61,1], [62,1], [63,1]]);

// D_LEN, as [value, runLength] pairs -- both tables are pure runs,
// which is visible here and is not visible in 256 loose digits.
expandRuns(D_LEN, [[3,32], [4,48], [5,64], [6,48], [7,48], [8,16]]);

// ---------------------------------------------------------------- bit reader
/**
 * xDMS's getbits.h, kept bit-exact including its quirks.
 *
 * Two of them matter. The buffer is masked down to `count` significant bits on
 * every drop, which is why GETBITS(12) can safely index a 4096-entry table.
 * And the refill reads PAST the packed data by up to three bytes, into
 * whatever the shared track buffer happens to hold -- so the input is modelled
 * as that same persistent 32 KB buffer rather than as a tight slice.
 */
const MASK: number[] = Array.from({ length: 25 }, (_, i) => (i === 0 ? 0 : (1 << i) - 1) >>> 0);

class Bits {
  private buf = 0;
  private count = 0;
  private pos = 0;
  constructor(private readonly data: Uint8Array) { this.drop(0); }
  /** Never called with n > 16; the 0xffff mask mirrors xDMS's USHORT cast. */
  get(n: number): number { return (this.buf >>> (this.count - n)) & 0xffff; }
  drop(n: number): void {
    this.count -= n;
    this.buf = (this.buf & MASK[this.count]) >>> 0;
    while (this.count < 16) {
      this.buf = (((this.buf << 8) >>> 0) | (this.data[this.pos++] ?? 0)) >>> 0;
      this.count += 8;
    }
  }
  getDrop(n: number): number { const v = this.get(n); this.drop(n); return v; }
}

// ---------------------------------------------------------------- huffman
const NC = 510;
const N1 = 510;
const NPT = 20;
const OFFSET = 253;

/** xDMS's maketbl.c, recursion and all. Not the same construction as the
 *  canonical LZH builder in lzh-decode.ts: this one also populates the
 *  left/right overflow tree that decode_c and decode_p walk for codes longer
 *  than the direct-lookup table, so the two are not interchangeable. */
function makeTable(
  nchar: number, bitlen: Uint8Array, tablebits: number,
  table: Uint16Array, left: Uint16Array, right: Uint16Array,
): number {
  const n = nchar;
  let avail = nchar;
  const tblsiz = 1 << tablebits;
  let bit = tblsiz >>> 1;
  const maxdepth = tablebits + 1;
  let depth = 1, len = 1;
  let c = -1;            // SHORT in the original: starts negative on purpose
  let codeword = 0;
  let err = 0;

  const mktbl = (): number => {
    if (err) return 0;
    let i = 0;
    if (len === depth) {
      while (++c < n) {
        if (bitlen[c] === len) {
          i = codeword;
          codeword += bit;
          if (codeword > tblsiz) { err = 1; return 0; }
          while (i < codeword) table[i++] = c;
          return c;
        }
      }
      c = -1;
      len++;
      bit >>>= 1;
    }
    depth++;
    if (depth < maxdepth) {
      mktbl();
      mktbl();
    } else if (depth > 32) {
      err = 2; return 0;
    } else {
      i = avail++;
      if (i >= 2 * n - 1) { err = 3; return 0; }
      left[i] = mktbl();
      right[i] = mktbl();
      if (codeword >= tblsiz) { err = 4; return 0; }
      if (depth === maxdepth) table[codeword++] = i;
    }
    depth--;
    return i;
  };

  mktbl();
  if (err) return err;
  mktbl();
  if (err) return err;
  return codeword !== tblsiz ? 5 : 0;
}

// ---------------------------------------------------------------- state
/**
 * Everything that survives from one track to the next.
 *
 * THE thing to understand about DMS: this is not per-track state. The history
 * buffer, every decoder's write cursor, HEAVY's Huffman trees and DEEP's
 * adaptive tree all carry over, and a track only resets them when its flags
 * say so. A port that allocates fresh state per track decodes track 0 and
 * nothing else, and the failure looks like a corrupt archive rather than a
 * bug.
 */
class DmsState {
  text = new Uint8Array(TEXT_LEN);
  quickTextLoc = 0;
  mediumTextLoc = 0;
  heavyTextLoc = 0;
  deepTextLoc = 0;
  initDeepTabs = true;

  // HEAVY: trees persist until a track arrives with the "read trees" flag.
  left = new Uint16Array(2 * NC - 1);
  right = new Uint16Array(2 * NC - 1 + 9);
  cLen = new Uint8Array(NC);
  ptLen = new Uint8Array(NPT);
  cTable = new Uint16Array(4096);
  ptTable = new Uint16Array(256);
  lastlen = 0;
  np = 0;

  // DEEP: an adaptive Huffman tree that keeps adapting across tracks.
  freq = new Uint16Array(627 + 1);
  prnt = new Uint16Array(627 + 314);
  son = new Uint16Array(627);

  constructor() { this.reset(); }

  /** xDMS's Init_Decrunchers. Note it clears only the first 0x3fc8 bytes of
   *  `text`, not the whole buffer -- reproduced exactly rather than tidied,
   *  because the masks reach 0x3fff and the difference is observable. */
  reset(): void {
    this.quickTextLoc = 251;
    this.mediumTextLoc = 0x3fbe;
    this.heavyTextLoc = 0;
    this.deepTextLoc = 0x3fc4;
    this.initDeepTabs = true;
    this.text.fill(0, 0, 0x3fc8);
  }
}

/**
 * Raised where the reference C would spin or run off an array.
 *
 * xDMS decodes files it assumes are well-formed; every tree walk here trusts
 * that the tree is a tree. This runs in a browser on a file a stranger may
 * have supplied, where a cycle in `prnt` or in left/right is a hung tab, not a
 * wrong answer. The bounds below are all strictly larger than any value a
 * valid stream can produce -- 32 exceeds the longest code the table builder
 * will emit, and a leaf-to-root walk cannot visit more nodes than the tree
 * has -- so no correct decode can reach one. They exist only to turn
 * "unbounded" into "this file is damaged".
 */
class Corrupt extends Error {}

// ---------------------------------------------------------------- unpackers
/** RLE, applied on its own (SIMPLE) or as a second pass over the LZ output. */
function unpackRle(inp: Uint8Array, out: Uint8Array, origsize: number): boolean {
  let i = 0, o = 0;
  while (o < origsize) {
    const a = inp[i++];
    if (a !== 0x90) { out[o++] = a; continue; }
    const b = inp[i++];
    if (!b) { out[o++] = a; continue; }   // 0x90 0x00 is a literal 0x90
    const v = inp[i++];
    let n: number;
    if (b === 0xff) { n = inp[i++]; n = ((n << 8) + inp[i++]) & 0xffff; } else n = b;
    if (o + n > origsize) return true;
    out.fill(v, o, o + n);
    o += n;
  }
  return false;
}

function unpackQuick(s: DmsState, inp: Uint8Array, out: Uint8Array, origsize: number): boolean {
  const bits = new Bits(inp);
  const { text } = s;
  let o = 0;
  while (o < origsize) {
    if (bits.get(1) !== 0) {
      bits.drop(1);
      out[o++] = text[s.quickTextLoc++ & 0xff] = bits.getDrop(8);
    } else {
      bits.drop(1);
      let j = bits.getDrop(2) + 2;
      let i = (s.quickTextLoc - bits.getDrop(8) - 1) & 0xffff;
      while (j--) out[o++] = text[s.quickTextLoc++ & 0xff] = text[i++ & 0xff];
    }
  }
  s.quickTextLoc = (s.quickTextLoc + 5) & 0xff;
  return false;
}

function unpackMedium(s: DmsState, inp: Uint8Array, out: Uint8Array, origsize: number): boolean {
  const bits = new Bits(inp);
  const { text } = s;
  let o = 0;
  while (o < origsize) {
    if (bits.get(1) !== 0) {
      bits.drop(1);
      out[o++] = text[s.mediumTextLoc++ & 0x3fff] = bits.getDrop(8);
    } else {
      bits.drop(1);
      let c = bits.getDrop(8);
      let j = D_CODE[c] + 3;
      let u = D_LEN[c];
      c = ((c << u) | bits.getDrop(u)) & 0xff;
      u = D_LEN[c];
      c = ((D_CODE[c] << 8) | (((c << u) | bits.getDrop(u)) & 0xff)) & 0xffff;
      let i = (s.mediumTextLoc - c - 1) & 0xffff;
      while (j--) out[o++] = text[s.mediumTextLoc++ & 0x3fff] = text[i++ & 0x3fff];
    }
  }
  s.mediumTextLoc = (s.mediumTextLoc + 66) & 0x3fff;
  return false;
}

// --- DEEP: adaptive (dynamic) Huffman, the one mode with a tree that
// --- rebalances as it decodes and keeps doing so across track boundaries.
const F = 60, THRESHOLD = 2;
const N_CHAR = 256 - THRESHOLD + F;   // 314
const T_SIZE = N_CHAR * 2 - 1;        // 627
const R_ROOT = T_SIZE - 1;            // 626
const MAX_FREQ = 0x8000;

function initDeepTabs(s: DmsState): void {
  const { freq, son, prnt } = s;
  for (let i = 0; i < N_CHAR; i++) { freq[i] = 1; son[i] = i + T_SIZE; prnt[i + T_SIZE] = i; }
  let i = 0, j = N_CHAR;
  while (j <= R_ROOT) {
    freq[j] = freq[i] + freq[i + 1];
    son[j] = i;
    prnt[i] = prnt[i + 1] = j;
    i += 2; j++;
  }
  freq[T_SIZE] = 0xffff;
  prnt[R_ROOT] = 0;
  s.initDeepTabs = false;
}

function reconst(s: DmsState): void {
  const { freq, son, prnt } = s;
  let j = 0;
  for (let i = 0; i < T_SIZE; i++) {
    if (son[i] >= T_SIZE) { freq[j] = (freq[i] + 1) >>> 1; son[j] = son[i]; j++; }
  }
  for (let i = 0, jj = N_CHAR; jj < T_SIZE; i += 2, jj++) {
    let k = i + 1;
    const f = freq[jj] = (freq[i] + freq[k]) & 0xffff;
    for (k = jj - 1; f < freq[k]; k--);
    k++;
    // The original memmove()s (j-k)*2 BYTES over USHORT arrays, i.e. (j-k)
    // elements. copyWithin counts elements, so the *2 must NOT come along --
    // carrying it over is the obvious way to port this line wrong.
    freq.copyWithin(k + 1, k, jj);
    freq[k] = f;
    son.copyWithin(k + 1, k, jj);
    son[k] = i;
  }
  for (let i = 0; i < T_SIZE; i++) {
    const k = son[i];
    if (k >= T_SIZE) prnt[k] = i; else prnt[k] = prnt[k + 1] = i;
  }
}

function update(s: DmsState, code: number): void {
  const { freq, son, prnt } = s;
  if (freq[R_ROOT] === MAX_FREQ) reconst(s);
  let c = prnt[code + T_SIZE];
  let steps = 0;
  do {
    if (++steps > T_SIZE) throw new Corrupt('cycle walking to the tree root');
    const k = ++freq[c];
    let l = c + 1;
    if (k > freq[l]) {
      while (l < T_SIZE && k > freq[++l]);
      l--;
      freq[c] = freq[l];
      freq[l] = k;
      const i = son[c];
      prnt[i] = l;
      if (i < T_SIZE) prnt[i + 1] = l;
      const jj = son[l];
      son[l] = i;
      prnt[jj] = c;
      if (jj < T_SIZE) prnt[jj + 1] = c;
      son[c] = jj;
      c = l;
    }
  } while ((c = prnt[c]) !== 0);
}

function unpackDeep(s: DmsState, inp: Uint8Array, out: Uint8Array, origsize: number): boolean {
  const bits = new Bits(inp);
  if (s.initDeepTabs) initDeepTabs(s);
  const { text, son } = s;
  let o = 0;
  while (o < origsize) {
    let c = son[R_ROOT];
    let depth = 0;
    while (c < T_SIZE) {
      if (++depth > T_SIZE) throw new Corrupt('cycle descending the DEEP tree');
      c = son[c + bits.getDrop(1)];
    }
    c -= T_SIZE;
    update(s, c);
    if (c < 256) {
      out[o++] = text[s.deepTextLoc++ & 0x3fff] = c;
    } else {
      let j = c - 255 + THRESHOLD;
      // DecodePosition
      let i = bits.getDrop(8);
      const hi = D_CODE[i] << 8;
      const nb = D_LEN[i];
      i = ((i << nb) | bits.getDrop(nb)) & 0xff;
      const pos = (hi | i) & 0xffff;
      let from = (s.deepTextLoc - pos - 1) & 0xffff;
      while (j--) out[o++] = text[s.deepTextLoc++ & 0x3fff] = text[from++ & 0x3fff];
    }
  }
  s.deepTextLoc = (s.deepTextLoc + 60) & 0x3fff;
  return false;
}

// --- HEAVY: static Huffman + LZ, essentially LZH. The trees are read only
// --- when the track's flags say so and otherwise carry over.
function readTreeC(s: DmsState, bits: Bits): boolean {
  let n = bits.getDrop(9);
  // 9 bits can say 511, and the table only holds 510. xDMS writes it anyway;
  // see readTreeP for why this is refused rather than reproduced.
  if (n > NC) return true;
  if (n > 0) {
    for (let i = 0; i < n; i++) s.cLen[i] = bits.getDrop(5);
    s.cLen.fill(0, n, 510);
    return makeTable(510, s.cLen, 12, s.cTable, s.left, s.right) !== 0;
  }
  n = bits.getDrop(9);
  s.cLen.fill(0, 0, 510);
  s.cTable.fill(n);
  return false;
}

function readTreeP(s: DmsState, bits: Bits): boolean {
  let n = bits.getDrop(5);
  /*
   * 5 bits can say 31; pt_len holds 20. A valid stream never exceeds `np`
   * (14 or 15), so any larger count means the data is not what it claims.
   *
   * This is a LATENT BUFFER OVERFLOW IN xDMS ITSELF, found on 2026-09-12 by
   * feeding HEAVY2 streams to the HEAVY1 decoder: 8 of the first 33 real
   * tracks asked for 21..26, and the reference writes every one of them past
   * the end of `pt_len` into whatever global follows it. That is undefined
   * behaviour, so it is not something to reproduce -- there is no defined
   * behaviour to reproduce. Refusing is the only answer that is both safe and
   * honest, and it costs nothing: no valid archive reaches here.
   *
   * The bound is the ARRAY's (20), not `np`, deliberately. Between np and 20
   * the reference is still well-defined -- it writes entries make_table then
   * ignores -- so matching it there keeps this port bug-compatible everywhere
   * the original actually has behaviour.
   */
  if (n > NPT) return true;
  if (n > 0) {
    for (let i = 0; i < n; i++) s.ptLen[i] = bits.getDrop(4);
    s.ptLen.fill(0, n, s.np);
    return makeTable(s.np, s.ptLen, 8, s.ptTable, s.left, s.right) !== 0;
  }
  n = bits.getDrop(5);
  s.ptLen.fill(0, 0, s.np);
  s.ptTable.fill(n);
  return false;
}

function unpackHeavy(s: DmsState, inp: Uint8Array, out: Uint8Array, flags: number, origsize: number): boolean {
  // Heavy 1 uses a 4 KB dictionary, Heavy 2 an 8 KB one.
  const bitmask = flags & 8 ? 0x1fff : 0x0fff;
  s.np = flags & 8 ? 15 : 14;

  const bits = new Bits(inp);
  if (flags & 2) {
    if (readTreeC(s, bits)) return true;
    if (readTreeP(s, bits)) return true;
  }

  const { text, left, right, cLen, cTable, ptLen, ptTable } = s;

  const decodeC = (): number => {
    let j = cTable[bits.get(12)];
    if (j < N1) { bits.drop(cLen[j]); return j; }
    bits.drop(12);
    const i = bits.get(16);
    let m = 0x8000, d = 0;
    do {
      if (++d > 32) throw new Corrupt('cycle in the HEAVY literal tree');
      j = i & m ? right[j] : left[j];
      m >>>= 1;
    } while (j >= N1);
    bits.drop(cLen[j] - 12);
    return j;
  };

  const decodeP = (): number => {
    let j = ptTable[bits.get(8)];
    if (j < s.np) { bits.drop(ptLen[j]); } else {
      bits.drop(8);
      const i = bits.get(16);
      let m = 0x8000, d = 0;
      do {
        if (++d > 32) throw new Corrupt('cycle in the HEAVY position tree');
        j = i & m ? right[j] : left[j];
        m >>>= 1;
      } while (j >= s.np);
      bits.drop(ptLen[j] - 8);
    }
    if (j !== s.np - 1) {
      if (j > 0) { const n = j - 1; j = (bits.get(n) | (1 << (j - 1))) & 0xffff; bits.drop(n); }
      s.lastlen = j;
    }
    return s.lastlen;
  };

  let o = 0;
  while (o < origsize) {
    const c = decodeC();
    if (c < 256) {
      out[o++] = text[s.heavyTextLoc++ & bitmask] = c;
    } else {
      let j = c - OFFSET;
      let i = (s.heavyTextLoc - decodeP() - 1) & 0xffff;
      while (j--) out[o++] = text[s.heavyTextLoc++ & bitmask] = text[i++ & bitmask];
    }
  }
  return false;
}

// ---------------------------------------------------------------- container
export interface DmsInfo {
  /** Compression modes encountered, by name, in the order first seen. */
  modes: string[];
  /** Lowest and highest track the header claims. */
  from: number;
  to: number;
  /** Tracks actually decoded into the image. */
  tracks: number;
  /** FILE_ID.DIZ, if the archive carried one. */
  fileId?: string;
}

export type DmsResult =
  | { ok: true; adf: Uint8Array; info: DmsInfo }
  | { ok: false; reason: string };

const MODE_NAMES = ['NOCOMP', 'SIMPLE', 'QUICK', 'MEDIUM', 'DEEP', 'HEAVY1', 'HEAVY2'];

function be16(b: Uint8Array, at: number): number { return (b[at] << 8) | b[at + 1]; }

/**
 * Decode a .dms into a plain 901,120-byte ADF.
 *
 * Never throws: this runs on a file a person dropped into a browser, so every
 * malformed input has to come back as a reason rather than an exception. The
 * checks are DMS's own -- header CRC, per-track header CRC, per-track data CRC
 * over the PACKED bytes, and a checksum over the UNPACKED bytes -- which means
 * a decoder bug is caught by the format's own integrity fields and not only by
 * whether the result happens to look like a disk.
 */
export function readDms(src: Uint8Array): DmsResult {
  try {
    return decode(src);
  } catch (e) {
    if (e instanceof Corrupt) return { ok: false, reason: `the archive is damaged (${e.message})` };
    throw e;
  }
}

function decode(src: Uint8Array): DmsResult {
  if (src.length < HEADLEN) return { ok: false, reason: 'too short to be a DMS archive' };
  if (src[0] !== 0x44 || src[1] !== 0x4d || src[2] !== 0x53 || src[3] !== 0x21) {
    return { ok: false, reason: 'not a DMS archive (no "DMS!" signature)' };
  }
  if (be16(src, HEADLEN - 2) !== crc16(src, 4, HEADLEN - 6)) {
    return { ok: false, reason: 'DMS header checksum failed -- the file is damaged' };
  }

  const geninfo = be16(src, 10);
  // Bit 1 is "encrypted". Refusing is the only honest option: without the
  // password the tracks decode to noise that would still pass as an ADF by
  // size, and silently mounting a scrambled disk is worse than a clear no.
  if (geninfo & 0x02) return { ok: false, reason: 'this DMS archive is password-protected' };

  const from = be16(src, 16);
  const to = be16(src, 18);

  const state = new DmsState();
  // One persistent pair of track buffers, exactly as xDMS uses: the bit
  // reader can run a few bytes past the packed data, and what it finds there
  // must be what the reference finds there.
  const b1 = new Uint8Array(TRACK_BUFFER_LEN);
  const b2 = new Uint8Array(TRACK_BUFFER_LEN);

  const out: Uint8Array[] = [];
  const modes: string[] = [];
  let fileId: string | undefined;
  let total = 0;
  let expectNumber: number | null = null;
  let at = HEADLEN;

  while (at + THLEN <= src.length) {
    const th = src.subarray(at, at + THLEN);
    if (th[0] !== 0x54 || th[1] !== 0x52) {
      return { ok: false, reason: `expected a track header at byte ${at}` };
    }
    if (crc16(th, 0, THLEN - 2) !== be16(th, THLEN - 2)) {
      return { ok: false, reason: `track header checksum failed at byte ${at}` };
    }

    const number = be16(th, 2);
    const pklen1 = be16(th, 6);
    const pklen2 = be16(th, 8);
    const unpklen = be16(th, 10);
    const flags = th[12];
    const cmode = th[13];
    const usum = be16(th, 14);
    const dcrc = be16(th, 16);
    at += THLEN;

    if (pklen1 > TRACK_BUFFER_LEN || pklen2 > TRACK_BUFFER_LEN || unpklen > TRACK_BUFFER_LEN) {
      return { ok: false, reason: `track ${number} declares an impossible length` };
    }
    if (at + pklen1 > src.length) return { ok: false, reason: `track ${number} is truncated` };
    if (cmode > 6) return { ok: false, reason: `track ${number} uses unknown compression mode ${cmode}` };

    b1.set(src.subarray(at, at + pklen1));
    at += pklen1;
    if (crc16(b1, 0, pklen1) !== dcrc) {
      return { ok: false, reason: `track ${number} failed its data checksum -- the file is damaged` };
    }

    // Track 80 is FILE_ID.DIZ and 0xffff is the banner: metadata, not disk.
    // A track 0 of only 1024 bytes is a "fake boot block" carrying more
    // advertising, and is likewise not part of the image.
    const isDiskTrack = number < 80 && unpklen > 2048;
    if (!isDiskTrack) {
      if (number === 80 && cmode === 0 && unpklen <= 2048) {
        fileId = new TextDecoder('latin1').decode(b1.subarray(0, Math.min(pklen1, unpklen)))
          .replace(/\0+$/, '').trim() || undefined;
      }
      if (!(flags & 1)) state.reset();
      continue;
    }

    if (!modes.includes(MODE_NAMES[cmode])) modes.push(MODE_NAMES[cmode]);

    // Non-sequential tracks would land at the wrong offset, because the
    // stream is assembled in file order (as xDMS does) rather than seeked by
    // track number. Rather than silently produce a scrambled disk, say so.
    if (expectNumber !== null && number !== expectNumber) {
      return { ok: false, reason: `tracks are out of order (expected ${expectNumber}, got ${number})` };
    }
    expectNumber = number + 1;

    let failed = false;
    switch (cmode) {
      case 0: b2.set(b1.subarray(0, unpklen)); break;
      case 1: failed = unpackRle(b1, b2, unpklen); break;
      case 2: failed = unpackQuick(state, b1, b2, pklen2) || unpackRle(b2, b1, unpklen); if (!failed) b2.set(b1.subarray(0, unpklen)); break;
      case 3: failed = unpackMedium(state, b1, b2, pklen2) || unpackRle(b2, b1, unpklen); if (!failed) b2.set(b1.subarray(0, unpklen)); break;
      case 4: failed = unpackDeep(state, b1, b2, pklen2) || unpackRle(b2, b1, unpklen); if (!failed) b2.set(b1.subarray(0, unpklen)); break;
      case 5:
      case 6:
        failed = unpackHeavy(state, b1, b2, cmode === 5 ? (flags & 7) : (flags | 8), pklen2);
        if (!failed && (flags & 4)) {
          failed = unpackRle(b2, b1, unpklen);
          if (!failed) b2.set(b1.subarray(0, unpklen));
        }
        break;
    }
    if (failed) return { ok: false, reason: `track ${number} could not be decompressed` };

    if (checksum(b2, unpklen) !== usum) {
      return { ok: false, reason: `track ${number} decoded to the wrong checksum` };
    }

    out.push(b2.slice(0, unpklen));
    total += unpklen;
    if (!(flags & 1)) state.reset();
  }

  if (out.length === 0) return { ok: false, reason: 'the archive contains no disk tracks' };
  if (total !== ADF_BYTES) {
    return {
      ok: false,
      reason: `decoded ${total} bytes, not a standard ${ADF_BYTES}-byte DD disk ` +
              `(${out.length} tracks) -- HD and non-standard disks are not supported`,
    };
  }

  const adf = new Uint8Array(ADF_BYTES);
  let o = 0;
  for (const t of out) { adf.set(t, o); o += t.length; }
  return { ok: true, adf, info: { modes, from, to, tracks: out.length, fileId } };
}

/**
 * Test-only surface.
 *
 * QUICK, MEDIUM, DEEP and HEAVY1 are all but extinct in the wild -- DMS chose
 * HEAVY2 by default and essentially every real archive uses it -- so no
 * collection of sample files exercises those four code paths. They are instead
 * compared against the reference C directly, decoder by decoder, over
 * deterministic pseudo-random input: these are total functions over arbitrary
 * bytes, so "not a real compressed stream" is not an obstacle to differential
 * testing. See scripts/dms-verify.ts.
 */
export const __internals = {
  DmsState, unpackRle, unpackQuick, unpackMedium, unpackDeep, unpackHeavy, crc16,
};
