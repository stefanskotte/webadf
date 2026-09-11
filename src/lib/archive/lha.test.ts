import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLha, type LhaEntry } from './lha';

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
