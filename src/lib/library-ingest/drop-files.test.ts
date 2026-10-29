import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { diskFilesFromDrop } from './drop-files';
import { MAX_ARCHIVE_BYTES } from '@/lib/archive';

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

  it('refuses an archive over the cap without reading it into the tab', async () => {
    const file = new File(['x'], 'huge.zip');
    Object.defineProperty(file, 'size', { value: MAX_ARCHIVE_BYTES + 1 });
    const read = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('read a multi-GB archive'));
    const r = await diskFilesFromDrop([{ name: 'huge.zip', kind: 'file', file }]);
    expect(r).toEqual({ files: [], refused: [{ name: 'huge.zip', reason: "can't open this archive" }], notes: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('a drop of many archives is handed over a chunk at a time, never holding more than one chunk of members', async () => {
    const PER = 30;
    const delivered: number[] = [];
    let extracted = 0;
    const heldAtRead: number[] = [];
    const items = Array.from({ length: 4 }, (_, a) => {
      const zip = zipOf(Array.from({ length: PER }, (_, k) => ({ name: `Z${a}/D${k}.adf`, bytes: new Uint8Array([a, k]) })));
      const file = new File([zip as unknown as BlobPart], `z${a}.zip`);
      const read = file.arrayBuffer.bind(file);
      // Members of the archives read so far, less those already handed over: what the tab holds as this one is read.
      vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
        heldAtRead.push(extracted - delivered.reduce((n, c) => n + c, 0));
        extracted += PER;
        return read();
      });
      return { name: `z${a}.zip`, kind: 'file' as const, file };
    });
    const names: string[] = [];
    const r = await diskFilesFromDrop(items, async (files) => { delivered.push(files.length); names.push(...files.map((f) => f.name)); }, 50);
    expect(r.files).toEqual([]);
    expect(delivered).toEqual([50, 50, 20]);
    expect(names).toHaveLength(4 * PER);
    expect(new Set(names).size).toBe(PER);
    expect(Math.max(...heldAtRead)).toBeLessThan(50);
  });

  it('without onChunk every image comes back at once, as before', async () => {
    const zip = zipOf(Array.from({ length: 60 }, (_, k) => ({ name: `D${k}.adf`, bytes: new Uint8Array([k]) })));
    const r = await diskFilesFromDrop([{ name: 'z.zip', kind: 'file', file: new File([zip as unknown as BlobPart], 'z.zip') }], undefined, 50);
    expect(r.files).toHaveLength(60);
  });
});
