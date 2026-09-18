import { ADF_BYTES, TRACK_DATA_BYTES, TRACKS } from '@/lib/adfmfm';
import { buildDelta, encodeDelta } from './delta';
import { nextKind, deltasSinceSnapshot, type VersionEntry, type VersionKind } from './chain';

/**
 * Turning a write session into the next version of a disk (write-back spec
 * §3.4). Pure: the store (store.ts) does the I/O, this decides what to store.
 */

export interface StagedTrack { track: number; data: Uint8Array }

/** A track the board may upload: 0..159, exactly one track of sector data. */
export function isTrackUpload(track: number, data: Uint8Array): boolean {
  return Number.isInteger(track) && track >= 0 && track < TRACKS
    && data.length === TRACK_DATA_BYTES;
}

/** `head` with each staged track written over it. Does not modify `head`. */
export function overlayTracks(head: Uint8Array, tracks: readonly StagedTrack[]): Uint8Array {
  if (head.length !== ADF_BYTES) throw new Error(`head must be ${ADF_BYTES} bytes, got ${head.length}`);
  const out = head.slice();
  for (const t of tracks) {
    if (!isTrackUpload(t.track, t.data)) throw new Error(`not a track upload: track ${t.track}`);
    out.set(t.data, t.track * TRACK_DATA_BYTES);
  }
  return out;
}

export interface PlannedVersion {
  kind: VersionKind;
  /** Sectors that differ from the previous version. */
  sectorCount: number;
  /** The encoded WDLD delta for a 'delta'; null for a 'snapshot' (the image is the blob). */
  deltaBlob: Uint8Array | null;
}

/** What to record for `next`, given the history so far. Null when nothing changed. */
export function planNextVersion(
  entries: readonly VersionEntry[], head: Uint8Array, next: Uint8Array,
): PlannedVersion | null {
  const delta = buildDelta(head, next);
  if (delta.sectors.length === 0) return null;
  const kind = nextKind(delta.sectors.length, deltasSinceSnapshot(entries));
  return {
    kind,
    sectorCount: delta.sectors.length,
    deltaBlob: kind === 'delta' ? encodeDelta(delta) : null,
  };
}
