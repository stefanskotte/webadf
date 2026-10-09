// Metadata a cover upload must not keep: a phone photo of a box carries the
// place it was taken (Exif GPS) in its bytes, and those bytes are served back.
//
// Pure, no dependency. Every walker is bounded (each step advances at least
// one byte) and returns the input UNCHANGED when the structure is malformed,
// rather than guessing: a file whose segments do not parse was already a
// poor candidate, and the dimension sniff has accepted it either way.

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const ascii = (b: Uint8Array, i: number, s: string) =>
  b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The Orientation (0x0112) value of an Exif APP1 payload (after the marker length), or null. */
function exifOrientation(seg: Uint8Array): number | null {
  // seg = "Exif\0\0" + TIFF
  if (!ascii(seg, 0, 'Exif') || seg[4] !== 0 || seg[5] !== 0 || seg.length < 6 + 8) return null;
  const t = 6;
  const little = seg[t] === 0x49 && seg[t + 1] === 0x49;
  if (!little && !(seg[t] === 0x4d && seg[t + 1] === 0x4d)) return null;
  const r16 = (i: number) => (little ? seg[i] | (seg[i + 1] << 8) : (seg[i] << 8) | seg[i + 1]);
  const r32 = (i: number) => (little
    ? (seg[i] | (seg[i + 1] << 8) | (seg[i + 2] << 16) | (seg[i + 3] << 24)) >>> 0
    : ((seg[i] << 24) | (seg[i + 1] << 16) | (seg[i + 2] << 8) | seg[i + 3]) >>> 0);
  if (r16(t + 2) !== 0x2a) return null;
  const ifd = t + r32(t + 4);
  if (ifd + 2 > seg.length) return null;
  const n = r16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > seg.length) return null;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** A complete minimal Exif APP1 segment (marker included) holding only Orientation. */
function orientationSegment(value: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,       // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD0 at 8
    0x00, 0x01,                               // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, value, 0x00, 0x00, // Orientation, SHORT
    0x00, 0x00, 0x00, 0x00,                   // no next IFD
  ]);
}

/**
 * JPEG: drop APP1 (Exif, XMP) and APP13 (Photoshop/IPTC); keep APP0, APP2
 * (ICC), APP14 (Adobe colour transform) and every other segment; everything
 * from the first SOS on is copied verbatim. A non-default Exif Orientation is
 * written back as a minimal Exif segment so a sideways photo stays upright.
 */
export function stripJpeg(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const head: Uint8Array[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let orientationAt = -1; // index into `head` where the Orientation segment goes
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return b;
    let m = b[i + 1];
    let j = i;
    while (m === 0xff && j + 2 < b.length) { j++; m = b[j + 1]; } // fill bytes
    if (m === 0xff) return b;
    const markerStart = j;
    if (m === 0xda) { // SOS: the rest is entropy-coded data, verbatim
      if (orientation !== null && orientationAt < 0) orientationAt = head.length;
      const out = [...head];
      if (orientation !== null && orientation !== 1) out.splice(orientationAt, 0, orientationSegment(orientation));
      out.push(b.subarray(markerStart));
      return concat(out);
    }
    if (m === 0xd9) return b; // EOI before any scan
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { head.push(b.subarray(markerStart, markerStart + 2)); i = markerStart + 2; continue; }
    if (markerStart + 3 >= b.length) return b;
    const len = be16(b, markerStart + 2);
    const end = markerStart + 2 + len;
    if (len < 2 || end > b.length) return b;
    if (m === 0xe1 || m === 0xed) {
      if (m === 0xe1 && orientation === null) {
        const o = exifOrientation(b.subarray(markerStart + 4, end));
        if (o !== null) orientation = o;
      }
    } else {
      // Orientation goes after a leading APP0, before anything else.
      if (m !== 0xe0 && orientationAt < 0) orientationAt = head.length;
      head.push(b.subarray(markerStart, end));
    }
    i = end;
  }
  return b;
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);

/** PNG: drop text and Exif chunks. Each chunk has its own CRC, so nothing else changes. */
export function stripPng(b: Uint8Array): Uint8Array {
  if (b.length < 8 + 12 || b[0] !== 0x89 || !ascii(b, 1, 'PNG')) return b;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let dropped = false;
  while (i + 12 <= b.length) {
    const len = be32(b, i);
    const end = i + 12 + len;
    if (end > b.length) return b;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (PNG_DROP.has(type)) dropped = true; else parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  if (!dropped) return b;
  parts.push(b.subarray(i)); // anything after IEND, as it was
  return concat(parts);
}

/** WebP (RIFF): drop EXIF and XMP chunks, clear their VP8X flags, fix the RIFF size. */
export function stripWebp(b: Uint8Array): Uint8Array {
  if (b.length < 20 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return b;
  const parts: Uint8Array[] = [];
  let i = 12;
  let dropped = false;
  while (i + 8 <= b.length) {
    const len = le32(b, i + 4);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > b.length) return b;
    const stop = Math.min(end, b.length);
    if (ascii(b, i, 'EXIF') || ascii(b, i, 'XMP ')) dropped = true;
    else if (ascii(b, i, 'VP8X') && len >= 10) {
      const chunk = b.slice(i, stop);
      chunk[8] &= ~(0x08 | 0x04);
      parts.push(chunk);
    } else parts.push(b.subarray(i, stop));
    i = end;
  }
  if (!dropped) return b;
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  out.set(body, 12);
  const size = out.length - 8;
  out[4] = size & 0xff; out[5] = (size >>> 8) & 0xff; out[6] = (size >>> 16) & 0xff; out[7] = (size >>> 24) & 0xff;
  return out;
}

/** The bytes to store: the image without location or authoring metadata. GIF carries none that matters. */
export function stripImageMetadata(b: Uint8Array): Uint8Array {
  if (b[0] === 0xff) return stripJpeg(b);
  if (b[0] === 0x89) return stripPng(b);
  if (b[0] === 0x52) return stripWebp(b);
  return b;
}
