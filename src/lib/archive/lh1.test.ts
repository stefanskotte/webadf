import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLha, type LhaEntry } from './lha';
import { decodeLh1 } from './lzh-decode';

/**
 * -lh1- (LHarc 1.x): 4 KB window, adaptive Huffman for literals and lengths,
 * a fixed Huffman table for the top 6 bits of a position.
 *
 * Every fixture was produced by /opt/homebrew/bin/lha (LHa for UNIX
 * 1.14i-ac20211125) with `lha -ao1` (method -lh1-, header level 1) -- see
 * scripts/lh1-fixtures.py -- and every expected hash below is of what that
 * same tool EXTRACTS (`lha -x` / `lha -p`), never of anything this repository
 * wrote. The operator's real .lzh was refused as "unsupported method -lh1-".
 */
const FIX = join(__dirname, 'fixtures');
const read = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const byName = (entries: LhaEntry[], name: string) => entries.find((e) => e.path === name);

/** name -> [size, sha256] of `lha -x` output. */
const EXPECTED: Record<string, [number, string]> = {
  'readme.txt': [135, '1aeb60e2249192a0239b20bdba50d1e229d80ca5bfa45ebb717e3ff548cef326'],
  // Skewed random bytes, so lha compresses rather than stores them.
  'binary.bin': [3000, 'a7c35abd0bd59226acda8532ac9e8187f6c9b7658cff7f4bcce859462858e1c7'],
  // "AMIGA" x 4000 + 3000 NULs: maximum-length (60) matches, over and over.
  'repeat.bin': [23000, 'c4b7a5d1f967cc1a7ad546417e15647e9563f56d0434a1fa84ce680b5825bb59'],
  // A 1.5 KB block repeated both inside and beyond the 4 KB window.
  'window.txt': [10500, 'badfef05be618145887b45b0187bcc65b23ef3657f4295bec85e1ede76bf4362'],
};

describe('lh1.lzh (lha -ao1)', () => {
  const { entries, skipped } = readLha(read('lh1.lzh'));

  it('reads every member and skips nothing', () => {
    expect(skipped).toEqual([]);
    expect(entries.map((e) => e.path).sort()).toEqual(
      ['binary.bin', 'empty.txt', 'readme.txt', 'repeat.bin', 'window.txt'],
    );
  });

  it.each(Object.entries(EXPECTED))('decodes %s to the bytes lha extracts', (name, [size, hash]) => {
    const e = byName(entries, name);
    expect(e?.method).toBe('-lh1-');
    expect(e?.bytes.length).toBe(size);
    expect(sha(e!.bytes)).toBe(hash);
  });

  it('keeps the readable text exactly', () => {
    const readme = new TextDecoder('latin1').decode(byName(entries, 'readme.txt')!.bytes);
    expect(readme).toBe('The quick brown fox jumps over the lazy dog. '.repeat(3).trimEnd() + '\n');
  });

  it('reads the empty file (lha stores it as -lh0-)', () => {
    const e = byName(entries, 'empty.txt');
    expect(e?.method).toBe('-lh0-');
    expect(e?.bytes.length).toBe(0);
  });

  it('expands through the same entry point the drop target uses', async () => {
    const { expandArchive } = await import('./index');
    const r = await expandArchive('lh1.lzh', read('lh1.lzh'));
    expect(r && 'format' in r && r.format).toBe('lha');
    expect(r && 'members' in r && r.members).toHaveLength(5);
    expect(r && 'skipped' in r && r.skipped).toEqual([]);
  });
});

describe('lh1-big.lzh: a 396,000-byte member', () => {
  it('decodes to the bytes lha extracts (exercises the adaptive tree rebuild)', () => {
    // 396,000 bytes is far past 0x8000 symbols, so reconst() -- the halving of
    // every frequency when the root reaches 0x8000 -- runs several times.
    const { entries, skipped } = readLha(read('lh1-big.lzh'));
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('big.txt');
    expect(entries[0].bytes.length).toBe(396_000);
    expect(sha(entries[0].bytes)).toBe('ae80cc0950f5922bb1ab72fceafdbf55498d154054599a424d0bde38fcd7736c');
  });
});

