import { describe, it, expect } from 'vitest';
import { writeWfmfTracks, readWfmf, WfmfFormatError, FIRMWARE_ACCEPT_TRACK_BITS, TRACKS, WFMF_HEADER_BYTES } from '@/lib/adfmfm';
import { parseLikeFirmware } from '@/lib/adfmfm/firmware-parser';

const track = (bytes: number, fill = 0xaa) => ({ bits: bytes * 8, bytes: new Uint8Array(bytes).fill(fill) });

describe('writeWfmfTracks', () => {
  it('preserves each track length, pads to 4 bytes, and sizes the container to fit', () => {
    const tracks = Array.from({ length: TRACKS }, (_, t) => track(12_500 + t)); // odd and even lengths
    const blob = writeWfmfTracks(tracks);
    const expected = WFMF_HEADER_BYTES + tracks.reduce((n, t) => n + 4 + t.bytes.length + ((4 - (t.bytes.length & 3)) & 3), 0);
    expect(blob.length).toBe(expected);
    const back = readWfmf(blob);
    back.forEach((b, t) => expect(b).toEqual(tracks[t].bytes));
    expect(parseLikeFirmware([blob]).ok).toBe(true);
  });

  it('refuses a track over the firmware ceiling, a wrong count, and a bits/bytes mismatch', () => {
    const ok = Array.from({ length: TRACKS }, () => track(12_668));
    const long = ok.slice(); long[9] = track(FIRMWARE_ACCEPT_TRACK_BITS / 8 + 1);
    expect(() => writeWfmfTracks(long)).toThrow(WfmfFormatError);
    expect(() => writeWfmfTracks(ok.slice(1))).toThrow(WfmfFormatError);
    const skew = ok.slice(); skew[3] = { bits: 100, bytes: new Uint8Array(20) };
    expect(() => writeWfmfTracks(skew)).toThrow(WfmfFormatError);
  });
});
