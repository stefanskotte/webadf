import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLha, type LhaEntry } from './lha';
import { decodeLzh, LzhWorkBudgetError } from './lzh-decode';

/**
 * Fixtures are produced by /opt/homebrew/bin/lha, not by anything in this
 * repository, and the expected bytes below are what that tool extracts. That
 * is the same standard adffs holds itself to with xdftool and adfmfm with
 * greaseweazle: a format reader that only agrees with its own writer has
 * proved nothing.
 *
 * Three header levels, because the level is not a detail. macOS `lha` writes
 * level 2 by default while real Aminet uploads are overwhelmingly level 1 --
 * measured across five of them -- and level 1 is the one with the extended
 * header chain that is easy to walk incorrectly.
 *
 * The wider check against actual Aminet archives is `pnpm lha:verify <dir>`,
 * kept out of the unit suite because it needs third-party files this
 * repository should not carry.
 */
const FIX = join(__dirname, 'fixtures');
const read = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));

const README =
  'The quick brown fox jumps over the lazy dog. '.repeat(3).trimEnd() + '\n';
const DEEP = 'nested file contents for directory handling\n';

const byName = (entries: LhaEntry[], suffix: string) =>
  entries.find((e) => e.path.endsWith(suffix));
const text = (e: LhaEntry | undefined) =>
  e ? new TextDecoder('latin1').decode(e.bytes) : undefined;

describe.each(['h0.lha', 'h1.lha', 'h2.lha'])('%s', (file) => {
  const { entries, skipped } = readLha(read(file));

  it('reads every file and skips nothing', () => {
    expect(skipped).toEqual([]);
    // Four files: readme, tiny, noise, and one inside a subdirectory.
    expect(entries).toHaveLength(4);
  });

  it('decompresses -lh5- to the exact original bytes', () => {
    expect(text(byName(entries, 'readme.txt'))).toBe(README);
  });

  it('reads a stored -lh0- member', () => {
    // 600 random bytes do not compress, so lha stores them -- which is how
    // this fixture exercises the no-compression path at all.
    const noise = byName(entries, 'noise.bin');
    expect(noise?.method).toBe('-lh0-');
    expect(noise?.bytes).toHaveLength(600);
  });

  it('keeps a nested path rather than flattening it', () => {
    const deep = byName(entries, 'deep.txt');
    expect(deep?.path).toContain('sub/');
    expect(text(deep)).toBe(DEEP);
  });

  it('emits no entry for the directory records themselves', () => {
    // -lhd- members carry no data; the staging area makes parents from paths.
    expect(entries.some((e) => e.method === '-lhd-')).toBe(false);
    expect(entries.every((e) => !e.path.endsWith('/'))).toBe(true);
  });

  it('translates the 0xff path separator', () => {
    expect(entries.every((e) => !e.path.includes('\xff'))).toBe(true);
  });

  it('reports no protection bits when the archive carries none', () => {
    // These are written on macOS, so there is no 0x40 Amiga attribute header.
    // null, NOT zero: "the archive said nothing" and "the archive said rwed"
    // are different claims, and only the first may be replaced by a default.
    expect(entries.every((e) => e.protection === null)).toBe(true);
  });
});

// .lzh is the same container under another name (Amiga sites ship both; nothing
// in the bytes differs). These three were written by the same `lha` with
// `-o5/-o6/-o7`, i.e. the -lh5-/-lh6-/-lh7- methods, and named .lzh so the
// extension the app dispatches on is the one a user would actually drop.
describe.each([['m5.lzh', '-lh5-'], ['m6.lzh', '-lh6-'], ['m7.lzh', '-lh7-']])('%s', (file, method) => {
  const { entries, skipped } = readLha(read(file));

  it('reads every file and skips nothing', () => {
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(4);
  });

  it(`decompresses ${method} to the exact original bytes`, () => {
    const readme = byName(entries, 'readme.txt');
    expect(readme?.method).toBe(method);
    expect(text(readme)).toBe(README);
    expect(text(byName(entries, 'deep.txt'))).toBe(DEEP);
  });

  it('expands through the same entry point the drop target uses', async () => {
    const { expandArchive } = await import('./index');
    const r = await expandArchive(file, read(file));
    expect(r && 'format' in r && r.format).toBe('lha');
    expect(r && 'members' in r && r.members).toHaveLength(4);
  });
});

