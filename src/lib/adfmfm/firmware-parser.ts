// A TypeScript mirror of wifi-floppy/firmware/src/image_loader.c.
//
// This is not a test helper. It is an executable statement of what the device
// accepts, kept in the repo alongside the firmware for the same reason the
// firmware is here at all: so the contract cannot drift silently. If
// image_loader.c changes, change this with it.
//
// Mirrored behaviours:
//   - wrong magic or version aborts
//   - bits > TRACK_MAX_BYTES * 8 aborts before the byte-count arithmetic,
//     rather than computing payload_bytes first and checking it after
//   - payload_bytes > TRACK_MAX_BYTES aborts rather than truncating
//   - a short body leaves the image incomplete and NO disk is presented
//
// The second bullet used to be the other way around: this file computed
// `bytes = (bits + 7) >>> 3` and only bounded the result, deliberately
// reproducing a real image_loader.c bug where bits near 2**32 (e.g.
// 0xFFFFFFF9) made `bits + 7` wrap to 0 under ToUint32, so a garbage bit
// count parsed as a 0-byte track instead of being refused. That was correct
// to mirror at the time: this file's job is to model what the device
// actually accepts, and the device accepted it. The firmware bug is now
// fixed (image_loader.c bounds `bits` before the arithmetic), so this file
// was moved to match -- the two parsers agree here for the same reason they
// agree everywhere else: the device changed, not this file's mission.
//
// This mirror flattens the input chunks into one contiguous buffer before
// parsing anything, rather than reassembling incrementally the way
// image_loader.c's real state machine does. That is sufficient for the
// question this mirror answers -- "would the device accept this blob?" -- but
// it means chunk boundaries are erased before parsing starts: this file does
// NOT exercise the C's incremental reassembly or resume-after-partial-chunk
// logic. That behaviour stays untested by this repo. Porting the C's state
// machine would let us test it, but we cannot execute the C to check such a
// port against, so it is not attempted here.

const IMAGE_MAGIC = 0x464d4657;
const IMAGE_VERSION = 1;
const NUM_TRACKS = 160;
const TRACK_MAX_BYTES = 13312;

export interface FirmwareParseResult {
  ok: boolean;
  tracks: (Uint8Array | null)[];
  reason?: string;
}

function le32(flat: Uint8Array, at: number): number {
  return (flat[at] | (flat[at + 1] << 8) | (flat[at + 2] << 16) | (flat[at + 3] << 24)) >>> 0;
}

function fail(tracks: (Uint8Array | null)[], reason: string): FirmwareParseResult {
  return { ok: false, tracks, reason };
}

export function parseLikeFirmware(chunks: Uint8Array[]): FirmwareParseResult {
  const tracks: (Uint8Array | null)[] = Array.from({ length: NUM_TRACKS }, () => null);

  const flat = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  {
    let at = 0;
    for (const c of chunks) { flat.set(c, at); at += c.length; }
  }

  if (flat.length < 16) return fail(tracks, 'short header');
  if (le32(flat, 0) !== IMAGE_MAGIC) return fail(tracks, 'bad magic');
  if (le32(flat, 4) !== IMAGE_VERSION) return fail(tracks, 'bad version');
  const count = le32(flat, 8);
  if (count <= 0 || count > NUM_TRACKS) return fail(tracks, `bad track count ${count}`);

  let at = 16;
  for (let t = 0; t < count; t++) {
    if (at + 4 > flat.length) return fail(tracks, `truncated before track ${t} length`);
    const bits = le32(flat, at);
    at += 4;
    // Bound `bits` BEFORE the arithmetic, matching image_loader.c: (bits + 7)
    // reaches 2**32 for bits === 0xFFFFFFF9 and wraps to 0 under ToUint32,
    // which would otherwise slip a garbage bit count past the byte-count
    // check below as a 0-byte track.
    if (bits > TRACK_MAX_BYTES * 8) {
      return fail(tracks, `track ${t} has ${bits} bits, over the ${TRACK_MAX_BYTES * 8}-bit ceiling`);
    }
    const bytes = (bits + 7) >>> 3;
    if (bytes > TRACK_MAX_BYTES) {
      return fail(tracks, `track ${t} is ${bytes} bytes, over the ${TRACK_MAX_BYTES}-byte slot`);
    }
    if (at + bytes > flat.length) return fail(tracks, `truncated inside track ${t}`);
    tracks[t] = flat.slice(at, at + bytes);
    at += bytes;
    const pad = (4 - (bytes & 3)) & 3;
    if (at + pad > flat.length) return fail(tracks, `truncated in track ${t} padding`);
    at += pad;
  }

  if (tracks.some((x) => x === null)) return fail(tracks, 'image incomplete');
  return { ok: true, tracks };
}
