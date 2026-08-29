// adfmfm — Amiga MFM encoder.
//
// Turns a standard 880 KB ADF into the WFMF container consumed by
// wifi-floppy/firmware/src/image_loader.c. See README.md and
// docs/superpowers/specs/2026-08-29-adfmfm-encoder-design.md.

import { assertAdf, adfTrack } from './adf';
import { encodeTrack, decodeTrack } from './track';
import { writeWfmf, readWfmf } from './wfmf';
import { TRACKS, TRACK_DATA_BYTES, ADF_BYTES } from './constants';

export * from './constants';
export { AdfFormatError } from './adf';
export { TrackDecodeError } from './track';
export { WfmfFormatError } from './wfmf';
export { encodeTrack, decodeTrack } from './track';
export { writeWfmf, readWfmf } from './wfmf';

/**
 * Encode a whole disk. 901,120 bytes in, 2,027,536 bytes out.
 *
 * Deterministic: the same ADF always yields the same blob, which is what makes
 * it safe to cache the result under the ADF's SHA-256.
 */
export function encodeDisk(adf: Uint8Array): Uint8Array {
  assertAdf(adf);
  const tracks: Uint8Array[] = new Array(TRACKS);
  for (let t = 0; t < TRACKS; t++) {
    tracks[t] = encodeTrack(adfTrack(adf, t), t);
  }
  return writeWfmf(tracks);
}

/** Decode a whole disk back to an ADF. Used for round-trip validation. */
export function decodeDisk(blob: Uint8Array): Uint8Array {
  const tracks = readWfmf(blob);
  const adf = new Uint8Array(ADF_BYTES);
  for (let t = 0; t < tracks.length; t++) {
    adf.set(decodeTrack(tracks[t]), t * TRACK_DATA_BYTES);
  }
  return adf;
}
