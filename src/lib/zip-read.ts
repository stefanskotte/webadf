import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/** Just enough zip for the TOSEC pack: central directory, stored (0) and deflate (8), no zip64. */
export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; localOffset: number }

export async function listZip(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('not a zip file (no end of central directory)');
    const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('zip64 archives are not supported');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
      const nameLen = cd.readUInt16LE(p + 28), extra = cd.readUInt16LE(p + 30), comment = cd.readUInt16LE(p + 32);
      const entry = { name: cd.toString('utf8', p + 46, p + 46 + nameLen), method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), localOffset: cd.readUInt32LE(p + 42) };
      if (entry.compressedSize === 0xffffffff || entry.localOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
      out.push(entry);
      p += 46 + nameLen + extra + comment;
    }
    return out;
  } finally { await fh.close(); }
}

export async function readZipEntry(path: string, e: ZipEntry): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, e.localOffset);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt zip local header for ${e.name}`);
    const start = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const body = Buffer.alloc(e.compressedSize);
    await fh.read(body, 0, e.compressedSize, start);
    if (e.method === 0) return body;
    if (e.method === 8) return inflateRawSync(body);
    throw new Error(`${e.name}: unsupported zip compression method ${e.method}`);
  } finally { await fh.close(); }
}
