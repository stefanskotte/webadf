// A title's own cover image: what an upload must be, and which image wins.
//
// Pure on purpose -- no database, no store -- so every rule a person's upload
// meets is a unit test, not a guess about what a route did.

/** 2 MiB. A 400x500 box-art scan is ~150 KB; this leaves room for a photo of a real box. */
export const MAX_COVER_BYTES = 2 * 1024 * 1024;
/** Per side. Covers render in a 220 px box; anything bigger is a mistake or a decompression bomb. */
export const MAX_COVER_SIDE = 4096;
export const MIN_COVER_SIDE = 16;

/**
 * Raster types only. Never image/svg+xml: the bytes are served same-origin,
 * and an SVG can carry script. The same set the Demozoo copier accepts.
 */
export type CoverType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const COVER_TYPES: readonly CoverType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface SniffedImage { type: CoverType; width: number; height: number }

export type CoverCheck =
  | { ok: true; image: SniffedImage }
  | { ok: false; error: 'empty' | 'too_large' | 'not_an_image' | 'bad_dimensions'; detail: string };

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const ascii = (b: Uint8Array, i: number, s: string) =>
  b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

function sniffPng(b: Uint8Array): SniffedImage | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null;
  // The first chunk must be IHDR (PNG spec 5.6); its width/height follow.
  if (!ascii(b, 12, 'IHDR')) return null;
  return { type: 'image/png', width: be32(b, 16), height: be32(b, 20) };
}

function sniffGif(b: Uint8Array): SniffedImage | null {
  if (b.length < 10 || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return null;
  return { type: 'image/gif', width: le16(b, 6), height: le16(b, 8) };
}

function sniffJpeg(b: Uint8Array): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  // Walk the marker segments to the first start-of-frame, which carries the size.
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]; } // fill bytes
    i += 2;
    // Standalone markers carry no length.
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (m === 0xd9 || m === 0xda) return null; // end of image / scan before any frame
    if (i + 1 >= b.length) return null;
    const len = be16(b, i);
    if (len < 2) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (i + 6 >= b.length) return null;
      return { type: 'image/jpeg', height: be16(b, i + 3), width: be16(b, i + 5) };
    }
    i += len;
  }
  return null;
}

function sniffWebp(b: Uint8Array): SniffedImage | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8 ')) {
    // Lossy: a keyframe start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: 'image/webp', width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) {
    return { type: 'image/webp', width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

/**
 * What the bytes ARE, from their own header -- never the filename or the
 * Content-Type the browser sent, both of which the uploader controls.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes);
}

/** Every rule an uploaded cover must meet, in the order a person can act on. */
export function checkCoverImage(bytes: Uint8Array): CoverCheck {
  if (bytes.byteLength === 0) return { ok: false, error: 'empty', detail: 'The file is empty.' };
  if (bytes.byteLength > MAX_COVER_BYTES) {
    return { ok: false, error: 'too_large', detail: 'Images can be at most 2 MB.' };
  }
  const image = sniffImage(bytes);
  if (!image) {
    return { ok: false, error: 'not_an_image', detail: 'Use a PNG, JPEG, GIF or WebP image.' };
  }
  const { width, height } = image;
  if (width < MIN_COVER_SIDE || height < MIN_COVER_SIDE || width > MAX_COVER_SIDE || height > MAX_COVER_SIDE) {
    return {
      ok: false, error: 'bad_dimensions',
      detail: `Images must be between ${MIN_COVER_SIDE} and ${MAX_COVER_SIDE} pixels on each side (this one is ${width}x${height}).`,
    };
  }
  return { ok: true, image };
}

const SHA256_RE = /^[0-9a-f]{64}$/;
export const isCoverDigest = (s: string) => SHA256_RE.test(s);

/**
 * Where a title's own cover is served. The digest is in the path so the URL
 * changes whenever the image does, which is what lets the route mark the
 * response immutable.
 */
export function coverOverrideUrl(gameId: string, sha256: string): string {
  return `/api/games/${encodeURIComponent(gameId)}/cover/${sha256}`;
}

/**
 * The one precedence rule: a person's own image, else the enriched one, else
 * nothing (the caller draws its placeholder). Shared by the library cards,
 * the collection mosaics and the title page so they can never disagree.
 */
export function effectiveCoverUrl(
  gameId: string, overrideSha256: string | null | undefined, enrichedUrl: string | null | undefined,
): string | null {
  if (overrideSha256) return coverOverrideUrl(gameId, overrideSha256);
  return enrichedUrl ?? null;
}
