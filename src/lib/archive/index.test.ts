import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandArchive, isArchiveName, MAX_ARCHIVE_BYTES } from './index';

const fx = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', n)));

describe('isArchiveName', () => {
  it('accepts the three extensions that matter, case-insensitively', () => {
    for (const n of ['x.lha', 'X.LHA', 'x.lzh', 'x.zip', 'X.Zip']) {
      expect(isArchiveName(n)).toBe(true);
    }
  });
  it('rejects anything else, including a disk image', () => {
    for (const n of ['x.adf', 'x.txt', 'lha', 'x.lha.txt']) {
      expect(isArchiveName(n)).toBe(false);
    }
  });
});

describe('expandArchive', () => {
  it('returns null for a file that is not an archive, so it drops normally', async () => {
    expect(await expandArchive('notes.txt', new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('expands an lha', async () => {
    const r = await expandArchive('h1.lha', fx('h1.lha'));
    expect(r && 'format' in r && r.format).toBe('lha');
    expect(r && 'members' in r && r.members.length).toBe(4);
  });

  it('expands a zip', async () => {
    const r = await expandArchive('t.zip', fx('t.zip'));
    expect(r && 'format' in r && r.format).toBe('zip');
    expect(r && 'members' in r && r.members.some((m) => m.path.endsWith('deep.txt'))).toBe(true);
  });

  it('refuses one over the cap, and says how big it was', async () => {
    // The cap guards the browser, so it is checked BEFORE any decoding --
    // asserting on a buffer that would be ruinous to actually decode.
    const huge = new Uint8Array(MAX_ARCHIVE_BYTES + 1);
    const r = await expandArchive('big.lha', huge);
    expect(r).toEqual({ error: 'too-large', sizeBytes: MAX_ARCHIVE_BYTES + 1 });
  });

  it('reports unreadable rather than an empty archive for junk', async () => {
    // An empty list would read as "this archive has no files in it", which is
    // a different and wrong statement.
    const junk = new Uint8Array(300).map((_, i) => (i * 17) & 0xff);
    expect(await expandArchive('junk.lha', junk)).toEqual({ error: 'unreadable' });
    expect(await expandArchive('junk.zip', junk)).toEqual({ error: 'unreadable' });
  });

  it('carries protection through as null when the archive has none', async () => {
    const r = await expandArchive('h1.lha', fx('h1.lha'));
    expect(r && 'members' in r && r.members.every((m) => m.protection === null)).toBe(true);
  });
});
