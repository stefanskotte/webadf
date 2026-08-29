import { splitOddEven, joinOddEven, checksum, fillClockBits } from './mfm';
import {
  SECTORS, SECTOR_DATA_BYTES, TRACK_DATA_BYTES, TRACK_BYTES, TRACKS,
  SECTOR_MFM_BYTES, GAP_LEAD_BYTES,
} from './constants';

const SYNC = Uint8Array.of(0x44, 0x89, 0x44, 0x89);
const LABEL_BYTES = 16;

function be32(v: number): Uint8Array {
  return Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

/**
 * Encode one 5,632-byte ADF track into 12,668 bytes of Amiga MFM.
 * Layout is spec §2. Sector n sits at physical position n with sector id n.
 */
export function encodeTrack(data: Uint8Array, trackNo: number): Uint8Array {
  if (data.length !== TRACK_DATA_BYTES) {
    throw new RangeError(`track data must be ${TRACK_DATA_BYTES} bytes, got ${data.length}`);
  }
  if (!Number.isInteger(trackNo) || trackNo < 0 || trackNo >= TRACKS) {
    throw new RangeError(`track number must be an integer in 0..${TRACKS - 1}, got ${trackNo}`);
  }

  const out = new Uint8Array(TRACK_BYTES); // gaps are already zero
  const label = new Uint8Array(LABEL_BYTES);

  for (let n = 0; n < SECTORS; n++) {
    const sectorData = data.subarray(n * SECTOR_DATA_BYTES, (n + 1) * SECTOR_DATA_BYTES);

    // The fourth byte counts sectors remaining to the gap, by physical position.
    const header = Uint8Array.of(0xff, trackNo, n, SECTORS - n);

    const headerAndLabel = new Uint8Array(header.length + label.length);
    headerAndLabel.set(header, 0);
    headerAndLabel.set(label, header.length);

    let at = GAP_LEAD_BYTES + n * SECTOR_MFM_BYTES;
    out.set(SYNC, at);                                          at += 4;
    out.set(splitOddEven(header), at);                          at += 8;
    out.set(splitOddEven(label), at);                           at += 32;
    out.set(splitOddEven(be32(checksum(headerAndLabel))), at);  at += 8;
    out.set(splitOddEven(be32(checksum(sectorData))), at);      at += 8;
    out.set(splitOddEven(sectorData), at);                      at += 1024;
    out.set(splitOddEven(new Uint8Array(2)), at);
  }

  fillClockBits(out);
  return out;
}

export class TrackDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackDecodeError';
  }
}

function u32be(v: Uint8Array): number {
  return (((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0);
}

/**
 * Decode 12,668 bytes of Amiga MFM back to a 5,632-byte ADF track.
 *
 * Scans for sync rather than assuming fixed offsets, so it does not silently
 * inherit the encoder's layout — which is the whole point of using it as a
 * round-trip check.
 */
export function decodeTrack(mfm: Uint8Array): Uint8Array {
  if (mfm.length !== TRACK_BYTES) {
    throw new TrackDecodeError(`track must be ${TRACK_BYTES} bytes, got ${mfm.length}`);
  }

  const out = new Uint8Array(TRACK_DATA_BYTES);
  const seen = new Set<number>();

  for (let i = 0; i + SECTOR_MFM_BYTES <= mfm.length; ) {
    if (!(mfm[i] === 0x44 && mfm[i + 1] === 0x89 && mfm[i + 2] === 0x44 && mfm[i + 3] === 0x89)) {
      i++;
      continue;
    }
    let at = i + 4;
    const header = joinOddEven(mfm.subarray(at, at + 8));       at += 8;
    const label = joinOddEven(mfm.subarray(at, at + 32));       at += 32;
    const hdrSum = u32be(joinOddEven(mfm.subarray(at, at + 8))); at += 8;
    const datSum = u32be(joinOddEven(mfm.subarray(at, at + 8))); at += 8;
    const data = joinOddEven(mfm.subarray(at, at + 1024));

    const headerAndLabel = new Uint8Array(header.length + label.length);
    headerAndLabel.set(header, 0);
    headerAndLabel.set(label, header.length);

    if (checksum(headerAndLabel) !== hdrSum) {
      throw new TrackDecodeError(`header checksum mismatch at byte ${i}`);
    }
    if (checksum(data) !== datSum) {
      throw new TrackDecodeError(`data checksum mismatch at byte ${i}`);
    }

    const sectorId = header[2];
    if (sectorId >= SECTORS) {
      throw new TrackDecodeError(`sector id ${sectorId} out of range at byte ${i}`);
    }
    if (seen.has(sectorId)) {
      throw new TrackDecodeError(`sector ${sectorId} appears twice`);
    }
    seen.add(sectorId);
    out.set(data, sectorId * SECTOR_DATA_BYTES);

    i += SECTOR_MFM_BYTES;
  }

  if (seen.size !== SECTORS) {
    throw new TrackDecodeError(`expected 11 sectors, found ${seen.size}`);
  }
  return out;
}
