import { splitOddEven, checksum, fillClockBits } from './mfm';
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
