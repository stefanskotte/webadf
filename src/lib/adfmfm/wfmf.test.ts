import { describe, it, expect } from 'vitest';
import { writeWfmf, readWfmf, WfmfFormatError } from './wfmf';
import { parseLikeFirmware } from './firmware-parser';
import {
  TRACKS, TRACK_BYTES, TRACK_BITS, WFMF_BYTES,
  FIRMWARE_ACCEPT_TRACK_BITS, FIRMWARE_SAFE_TRACK_BITS,
} from './constants';

function tracks(): Uint8Array[] {
  return Array.from({ length: TRACKS }, (_, t) => new Uint8Array(TRACK_BYTES).fill(t & 0xff));
}

function chunked(blob: Uint8Array, seed: number): Uint8Array[] {
  // Deterministic ragged chunking: image_loader.c was tested on the host the
  // same way, because its whole job is reassembling arbitrary TCP chunks.
  const out: Uint8Array[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < blob.length; ) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const n = 1 + (x % 4096);
    out.push(blob.subarray(i, Math.min(i + n, blob.length)));
    i += n;
  }
  return out;
}

function buildBlobWithTrackBits(trackPayloadBits: number): Uint8Array {
  const trackPayloadBytes = (trackPayloadBits + 7) >>> 3;
  const trackPad = (4 - (trackPayloadBytes & 3)) & 3;
  const blobSize = 16 + TRACKS * (4 + trackPayloadBytes + trackPad);

  const blob = new Uint8Array(blobSize);
  const dv = new DataView(blob.buffer);

  // Write header
  dv.setUint32(0, 0x464d4657, true);  // magic
  dv.setUint32(4, 1, true);             // version
  dv.setUint32(8, TRACKS, true);        // track_count = 160
  dv.setUint32(12, 0, true);            // reserved

  // Write tracks
  let at = 16;
  for (let t = 0; t < TRACKS; t++) {
    dv.setUint32(at, trackPayloadBits, true);
    at += 4;
    // Fill track payload with t & 0xff to make misalignment detectable
    blob.fill(t & 0xff, at, at + trackPayloadBytes);
    at += trackPayloadBytes;
    // Padding byte(s) are zero (already zero-initialized)
    at += trackPad;
  }

  return blob;
}

describe('writeWfmf', () => {
  it('produces exactly WFMF_BYTES', () => {
    expect(writeWfmf(tracks()).length).toBe(WFMF_BYTES);
  });

  it('writes the header the firmware expects', () => {
    const b = writeWfmf(tracks());
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x464d4657);
    expect(dv.getUint32(4, true)).toBe(1);
    expect(dv.getUint32(8, true)).toBe(160);
    expect(dv.getUint32(12, true)).toBe(0);
    expect(dv.getUint32(16, true)).toBe(TRACK_BITS);
  });

  it('emits no padding, because TRACK_BYTES is 4-byte aligned', () => {
    expect(TRACK_BYTES % 4).toBe(0);
    expect(writeWfmf(tracks()).length).toBe(16 + TRACKS * (4 + TRACK_BYTES));
  });

  it('stays under the real firmware ceiling (TRACK_MFM_MAX * 8)', () => {
    // The binding limit: track_cache.c:14 and main.c:28 cannot hold more than
    // this many bits, regardless of what image_loader.c will accept.
    expect(TRACK_BITS).toBeLessThanOrEqual(FIRMWARE_SAFE_TRACK_BITS);
  });

  it('stays under the looser image_loader.c acceptance ceiling too', () => {
    // Looser and non-binding in practice -- FIRMWARE_SAFE_TRACK_BITS above is
    // the one that must never be exceeded -- but worth asserting so a future
    // change that widens the gap between the two constants is visible here.
    expect(TRACK_BITS).toBeLessThanOrEqual(FIRMWARE_ACCEPT_TRACK_BITS);
  });

  it('rejects the wrong number of tracks', () => {
    expect(() => writeWfmf(tracks().slice(0, 159))).toThrow(/160/);
  });

  it('rejects a track of the wrong length', () => {
    const t = tracks();
    t[7] = new Uint8Array(TRACK_BYTES - 4);
    expect(() => writeWfmf(t)).toThrow(/12668/);
  });
});

