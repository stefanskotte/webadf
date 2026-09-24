import { describe, it, expect } from 'vitest';
import { readWfmf, WfmfFormatError } from '@/lib/adfmfm';
import { parseLikeFirmware } from '@/lib/adfmfm/firmware-parser';
import { parseHfe, type HfeDisk } from './parse';
import { hfeToWfmf, tooLongTrack } from './to-wfmf';
import { decodeSectors } from './extract';
import { fixture } from './__fixtures__/load';
import { sparseAdf } from './__fixtures__/source';

const disk = (): HfeDisk => {
  const r = parseHfe(fixture('clean'));
  if (!r.ok) throw new Error(r.reason);
  return r.disk;
};

describe('hfeToWfmf', () => {
  it('passes the firmware acceptance mirror', () => {
    expect(parseLikeFirmware([hfeToWfmf(disk())]).ok).toBe(true);
  });

  it('round trip: every WFMF track decodes to the source ADF sectors, in track order cylinder*2+side', () => {
    const src = sparseAdf();
    const tracks = readWfmf(hfeToWfmf(disk()));
    expect(tracks).toHaveLength(160);
    tracks.forEach((bytes, t) => {
      const sectors = decodeSectors({ bits: bytes.length * 8, bytes }, t);
      expect(sectors.size, `track ${t}`).toBe(11);
      for (const [id, data] of sectors) {
        expect(Buffer.compare(Buffer.from(data), Buffer.from(src.subarray(t * 5632 + id * 512, t * 5632 + id * 512 + 512)))).toBe(0);
      }
    });
  });

  it('serves only cylinders 0-79 when the HFE has 84', () => {
    const d = disk();
    const extra = { ...d, cylinders: 84, tracks: [...d.tracks, ...d.tracks.slice(0, 4)] };
    expect(readWfmf(hfeToWfmf(extra))).toHaveLength(160);
  });

  it('tooLongTrack names the cylinder and side; hfeToWfmf refuses it', () => {
    const d = disk();
    const big = { bits: 13_313 * 8, bytes: new Uint8Array(13_313) };
    const bad = { ...d, tracks: d.tracks.map((t, c) => (c === 12 ? [t[0], big] as typeof t : t)) };
    expect(tooLongTrack(d)).toBeNull();
    expect(tooLongTrack(bad)).toBe("Cylinder 12 side 1 is 106504 bits — longer than the board's 106496-bit track limit.");
    expect(() => hfeToWfmf(bad)).toThrow(WfmfFormatError);
  });

  it('ignores a too-long track on an unserved cylinder (80+)', () => {
    const d = disk();
    const big = { bits: 13_313 * 8, bytes: new Uint8Array(13_313) };
    const extra = { ...d, cylinders: 81, tracks: [...d.tracks, [big, big] as [typeof big, typeof big]] };
    expect(tooLongTrack(extra)).toBeNull();
  });
});
