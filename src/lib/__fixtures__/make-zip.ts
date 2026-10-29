import { deflateRawSync, crc32 } from 'node:zlib';

/** A minimal zip writer for tests: stored or deflate entries, no zip64. `amigaProtection`: made on an Amiga (host 1, R11). */
export function makeZip(files: { name: string; data: Buffer; deflate?: boolean; amigaProtection?: number }[]): Buffer {
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
    if (f.amigaProtection !== undefined) { ch.writeUInt16LE((1 << 8) | 20, 4); ch.writeUInt32LE((f.amigaProtection << 16) >>> 0, 38); }
    locals.push(lh, name, body); centrals.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
