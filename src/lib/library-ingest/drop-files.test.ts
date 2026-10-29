import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { diskFilesFromDrop } from './drop-files';

const fx = (n: string) => new File([readFileSync(`src/lib/archive/fixtures/${n}`)], n);

/** A stored-deflate zip of `members` (the shape src/lib/archive/index.test.ts builds). */
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

describe('diskFilesFromDrop', () => {
  it('keeps images, opens an .lha for the images inside, and names what it refused', async () => {
    const r = await diskFilesFromDrop([
      { name: 'Game.adf', kind: 'file', file: new File([new Uint8Array(901_120)], 'Game.adf') },
      { name: 'disks.lha', kind: 'file', file: fx('disks.lha') },
      { name: 'notes.txt', kind: 'file', file: new File(['x'], 'notes.txt') },
      { name: 't.zip', kind: 'file', file: fx('t.zip') },
      { name: 'Folder', kind: 'dir' },
    ]);
    expect(r.files.map((f) => [f.name, f.size])).toEqual([['Game.adf', 901_120], ['Disk1.adf', 901_120], ['Disk2.adf', 901_120]]);
    expect(r.refused).toEqual([{ name: 'notes.txt', reason: 'not a disk image' }, { name: 't.zip', reason: 'no disk images inside' }]);
    // disks.lha also holds Game/readme.txt: left out with a note, not a refusal.
    expect(r.notes).toEqual(['disks.lha: 1 other file inside, not disk images, left out']);
  });

  it("names a folder's files by their base names and leaves its dotfiles out", async () => {
    const r = await diskFilesFromDrop([
      { name: 'Set', kind: 'dir' },
      { name: 'Set/Disk 1.adf', kind: 'file', file: new File([new Uint8Array(4)], 'Disk 1.adf') },
      { name: 'Set/.DS_Store', kind: 'file', file: new File(['x'], '.DS_Store') },
      { name: 'Set/readme.txt', kind: 'file', file: new File(['x'], 'readme.txt') },
    ]);
    expect(r.files.map((f) => f.name)).toEqual(['Disk 1.adf']);
    expect(r.refused).toEqual([{ name: 'readme.txt', reason: 'not a disk image' }]);
  });

  it('a zip of images and other files adds the images and counts the rest', async () => {
    const adf = new Uint8Array(901_120);
    const zip = zipOf([
      { name: 'Set/A.adf', bytes: adf }, { name: 'Set/B.dms', bytes: new Uint8Array(10) },
      { name: 'Set/info.txt', bytes: new Uint8Array(3) }, { name: '__MACOSX/Set/._A.adf', bytes: new Uint8Array(3) },
    ]);
    const r = await diskFilesFromDrop([{ name: 'set.zip', kind: 'file', file: new File([zip as unknown as BlobPart], 'set.zip') }]);
    expect(r.files.map((f) => [f.name, f.size])).toEqual([['A.adf', 901_120], ['B.dms', 10]]);
    expect(r.refused).toEqual([]);
    expect(r.notes).toEqual(['set.zip: 1 other file inside, not disk images, left out']);
  });

  it("refuses an archive it can't open", async () => {
    const r = await diskFilesFromDrop([{ name: 'bad.lha', kind: 'file', file: new File(['not an archive'], 'bad.lha') }]);
    expect(r).toEqual({ files: [], refused: [{ name: 'bad.lha', reason: "can't open this archive" }], notes: [] });
  });
});
