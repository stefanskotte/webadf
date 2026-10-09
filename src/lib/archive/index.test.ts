import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { expandArchive, isArchiveName, MAX_ARCHIVE_BYTES, MAX_ZIP_MEMBER_BYTES } from './index';

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

/** A minimal deflate-only zip, built here so the test controls every byte. */
function zipOf(members: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const parts: Buffer[] = [];
  const cens: Buffer[] = [];
  let off = 0;
  for (const m of members) {
    const data = deflateRawSync(m.bytes);
    const nm = Buffer.from(m.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(m.bytes.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(m.bytes.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data);
    cens.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, eocd]));
}

describe('expandArchive zip caps (browser path)', () => {
  it('skips a deflate bomb member instead of inflating it whole', async () => {
    const bomb = new Uint8Array(MAX_ZIP_MEMBER_BYTES + 1);
    const r = await expandArchive('bomb.zip', zipOf([{ name: 'bomb.bin', bytes: bomb }]));
    expect(r && 'skipped' in r && r.skipped).toEqual([{ path: 'bomb.bin', reason: 'too large' }]);
    expect(r && 'members' in r && r.members).toHaveLength(0);
  });

  it('still expands DD and HD ADFs and a multi-disk archive', async () => {
    const disks = [
      { name: 'DD.adf', bytes: new Uint8Array(901_120).fill(1) },
      { name: 'HD.adf', bytes: new Uint8Array(1_802_240).fill(2) },
      ...Array.from({ length: 8 }, (_, i) => ({ name: `Disk${i}.adf`, bytes: new Uint8Array(901_120).fill(i + 3) })),
    ];
    const r = await expandArchive('set.zip', zipOf(disks));
    expect(r && 'members' in r && r.members.map((m) => m.bytes.length)).toEqual(disks.map((d) => d.bytes.length));
    expect(r && 'skipped' in r && r.skipped).toEqual([]);
  });
});
