import { describe, it, expect } from 'vitest';
import { readDms } from './dms';

/**
 * These tests build DMS archives rather than ship them, so the container
 * rules -- the checksums, the track ordering, the metadata tracks that are not
 * disk -- are pinned without a megabyte of binary fixtures in the repo.
 *
 * What they deliberately do NOT try to prove is that the five decompressors
 * are correct. That cannot be settled by a fixture written by the same hands
 * as the decoder; it is settled in scripts/dms-verify.ts, which compares this
 * implementation against xDMS itself -- the code it was ported from -- over
 * real archives and over every mode, including the four that no real archive
 * uses. See that file for what is and is not covered.
 */

const CRC = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return (b: Uint8Array, from: number, len: number) => {
    let crc = 0;
    for (let i = from; i < from + len; i++) crc = (t[(crc ^ b[i]) & 0xff] ^ ((crc >>> 8) & 0xff)) & 0xffff;
    return crc;
  };
})();

const sum16 = (b: Uint8Array) => b.reduce((a, x) => (a + x) & 0xffff, 0);
function be16(b: Uint8Array, at: number, v: number) { b[at] = (v >> 8) & 0xff; b[at + 1] = v & 0xff; }

interface TrackSpec { number: number; data: Uint8Array; cmode?: number; packed?: Uint8Array; flags?: number }

/** Assemble a DMS whose checksums are all correct, so a test that expects a
 *  rejection is rejecting for the reason it names and not for a stale CRC. */
function buildDms(tracks: TrackSpec[], opts: { from?: number; to?: number; geninfo?: number } = {}): Uint8Array {
  const head = new Uint8Array(56);
  head.set([0x44, 0x4d, 0x53, 0x21]);
  be16(head, 10, opts.geninfo ?? 0);
  be16(head, 16, opts.from ?? 0);
  be16(head, 18, opts.to ?? 79);
  be16(head, 54, CRC(head, 4, 56 - 6));

  const parts: Uint8Array[] = [head];
  for (const t of tracks) {
    const packed = t.packed ?? t.data;
    const th = new Uint8Array(20);
    th.set([0x54, 0x52]);
    be16(th, 2, t.number);
    be16(th, 6, packed.length);
    be16(th, 8, packed.length);
    be16(th, 10, t.data.length);
    th[12] = t.flags ?? 1;          // bit 0 set: keep decoder state between tracks
    th[13] = t.cmode ?? 0;
    be16(th, 14, sum16(t.data));
    be16(th, 16, CRC(packed, 0, packed.length));
    be16(th, 18, CRC(th, 0, 18));
    parts.push(th, packed);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A full 80-cylinder disk, each cylinder 11264 bytes, stored uncompressed. */
function wholeDisk(fill: (cyl: number) => Uint8Array): TrackSpec[] {
  return Array.from({ length: 80 }, (_, i) => ({ number: i, data: fill(i) }));
}

const cylOf = (n: number) => { const b = new Uint8Array(11264); b.fill(n & 0xff); return b; };

describe('readDms', () => {
  it('decodes an uncompressed disk to exactly 901,120 bytes', () => {
    const r = readDms(buildDms(wholeDisk(cylOf)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adf.length).toBe(901120);
    // Cylinder N must land at N * 11264 -- placement, not just total size.
    expect(r.adf[0]).toBe(0);
    expect(r.adf[11264]).toBe(1);
    expect(r.adf[79 * 11264]).toBe(79);
    expect(r.info.tracks).toBe(80);
  });

  it('rejects a file that is not a DMS archive', () => {
    const r = readDms(new Uint8Array(200));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a DMS/);
  });

  it('rejects a damaged header rather than decoding it anyway', () => {
    const d = buildDms(wholeDisk(cylOf));
    d[20] ^= 0xff;                      // inside the header CRC's range
    const r = readDms(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/header checksum/);
  });

  it('catches a corrupted track body through the format\'s own CRC', () => {
    const d = buildDms(wholeDisk(cylOf));
    d[56 + 20 + 100] ^= 0xff;
    const r = readDms(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/data checksum/);
  });

  it('refuses a password-protected archive instead of producing noise', () => {
    // Without the password every track decodes to garbage that is still
    // 901,120 bytes -- indistinguishable from a disk by size alone, which is
    // exactly why this has to be refused up front.
    const r = readDms(buildDms(wholeDisk(cylOf), { geninfo: 0x02 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/password/);
  });

  it('refuses tracks that arrive out of order', () => {
    // The image is assembled in file order, as xDMS does. Out-of-order tracks
    // would silently land at the wrong offset, giving a disk that mounts and
    // is wrong -- worse than a refusal.
    const t = wholeDisk(cylOf);
    [t[3], t[4]] = [t[4], t[3]];
    const r = readDms(buildDms(t));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/out of order/);
  });

  it('refuses a disk that is not a standard DD image', () => {
    const r = readDms(buildDms(wholeDisk(cylOf).slice(0, 40)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a standard/);
  });

  it('decodes RLE tracks, and treats 0x90 0x00 as a literal 0x90', () => {
    // The escape byte is itself data when followed by a zero count; a decoder
    // that misses this corrupts every disk containing a 0x90 byte.
    const data = new Uint8Array(11264);
    data.fill(0xaa, 0, 4000);
    data.fill(0x90, 4000, 4001);
    data.fill(0x55, 4001);
    const packed: number[] = [];
    packed.push(0x90, 0xff, 0xaa, 0x0f, 0xa0);        // 4000 x 0xAA
    packed.push(0x90, 0x00);                          // a literal 0x90
    const rest = 11264 - 4001;
    packed.push(0x90, 0xff, 0x55, (rest >> 8) & 0xff, rest & 0xff);
    const tracks = wholeDisk(cylOf);
    tracks[0] = { number: 0, data, cmode: 1, packed: new Uint8Array(packed) };
    const r = readDms(buildDms(tracks));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adf[0]).toBe(0xaa);
    expect(r.adf[4000]).toBe(0x90);
    expect(r.adf[4001]).toBe(0x55);
    expect(r.info.modes).toContain('SIMPLE');
  });

  it('keeps FILE_ID.DIZ out of the disk image', () => {
    // Track 80 is metadata. Appending it would push the image past 901,120
    // bytes and shift nothing -- but it would also make the disk wrong, so
    // the size check alone is not what this is testing.
    const tracks = wholeDisk(cylOf);
    const diz = new TextEncoder().encode('A demo disk\r\n');
    tracks.push({ number: 80, data: diz, cmode: 0 });
    const r = readDms(buildDms(tracks));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.adf.length).toBe(901120);
    expect(r.info.fileId).toBe('A demo disk');
  });

  it('never throws, whatever it is handed', () => {
    // This runs in a browser on a file a person dropped in. A thrown
    // exception is a dead UI, so the contract is "always a result".
    const seeds = [0, 1, 7, 99, 12345];
    for (const s of seeds) {
      const b = new Uint8Array(4096);
      let x = s + 1;
      for (let i = 0; i < b.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >>> 16; }
      b.set([0x44, 0x4d, 0x53, 0x21]);
      expect(() => readDms(b)).not.toThrow();
    }
  });
});
