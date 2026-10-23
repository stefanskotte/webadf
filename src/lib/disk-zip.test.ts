import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8, Unzip, UnzipInflate } from 'fflate';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { readVolume } from '@/lib/adffs';
import { addFile, makeDirectory } from '@/lib/adffs/write';
import { zipEntries } from './disk-zip';

const ok = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error('write'); return r as Extract<T, { ok: true }>; };
const txt = (s: string) => new TextEncoder().encode(s);
const unzip = (r: ReturnType<typeof zipEntries>) => { if (!r.ok) throw new Error(r.reason); return r.zip; };

/** Name -> text, read entry by entry: unzipSync collects into a plain object, which loses a `__proto__` entry itself. */
function entries(zip: Uint8Array): [string, string][] {
  const out: [string, string][] = [];
  const reader = new Unzip((file) => {
    let text = '';
    file.ondata = (err, data, final) => { if (err) throw err; text += strFromU8(data); if (final) out.push([file.name, text]); };
    file.start();
  });
  reader.register(UnzipInflate);
  reader.push(zip, true);
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}

function disk() {
  let adf = syntheticVolume({ filesystem: 'FFS', volumeName: 'Zip' });
  adf = ok(makeDirectory(adf, 880, 'S')).adf;
  adf = ok(addFile(adf, 880, 'a.txt', txt('alpha'))).adf;
  let v = readVolume(adf); if (!v.ok) throw new Error();
  const s = v.root.find((e) => e.name === 'S')!.block;
  adf = ok(addFile(adf, s, 'Startup-Sequence', txt('echo hi'))).adf;
  adf = ok(makeDirectory(adf, s, 'Empty')).adf;
  adf = ok(addFile(adf, s, 'a.txt', txt('inner'))).adf;
  v = readVolume(adf); if (!v.ok) throw new Error();
  return { adf, root: v.root };
}

describe('zipEntries', () => {
  it('zips files and whole folders, keeping the folder paths', () => {
    const { adf, root } = disk();
    const blocks = root.map((e) => e.block);
    const out = unzipSync(unzip(zipEntries(adf, root, blocks)));
    expect(Object.keys(out).sort()).toEqual(['S/', 'S/Empty/', 'S/Startup-Sequence', 'S/a.txt', 'a.txt']);
    expect(strFromU8(out['S/Startup-Sequence'])).toBe('echo hi');
    expect(strFromU8(out['a.txt'])).toBe('alpha');
  });

  it('a file inside a selected folder is not zipped twice', () => {
    const { adf, root } = disk();
    const s = root.find((e) => e.name === 'S')!;
    const inner = s.children.find((e) => e.name === 'a.txt')!;
    const out = unzipSync(unzip(zipEntries(adf, root, [s.block, inner.block])));
    expect(Object.keys(out).filter((k) => k.endsWith('a.txt'))).toEqual(['S/a.txt']);
  });

  it('two selected files with one name from different folders both arrive', () => {
    const { adf, root } = disk();
    const outer = root.find((e) => e.name === 'a.txt')!;
    const inner = root.find((e) => e.name === 'S')!.children.find((e) => e.name === 'a.txt')!;
    const out = unzipSync(unzip(zipEntries(adf, root, [outer.block, inner.block])));
    expect(Object.keys(out).sort()).toEqual(['a (2).txt', 'a.txt']);
    expect(strFromU8(out['a (2).txt'])).toBe('inner');
  });

  it('answers not_found for a block that is not on the disk', () => {
    const { adf, root } = disk();
    expect(zipEntries(adf, root, [4321])).toEqual({ ok: false, reason: 'not_found' });
  });

  it('names that are object keys or path steps, and names differing only in case, all arrive', () => {
    let adf = syntheticVolume({ filesystem: 'FFS', volumeName: 'Odd' });
    for (const n of ['__proto__', 'toString', 'A.txt']) adf = ok(addFile(adf, 880, n, txt(n))).adf;
    adf = ok(makeDirectory(adf, 880, '..')).adf;
    adf = ok(makeDirectory(adf, 880, 'S')).adf;
    let v = readVolume(adf); if (!v.ok) throw new Error();
    adf = ok(addFile(adf, v.root.find((e) => e.name === '..')!.block, 'x', txt('x'))).adf;
    adf = ok(addFile(adf, v.root.find((e) => e.name === 'S')!.block, 'a.txt', txt('lower'))).adf;
    v = readVolume(adf); if (!v.ok) throw new Error();
    const s = v.root.find((e) => e.name === 'S')!;
    const blocks = [...v.root.filter((e) => e.name !== 'S').map((e) => e.block), s.children[0].block];
    expect(entries(unzip(zipEntries(adf, v.root, blocks)))).toEqual([
      ['A.txt', 'A.txt'], ['_../', ''], ['_../x', 'x'], ['__proto__', '__proto__'], ['a (2).txt', 'lower'], ['toString', 'toString'],
    ]);
  });
});
