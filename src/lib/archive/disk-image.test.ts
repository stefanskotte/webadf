import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { toAdf, adfName, DISK_IMAGE_PATTERN, MAX_COMPRESSED_IMAGE_BYTES } from './disk-image';

const adf = () => {
  const b = new Uint8Array(901120);
  b.set(new TextEncoder().encode('DOS\0'));
  b[1000] = 0x42;
  return b;
};

describe('toAdf', () => {
  it('passes an .adf through untouched, byte for byte', async () => {
    const src = adf();
    const r = await toAdf('Lemmings.adf', src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes).toBe(src);      // the same object: no copy, no re-encode
    expect(r.name).toBe('Lemmings.adf');
  });

  it('expands a .adz, which is just a gzipped ADF', async () => {
    const src = adf();
    const r = await toAdf('Lemmings.adz', new Uint8Array(gzipSync(Buffer.from(src))));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.length).toBe(901120);
    expect(r.bytes[1000]).toBe(0x42);
    // The name must become .adf: TOSEC identity is matched on the stem, and
    // the stored blob is an ADF whatever it arrived as.
    expect(r.name).toBe('Lemmings.adf');
    expect(r.from).toBe('adz');
  });

  it('reports a .adz that is not actually gzipped', async () => {
    const r = await toAdf('broken.adz', new Uint8Array([1, 2, 3, 4, 5]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a valid gzipped ADF/);
  });

  it('reports a .dms it cannot read instead of storing the raw bytes', async () => {
    // The behaviour this replaces: the file uploaded fine, appeared in the
    // library, and could never be mounted -- with nothing said about why.
    const r = await toAdf('broken.dms', new Uint8Array(600));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a DMS archive/);
  });

  it('refuses a compressed file too large to expand in a tab', async () => {
    const r = await toAdf('huge.adz', new Uint8Array(MAX_COMPRESSED_IMAGE_BYTES + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/);
  });

  it('accepts exactly the extensions the drop target advertises', () => {
    for (const n of ['a.adf', 'a.ADF', 'a.dsk', 'a.adz', 'a.dms', 'a.DMS']) {
      expect(DISK_IMAGE_PATTERN.test(n)).toBe(true);
    }
    for (const n of ['a.lha', 'a.zip', 'a.adf.txt', 'adf']) {
      expect(DISK_IMAGE_PATTERN.test(n)).toBe(false);
    }
  });

  it('renames only the compressed extensions', () => {
    expect(adfName('Disk 1.dms')).toBe('Disk 1.adf');
    expect(adfName('Disk 1.adz')).toBe('Disk 1.adf');
    expect(adfName('Disk 1.adf')).toBe('Disk 1.adf');
    // A name that merely contains "dms" must not be mangled.
    expect(adfName('dms-collection.adf')).toBe('dms-collection.adf');
  });
});
