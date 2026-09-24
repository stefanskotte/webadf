import {
  TRACKS, TRACK_BYTES, TRACK_BITS, WFMF_MAGIC, WFMF_VERSION,
  WFMF_HEADER_BYTES, WFMF_BYTES, FIRMWARE_ACCEPT_TRACK_BITS,
} from './constants';
import { AdfmfmError } from './errors';

export class WfmfFormatError extends AdfmfmError {
  constructor(message: string) {
    super(message);
    this.name = 'WfmfFormatError';
  }
}

/** Serialise 160 encoded tracks into the container image_loader.c consumes. */
export function writeWfmf(tracks: Uint8Array[]): Uint8Array {
  if (tracks.length !== TRACKS) {
    throw new WfmfFormatError(`expected ${TRACKS} tracks, got ${tracks.length}`);
  }
  for (let t = 0; t < tracks.length; t++) {
    if (tracks[t].length !== TRACK_BYTES) {
      throw new WfmfFormatError(`track ${t} must be ${TRACK_BYTES} bytes, got ${tracks[t].length}`);
    }
  }

  const out = new Uint8Array(WFMF_BYTES);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, WFMF_MAGIC, true);
  dv.setUint32(4, WFMF_VERSION, true);
  dv.setUint32(8, TRACKS, true);
  dv.setUint32(12, 0, true);

  let at = WFMF_HEADER_BYTES;
  for (const track of tracks) {
    dv.setUint32(at, TRACK_BITS, true);
    at += 4;
    out.set(track, at);
    at += track.length;
    // No padding: TRACK_BYTES is a multiple of 4. The reader still handles it.
  }
  return out;
}

/**
 * Like writeWfmf, but each track carries its own bit count. For a disk that
 * came from flux (HFE) rather than from our encoder: its tracks are whatever
 * length the original was, and the firmware times INDEX from the count
 * (start_streaming), so padding to nominal would change the disk.
 */
export function writeWfmfTracks(tracks: ReadonlyArray<{ bits: number; bytes: Uint8Array }>): Uint8Array {
  if (tracks.length !== TRACKS) {
    throw new WfmfFormatError(`expected ${TRACKS} tracks, got ${tracks.length}`);
  }
  let size = WFMF_HEADER_BYTES;
  tracks.forEach((tr, t) => {
    if (tr.bits <= 0 || tr.bits > FIRMWARE_ACCEPT_TRACK_BITS) {
      throw new WfmfFormatError(`track ${t} has ${tr.bits} bits, outside 1..${FIRMWARE_ACCEPT_TRACK_BITS}`);
    }
    if (tr.bytes.length !== (tr.bits + 7) >>> 3) {
      throw new WfmfFormatError(`track ${t}: ${tr.bits} bits but ${tr.bytes.length} bytes`);
    }
    size += 4 + tr.bytes.length + ((4 - (tr.bytes.length & 3)) & 3);
  });

  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, WFMF_MAGIC, true);
  dv.setUint32(4, WFMF_VERSION, true);
  dv.setUint32(8, TRACKS, true);
  dv.setUint32(12, 0, true);

  let at = WFMF_HEADER_BYTES;
  for (const tr of tracks) {
    dv.setUint32(at, tr.bits, true);
    at += 4;
    out.set(tr.bytes, at);
    at += tr.bytes.length + ((4 - (tr.bytes.length & 3)) & 3); // zero padding, as readWfmf and image_loader.c skip it
  }
  return out;
}

/** Parse a container back into its tracks. Strict — this is our own output. */
export function readWfmf(blob: Uint8Array): Uint8Array[] {
  if (blob.length < WFMF_HEADER_BYTES) {
    throw new WfmfFormatError(`blob shorter than a header: ${blob.length} bytes`);
  }
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dv.getUint32(0, true) !== WFMF_MAGIC) throw new WfmfFormatError('bad magic');
  if (dv.getUint32(4, true) !== WFMF_VERSION) {
    throw new WfmfFormatError(`unsupported version ${dv.getUint32(4, true)}`);
  }
  const count = dv.getUint32(8, true);
  if (count !== TRACKS) throw new WfmfFormatError(`expected ${TRACKS} tracks, header says ${count}`);

  const tracks: Uint8Array[] = [];
  let at = WFMF_HEADER_BYTES;
  for (let t = 0; t < count; t++) {
    if (at + 4 > blob.length) throw new WfmfFormatError(`truncated before track ${t} length`);
    const bits = dv.getUint32(at, true);
    at += 4;
    // Validate BEFORE the arithmetic: for bits near 2**32 (e.g. 0xFFFFFFF9),
    // `bits + 7` reaches 2**32 and wraps to 0 under ToUint32 regardless of
    // whether the shift that follows is signed or unsigned, so unsigned shift
    // alone does not make this safe. Rejecting oversized bits first closes
    // both the zero-length-tracks case and the negative-offset RangeError case.
    if (bits > FIRMWARE_ACCEPT_TRACK_BITS) {
      throw new WfmfFormatError(`track ${t} has ${bits} bits, over the firmware's accepted ceiling of ${FIRMWARE_ACCEPT_TRACK_BITS}`);
    }
    const bytes = (bits + 7) >>> 3;
    if (at + bytes > blob.length) throw new WfmfFormatError(`truncated inside track ${t}`);
    tracks.push(blob.slice(at, at + bytes));
    at += bytes + ((4 - (bytes & 3)) & 3);
  }
  return tracks;
}
