import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeZip } from '@/lib/__fixtures__/make-zip';
import { MAX_ARCHIVE_MEMBERS } from '@/lib/archive';
import { MEMBER_DEPTH_MAX, memberPath, openArchive } from './stash-archive';

const tzip = new Uint8Array(readFileSync('src/lib/archive/fixtures/t.zip'));

/** A zip whose every member is marked encrypted (central-directory flag bit 0). */
function encrypted(zip: Buffer): Uint8Array {
  const out = new Uint8Array(zip);
  const v = new DataView(out.buffer);
  const eocd = out.length - 22;
  let cen = v.getUint32(eocd + 16, true);
  for (let i = 0; i < v.getUint16(eocd + 10, true); i++) {
    v.setUint16(cen + 8, v.getUint16(cen + 8, true) | 1, true);
    cen += 46 + v.getUint16(cen + 28, true) + v.getUint16(cen + 30, true) + v.getUint16(cen + 32, true);
  }
  return out;
}

/** A level-0 LHA of stored (-lh0-) members, enough for the member cap. */
function makeLha(names: string[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const n of names) {
    const name = Buffer.from(n);
    const h = Buffer.alloc(24 + name.length);
    h[0] = 22 + name.length; h.write('-lh0-', 2, 'latin1');
    h[20] = 0; h[21] = name.length; name.copy(h, 22);
    parts.push(h);
  }
  return new Uint8Array(Buffer.concat([...parts, Buffer.from([0])]));
}

describe('openArchive', () => {
  it('refuses an archive of more than MAX_ARCHIVE_MEMBERS members whole, fast; at the cap it opens', async () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `d${i % 7}/m${i}.txt`);
    const t0 = performance.now();
    expect(await openArchive('many.zip', new Uint8Array(makeZip(names(MAX_ARCHIVE_MEMBERS + 1).map((name) => ({ name, data: Buffer.alloc(0) })))))).toBeNull();
    expect(await openArchive('many.lha', makeLha(names(MAX_ARCHIVE_MEMBERS + 1)))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect((await openArchive('cap.zip', new Uint8Array(makeZip(names(MAX_ARCHIVE_MEMBERS).map((name) => ({ name, data: Buffer.alloc(0) }))))))!.files)
      .toHaveLength(MAX_ARCHIVE_MEMBERS);
    expect((await openArchive('cap.lha', makeLha(names(MAX_ARCHIVE_MEMBERS))))!.files).toHaveLength(MAX_ARCHIVE_MEMBERS);
  });
  it('opens a zip as files with paths split into names and the dates it records', async () => {
    const a = (await openArchive('t.zip', tzip))!;
    expect(a.files.map((f) => f.path.join('/')).sort()).toEqual(['src/noise.bin', 'src/readme.txt', 'src/sub/deep.txt', 'src/tiny.txt']);
    expect(a.files.find((f) => f.path.at(-1) === 'readme.txt')!.date?.toISOString()).toBe('2026-09-11T14:47:48.000Z');
    expect(a.unreadable).toEqual([]);
  });
  it('opens an lha', async () => {
    const a = (await openArchive('h1.lha', new Uint8Array(readFileSync('src/lib/archive/fixtures/h1.lha'))))!;
    expect(a.files.length).toBeGreaterThan(0);
  });
  it('is null for a name that is not an archive, junk, an empty zip, or over MAX_ARCHIVE_BYTES', async () => {
    expect(await openArchive('t.txt', tzip)).toBeNull();
    expect(await openArchive('x.lha', new TextEncoder().encode('not an lha at all'))).toBeNull();
    expect(await openArchive('x.zip', new TextEncoder().encode('not a zip'))).toBeNull();
    expect(await openArchive('e.zip', new Uint8Array(makeZip([])))).toBeNull();
    expect(await openArchive('big.zip', new Uint8Array(25 * 1024 * 1024 + 1))).toBeNull();
  });
  it('is null when any member is over the caps (ruling 5): never a short list', async () => {
    const z = makeZip([{ name: 'a.txt', data: Buffer.from('a') }, { name: 'huge.bin', data: Buffer.alloc(5 * 1024 * 1024), deflate: true }]);
    expect(await openArchive('z.zip', new Uint8Array(z))).toBeNull();
    // A read of the small member alone does not inflate the big one.
    const one = (await openArchive('z.zip', new Uint8Array(z), (p) => p === 'a.txt'))!;
    expect(one.files.map((f) => f.path)).toEqual([['a.txt']]);
  });
  it('accept inflates only the members asked for', async () => {
    const a = (await openArchive('t.zip', tzip, (p) => p.startsWith('src/sub/')))!;
    expect(a.files.map((f) => f.path.join('/'))).toEqual(['src/sub/deep.txt']);
    // Nothing accepted is an empty archive view, not an unreadable archive.
    expect(await openArchive('t.zip', tzip, () => false)).toEqual({ files: [], unreadable: [] });
  });
  it('a member it cannot decode for another reason is named, not dropped', async () => {
    const z = encrypted(makeZip([{ name: 'd/secret.txt', data: Buffer.from('s') }]));
    expect(await openArchive('z.zip', z)).toBeNull();   // nothing readable at all
    const mixed = makeZip([{ name: 'ok.txt', data: Buffer.from('ok') }, { name: 'secret.txt', data: Buffer.from('s') }]);
    const v = new DataView(mixed.buffer, mixed.byteOffset);
    // Mark only the second central record encrypted.
    let cen = v.getUint32(mixed.length - 22 + 16, true);
    cen += 46 + v.getUint16(cen + 28, true);
    v.setUint16(cen + 8, 1, true);
    const a = (await openArchive('m.zip', new Uint8Array(mixed)))!;
    expect(a.files.map((f) => f.path)).toEqual([['ok.txt']]);
    expect(a.unreadable).toEqual([{ path: ['secret.txt'], reason: 'encrypted' }]);
  });
  it("memberPath drops '.', and makes a name no STASH: path carries bad, shown by its last name made safe", () => {
    expect(memberPath('./a/./b.txt')).toEqual({ path: ['a', 'b.txt'], bad: false });
    expect(memberPath('../b.txt')).toEqual({ path: ['b.txt'], bad: true });
    expect(memberPath('x/..')).toEqual({ path: ['_'], bad: true });
    expect(memberPath('d/c\u0001.txt')).toEqual({ path: ['c_.txt'], bad: true });
    expect(memberPath('x'.repeat(256))).toEqual({ path: ['x'.repeat(255)], bad: true });
    expect(memberPath(Array(MEMBER_DEPTH_MAX + 1).fill('d').join('/')).bad).toBe(true);
    expect(memberPath(Array(MEMBER_DEPTH_MAX).fill('d').join('/')).bad).toBe(false);
  });
});
