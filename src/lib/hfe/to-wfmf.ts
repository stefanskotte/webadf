// HFE -> WFMF, the container the board streams (spec D4). One WFMF track per
// (cylinder, side) for cylinders 0-79, in the order encodeDisk uses
// (cylinder * 2 + side). Per-track bit counts are kept, never padded.

import { writeWfmfTracks, FIRMWARE_ACCEPT_TRACK_BITS, TRACKS } from '@/lib/adfmfm';
import type { HfeDisk, HfeSide } from './parse';

const SERVED_CYLINDERS = TRACKS / 2;

/** The first served side the board cannot hold, as a sentence -- or null. */
export function tooLongTrack(disk: HfeDisk): string | null {
  for (let c = 0; c < SERVED_CYLINDERS; c++) {
    for (const s of [0, 1] as const) {
      const bits = disk.tracks[c][s].bits;
      if (bits > FIRMWARE_ACCEPT_TRACK_BITS) {
        return `Cylinder ${c} side ${s} is ${bits} bits — longer than the board's ${FIRMWARE_ACCEPT_TRACK_BITS}-bit track limit.`;
      }
    }
  }
  return null;
}

/**
 * The longest served side, in bits. Stored on the disk row at ingest so the
 * mount gate can refuse a board whose firmware holds shorter tracks (one
 * built before TRACK_MAX_BYTES grew to 14336) without re-reading the image.
 */
export function longestServedTrackBits(disk: HfeDisk): number {
  let max = 0;
  for (let c = 0; c < SERVED_CYLINDERS; c++) {
    for (const s of [0, 1] as const) max = Math.max(max, disk.tracks[c][s].bits);
  }
  return max;
}

export function hfeToWfmf(disk: HfeDisk): Uint8Array {
  const tracks: HfeSide[] = [];
  for (let t = 0; t < TRACKS; t++) tracks.push(disk.tracks[t >> 1][t & 1]);
  return writeWfmfTracks(tracks);
}