describe('readWfmf', () => {
  it('round-trips every track', () => {
    expect(readWfmf(writeWfmf(tracks()))).toEqual(tracks());
  });

  it('rejects a bad magic', () => {
    const b = writeWfmf(tracks());
    b[0] ^= 0xff;
    expect(() => readWfmf(b)).toThrow(WfmfFormatError);
  });

  it('rejects an unknown version', () => {
    const b = writeWfmf(tracks());
    b[4] = 2;
    expect(() => readWfmf(b)).toThrow(/version/i);
  });

  it('rejects a truncated body', () => {
    expect(() => readWfmf(writeWfmf(tracks()).subarray(0, WFMF_BYTES - 1))).toThrow(WfmfFormatError);
  });

  it('rejects a bit_count so large that (bits + 7) wraps to 0 under ToUint32', () => {
    // 0xFFFFFFF9 + 7 == 2**32, which wraps to 0 whether the shift that
    // follows is signed or unsigned. Unvalidated, this yields a zero-length
    // track and `at` never advances -- 160 zero-length tracks, no error.
    const b = writeWfmf(tracks());
    new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(16, 0xfffffff9, true);
    expect(() => readWfmf(b)).toThrow(WfmfFormatError);
  });

  it('rejects a bit_count whose byte length would go negative under a signed shift', () => {
    // 0x80000000 >> 3 is negative under a signed shift, which would otherwise
    // walk `at` negative and let a bare RangeError escape instead of a
    // WfmfFormatError.
    const b = writeWfmf(tracks());
    new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(16, 0x80000000, true);
    expect(() => readWfmf(b)).toThrow(WfmfFormatError);
  });
});

describe('parseLikeFirmware', () => {
  it('accepts our container split into ragged chunks', () => {
    for (const seed of [1, 0x9e3779b9, 0xdeadbeef]) {
      const r = parseLikeFirmware(chunked(writeWfmf(tracks()), seed));
      expect(r.ok, `seed ${seed}: ${r.reason}`).toBe(true);
      expect(r.tracks.filter((t) => t === null)).toHaveLength(0);
    }
  });

  it('accepts the whole container as a single chunk', () => {
    expect(parseLikeFirmware([writeWfmf(tracks())]).ok).toBe(true);
  });

  it('refuses a bad magic, as image_loader.c does', () => {
    const b = writeWfmf(tracks());
    b[0] ^= 0xff;
    expect(parseLikeFirmware([b]).ok).toBe(false);
  });

  it('refuses a track longer than TRACK_SLOT_BYTES', () => {
    const b = writeWfmf(tracks());
    new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(16, 13313 * 8, true);
    const r = parseLikeFirmware([b]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/13312|slot/i);
  });

  it('refuses a truncated body rather than presenting half a disk', () => {
    const r = parseLikeFirmware([writeWfmf(tracks()).subarray(0, 500000)]);
    expect(r.ok).toBe(false);
  });

  it('correctly handles odd-length tracks with padding (readWfmf)', () => {
    // 101336 bits / 8 = 12667 bytes (3 mod 4), needs 1 byte of padding.
    // pad = (4 - (12667 & 3)) & 3 = (4 - 3) & 3 = 1.
    const blob = buildBlobWithTrackBits(101336);
    const result = readWfmf(blob);
    expect(result).toHaveLength(160);
    for (let t = 0; t < 160; t++) {
      expect(result[t]).toHaveLength(12667);
      // Spot-check start, middle, end of each track to detect misalignment
      expect(result[t][0]).toBe(t & 0xff);
      expect(result[t][6333]).toBe(t & 0xff);
      expect(result[t][12666]).toBe(t & 0xff);
    }
  });

  it('correctly handles a payload of 1 mod 4 bytes, needing 3 bytes of padding (readWfmf)', () => {
    // 101320 bits / 8 = 12665 bytes (1 mod 4), needs 3 bytes of padding.
    // pad = (4 - (12665 & 3)) & 3 = (4 - 1) & 3 = 3.
    const blob = buildBlobWithTrackBits(101320);
    const result = readWfmf(blob);
    expect(result).toHaveLength(160);
    for (let t = 0; t < 160; t++) {
      expect(result[t]).toHaveLength(12665);
      expect(result[t][0]).toBe(t & 0xff);
      expect(result[t][6332]).toBe(t & 0xff);
      expect(result[t][12664]).toBe(t & 0xff);
    }
  });

  it('correctly handles odd-length tracks with padding (parseLikeFirmware)', () => {
    const blob = buildBlobWithTrackBits(101336);
    const r = parseLikeFirmware([blob]);
    expect(r.ok).toBe(true);
    expect(r.tracks).toHaveLength(160);
    for (let t = 0; t < 160; t++) {
      expect(r.tracks[t]).not.toBeNull();
      expect(r.tracks[t]!).toHaveLength(12667);
    }
    // Spot check track 5
    expect(r.tracks[5]![0]).toBe(5);
    expect(r.tracks[5]![6333]).toBe(5);
    expect(r.tracks[5]![12666]).toBe(5);
  });

  it('rejects track_count = 0', () => {
    const blob = buildBlobWithTrackBits(101336);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    dv.setUint32(8, 0, true); // Set track_count to 0
    const r = parseLikeFirmware([blob]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/count/i);
  });
});
