import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripJpeg, stripPng, stripWebp, stripImageMetadata } from './cover-strip';
import { sniffImage } from './cover-image';

const fx = (n: string) => new Uint8Array(readFileSync(join(__dirname, '__fixtures__/cover', n)));
const seg = (marker: number, payload: number[]) =>
  [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Exif APP1 payload with GPS-ish bytes and, optionally, Orientation. */
function exif(orientation: number | null, little = false) {
  const w16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const w32 = (v: number) => (little ? [v & 255, (v >> 8) & 255, 0, 0] : [0, 0, v >> 8, v & 255]);
  const entries: number[][] = [];
  if (orientation !== null) entries.push([...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0]);
  entries.push([...w16(0x8825), ...w16(4), ...w32(1), ...w32(0x40)]); // GPS IFD pointer
  return [...text('Exif'), 0, 0, ...(little ? [0x49, 0x49, 0x2a, 0] : [0x4d, 0x4d, 0, 0x2a]), ...(little ? [8, 0, 0, 0] : [0, 0, 0, 8]),
    ...w16(entries.length), ...entries.flat(), 0, 0, 0, 0, ...text('GPSLATITUDE-55.6761N')];
}

/** Walk the segments; throws if the structure is not SOI ... SOS ... EOI. */
function markers(b: Uint8Array): number[] {
  expect([b[0], b[1]]).toEqual([0xff, 0xd8]);
  expect([b[b.length - 2], b[b.length - 1]]).toEqual([0xff, 0xd9]);
  const out: number[] = [];
  let i = 2;
  for (;;) {
    expect(b[i]).toBe(0xff);
    const m = b[i + 1];
    out.push(m);
    if (m === 0xda) return out;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
}

const contains = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s));
const jpeg = (...segs: number[][]) => Uint8Array.from([
  0xff, 0xd8, ...segs.flat(), ...seg(0xc0, [8, 0, 20, 0, 20, 1, 1, 0x11, 0]), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
  0x12, 0x34, 0xff, 0xd9,
]);