describe('malformed input', () => {
  it('returns empty rather than throwing on random bytes', () => {
    // The caller is a drop target. An exception there is a dead UI with no
    // explanation, which is worse than an empty file list.
    const junk = new Uint8Array(512).map((_, i) => (i * 37) & 0xff);
    expect(() => readLha(junk)).not.toThrow();
  });

  it('returns empty rather than throwing on an empty buffer', () => {
    expect(readLha(new Uint8Array(0))).toEqual({ entries: [], skipped: [] });
  });

  it('stops instead of looping when a header claims no forward progress', () => {
    // A header whose sizes would leave the cursor where it started is the
    // shape that hangs a naive reader.
    const buf = read('h1.lha').slice();
    buf[7] = 0; buf[8] = 0; buf[9] = 0; buf[10] = 0;   // packed size = 0
    expect(() => readLha(buf)).not.toThrow();
  });

  it('truncates a filename at its NUL, dropping the comment', () => {
    // Real case: Aminet's l2boot.lha packs "name\\0created 02.08.2026..." into
    // the filename field. Bytes decoded perfectly and the paths were unusable.
    const buf = read('h0.lha').slice();
    const nameAt = 22;
    buf[nameAt + 3] = 0;   // truncate the first entry's name early
    const { entries } = readLha(buf);
    expect(entries[0]?.path).not.toContain('\0');
  });
});

describe('size guard (a header states the original size; nothing checks it is honest)', () => {
  // fixtures/disks.lha: Game/Disk1.adf and Game/Disk2.adf (-lh5-, 901,120
  // bytes each) and Game/readme.txt (-lh0-), level 1, made by `lha ao51`.
  const ADF = 901_120;
  /** The first entry's "original size" field, at offset 11 of its header. */
  const claimSize = (buf: Uint8Array, n: number) => {
    buf[11] = n & 0xff; buf[12] = (n >>> 8) & 0xff; buf[13] = (n >>> 16) & 0xff; buf[14] = (n >>> 24) & 0xff;
  };

  it('reads every member when no limit is given', () => {
    const { entries, skipped } = readLha(read('disks.lha'));
    expect(skipped).toEqual([]);
    expect(entries.map((e) => [e.path, e.bytes.length])).toEqual([
      ['Game/Disk1.adf', ADF], ['Game/Disk2.adf', ADF], ['Game/readme.txt', 10],
    ]);
  });

  it('skips a member that claims more than maxEntryBytes, without allocating it', () => {
    const buf = read('disks.lha').slice();
    claimSize(buf, 0xffff_ff00);   // ~4 GB: the allocation the guard exists to prevent
    const { entries, skipped } = readLha(buf, { maxEntryBytes: 4 * 1024 * 1024 });
    expect(skipped).toEqual([{ path: 'Game/Disk1.adf', reason: 'too large' }]);
    // The walk carries on past it: the header's packed size is still right.
    expect(entries.map((e) => e.path)).toEqual(['Game/Disk2.adf', 'Game/readme.txt']);
  });

  it('stops decoding once maxTotalBytes would be passed', () => {
    const { entries, skipped } = readLha(read('disks.lha'), { maxTotalBytes: ADF + 100 });
    expect(entries.map((e) => e.path)).toEqual(['Game/Disk1.adf', 'Game/readme.txt']);
    expect(skipped).toEqual([{ path: 'Game/Disk2.adf', reason: 'archive limit reached' }]);
  });

  it('decodes only the members accept() takes, skipping the rest as not selected', () => {
    const { entries, skipped } = readLha(read('disks.lha'), { accept: (p) => p.endsWith('.adf') });
    expect(entries.map((e) => e.path)).toEqual(['Game/Disk1.adf', 'Game/Disk2.adf']);
    expect(skipped).toEqual([{ path: 'Game/readme.txt', reason: 'not selected' }]);
  });

  it('applies the guard on the drop path too (expandArchive)', async () => {
    const { expandArchive } = await import('./index');
    const buf = read('disks.lha').slice();
    claimSize(buf, 0xffff_ff00);
    const r = await expandArchive('disks.lha', buf);
    expect(r && 'skipped' in r && r.skipped).toEqual([{ path: 'Game/Disk1.adf', reason: 'too large' }]);
  });
});

