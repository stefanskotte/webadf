import { ADF_BYTES, TRACK_DATA_BYTES, TRACKS } from './constants';
import { AdfmfmError } from './errors';

export class AdfFormatError extends AdfmfmError {
  constructor(message: string) {
    super(message);
    this.name = 'AdfFormatError';
  }
}

/**
 * Reject anything that is not a standard 880 KB double-density ADF.
 *
 * Deliberately stricter than Greaseweazle, which zero-pads a short track. That
 * is correct for a tool recovering a damaged disk and wrong for us: a truncated
 * ADF in the library is a bug worth surfacing, not one worth mounting.
 */
export function assertAdf(adf: Uint8Array): void {
  if (adf.length !== ADF_BYTES) {
    throw new AdfFormatError(
      `not a standard DD ADF: expected ${ADF_BYTES} bytes, got ${adf.length}`,
    );
  }
}

/** The 5,632 raw bytes of one track. trackNo is cyl * 2 + side. */
export function adfTrack(adf: Uint8Array, trackNo: number): Uint8Array {
  if (!Number.isInteger(trackNo) || trackNo < 0 || trackNo >= TRACKS) {
    throw new AdfFormatError(`track number must be an integer in 0..${TRACKS - 1}, got ${trackNo}`);
  }
  return adf.subarray(trackNo * TRACK_DATA_BYTES, (trackNo + 1) * TRACK_DATA_BYTES);
}
