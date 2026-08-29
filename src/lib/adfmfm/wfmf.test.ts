import { describe, it, expect } from 'vitest';
import { writeWfmf, readWfmf, WfmfFormatError } from './wfmf';
import { parseLikeFirmware } from './firmware-parser';
import { TRACKS, TRACK_BYTES, TRACK_BITS, WFMF_BYTES, FIRMWARE_MAX_TRACK_BITS } from './constants';

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

  it('stays under the firmware track ceiling', () => {
    expect(TRACK_BITS).toBeLessThanOrEqual(FIRMWARE_MAX_TRACK_BITS);
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

  it('accepts the container one byte at a time', () => {
    const b = writeWfmf(tracks());
    const one = Array.from({ length: b.length }, (_, i) => b.subarray(i, i + 1));
    expect(parseLikeFirmware(one).ok).toBe(true);
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
});