/**
 * An -lh5- stream of `blocks` one-literal blocks: each block has a one-symbol
 * T table and a 510-entry C table that costs no bits, so it is ~44 bits of
 * input per byte of output and a full table rebuild per byte. 20 MB of this
 * kept decodeLzh busy for 20.8 s before the block budget (review 2026-10-13).
 */
function tinyBlockStream(blocks: number): Uint8Array {
  const out: number[] = [];
  let acc = 0, n = 0;
  const put = (v: number, w: number) => {
    for (let i = w - 1; i >= 0; i--) {
      acc = (acc << 1) | ((v >> i) & 1);
      if (++n === 8) { out.push(acc); acc = 0; n = 0; }
    }
  };
  for (let b = 0; b < blocks; b++) {
    put(1, 16);              // blockSize 1
    put(0, 5); put(3, 5);    // T: a single symbol (3, i.e. length 1)
    put(510, 9);             // C: 510 lengths, each costing 0 bits
    put(0, 4); put(0, 4);    // P: a single symbol
    put(0, 1);               // the one literal
  }
  put(0, 8);
  return new Uint8Array(out);
}

/** A level-0 header (checksums unset: readLha does not verify them) around `data`. */
function lha0(name: string, method: string, data: Uint8Array, original: number): Uint8Array {
  const nm = Buffer.from(name);
  const h = Buffer.alloc(24 + nm.length);
  h[0] = 22 + nm.length;
  h.write(method, 2, 'latin1');
  h.writeUInt32LE(data.length, 7);
  h.writeUInt32LE(original, 11);
  h[21] = nm.length;
  nm.copy(h, 22);
  return new Uint8Array(Buffer.concat([h, Buffer.from(data), Buffer.alloc(1)]));
}

describe('work budget (a CPU bomb made of tiny blocks)', () => {
  const BLOCKS = 40_000;

  it('decodeLzh refuses a stream with far more blocks than its size justifies', () => {
    const t = performance.now();
    expect(() => decodeLzh(tinyBlockStream(BLOCKS), BLOCKS, 13)).toThrow(LzhWorkBudgetError);
    // Budget: ceil(40000 / 256) + 16 = 173 blocks, then it stops.
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('still decodes a short stream within the budget', () => {
    // 16 one-byte blocks for 16 bytes: the +16 allowance for tiny members.
    expect(decodeLzh(tinyBlockStream(16), 16, 13)).toHaveLength(16);
  });

  it('readLha turns it into a refusal of that member, not an exception', () => {
    const buf = lha0('Bomb.adf', '-lh5-', tinyBlockStream(BLOCKS), BLOCKS);
    const r = readLha(buf, { maxEntryBytes: 4 * 1024 * 1024 });
    expect(r.entries).toEqual([]);
    expect(r.skipped).toEqual([{ path: 'Bomb.adf', reason: 'corrupt (too many blocks)' }]);
  });
});

describe('accept() sees every member, decodable or not', () => {
  it('asks about an unsupported -lh1- member too, so a count cannot miss it', () => {
    const seen: string[] = [];
    const buf = lha0('Old.adf', '-lh1-', new Uint8Array(4), 4);
    readLha(buf, { accept: (p) => { seen.push(p); return false; } });
    expect(seen).toEqual(['Old.adf']);
  });
});
