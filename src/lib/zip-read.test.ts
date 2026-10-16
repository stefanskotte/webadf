import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listZip, readZipEntry } from './zip-read';
import { makeZip } from './__fixtures__/make-zip';

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