describe('stripJpeg', () => {
  it('removes GPS Exif and XMP and Photoshop, keeps JFIF, ICC and Adobe, and still parses', () => {
    const src = jpeg(
      seg(0xe0, text('JFIF').concat([0, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
      seg(0xe1, exif(null)),
      seg(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')),
      seg(0xe2, text('ICC_PROFILE\0').concat([1, 1, 9, 9])),
      seg(0xed, text('Photoshop 3.0\0IPTC')),
      seg(0xee, text('Adobe').concat([0, 100, 0, 0, 0, 0, 1])),
    );
    expect(contains(src, 'GPSLATITUDE')).toBe(true);
    const out = stripJpeg(src);
    expect(contains(out, 'GPSLATITUDE')).toBe(false);
    expect(contains(out, 'xmpmeta')).toBe(false);
    expect(contains(out, 'IPTC')).toBe(false);
    expect(markers(out)).toEqual([0xe0, 0xe2, 0xee, 0xc0, 0xda]);
    expect(sniffImage(out)).toEqual({ type: 'image/jpeg', width: 20, height: 20 });
    // The scan data is untouched.
    expect(Buffer.from(out).subarray(-6).toString('hex')).toBe(Buffer.from(src).subarray(-6).toString('hex'));
  });

  it.each([[6, false], [8, true], [3, false]])('keeps Orientation %i (little-endian: %s) and nothing else', (o, little) => {
    const out = stripJpeg(jpeg(seg(0xe0, text('JFIF').concat([0, 1, 1, 0, 0, 1, 0, 1, 0, 0])), seg(0xe1, exif(o, little))));
    expect(contains(out, 'GPSLATITUDE')).toBe(false);
    expect(markers(out)).toEqual([0xe0, 0xe1, 0xc0, 0xda]);
    const i = Buffer.from(out).indexOf(Buffer.from('Exif'));
    // minimal segment: orientation value sits at a fixed place
    const e = out.subarray(i - 4, i - 4 + 36);
    expect(e[2] << 8 | e[3]).toBe(0x22);
    expect(e[28]).toBe(0);
    expect(e[29]).toBe(o);
    expect(e.length).toBe(36 - 0);
    expect(e[3]).toBe(0x22);
    expect(sniffImage(out)).toEqual({ type: 'image/jpeg', width: 20, height: 20 });
  });

  it('is idempotent: the written-back Orientation parses as Orientation', () => {
    const once = stripJpeg(jpeg(seg(0xe1, exif(6))));
    expect(Buffer.from(stripJpeg(once)).equals(Buffer.from(once))).toBe(true);
  });

  it('writes no Orientation segment when it was 1 or absent', () => {
    expect(markers(stripJpeg(jpeg(seg(0xe1, exif(1)))))).toEqual([0xc0, 0xda]);
    expect(markers(stripJpeg(jpeg(seg(0xe1, exif(null)))))).toEqual([0xc0, 0xda]);
  });

  it('strips a real encoder file and it still sniffs the same', () => {
    const out = stripJpeg(fx('cover.jpg'));
    expect(sniffImage(out)).toEqual({ type: 'image/jpeg', width: 40, height: 50 });
  });

  it('returns malformed input unchanged, without crashing or looping', () => {
    const cases = [
      Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00),          // length past the end
      Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0x00, 0x00),    // length 0
      Uint8Array.of(0xff, 0xd8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),    // fill bytes forever
      Uint8Array.of(0xff, 0xd8, 0x00, 0x00, 0x00),                      // not a marker
      Uint8Array.of(0xff, 0xd8),
      new Uint8Array(0),
    ];
    for (const c of cases) expect(stripJpeg(c)).toBe(c);
  });
});

function chunk(type: string, data: number[]) {
  return [0, 0, 0, data.length, ...text(type), ...data, 1, 2, 3, 4]; // CRC not checked here
}
describe('stripPng', () => {
  it('drops tEXt, zTXt, iTXt and eXIf, keeps the rest', () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const src = Uint8Array.from([
      ...sig, ...chunk('IHDR', new Array(13).fill(0)), ...chunk('tEXt', text('Comment\0secret-gps')),
      ...chunk('eXIf', text('MM')), ...chunk('iCCP', [1]), ...chunk('zTXt', [1]), ...chunk('iTXt', [1]),
      ...chunk('IDAT', [9]), ...chunk('IEND', []),
    ]);
    const out = stripPng(src);
    expect(contains(out, 'secret-gps')).toBe(false);
    for (const t of ['tEXt', 'zTXt', 'iTXt', 'eXIf']) expect(contains(out, t)).toBe(false);
    for (const t of ['IHDR', 'iCCP', 'IDAT', 'IEND']) expect(contains(out, t)).toBe(true);
  });
  it('real PNG is unchanged; malformed does not crash', () => {
    const p = fx('cover.png');
    expect(sniffImage(stripPng(p))).toEqual({ type: 'image/png', width: 40, height: 50 });
    const bad = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xff, 0xff, 0x74, 0x45, 0x58, 0x74, 0, 0, 0, 0]);
    expect(stripPng(bad)).toBe(bad);
  });
});

describe('stripWebp', () => {
  it('drops EXIF and XMP, clears the flags, fixes the RIFF size', () => {
    const c = (t: string, d: number[]) => [...text(t), d.length & 255, 0, 0, 0, ...d, ...(d.length & 1 ? [0] : [])];
    const body = [...text('WEBP'), ...c('VP8X', [0x2c, 0, 0, 0, 15, 0, 0, 15, 0, 0]), ...c('VP8L', [1, 2, 3]),
      ...c('EXIF', text('GPSSECRET')), ...c('XMP ', text('xmp!'))];
    const src = Uint8Array.from([...text('RIFF'), body.length & 255, body.length >> 8, 0, 0, ...body]);
    const out = stripWebp(src);
    expect(contains(out, 'GPSSECRET')).toBe(false);
    expect(contains(out, 'XMP ')).toBe(false);
    expect(out[20] & 0x0c).toBe(0);
    expect(out[20] & 0x20).toBe(0x20); // ICC flag untouched
    expect(out[4] | (out[5] << 8)).toBe(out.length - 8);
    expect(stripWebp(fx('cover-vp8x.webp'))).toBeInstanceOf(Uint8Array);
    const bad = Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WEBP'), ...text('EXIF'), 0xff, 0xff, 0xff, 0x7f]);
    expect(stripWebp(bad)).toBe(bad);
  });
});

describe('stripImageMetadata', () => {
  it('leaves a GIF alone and dispatches by magic', () => {
    const g = fx('cover.gif');
    expect(stripImageMetadata(g)).toBe(g);
    expect(sniffImage(stripImageMetadata(fx('cover.jpg')))?.type).toBe('image/jpeg');
  });
});
