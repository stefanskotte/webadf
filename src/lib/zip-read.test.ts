import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { listZip, readZipEntry } from './zip-read';

function makeZip(files: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(f.deflate ? 8 : 0, 8); lh.writeUInt32LE(crc32(f.data), 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(f.deflate ? 8 : 0, 10); ch.writeUInt32LE(crc32(f.data), 16); ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body); centrals.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('zip-read', () => {
  it('lists and reads stored and deflated entries', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'z-')), 'a.zip');
    writeFileSync(p, makeZip([{ name: 'TOSEC/a.dat', data: Buffer.from('stored') }, { name: 'TOSEC/b.dat', data: Buffer.from('x'.repeat(1000)), deflate: true }]));
    const entries = await listZip(p);
    expect(entries.map((e) => e.name)).toEqual(['TOSEC/a.dat', 'TOSEC/b.dat']);
    expect((await readZipEntry(p, entries[0])).toString()).toBe('stored');
    expect((await readZipEntry(p, entries[1])).toString()).toBe('x'.repeat(1000));
  });
  it('refuses zip64 with a clear message', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'z-')), 'b.zip');
    const z = makeZip([{ name: 'a', data: Buffer.from('a') }]);
    z.writeUInt32LE(0xffffffff, z.length - 22 + 16); // central directory offset -> zip64 marker
    writeFileSync(p, z);
    await expect(listZip(p)).rejects.toThrow(/zip64/);
  });
  it('refuses a file that is not a zip', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'z-')), 'c.zip'); writeFileSync(p, 'not a zip');
    await expect(listZip(p)).rejects.toThrow(/not a zip/);
  });
});
