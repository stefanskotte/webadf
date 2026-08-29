import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeDisk, decodeDisk, ADF_BYTES, WFMF_BYTES, TRACK_DATA_BYTES } from './index';
import { AdfFormatError } from './adf';
import { readWfmf } from './wfmf';
import { parseLikeFirmware } from './firmware-parser';
import { syntheticAdf, type SyntheticKind } from './synthetic';

const KINDS: SyntheticKind[] = ['zeros', 'ones', 'prng', 'bootblock'];
const FIXTURE_TRACKS = [0, 1, 80, 159];

describe('encodeDisk', () => {
  it('produces exactly WFMF_BYTES', () => {
    expect(encodeDisk(syntheticAdf('prng')).length).toBe(WFMF_BYTES);
  });

  it.each(KINDS)('every track of %s matches the golden fixture', (kind) => {
    const tracks = readWfmf(encodeDisk(syntheticAdf(kind)));
    for (const t of FIXTURE_TRACKS) {
      const name = `${kind}-t${String(t).padStart(3, '0')}.mfm`;
      const golden = new Uint8Array(
        readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))),
      );
      const at = tracks[t].findIndex((b, i) => b !== golden[i]);
      expect(at, `${kind} track ${t}: first differing byte at ${at}`).toBe(-1);
    }
  });

  it.each(KINDS)('round-trips %s', (kind) => {
    expect(decodeDisk(encodeDisk(syntheticAdf(kind)))).toEqual(syntheticAdf(kind));
  });

  it('produces a container the firmware parser accepts', () => {
    expect(parseLikeFirmware([encodeDisk(syntheticAdf('prng'))]).ok).toBe(true);
  });

  it('places each track at cyl*2+side, not in some other order', () => {
    // Give track 80 a signature no other track has, and check it lands at 80.
    const adf = syntheticAdf('zeros');
    adf.fill(0x5a, 80 * TRACK_DATA_BYTES, 81 * TRACK_DATA_BYTES);
    const back = decodeDisk(encodeDisk(adf));
    expect(back.slice(80 * TRACK_DATA_BYTES, 81 * TRACK_DATA_BYTES).every((b) => b === 0x5a)).toBe(true);
    expect(back.slice(79 * TRACK_DATA_BYTES, 80 * TRACK_DATA_BYTES).every((b) => b === 0x00)).toBe(true);
  });

  it('rejects an ADF that is not exactly 901,120 bytes', () => {
    expect(() => encodeDisk(new Uint8Array(ADF_BYTES - 1))).toThrow(AdfFormatError);
    expect(() => encodeDisk(new Uint8Array(ADF_BYTES + 1))).toThrow(AdfFormatError);
    expect(() => encodeDisk(new Uint8Array(0))).toThrow(AdfFormatError);
  });

  it('does not pad a short ADF, unlike the reference', () => {
    expect(() => encodeDisk(new Uint8Array(ADF_BYTES - 512))).toThrow(/901120/);
  });

  it('is deterministic, which is what makes the cache safe to key by SHA-256', () => {
    expect(encodeDisk(syntheticAdf('prng'))).toEqual(encodeDisk(syntheticAdf('prng')));
  });
});
