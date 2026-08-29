// A TypeScript mirror of wifi-floppy/firmware/src/image_loader.c.
//
// This is not a test helper. It is an executable statement of what the device
// accepts, kept in the repo alongside the firmware for the same reason the
// firmware is here at all: so the contract cannot drift silently. If
// image_loader.c changes, change this with it.
//
// Mirrored behaviours:
//   - bytes arrive in arbitrary chunks; header and lengths reassemble a byte
//     at a time
//   - wrong magic or version aborts
//   - payload_bytes > TRACK_SLOT_BYTES aborts rather than truncating
//   - a short body leaves the image incomplete and NO disk is presented

const IMAGE_MAGIC = 0x464d4657;
const IMAGE_VERSION = 1;
const NUM_TRACKS = 160;
const TRACK_SLOT_BYTES = 13312;

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
    const bytes = (bits + 7) >>> 3;
    if (bytes > TRACK_SLOT_BYTES) {
      return fail(tracks, `track ${t} is ${bytes} bytes, over the ${TRACK_SLOT_BYTES}-byte slot`);
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