describe('lh1-fuzz.lzh: random bytes as -lh1- data, decoded by the reference', () => {
  // Eight level-0 members of 1,500 random bytes claiming 1,000 bytes each.
  // The hashes are of the first 1,000 bytes `lha -p` printed for each (lha
  // writes the whole of the last match, so it prints a few bytes more, and
  // then reports a CRC error). Garbage is where a decoder written from memory
  // differs from the real one: these streams reference positions BEFORE the
  // start of the file constantly, and LHA's window starts out full of spaces.
  const FUZZ = [
    '8594c142aafbedc50919396666729777050882b1cc66f55e6f6b6c0825a2023c',
    'b942cfe3077bfc7a0cbb88e732c134445830dd8843051be7ea1c9921bc40b48b',
    '44a4680eba2cbec8d8ff29597388444919fc131e9fd6b9bdfb8e748dfc9b346c',
    'cb74edf8b5d5f001821b1cf5cd381fa6402e3d8ce94b279654b311ece5dcf79e',
    'a95049d3e5600e948e756177ee9de598d19e1797ecda12ba446032732b4937b4',
    'b0ac7606a67b7deb2e7ba776e751f428e910d673ef129e0562eeef40752de456',
    '98bd9a0da73999867b07202490679c99bd3dfe539ab64014ac87d29ed8e9bbdb',
    '9d82436e95c66e61cacae1c0ae1fee71cee3b5927a42daa6f3e955487c2243ce',
  ];
  const { entries, skipped } = readLha(read('lh1-fuzz.lzh'));

  it('yields what the reference decoder yields, byte for byte', () => {
    expect(skipped).toEqual([]);
    expect(entries.map((e) => sha(e.bytes))).toEqual(FUZZ);
  });

  it('fills the window with spaces before the first byte, as LHA does', () => {
    // lha -p's fuzz0.bin begins 0x9c followed by 23 spaces copied from before
    // the start of the output.
    expect(Array.from(entries[0].bytes.subarray(0, 4))).toEqual([0x9c, 0x20, 0x20, 0x20]);
  });
});

describe('a damaged -lh1- member', () => {
  const full = read('lh1.lzh');
  /** Offset of the header whose name field holds `name`. */
  const headerOf = (name: string) => {
    const at = Buffer.from(full).indexOf(name, 0, 'latin1');
    return at - 22;
  };

  it('cut mid-stream is refused as truncated, and the members before it survive', () => {
    const w = headerOf('window.txt');
    const cut = full.subarray(0, w + 22 + 'window.txt'.length + 5 + 3000);
    const t = performance.now();
    const r = readLha(cut);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.entries.map((e) => e.path).sort()).toEqual(['binary.bin', 'empty.txt', 'readme.txt', 'repeat.bin']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].path).toBe('window.txt');
    expect(r.skipped[0].reason).toMatch(/^truncated \(\d+\/10500 bytes\)$/);
  });

  it('with a flipped byte, decodes exactly as the reference does and never throws', () => {
    // The byte 1,500 past window.txt's header start, XOR 0x5a. `lha -p`
    // prints these 10,500 bytes and then "CRC error".
    const buf = full.slice();
    buf[headerOf('window.txt') + 22 + 1500] ^= 0x5a;
    let r!: ReturnType<typeof readLha>;
    expect(() => { r = readLha(buf); }).not.toThrow();
    const w = byName(r.entries, 'window.txt');
    expect(w && sha(w.bytes)).toBe('d182a5d8cdb74ef9daf842e83543aad5662436204ba15bd8b7ccb91092df9f25');
  });
});

describe('decodeLh1 bounds (a crafted stream)', () => {
  it('never writes past the size it was asked for', () => {
    const src = new Uint8Array(4096).fill(0xa5);
    expect(decodeLh1(src, 100).length).toBeLessThanOrEqual(100);
  });

  it('stops when the input runs out instead of decoding zeros up to a huge claim', () => {
    // 64 bytes of input claiming 16 MB: without the stop it would decode
    // ~16M symbols of nothing. Returns short; readLha calls that truncated.
    const t = performance.now();
    const out = decodeLh1(new Uint8Array(64).fill(0xff), 16 * 1024 * 1024);
    expect(out.length).toBeLessThan(16 * 1024 * 1024);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('returns empty for empty input with a non-zero claim, without throwing', () => {
    expect(decodeLh1(new Uint8Array(0), 1000).length).toBe(0);
  });

  it('returns empty for a zero claim', () => {
    expect(decodeLh1(new Uint8Array(10), 0).length).toBe(0);
  });
});
