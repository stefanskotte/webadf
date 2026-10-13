import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAdf, adfName, gzipHoldsDms, DISK_IMAGE_PATTERN, MAX_COMPRESSED_IMAGE_BYTES } from './disk-image';
import { readDms } from './dms';

const fx = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', n)));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The disk inside fixtures/disk.dmz (an uncompressed-mode DMS, gzipped) and,
 *  gzipped bare, fixtures/not-dms.dmz. */
const fixtureAdf = () => {
  const b = new Uint8Array(901120);
  b.set([0x44, 0x4f, 0x53, 0]);
  for (let i = 0; i < 4096; i++) b[1024 + i] = i & 0xff;
  return b;
};

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
    for (const n of ['a.adf', 'a.ADF', 'a.dsk', 'a.adz', 'a.dms', 'a.DMS', 'a.dmz', 'a.DMZ']) {
      expect(DISK_IMAGE_PATTERN.test(n)).toBe(true);
    }
    for (const n of ['a.lha', 'a.zip', 'a.adf.txt', 'adf']) {
      expect(DISK_IMAGE_PATTERN.test(n)).toBe(false);
    }
  });

  it('renames only the compressed extensions', () => {
    expect(adfName('Disk 1.dms')).toBe('Disk 1.adf');
    expect(adfName('Disk 1.adz')).toBe('Disk 1.adf');
    expect(adfName('Disk 1.dmz')).toBe('Disk 1.adf');
    expect(adfName('Disk 1.adf')).toBe('Disk 1.adf');
    // A name that merely contains "dms" must not be mangled.
    expect(adfName('dms-collection.adf')).toBe('dms-collection.adf');
  });
});

describe('toAdf on a .dmz (a gzipped DMS)', () => {
  it('gunzips it and decodes the DMS inside to the ADF', async () => {
    const r = await toAdf('Game (Disk 1).dmz', fx('disk.dmz'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe('Game (Disk 1).adf');
    expect(r.from).toBe('dmz');
    expect(r.note).toBe('NOCOMP');
    // Same identity as the .adf of the same disk.
    expect(sha(r.bytes)).toBe(sha(fixtureAdf()));
  });

  it('refuses a .dmz that is gzipped but holds no DMS, without storing anything', async () => {
    const r = await toAdf('fake.dmz', fx('not-dms.dmz'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^fake\.dmz: not a DMS archive/);
  });

  it('refuses a .dmz that is not gzipped at all', async () => {
    const r = await toAdf('broken.dmz', new Uint8Array([1, 2, 3, 4, 5]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a valid gzipped DMS/);
  });

  it('refuses a gzip bomb by size, before inflating it whole', async () => {
    // 64 MiB of zeros gzips to ~64 KB; the output cap is the .dms input cap.
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
    const r = await toAdf('bomb.dmz', bomb);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bomb.dmz expands to more than 4 MB; the limit is 4 MB');
  });

  it('refuses a .dmz too large to expand, like any other compressed image', async () => {
    const r = await toAdf('huge.dmz', new Uint8Array(MAX_COMPRESSED_IMAGE_BYTES + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too large/);
  });

  // A real DMS from the operator's archive (gitignored, absent in CI): its
  // gzipped form must decode to exactly what the .dms decodes to.
  const real = join(process.cwd(), 'adf-archive', 'powerglove.dms');
  it.skipIf(!existsSync(real))('decodes a real archive .dms the same gzipped as bare', async () => {
    const dms = new Uint8Array(readFileSync(real));
    const bare = readDms(dms);
    expect(bare.ok).toBe(true);
    const r = await toAdf('powerglove.dmz', new Uint8Array(gzipSync(dms)));
    expect(r.ok).toBe(true);
    if (!r.ok || !bare.ok) return;
    expect(sha(r.bytes)).toBe(sha(bare.adf));
  });
});

describe('toAdf on an .adz bomb', () => {
  it('names the size limit rather than calling it invalid', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
    const r = await toAdf('bomb.adz', bomb);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bomb.adz expands to more than 2.5 MB; the limit is 2.5 MB');
  });
});

describe('gzipHoldsDms', () => {
  it('tells a gzipped DMS from a gzipped ADF by the first bytes', async () => {
    expect(await gzipHoldsDms(fx('disk.dmz'))).toBe(true);
    expect(await gzipHoldsDms(fx('not-dms.dmz'))).toBe(false);
    expect(await gzipHoldsDms(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
