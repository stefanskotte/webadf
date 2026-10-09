import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkCoverImage, sniffImage, effectiveCoverUrl, coverOverrideUrl, isCoverDigest,
  MAX_COVER_BYTES,
} from './cover-image';

// Real files, made by ImageMagick 7 and cwebp (libwebp) on 2026-10-09 -- not
// hand-built headers, so the sniffers are checked against what encoders really
// write (a JPEG's APP segments before its frame, the three WebP chunk kinds).
// All are 40x50 except wide.png (5000x20).
const fx = (name: string) => new Uint8Array(readFileSync(join(__dirname, '__fixtures__/cover', name)));

describe('sniffImage reads the type and size from the bytes themselves', () => {
  it.each([
    ['cover.png', 'image/png'],
    ['cover.jpg', 'image/jpeg'],
    ['cover-progressive.jpg', 'image/jpeg'],
    ['cover.gif', 'image/gif'],
    ['cover-lossy.webp', 'image/webp'],
    ['cover-lossless.webp', 'image/webp'],
    ['cover-vp8x.webp', 'image/webp'],
  ])('%s is %s, 40x50', (name, type) => {
    expect(sniffImage(fx(name))).toEqual({ type, width: 40, height: 50 });
  });

  it('refuses an SVG, even though browsers call it an image', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffImage(svg)).toBeNull();
  });

  it('refuses HTML dressed as a PNG (the name and the MIME type are never consulted)', () => {
    expect(sniffImage(new TextEncoder().encode('<!doctype html><title>x</title>'))).toBeNull();
  });

  it('refuses a truncated PNG signature and a PNG whose first chunk is not IHDR', () => {
    const png = fx('cover.png');
    expect(sniffImage(png.slice(0, 7))).toBeNull();
    const bad = png.slice();
    bad[12] = 0x58; // 'X' instead of 'I'
    expect(sniffImage(bad)).toBeNull();
  });

  it('refuses a JPEG that ends before any frame header', () => {
    expect(sniffImage(fx('cover.jpg').slice(0, 20))).toBeNull();
  });

  it('refuses a RIFF that is not WebP (a WAV file)', () => {
    const wav = fx('cover-lossy.webp').slice();
    wav.set(new TextEncoder().encode('WAVE'), 8);
    expect(sniffImage(wav)).toBeNull();
  });
});

describe('checkCoverImage', () => {
  it('accepts a real image and says what it is', () => {
    const r = checkCoverImage(fx('cover.png'));
    expect(r).toEqual({ ok: true, image: { type: 'image/png', width: 40, height: 50 } });
  });

  it('refuses an empty file', () => {
    expect(checkCoverImage(new Uint8Array())).toMatchObject({ ok: false, error: 'empty' });
  });

  it('refuses anything over 2 MB before looking inside it', () => {
    const big = new Uint8Array(MAX_COVER_BYTES + 1);
    big.set(fx('cover.png'));
    expect(checkCoverImage(big)).toMatchObject({ ok: false, error: 'too_large' });
  });

  it('accepts exactly 2 MB', () => {
    const edge = new Uint8Array(MAX_COVER_BYTES);
    edge.set(fx('cover.png'));
    expect(checkCoverImage(edge).ok).toBe(true);
  });

  it('refuses bytes that are not one of the four types', () => {
    expect(checkCoverImage(new Uint8Array([1, 2, 3, 4, 5]))).toMatchObject({ ok: false, error: 'not_an_image' });
  });

  it('refuses an image wider than 4096 pixels', () => {
    const r = checkCoverImage(fx('wide.png'));
    expect(r).toMatchObject({ ok: false, error: 'bad_dimensions' });
    if (!r.ok) expect(r.detail).toMatch(/5000x20/);
  });

  it('refuses a header that claims a zero-pixel image', () => {
    const png = fx('cover.png').slice();
    png.set([0, 0, 0, 0], 16);
    expect(checkCoverImage(png)).toMatchObject({ ok: false, error: 'bad_dimensions' });
  });
});

describe('cover precedence: override > enriched > placeholder', () => {
  const sha = 'a'.repeat(64);
  it('an override wins over an enriched cover', () => {
    expect(effectiveCoverUrl('g1', sha, '/api/images/' + 'b'.repeat(40))).toBe(`/api/games/g1/cover/${sha}`);
  });
  it('without an override the enriched cover is used', () => {
    expect(effectiveCoverUrl('g1', null, '/api/images/x')).toBe('/api/images/x');
  });
  it('with neither there is no URL (the caller draws the placeholder)', () => {
    expect(effectiveCoverUrl('g1', null, undefined)).toBeNull();
    expect(effectiveCoverUrl('g1', undefined, null)).toBeNull();
  });
  it('the override URL carries the digest, so a new image is a new URL', () => {
    expect(coverOverrideUrl('g 1', sha)).toBe(`/api/games/g%201/cover/${sha}`);
    expect(isCoverDigest(sha)).toBe(true);
    expect(isCoverDigest('A'.repeat(64))).toBe(false);
    expect(isCoverDigest('a'.repeat(40))).toBe(false);
  });
});
